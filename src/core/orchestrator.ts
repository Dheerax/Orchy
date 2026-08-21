import { EventEmitter } from 'events';
import { AgentBackend, BackendHandle } from '../backends/types';
import { DeliverableVerifier } from './deliverableVerifier';
import { SessionRegistry } from './sessionRegistry';
import { Deliverable, DEFAULT_FORBIDDEN_COMMANDS, Session, TERMINAL_STATUSES } from './types';
import { WorktreeManager } from './worktreeManager';

export interface SpawnRequest {
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
    const directory = worktree?.path ?? this.worktrees.root;

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
    });

    try {
      const handle = await this.backend.spawn({
        sessionId: id,
        task: this.decorateTask(req.task, deliverables, worktree?.path),
        directory,
        agent: req.agent,
        model: req.model,
        autoApprove: req.autoApprove,
      });
      this.handles.set(id, handle);
      this.attach(id, handle, req.budgetCap);
      this.registry.record({ type: 'status', session: id, status: 'running' });
    } catch (err) {
      this.registry.record({
        type: 'status',
        session: id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const session = this.registry.get(id);
    if (!session) {
      throw new Error(`session ${id} vanished immediately after spawn`);
    }
    this.emit('spawned', session);
    return session;
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
      lines.push('', 'Do not report completion before producing them.');
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
    const after = this.registry.get(id);
    // Always announce the outcome, not just success — the auto-verify triggered
    // by a backend going idle is fire-and-forget, so this is the only signal a
    // caller has that the check actually finished.
    this.emit('verified', after);
    if (after?.status === 'complete') {
      this.emit('completed', after);
    }
    return after;
  }

  /** Backend handle for a session spawned in this window, if any. */
  handleOf(id: string): BackendHandle | undefined {
    return this.handles.get(id);
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
  }

  disposeAll(): void {
    for (const unsubscribe of this.unsubscribes.values()) {
      unsubscribe();
    }
    this.unsubscribes.clear();
  }
}
