import { EventEmitter } from 'events';
import { AgentBackend, BackendHandle } from '../backends/types';
import { DeliverableVerifier } from './deliverableVerifier';
import { SessionRegistry } from './sessionRegistry';
import { Deliverable, DEFAULT_FORBIDDEN_COMMANDS, Session, TERMINAL_STATUSES } from './types';
import { WorktreeManager } from './worktreeManager';

export interface SpawnRequest {
  /**
   * Sessions that must complete before this one starts. Their branches are
   * merged into this session's worktree at release, so a dependency means
   * "after, and on top of" rather than only "after".
   */
  dependsOn?: string[];
  /** Free-text label used for the id and grouping. Not sent to the backend. */
  role: string;
  /**
   * Backend-native agent name (OpenCode's --agent). Only set this when the agent
   * genuinely exists — passing an unknown name fails the spawn, and a role is
   * just a label the user typed.
   */
  agent?: string;
  task: string;
  name?: string;
  deliverables?: Deliverable[];
  model?: string;
  /** Skip worktree isolation. Only for read-only research sessions. */
  shareWorkspace?: boolean;
  budgetCap?: number;
  autoApprove?: boolean;
}

export interface OrchyConfig {
  baseBranch: string;
  globalBudgetCap?: number;
}

/**
 * Ties the state layer, worktrees, and backends together.
 *
 * Everything that mutates pipeline state goes through here so that exactly one
 * component decides what an event means. The UI never talks to a backend.
 */
export class Orchestrator extends EventEmitter {
  private handles = new Map<string, BackendHandle>();
  private unsubscribes = new Map<string, () => void>();
  private counters = new Map<string, number>();
  /** Sessions held until their dependencies complete. */
  private queued = new Map<string, { request: SpawnRequest }>();

  constructor(
    private readonly registry: SessionRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly backend: AgentBackend,
    private readonly verifier: DeliverableVerifier,
    private readonly config: OrchyConfig
  ) {
    super();
    this.rehydrateCounters();
  }

  /** Ids must not collide with sessions replayed from a previous window. */
  private rehydrateCounters(): void {
    for (const session of this.registry.all()) {
      const match = /^(.+)-(\d+)$/.exec(session.id);
      if (match) {
        const [, role, n] = match;
        this.counters.set(role, Math.max(this.counters.get(role) ?? 0, Number(n)));
      }
    }
  }

  private nextId(role: string): string {
    const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
    let n = (this.counters.get(slug) ?? 0) + 1;
    // Skip ids whose branch still exists from an earlier session, otherwise
    // `git worktree add -b` fails and the spawn dies for a confusing reason.
    while (this.worktrees.branchExists(`agent/${slug}-${n}`)) {
      n++;
    }
    this.counters.set(slug, n);
    return `${slug}-${n}`;
  }

  async spawn(req: SpawnRequest): Promise<Session> {
    const id = this.nextId(req.role);
    const deliverables = req.deliverables ?? [];

    const worktree = req.shareWorkspace
      ? undefined
      : this.worktrees.create(id, this.config.baseBranch);

    const dependsOn = (req.dependsOn ?? []).filter((d) => this.registry.get(d));

    this.registry.record({
      type: 'spawned',
      session: id,
      name: req.name ?? `${req.role} — ${req.task.slice(0, 60)}`,
      role: req.role,
      task: req.task,
      backend: { type: this.backend.id, handle: '', model: req.model },
      worktree,
      deliverables,
      contract: { forbiddenCommands: [...DEFAULT_FORBIDDEN_COMMANDS] },
      dependsOn,
    });

    if (dependsOn.length > 0 && !this.dependenciesMet(dependsOn)) {
      // Held rather than started. Release happens when the last dependency
      // verifies, so its work exists before this session is told to build on it.
      this.queued.set(id, { request: req });
      const session = this.registry.get(id);
      if (!session) {
        throw new Error(`session ${id} vanished immediately after spawn`);
      }
      this.emit('spawned', session);
      return session;
    }

    await this.start(id, req);

    const session = this.registry.get(id);
    if (!session) {
      throw new Error(`session ${id} vanished immediately after spawn`);
    }
    this.emit('spawned', session);
    return session;
  }

