import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { Orchestrator, SpawnRequest } from '../core/orchestrator';
import { ProjectConfig, loadProjectConfig } from '../core/projectConfig';
import { SessionRegistry } from '../core/sessionRegistry';
import { NEEDS_ATTENTION } from '../core/types';

interface Handshake {
  port: number;
  token: string;
  pid: number;
  workspace: string;
  /**
   * Which build is actually live.
   *
   * VS Code keeps running the extension it loaded at startup, so an installed
   * version and a running version can differ for as long as the window stays
   * open. Without this written down, every symptom has to be re-diagnosed
   * against a build that may not be the one producing it.
   */
  version: string;
}

/**
 * Local RPC surface the orchestrator's MCP server talks to.
 *
 * An MCP server runs as a subprocess of the agent and cannot reach into the
 * extension host, so this is the seam. Bound to 127.0.0.1 with a per-session
 * token written to `.orchy/daemon.json` — a loopback port with no auth would be
 * reachable by anything else running on the machine.
 */
export class DaemonServer {
  private server: http.Server | undefined;
  private readonly token = crypto.randomBytes(24).toString('hex');

  constructor(
    private readonly registry: SessionRegistry,
    private readonly orchestrator: Orchestrator,
    private readonly orchyDir: string,
    private readonly workspaceRoot: string,
    private readonly version: string
  ) {}

  /** This repository's rules, re-read each time so an edit takes effect at once. */
  private project(): ProjectConfig {
    return loadProjectConfig(this.workspaceRoot);
  }

  /** Set by the extension so a proposed plan can surface in the UI immediately. */
  onPlanProposed: ((plan: import('../core/types').Plan) => void) | undefined;

  /** Set by the extension so "the panel is blank" can be answered with facts. */
  onDiagnostics: (() => Record<string, unknown>) | undefined;

