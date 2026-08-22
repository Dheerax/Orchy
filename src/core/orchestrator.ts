import { EventEmitter } from 'events';
import { AgentBackend, BackendHandle } from '../backends/types';
import { ContractChecker } from './contractChecker';
import { DeliverableVerifier } from './deliverableVerifier';
import { Planner } from './planner';
import { SessionRegistry } from './sessionRegistry';
import {
  AgentContract,
  Deliverable,
  DEFAULT_FORBIDDEN_COMMANDS,
  Plan,
  PlannedAgent,
  Session,
  TERMINAL_STATUSES,
} from './types';
import { WorktreeManager } from './worktreeManager';

export interface SpawnRequest {
  /**
   * Sessions that must complete before this one starts. Their branches are
   * merged into this session's worktree at release, so a dependency means
   * "after, and on top of" rather than only "after".
   */
  dependsOn?: string[];
  /** What this agent promises to produce, and what it expects to exist. */
  agreement?: AgentContract;
  /** The plan this agent belongs to, so a run can be shown on its own. */
  planId?: string;
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
  /** Merge a verified session automatically when nothing about it is ambiguous. */
  autoMerge?: boolean;
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
  private poller: NodeJS.Timeout | undefined;
  private polling = false;
  /** Sessions held until their dependencies complete. */
  private queued = new Map<string, { request: SpawnRequest }>();

  constructor(
    private readonly registry: SessionRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly backend: AgentBackend,
    private readonly verifier: DeliverableVerifier,
    private readonly config: OrchyConfig,
    readonly planner: Planner = new Planner(),
    private readonly contracts: ContractChecker = new ContractChecker()
  ) {
    super();
    this.rehydrateCounters();
    this.startWatching();
  }

  /**
   * Watch running sessions for completion.
   *
   * The backend's event stream reports tool calls but never a terminal event we
   * can recognise, so a finished session sat at `running` indefinitely and its
   * dependents never released. Asking directly is cheap — local HTTP, no tokens,
   * no orchestrator turns — and it means the pipeline advances on its own rather
   * than only when somebody thinks to look.
   */
  private startWatching(intervalMs = 2000): void {
    this.poller = setInterval(() => void this.sweep(), intervalMs);
  }