  /** Connect a session to its backend and send the opening prompt. */
  private async start(id: string, req: SpawnRequest): Promise<void> {
    const session = this.registry.get(id);
    if (!session) {
      return;
    }
    const opts = {
      sessionId: id,
      task: this.decorateTask(req.task, session.deliverables, session.worktree?.path),
      directory: session.worktree?.path ?? this.worktrees.root,
      agent: req.agent,
      model: req.model,
      autoApprove: req.autoApprove,
    };

    try {
      // Subscribe between creating the session and prompting it. Doing both in
      // one call meant the first events could land before anyone was listening,
      // which showed up as the last-spawned agent looking stuck.
      let handle: BackendHandle;
      if (this.backend.prepare && this.backend.begin) {
        handle = await this.backend.prepare(opts);
        this.handles.set(id, handle);
        this.attach(id, handle, req.budgetCap);
        this.registry.record({ type: 'attached', session: id, handle: handle.id });
        this.registry.record({ type: 'status', session: id, status: 'running' });
        await this.backend.begin(handle, opts.task);
      } else {
        handle = await this.backend.spawn(opts);
        this.handles.set(id, handle);
        this.attach(id, handle, req.budgetCap);
        this.registry.record({ type: 'attached', session: id, handle: handle.id });
        this.registry.record({ type: 'status', session: id, status: 'running' });
      }
    } catch (err) {
      this.registry.record({
        type: 'status',
        session: id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private dependenciesMet(ids: string[]): boolean {
    return ids.every((d) => this.registry.get(d)?.status === 'complete');
  }

  /** A dependency that can never complete should not leave dependents waiting forever. */
  private deadDependency(ids: string[]): string | undefined {
    return ids.find((d) => {
      const status = this.registry.get(d)?.status;
      return status === 'failed' || status === 'archived' || status === undefined;
    });
  }

  /**
   * Start any queued session whose dependencies are now satisfied.
   *
   * Called whenever a session completes. Merging each dependency's branch in
   * first is the point: without it a dependency would only mean "later", and the
   * dependent would start from a base that predates the work it is meant to
   * build on.
   */
  private async releaseReady(): Promise<void> {
    for (const [id, entry] of [...this.queued]) {
      const session = this.registry.get(id);
      if (!session) {
        this.queued.delete(id);
        continue;
      }

      const dead = this.deadDependency(session.dependsOn);
      if (dead) {
        this.queued.delete(id);
        this.registry.record({
          type: 'status',
          session: id,
          status: 'failed',
          error: `Dependency ${dead} will never complete, so this session cannot start.`,
        });
        continue;
      }
      if (!this.dependenciesMet(session.dependsOn)) {
        continue;
      }

      this.queued.delete(id);

      if (session.worktree) {
        const conflicts: string[] = [];
        for (const dep of session.dependsOn) {
          const branch = this.registry.get(dep)?.worktree?.branch;
          if (!branch) {
            continue;
          }
          try {
            conflicts.push(...this.worktrees.mergeInto(session.worktree.path, branch));
          } catch (err) {
            this.registry.record({
              type: 'status',
              session: id,
              status: 'failed',
              error: `Could not merge ${branch}: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
        }
        if (conflicts.length > 0) {
          // A human has to choose here. Starting the agent on a conflicted tree
          // would just produce confident work on top of merge markers.
          this.registry.record({
            type: 'status',
            session: id,
            status: 'waiting_input',
            error:
              `Merging dependencies left conflicts in ${conflicts.join(', ')}. ` +
              `Resolve them in ${session.worktree.path}, then verify to release this session.`,
          });
          continue;
        }
      }

      await this.start(id, entry.request);
    }
  }

  /**
   * Prepend the working agreement to the task.
   * Stating deliverables to the agent is what makes verification fair — the
   * session is told exactly what it will be measured against.
   */
  private decorateTask(task: string, deliverables: Deliverable[], worktree?: string): string {
    const lines = [task, ''];
    if (worktree) {
      lines.push(
        `You are working in an isolated git worktree at ${worktree}.`,
        `Do not modify files outside it. Do not run git stash, git reset --hard, or force-push —`,
        `the stash and refs are shared with other agents working in parallel.`,
        ''
      );
    }
    if (deliverables.length > 0) {
      lines.push('You are done only when all of these exist and pass:');
      for (const d of deliverables) {
        lines.push(`  - [${d.kind}] ${d.spec}`);
      }
      lines.push(
        '',
        'Do not report completion before producing them.',
        'When they are all in place, commit your work on this branch:',
        '  git add -A && git commit -m "<short summary>"',
        'Leaving changes uncommitted blocks the merge back to main.'
      );
    }
    return lines.join('\n');
  }

  private attach(id: string, handle: BackendHandle, budgetCap?: number): void {
    const unsubscribe = this.backend.subscribe(handle, (event) => {
      const session = this.registry.get(id);
      if (!session || TERMINAL_STATUSES.has(session.status)) {
        return;
      }
      switch (event.kind) {
        case 'status':
          this.registry.record({
            type: 'status',
            session: id,
            status: event.status,
            error: event.error,
          });
          if (event.status === 'idle_unverified') {
            void this.refreshUsage(id);
            void this.verify(id);
          }
          break;
        case 'tool':
          this.registry.record({ type: 'tool', session: id, name: event.name, target: event.target });
          break;
        case 'budget':
          this.registry.record({
            type: 'budget',
            session: id,
            tokensUsed: event.tokensUsed,
            costEstimate: event.costEstimate,
          });
          this.enforceBudget(id, budgetCap);
          break;
        case 'text':
          break;
      }
    });
    this.unsubscribes.set(id, unsubscribe);
  }

  /**
   * Stop a session that has burned its budget.
   * Cost scales linearly with agent count and no tool in this category guards
   * it; an unattended pipeline can otherwise run all night.
   */
  private enforceBudget(id: string, sessionCap?: number): void {
    const session = this.registry.get(id);
    if (!session) {
      return;
    }
    const cap = sessionCap ?? session.budget.cap ?? this.config.globalBudgetCap;
    if (cap === undefined || session.budget.costEstimate < cap) {
      return;
    }
    void this.interrupt(id, 'budget exhausted');
    this.registry.record({
      type: 'status',
      session: id,
      status: 'waiting_input',
      error: `Budget cap of ${cap} reached (spent ${session.budget.costEstimate.toFixed(2)}). Raise the cap or kill the session.`,
    });
  }

  /** Check declared deliverables and promote the session only if they hold. */
  async verify(id: string): Promise<Session | undefined> {
    const session = this.registry.get(id);
    if (!session) {
      return undefined;
    }
    const cwd = session.worktree?.path;
    if (!cwd || session.deliverables.length === 0) {
      return session;
    }
    const results = await this.verifier.verifyAll(session.deliverables, cwd);
    for (const r of results) {
      this.registry.record({
        type: 'deliverable',
        session: id,
        spec: r.spec,
        verified: r.verified,
        detail: r.detail,
      });
    }
    if (results.length > 0 && results.every((r) => r.verified)) {
      // Ask for completion explicitly. Deliverables alone only promote a session
      // already parked at idle_unverified, so a session still marked running
      // would otherwise verify all-green and never change status.
      this.registry.record({ type: 'status', session: id, status: 'complete' });
    }
    await this.refreshUsage(id);

    const after = this.registry.get(id);
    if (after?.status === 'complete') {
      await this.releaseReady();
    }
    // Always announce the outcome, not just success — the auto-verify triggered
    // by a backend going idle is fire-and-forget, so this is the only signal a
    // caller has that the check actually finished.
    this.emit('verified', after);
    if (after?.status === 'complete') {
      this.emit('completed', after);
    }
    return after;
  }

  /**
   * Re-adopt sessions a previous window spawned.
   *
   * Without this, reloading strands every live agent: the session keeps running
   * on the backend but this window holds no handle for it, so it can never be
   * shown in the grid again. Returns the sessions successfully reconnected.
   */
  async adoptExisting(): Promise<Session[]> {
    const adopted: Session[] = [];
    for (const session of this.registry.all()) {
      if (this.handles.has(session.id) || !session.backend.handle || !session.worktree) {
        continue;
      }
      if (['archived', 'complete', 'failed'].includes(session.status)) {
        continue;
      }
      const handle: BackendHandle = {
        id: session.backend.handle,
        directory: session.worktree.path,
      };
      try {
        // Prove the session is really still there before claiming it.
        await this.backend.transcript?.(handle);
      } catch {
        continue;
      }
      this.handles.set(session.id, handle);
      this.attach(session.id, handle);
      // Fresh-window reconciliation marked this detached; we are listening
      // again now, and the event stream will correct it within a turn.
      this.registry.record({ type: 'status', session: session.id, status: 'running' });
      void this.refreshUsage(session.id);
      adopted.push(session);
    }
    return adopted;
  }

  /** Backend handle for a session spawned in this window, if any. */
  handleOf(id: string): BackendHandle | undefined {
    return this.handles.get(id);
  }

  /**
   * Pull tokens and cost from the backend.
   *
   * Usage never arrived as events, so spend sat at zero for every session from
   * spawn through completion — which quietly made budget caps unenforceable.
   */
  private async refreshUsage(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle || !this.backend.usage) {
      return;
    }
    try {
      const usage = await this.backend.usage(handle);
      const current = this.registry.get(id);
      if (
        current &&
        (current.budget.tokensUsed !== usage.tokensUsed ||
          current.budget.costEstimate !== usage.costEstimate)
      ) {
        this.registry.record({
          type: 'budget',
          session: id,
          tokensUsed: usage.tokensUsed,
          costEstimate: usage.costEstimate,
        });
      }
    } catch {
      // Usage is informational; never fail an operation over it.
    }
  }

  async send(id: string, text: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) {
      throw new Error(`Session ${id} is not attached in this window.`);
    }
    await this.backend.send(handle, text);
    this.registry.record({ type: 'status', session: id, status: 'running' });
  }

  async interrupt(id: string, reason: string): Promise<void> {
    const handle = this.handles.get(id);
    if (handle) {
      await this.backend.interrupt(handle, reason);
    }
  }

  async kill(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (handle) {
      await this.backend.kill(handle).catch(() => undefined);
    }
    this.unsubscribes.get(id)?.();
    this.unsubscribes.delete(id);
    this.handles.delete(id);
    this.registry.record({ type: 'status', session: id, status: 'failed', error: 'killed by user' });
  }

  /**
   * Archive a finished session and remove its worktree.
   * Refuses to discard uncommitted work unless explicitly forced.
   */
  async archive(id: string, opts: { force?: boolean; deleteBranch?: boolean } = {}): Promise<void> {
    const session = this.registry.get(id);
    if (!session) {
      return;
    }
    this.unsubscribes.get(id)?.();
    this.unsubscribes.delete(id);
    this.handles.delete(id);
    if (session.worktree) {
      this.worktrees.remove(session.worktree.path, opts);
    }
    this.registry.record({ type: 'archived', session: id });
  }

  /** Merge a verified session's branch into the base branch. */
  async merge(id: string): Promise<void> {
    const session = this.registry.get(id);
    if (!session?.worktree) {
      throw new Error(`Session ${id} has no worktree to merge.`);
    }
    if (session.status !== 'complete') {
      throw new Error(
        `Refusing to merge ${id}: status is ${session.status}, not complete. ` +
          `Verify its deliverables first.`
      );
    }
    this.worktrees.mergeBack(session.worktree.path, session.worktree.branch, this.config.baseBranch);
    this.registry.record({
      type: 'merged',
      session: id,
      branch: session.worktree.branch,
      into: this.config.baseBranch,
    });
    this.emit('merged', session);
  }

  disposeAll(): void {
    for (const unsubscribe of this.unsubscribes.values()) {
      unsubscribe();
    }
    this.unsubscribes.clear();
  }
}