  async start(): Promise<number> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const handshake: Handshake = {
      port,
      token: this.token,
      pid: process.pid,
      workspace: this.workspaceRoot,
      version: this.version,
    };
    fs.mkdirSync(this.orchyDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.orchyDir, 'daemon.json'),
      JSON.stringify(handshake, null, 2),
      'utf8'
    );
    return port;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    if (req.headers['x-orchy-token'] !== this.token) {
      send(401, { error: 'bad or missing token' });
      return;
    }

    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          send(400, { error: 'invalid JSON body' });
          return;
        }
      }
    }

    try {
      send(200, await this.route(req.url ?? '/', body));
    } catch (err) {
      // Surface the real failure. A generic message here would strand the
      // orchestrator with nothing to act on.
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async route(url: string, body: Record<string, unknown>): Promise<unknown> {
    const route = url.split('?')[0];
    switch (route) {
      case '/health':
        return { ok: true, workspace: this.workspaceRoot, version: this.version };

      case '/list':
        return { sessions: this.registry.all().map(summarize) };

      case '/status': {
        const id = String(body.session_id ?? '');
        const session = this.registry.get(id);
        if (!session) {
          throw new Error(`No session '${id}'. Known: ${this.knownIds()}`);
        }
        return summarize(session);
      }

      case '/spawn': {
        const request = toSpawnRequest(body);
        const session = await this.orchestrator.spawn(request);
        return summarize(session);
      }

      case '/send': {
        const id = String(body.session_id ?? '');
        await this.orchestrator.send(id, String(body.text ?? ''));
        return { ok: true };
      }

      case '/verify': {
        const id = String(body.session_id ?? '');
        const session = await this.orchestrator.verify(id);
        if (!session) {
          throw new Error(`No session '${id}'. Known: ${this.knownIds()}`);
        }
        return summarize(session);
      }

      case '/project': {
        const project = this.project();
        return {
          config_file: project.path ?? null,
          base_branch: project.baseBranch ?? null,
          rules: project.rules,
          verify: project.verify ?? null,
          models: project.models,
          budget_cap: project.budgetCap ?? null,
          forbid: project.forbid,
          warnings: project.warnings,
          note: project.path
            ? 'These are this repository\'s own rules. They are already appended to every ' +
              'agent brief, so do not repeat them in tasks — but do plan around them: a rule ' +
              'saying no new dependencies changes what a sensible plan looks like.'
            : 'This project has no .orchy/config.json, so there are no house rules beyond what you ' +
              'can read in the code. Run "Orchy: Create Project Config" in VS Code to add one.',
        };
      }

      case '/plan': {
        const agents = Array.isArray(body.agents) ? body.agents : [];
        const plan = this.orchestrator.planner.propose(
          String(body.summary ?? 'Pipeline'),
          agents.map((a) => {
            const agent = a as Record<string, unknown>;
            const raw = Array.isArray(agent.deliverables) ? agent.deliverables : [];
            return {
              role: String(agent.role ?? 'agent'),
              task: String(agent.task ?? ''),
              model: agent.model ? String(agent.model) : undefined,
              dependsOn: Array.isArray(agent.depends_on) ? agent.depends_on.map(Number) : [],
              provides: (Array.isArray(agent.provides) ? agent.provides : []).map((p) => {
                const entry = p as Record<string, unknown>;
                return { symbol: String(entry.symbol ?? ''), file: String(entry.file ?? '') };
              }),
              needs: Array.isArray(agent.needs) ? agent.needs.map(String) : [],
              deliverables: raw.map((d) => {
                const entry = d as Record<string, unknown>;
                const kind = String(entry.kind ?? 'file');
                return {
                  kind: (kind === 'glob' || kind === 'command' ? kind : 'file') as
                    | 'file'
                    | 'glob'
                    | 'command',
                  spec: String(entry.spec ?? ''),
                  verified: false,
                };
              }),
            };
          })
        );
        this.onPlanProposed?.(plan);

        // Floor of a minute, whatever was asked for. A one-second wait returns
        // "still proposed", which reads to an orchestrator as "try again" — and
        // a proposal loop replaces the plan the user is mid-way through reading,
        // over and over, so they can never finish deciding.
        const decided = await this.orchestrator.planner.awaitDecision(
          plan.id,
          Math.min(Math.max(Number(body.timeout_seconds ?? 600), 60), 1800) * 1000
        );
        if (decided?.status === 'approved') {
          const sessions = await this.orchestrator.runPlan(decided);
          return {
            plan_id: plan.id,
            status: 'approved',
            warnings: plan.warnings,
            sessions: sessions.map(summarize),
            note:
              sessions.length === 0
                ? 'Already spawned — the panel ran this plan. Use orchy_list to see its agents.'
                : undefined,
          };
        }
        return { ...this.planStatus(plan.id), warnings: plan.warnings };
      }

      case '/diag':
        return {
          version: this.version,
          workspace: this.workspaceRoot,
          sessions: this.registry.all().length,
          pending_plans: this.orchestrator.planner.pending().map((p) => p.id),
          panel: this.onDiagnostics?.() ?? { open: false, note: 'No panel surface registered.' },
        };

      case '/models': {
        await this.orchestrator.refreshModels();
        const models = this.orchestrator.models.models;
        return {
          count: models.length,
          models: models.map((m) => ({
            id: m.id,
            name: m.name,
            tier: this.orchestrator.models.tierOf(m.id),
            input_cost_per_mtok: m.inputCost,
            output_cost_per_mtok: m.outputCost,
            context: m.context,
          })),
          note:
            'Pick per agent by what the work needs: a cheap model for mechanical ' +
            'edits, a strong one where correctness is actually decided. Naming a ' +
            'model that is not on this list is not fatal — Orchy substitutes the ' +
            'nearest available model of the same tier and records that it did — ' +
            'but choosing from here is how you get what you intended.',
        };
      }

      case '/plan_status':
        return this.planStatus(String(body.plan_id ?? ''));

      case '/wait':
        return this.wait(
          Array.isArray(body.session_ids) ? body.session_ids.map(String) : undefined,
          typeof body.timeout_seconds === 'number' ? body.timeout_seconds : 300
        );

      case '/fork': {
        const raw = Array.isArray(body.deliverables) ? body.deliverables : undefined;
        const session = await this.orchestrator.fork(
          String(body.session_id ?? ''),
          String(body.task ?? ''),
          raw?.map((d) => {
            const entry = d as Record<string, unknown>;
            const kind = String(entry.kind ?? 'file');
            return {
              kind: (kind === 'glob' || kind === 'command' ? kind : 'file') as
                | 'file'
                | 'glob'
                | 'command',
              spec: String(entry.spec ?? ''),
              verified: false,
            };
          })
        );
        return summarize(session);
      }

      case '/set_model':
        await this.orchestrator.setModel(
          String(body.session_id ?? ''),
          String(body.model ?? '')
        );
        return { ok: true };

      case '/relay':
        await this.orchestrator.relay(
          String(body.from ?? ''),
          String(body.to ?? ''),
          String(body.question ?? '')
        );
        return { ok: true };

      case '/interrupt':
        await this.orchestrator.interrupt(String(body.session_id ?? ''), String(body.reason ?? ''));
        return { ok: true };

      case '/kill':
        await this.orchestrator.kill(String(body.session_id ?? ''));
        return { ok: true };

      case '/archive':
        await this.orchestrator.archive(String(body.session_id ?? ''), {
          force: body.force === true,
        });
        return { ok: true };

      case '/merge':
        await this.orchestrator.merge(String(body.session_id ?? ''));
        return { ok: true };

      default:
        throw new Error(`unknown route ${route}`);
    }
  }

  /**
   * Block until a watched session needs something, then return.
   *
   * The alternative is an orchestrator burning turns on sleep-then-poll, which
   * costs tokens, adds latency in both directions, and still misses the moment
   * an agent actually became blocked. The daemon already sees every state change,
   * so it should be the thing that waits.
   */
  /**
   * What became of a plan, without proposing anything.
   *
   * The failure mode this exists to prevent: a proposal call times out while the
   * user is still reading, the orchestrator reads that as "try again", and the
   * two of them chase each other — a new plan replacing the one being decided,
   * forever. Waiting is not free either, so there has to be a cheap way to ask.
   */
  private planStatus(id: string): Record<string, unknown> {
    const plan = this.orchestrator.planner.get(id);
    if (!plan) {
      return { plan_id: id, status: 'unknown', note: 'No such plan. It may predate a reload.' };
    }
    const notes: Record<string, string> = {
      proposed:
        'Still on screen, awaiting the user decision. Do NOT propose this or any other plan ' +
        'again — a new proposal replaces what they are reading. Either poll orchy_plan_status ' +
        'occasionally, or stop and let the user come back to you: the plan survives a reload, ' +
        'and its agents spawn on approval whether or not you are still waiting.',
      approved: plan.ranAt
        ? 'Approved and spawned. Use orchy_list to see the agents.'
        : 'Approved. The agents are being spawned.',
      rejected: plan.feedback
        ? 'The user wants changes. Revise to address the feedback and propose again.'
        : 'The user rejected this plan. Ask what to change before proposing again.',
      superseded: 'Replaced by a newer plan you proposed. Follow that one instead.',
    };
    return {
      plan_id: plan.id,
      status: plan.status,
      feedback: plan.feedback,
      spawned: Boolean(plan.ranAt),
      note: notes[plan.status],
    };
  }

  private wait(sessionIds: string[] | undefined, timeoutSeconds: number): Promise<unknown> {
    const watched = (): ReturnType<SessionRegistry['all']> =>
      this.registry.all().filter((s) => !sessionIds || sessionIds.includes(s.id));

    const settled = (): ReturnType<SessionRegistry['all']> =>
      watched().filter(
        (s) =>
          NEEDS_ATTENTION.has(s.status) ||
          s.status === 'complete' ||
          s.status === 'archived'
      );

    const ready = settled();
    if (ready.length > 0) {
      return Promise.resolve({ reason: 'ready', sessions: ready.map(summarize) });
    }

    return new Promise((resolve) => {
      const finish = (reason: string): void => {
        clearTimeout(timer);
        this.registry.off('changed', onChanged);
        resolve({
          reason,
          sessions: (reason === 'timeout' ? watched() : settled()).map(summarize),
        });
      };
      const onChanged = (): void => {
        if (settled().length > 0) {
          finish('ready');
        }
      };
      const timer = setTimeout(
        () => finish('timeout'),
        Math.min(Math.max(timeoutSeconds, 1), 600) * 1000
      );
      this.registry.on('changed', onChanged);
    });
  }

  private knownIds(): string {
    const ids = this.registry.all().map((s) => s.id);
    return ids.length > 0 ? ids.join(', ') : '(none)';
  }

  dispose(): void {
    this.server?.close();
    try {
      fs.unlinkSync(path.join(this.orchyDir, 'daemon.json'));
    } catch {
      // Already gone — nothing to clean up.
    }
  }
}

