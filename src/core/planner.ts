import { randomUUID } from 'crypto';
import { Plan, PlannedAgent } from './types';

/**
 * Holds proposed pipelines until a human approves them.
 *
 * Agents used to appear and the user found out afterwards. Proposing the whole
 * shape first — who exists, what each owes, what depends on what — turns that
 * into a decision rather than a surprise, and it is the only point at which a
 * bad decomposition is cheap to fix.
 */
export class Planner {
  private plans = new Map<string, Plan>();
  private waiters = new Map<string, ((plan: Plan) => void)[]>();

  propose(summary: string, agents: PlannedAgent[]): Plan {
    const plan: Plan = {
      id: randomUUID().slice(0, 8),
      summary,
      agents,
      status: 'proposed',
      warnings: Planner.validate(agents),
      createdAt: new Date().toISOString(),
    };
    this.plans.set(plan.id, plan);
    return plan;
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

  get(id: string): Plan | undefined {
    return this.plans.get(id);
  }

  pending(): Plan[] {
    return [...this.plans.values()].filter((p) => p.status === 'proposed');
  }

  settle(id: string, status: 'approved' | 'rejected', feedback?: string): Plan | undefined {
    const plan = this.plans.get(id);
    if (!plan || plan.status !== 'proposed') {
      return plan;
    }
    plan.status = status;
    plan.feedback = feedback;
    for (const resolve of this.waiters.get(id) ?? []) {
      resolve(plan);
    }
    this.waiters.delete(id);
    return plan;
  }

  /** Resolves once a human approves or rejects, so the orchestrator can block on it. */
  awaitDecision(id: string, timeoutMs: number): Promise<Plan | undefined> {
    const plan = this.plans.get(id);
    if (!plan || plan.status !== 'proposed') {
      return Promise.resolve(plan);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.plans.get(id)), timeoutMs);
      const done = (settled: Plan): void => {
        clearTimeout(timer);
        resolve(settled);
      };
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), done]);
    });
  }
}
