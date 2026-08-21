import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Plan, PlannedAgent } from './types';

/** Plans kept on disk. Enough to survive a reload; not an archive. */
const KEEP = 50;

/**
 * Holds proposed pipelines until a human approves them.
 *
 * Agents used to appear and the user found out afterwards. Proposing the whole
 * shape first — who exists, what each owes, what depends on what — turns that
 * into a decision rather than a surprise, and it is the only point at which a
 * bad decomposition is cheap to fix.
 *
 * Plans outlive the window that proposed them. A pipeline is often several
 * minutes of orchestrator work before the user ever sees it, and losing that to
 * a reload — or to the user closing the panel to go read the code the plan is
 * about — means paying for it twice.
 */
export class Planner {
  private plans = new Map<string, Plan>();
  private waiters = new Map<string, ((plan?: Plan) => void)[]>();
  private readonly storePath: string | undefined;

  /** @param dir The `.orchy` directory. Omit to keep plans in memory only. */
  constructor(dir?: string) {
    this.storePath = dir ? path.join(dir, 'plans.json') : undefined;
    this.load();
  }

  propose(summary: string, agents: PlannedAgent[]): Plan {
    const fingerprint = Planner.fingerprint(summary, agents);

    // Re-proposing an identical plan is not a second question. It happens when
    // the orchestrator's call timed out while the user was still reading, and
    // showing the same shape twice would only make them decide it twice.
    const same = [...this.plans.values()].find(
      (p) => p.status === 'proposed' && p.fingerprint === fingerprint
    );
    if (same) {
      return same;
    }

    // A *different* plan means the orchestrator has revised: the pending one is
    // dead. Settling it releases whoever is blocked on it instead of leaving
    // that call to time out, and keeps the panel showing one live decision.
    for (const stale of this.plans.values()) {
      if (stale.status === 'proposed') {
        this.settle(stale.id, 'superseded');
      }
    }

    const plan: Plan = {
      id: randomUUID().slice(0, 8),
      summary,
      agents,
      status: 'proposed',
      warnings: Planner.validate(agents),
      createdAt: new Date().toISOString(),
      fingerprint,
    };
    this.plans.set(plan.id, plan);
    this.save();
    return plan;
  }

  /** The shape of a plan, ignoring anything the user would not see as different. */
  private static fingerprint(summary: string, agents: PlannedAgent[]): string {
    return JSON.stringify([
      summary.trim(),
      agents.map((a) => [
        a.role,
        a.task.trim(),
        a.model ?? '',
        [...a.dependsOn].sort(),
        a.provides.map((p) => p.symbol + '@' + p.file).sort(),
        [...a.needs].sort(),
        a.deliverables.map((d) => d.kind + ':' + d.spec).sort(),
      ]),
    ]);
  }

  /**
   * Problems worth raising before anything runs.
   *
   * These are warnings rather than refusals: the orchestrator may know something
   * the static view does not, and a human is about to look at this anyway.
   */
  static validate(agents: PlannedAgent[]): string[] {
    const warnings: string[] = [];

    const providedBy = new Map<string, number[]>();
    agents.forEach((agent, i) => {
      for (const p of agent.provides) {
        providedBy.set(p.symbol, [...(providedBy.get(p.symbol) ?? []), i]);
      }
    });

    for (const [symbol, providers] of providedBy) {
      if (providers.length > 1) {
        warnings.push(
          `${providers.map((i) => agents[i].role).join(' and ')} both promise '${symbol}'. ` +
            `Two agents producing the same symbol will conflict at merge.`
        );
      }
    }

    agents.forEach((agent, i) => {
      for (const need of agent.needs) {
        const providers = providedBy.get(need);
        if (!providers) {
          warnings.push(
            `${agent.role} needs '${need}' but no agent in this plan provides it. ` +
              `It must already exist in the codebase, or the plan is missing an agent.`
          );
          continue;
        }
        // A need is only safe if it arrives before the agent starts, which means
        // the provider has to be a dependency — directly or transitively.
        const reachable = this.dependencyClosure(agents, i);
        if (!providers.some((p) => reachable.has(p))) {
          warnings.push(
            `${agent.role} needs '${need}' from ${providers
              .map((p) => agents[p].role)
              .join('/')}, but does not depend on it — so it may start before that work exists.`
          );
        }
      }
    });

    // A cycle would leave every agent in the loop queued forever.
    agents.forEach((agent, i) => {
      if (this.dependencyClosure(agents, i).has(i)) {
        warnings.push(`${agent.role} is part of a dependency cycle and would never start.`);
      }
    });

    for (const agent of agents) {
      if (agent.deliverables.length === 0) {
        warnings.push(
          `${agent.role} declares no deliverables, so it can never be verified complete.`
        );
      }
    }

    warnings.push(...this.predictConflicts(agents));
    return warnings;
  }