  private async sweep(): Promise<void> {
    if (this.polling || !this.backend.pollState) {
      return;
    }
    this.polling = true;
    try {
      for (const session of this.registry.all()) {
        if (session.status !== 'running' && session.status !== 'spawning') {
          continue;
        }
        const handle = this.handles.get(session.id);
        if (!handle) {
          continue;
        }
        let observed;
        try {
          observed = await this.backend.pollState(handle);
        } catch {
          continue; // Transient; the next sweep will try again.
        }

        if (
          observed.tokensUsed !== session.budget.tokensUsed ||
          observed.costEstimate !== session.budget.costEstimate
        ) {
          this.registry.record({
            type: 'budget',
            session: session.id,
            tokensUsed: observed.tokensUsed,
            costEstimate: observed.costEstimate,
          });
          this.enforceBudget(session.id);
        }

        if (observed.state === 'idle') {
          this.registry.record({
            type: 'status',
            session: session.id,
            status: 'idle_unverified',
          });
          await this.verify(session.id);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  stopWatching(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
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
      agreement: req.agreement ?? { provides: [], needs: [] },
      planId: req.planId,
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

  /**
   * Merge a verified session without asking, when nothing about it is ambiguous.
   *
   * Opt-in, and deliberately timid: it declines on anything it cannot merge
   * cleanly. Once agents are reliable the approval step becomes the bottleneck,
   * but a merge that needed a human and did not get one is far worse than a
   * merge that waited.
   */
  private async maybeAutoMerge(id: string): Promise<void> {
    if (!this.config.autoMerge) {
      return;
    }
    try {
      await this.merge(id);
      this.emit('autoMerged', this.registry.get(id));
    } catch (err) {
      this.registry.record({
        type: 'status',
        session: id,
        status: 'waiting_input',
        error: `Automatic merge declined: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Turn an approved plan into running agents.
   * Indices become real session ids as each agent is created, so a plan can
   * describe its own shape without knowing ids in advance.
   */
  async runPlan(plan: Plan): Promise<Session[]> {
    // Approval can reach here twice — from the call that was blocked on it and
    // from the panel that settled it. Two pipelines' worth of worktrees is not
    // something the user can easily undo.
    if (!this.planner.markRan(plan.id)) {
      return [];
    }
    const created: Session[] = [];
    const idByIndex = new Map<number, string>();

    // Dependencies first, so an agent's depends_on always resolves.
    const order = Planner.topologicalOrder(plan.agents);

    for (const index of order) {
      const agent: PlannedAgent = plan.agents[index];
      const session = await this.spawn({
        planId: plan.id,
        role: agent.role,
        task: agent.task,
        deliverables: agent.deliverables,
        model: agent.model,
        dependsOn: agent.dependsOn
          .map((d) => idByIndex.get(d))
          .filter((d): d is string => d !== undefined),
        agreement: { provides: agent.provides, needs: agent.needs },
      });
      idByIndex.set(index, session.id);
      created.push(session);
    }
    return created;
  }

  /** Connect a session to its backend and send the opening prompt. */
  private async start(id: string, req: SpawnRequest): Promise<void> {
    const session = this.registry.get(id);
    if (!session) {
      return;
    }
    const opts = {
      sessionId: id,
      task: this.decorateTask(
        req.task,
        session.deliverables,
        session.worktree?.path,
        session.agreement
      ),
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
  private decorateTask(
    task: string,
    deliverables: Deliverable[],
    worktree?: string,
    agreement?: AgentContract
  ): string {
    const lines = [task, ''];
    if (worktree) {
      lines.push(
        `You are working in an isolated git worktree at ${worktree}.`,
        `Do not modify files outside it. Do not run git stash, git reset --hard, or force-push —`,
        `the stash and refs are shared with other agents working in parallel.`,
        ''
      );
    }
    if (agreement && agreement.provides.length > 0) {
      lines.push('Other agents are waiting on these, exactly as named:');
      for (const p of agreement.provides) {
        lines.push(`  - export \`${p.symbol}\` from ${p.file}`);
      }
      lines.push(
        'Do not rename or relocate them — downstream agents are already written against these.',
        ''
      );
    }
    if (agreement && agreement.needs.length > 0) {
      lines.push(
        `Already available from work merged into this branch: ${agreement.needs.join(', ')}.`,
        'Use them rather than redefining them.',
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
    const contractResults = this.contracts.check(session.agreement, cwd);
    for (const r of contractResults) {
      this.registry.record({
        type: 'contract',
        session: id,
        symbol: r.symbol,
        file: r.file,
        satisfied: r.satisfied,
        detail: r.detail,
      });
    }
    const brokenPromise = contractResults.find((r) => !r.satisfied);
    if (brokenPromise) {
      // Deliverables can pass while the interface everyone else waits on is
      // missing. Completing here would release dependents onto a broken contract.
      this.registry.record({
        type: 'status',
        session: id,
        status: 'idle_unverified',
        error: `Contract not met — ${brokenPromise.detail}.`,
      });
      this.emit('verified', this.registry.get(id));
      return this.registry.get(id);
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
      await this.maybeAutoMerge(id);
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

  /**
   * Start a fresh session from another session's work, with a corrected task.
   *
   * When an agent goes wrong the useful move is rarely to start over — most of
   * what it did was fine. Forking keeps its commits and gives the replacement a
   * better instruction, which is cheaper than re-deriving the good part and
   * safer than arguing with a session that has already convinced itself.
   */
  async fork(sourceId: string, task: string, deliverables?: Deliverable[]): Promise<Session> {
    const source = this.registry.get(sourceId);
    if (!source) {
      throw new Error(`No session '${sourceId}' to fork.`);
    }
    if (!source.worktree) {
      throw new Error(`Session '${sourceId}' has no worktree, so there is nothing to fork from.`);
    }

    const id = this.nextId(source.role);
    const worktree = this.worktrees.createFrom(id, source.worktree.branch);

    this.registry.record({
      type: 'spawned',
      session: id,
      name: `${source.name} (fork)`,
      role: source.role,
      task,
      backend: { type: this.backend.id, handle: '', model: source.backend.model },
      worktree,
      deliverables: deliverables ?? source.deliverables.map((d) => ({ ...d, verified: false })),
      contract: source.contract,
      dependsOn: [],
      agreement: source.agreement,
    });
    this.registry.record({
      type: 'message',
      session: sourceId,
      to: id,
      summary: 'forked',
    });

    await this.start(id, { role: source.role, task, model: source.backend.model });
    const session = this.registry.get(id);
    if (!session) {
      throw new Error(`fork ${id} vanished immediately after spawn`);
    }
    this.emit('spawned', session);
    return session;
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

  /**
   * Pass a question from one agent to another, and record that it happened.
   *
   * Agents cannot reach each other directly, and should not: unmediated chatter
   * between agents burns tokens and drifts off-task. Routing through here keeps
   * the orchestrator in the loop, and makes coordination something the pipeline
   * can show rather than something that happens invisibly.
   */
  async relay(from: string, to: string, question: string): Promise<void> {
    const asker = this.registry.get(from);
    const target = this.registry.get(to);
    if (!asker) {
      throw new Error(`No session '${from}' to ask on behalf of.`);
    }
    if (!target) {
      throw new Error(`No session '${to}' to ask.`);
    }
    if (!this.handles.has(to)) {
      throw new Error(`Session '${to}' is not connected in this window.`);
    }

    this.registry.record({
      type: 'message',
      session: from,
      to,
      summary: question.slice(0, 160),
    });

    await this.send(
      to,
      `A question from ${asker.id} (${asker.role}), which is working on: ${asker.task}

` +
        `${question}

` +
        `Answer it directly. Do not change any files to answer — if the answer requires a ` +
        `change, say so instead of making it, because ${asker.id} is working in its own branch.`
    );
    this.emit('relayed', { from, to });
  }

  /** Move a running session onto a different model, keeping its context. */
  async setModel(id: string, model: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) {
      throw new Error(`Session '${id}' is not connected in this window.`);
    }
    if (!this.backend.setModel) {
      throw new Error(`${this.backend.id} cannot change model mid-session.`);
    }
    await this.backend.setModel(handle, model);
    this.registry.record({ type: 'model', session: id, model });
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
    this.stopWatching();
    for (const unsubscribe of this.unsubscribes.values()) {
      unsubscribe();
    }
    this.unsubscribes.clear();
  }
}
