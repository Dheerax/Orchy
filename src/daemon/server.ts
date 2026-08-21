import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { Orchestrator, SpawnRequest } from '../core/orchestrator';
import { SessionRegistry } from '../core/sessionRegistry';

interface Handshake {
  port: number;
  token: string;
  pid: number;
  workspace: string;
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
    private readonly workspaceRoot: string
  ) {}

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
        return { ok: true, workspace: this.workspaceRoot };

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
    spend: session.budget.costEstimate,
    error: session.lastError,
  };
}