  /**
   * Agents that will fight over the same file.
   *
   * Worktrees keep them from stepping on each other while they work, and hand
   * you the collision at merge time instead. Catching it here costs a line of
   * text; catching it there costs a manual three-way merge of code written by
   * two agents that never saw each other's version.
   *
   * Only flags siblings — if one depends on the other, the second inherits the
   * first's work and editing the same file is exactly what it is supposed to do.
   */
  private static predictConflicts(agents: PlannedAgent[]): string[] {
    const warnings: string[] = [];
    const filesOf = (a: PlannedAgent): Set<string> =>
      new Set(
        [
          ...a.deliverables.filter((d) => d.kind === 'file').map((d) => d.spec),
          ...a.provides.map((p) => p.file),
        ].map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
      );

    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const related =
          this.dependencyClosure(agents, i).has(j) || this.dependencyClosure(agents, j).has(i);
        if (related) {
          continue;
        }
        const shared = [...filesOf(agents[i])].filter((f) => filesOf(agents[j]).has(f));
        if (shared.length > 0) {
          warnings.push(
            `${agents[i].role} and ${agents[j].role} both write ${shared.join(', ')} and ` +
              `neither depends on the other — they will conflict at merge. Make one depend on ` +
              `the other, or give the file to one of them.`
          );
        }
      }
    }
    return warnings;
  }

  /** Every agent index reachable through dependsOn from `start`. */
  private static dependencyClosure(agents: PlannedAgent[], start: number): Set<number> {
    const seen = new Set<number>();
    const stack = [...(agents[start]?.dependsOn ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined || seen.has(next) || !agents[next]) {
        continue;
      }
      seen.add(next);
      stack.push(...agents[next].dependsOn);
    }
    return seen;
  }

  /**
   * Topological ordering of agents by dependency.
   *
   * Dependencies always appear before dependents, so that iterating in this
   * order guarantees every dependency's session id has already been allocated
   * when its dependent is spawned.
   */
  static topologicalOrder(agents: PlannedAgent[]): number[] {
    const order: number[] = [];
    const visited = new Set<number>();
    const visiting = new Set<number>();

    const visit = (i: number): void => {
      if (visited.has(i)) {
        return;
      }
      if (visiting.has(i)) {
        return;
      }
      visiting.add(i);
      for (const dep of agents[i]?.dependsOn ?? []) {
        if (dep >= 0 && dep < agents.length) {
          visit(dep);
        }
      }
      visiting.delete(i);
      visited.add(i);
      order.push(i);
    };

    for (let i = 0; i < agents.length; i++) {
      visit(i);
    }
    return order;
  }

  get(id: string): Plan | undefined {
    return this.plans.get(id);
  }

  pending(): Plan[] {
    return [...this.plans.values()].filter((p) => p.status === 'proposed');
  }

  /**
   * Whether a call is still blocked on this decision.
   *
   * When nothing is waiting — the window reloaded, or the orchestrator's call
   * timed out — approval has nobody to hand the plan to, so the extension has
   * to run it itself. Without this, approving a restored plan does nothing.
   */
  hasWaiter(id: string): boolean {
    return (this.waiters.get(id)?.length ?? 0) > 0;
  }

  /**
   * Claim the right to spawn this plan's agents. True for the first caller only.
   *
   * Unknown plans return true: a plan the planner never saw is not its business
   * to guard.
   */
  markRan(id: string): boolean {
    const plan = this.plans.get(id);
    if (!plan) {
      return true;
    }
    if (plan.ranAt) {
      return false;
    }
    plan.ranAt = new Date().toISOString();
    this.save();
    return true;
  }

  settle(
    id: string,
    status: 'approved' | 'rejected' | 'superseded',
    feedback?: string
  ): Plan | undefined {
    const plan = this.plans.get(id);
    if (!plan || plan.status !== 'proposed') {
      return plan;
    }
    plan.status = status;
    plan.feedback = feedback;
    this.save();
    for (const resolve of this.waiters.get(id) ?? []) {
      resolve(plan);
    }
    this.waiters.delete(id);
    return plan;
  }

  private load(): void {
    if (!this.storePath) {
      return;
    }
    try {
      const stored = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Plan[];
      for (const plan of stored) {
        this.plans.set(plan.id, plan);
      }
    } catch {
      // No store yet, or an unreadable one. A lost plan costs a re-propose;
      // refusing to start the extension over it costs far more.
    }
  }

  private save(): void {
    if (!this.storePath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const recent = [...this.plans.values()].slice(-KEEP);
      fs.writeFileSync(this.storePath, JSON.stringify(recent, null, 2), 'utf8');
    } catch {
      // Persistence is a convenience here; the in-memory plan still works.
    }
  }

  /** Resolves once a human approves or rejects, so the orchestrator can block on it. */
  awaitDecision(id: string, timeoutMs: number): Promise<Plan | undefined> {
    const plan = this.plans.get(id);
    if (!plan || plan.status !== 'proposed') {
      return Promise.resolve(plan);
    }
    return new Promise((resolve) => {
      const done = (settled?: Plan): void => {
        clearTimeout(timer);
        // Deregister on timeout as well as on decision, so a later approval can
        // tell that nothing is listening any more and run the plan itself.
        this.waiters.set(
          id,
          (this.waiters.get(id) ?? []).filter((w) => w !== done)
        );
        resolve(settled ?? this.plans.get(id));
      };
      const timer = setTimeout(() => done(), timeoutMs);
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), done]);
    });
  }
}