function toSpawnRequest(body: Record<string, unknown>): SpawnRequest {
  const rawDeliverables = Array.isArray(body.deliverables) ? body.deliverables : [];
  return {
    role: String(body.role ?? 'agent'),
    agent: body.agent ? String(body.agent) : undefined,
    dependsOn: Array.isArray(body.depends_on) ? body.depends_on.map(String) : undefined,
    task: String(body.task ?? ''),
    name: body.name ? String(body.name) : undefined,
    model: body.model ? String(body.model) : undefined,
    shareWorkspace: body.share_workspace === true,
    autoApprove: body.auto_approve === true,
    budgetCap: typeof body.budget_cap === 'number' ? body.budget_cap : undefined,
    deliverables: rawDeliverables.map((d) => {
      const entry = d as Record<string, unknown>;
      const kind = String(entry.kind ?? 'file');
      return {
        kind: (kind === 'glob' || kind === 'command' ? kind : 'file') as
          | 'file'
          | 'glob'
          | 'command',
        spec: String(entry.spec ?? ''),
        verified: false,
      };
    }),
  };
}

function summarize(session: ReturnType<SessionRegistry['all']>[number]): unknown {
  return {
    id: session.id,
    name: session.name,
    role: session.role,
    status: session.status,
    branch: session.worktree?.branch,
    worktree: session.worktree?.path,
    deliverables: session.deliverables.map((d) => ({
      spec: d.spec,
      kind: d.kind,
      verified: d.verified,
      detail: d.detail,
    })),
    model: session.backend.model,
    tokens: session.budget.tokensUsed,
    spend: session.budget.costEstimate,
    error: session.lastError,
  };
}
