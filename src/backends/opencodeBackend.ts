import { execFile, spawn } from 'child_process';
import { AgentEvent, AgentBackend, BackendCapabilities, BackendHandle, SpawnOpts } from './types';
import { OpenCodeClient, OpenCodeEvent } from './opencodeClient';

const DEFAULT_PORT = 4096;

/**
 * OpenCode backend.
 *
 * Orchestration goes over HTTP against a single shared `opencode serve`.
 * Visibility comes from `opencode attach <url> --session <id>`, which binds a
 * live TUI to that same session. We never drive the TUI with synthetic
 * keystrokes — the terminal is a view, not a control surface.
 */
export class OpenCodeBackend implements AgentBackend {
  readonly id = 'opencode' as const;
  readonly displayName = 'OpenCode';

  private client: OpenCodeClient;
  private serverProcess: ReturnType<typeof spawn> | undefined;

  constructor(private readonly port = DEFAULT_PORT) {
    this.client = new OpenCodeClient(`http://127.0.0.1:${port}`);
  }

  get serverUrl(): string {
    return this.client.baseUrl;
  }

  capabilities(): BackendCapabilities {
    return {
      // Image models exist but ride an OAuth path that fails in practice.
      // Route image work to agy instead.
      images: false,
      attachTui: true,
      checkpoints: true,
    };
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('opencode', ['--version'], { windowsHide: true }, (err) => resolve(!err));
    });
  }

  /** Start `opencode serve` if it isn't already up. Idempotent. */
  async ensureServer(timeoutMs = 20_000): Promise<void> {
    if (await this.client.health()) {
      return;
    }
    this.serverProcess = spawn('opencode', ['serve', '--port', String(this.port)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    this.serverProcess.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if (await this.client.health()) {
        return;
      }
    }
    throw new Error(
      `opencode serve did not become healthy on port ${this.port} within ${timeoutMs / 1000}s`
    );
  }

  async spawn(opts: SpawnOpts): Promise<BackendHandle> {
    await this.ensureServer();
    const session = await this.client.createSession({
      directory: opts.directory,
      agent: opts.agent,
      model: parseModel(opts.model),
    });
    await this.client.prompt(session.id, opts.task);
    return { id: session.id, directory: opts.directory };
  }

  async send(handle: BackendHandle, text: string): Promise<void> {
    await this.client.prompt(handle.id, text);
  }

  async interrupt(handle: BackendHandle, _reason: string): Promise<void> {
    await this.client.interrupt(handle.id);
  }

  async kill(handle: BackendHandle): Promise<void> {
    try {
      await this.client.interrupt(handle.id);
    } catch {
      // Session may already be idle; deletion is what matters.
    }
    await this.client.deleteSession(handle.id);
  }

  subscribe(handle: BackendHandle, listener: (event: AgentEvent) => void): () => void {
    return this.client.onEvent((evt) => {
      if (sessionIdOf(evt) !== handle.id) {
        return;
      }
      const normalized = normalize(evt);
      if (normalized) {
        listener(normalized);
      }
    });
  }

  attachCommand(handle: BackendHandle): { command: string; args: string[] } {
    return {
      command: 'opencode',
      args: [
        'attach',
        this.serverUrl,
        '--session',
        handle.id,
        '--dir',
        handle.directory,
        '--mini',
        '--replay-limit',
        '200',
      ],
    };
  }

  dispose(): void {
    this.client.close();
  }
}

function parseModel(model?: string): { id: string; providerID: string } | undefined {
  if (!model) {
    return undefined;
  }
  const slash = model.indexOf('/');
  if (slash === -1) {
    return undefined;
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** OpenCode nests the session id differently per event type; check the known spots. */
function sessionIdOf(evt: OpenCodeEvent): string | undefined {
  const props = (evt.properties ?? {}) as Record<string, unknown>;
  const candidates = [
    props.sessionID,
    props.sessionId,
    (props.info as Record<string, unknown> | undefined)?.sessionID,
    (evt.durable as Record<string, unknown> | undefined)?.aggregateID,
  ];
  return candidates.find((c): c is string => typeof c === 'string');
}

/**
 * Map an OpenCode event to Orchy's vocabulary.
 *
 * Note the deliberate asymmetry: OpenCode's `idle` becomes `idle_unverified`,
 * never `complete`. Only the DeliverableVerifier may promote a session, because
 * a backend going quiet says nothing about whether it produced anything.
 */
function normalize(evt: OpenCodeEvent): AgentEvent | undefined {
  const type = evt.type.toLowerCase();
  const props = (evt.properties ?? {}) as Record<string, unknown>;

  if (type.includes('permission')) {
    return { kind: 'status', status: 'waiting_input' };
  }
  if (type.includes('error')) {
    const message =
      typeof props.message === 'string'
        ? props.message
        : typeof props.error === 'string'
          ? props.error
          : JSON.stringify(props).slice(0, 300);
    return { kind: 'status', status: 'failed', error: message };
  }
  if (type.includes('idle')) {
    return { kind: 'status', status: 'idle_unverified' };
  }
  if (type.includes('tool')) {
    const name = typeof props.tool === 'string' ? props.tool : 'tool';
    const target =
      typeof props.path === 'string'
        ? props.path
        : typeof props.filePath === 'string'
          ? props.filePath
          : undefined;
    return { kind: 'tool', name, target };
  }
  if (type.includes('token') || type.includes('usage')) {
    const tokens = Number(props.tokens ?? props.total ?? 0);
    const cost = Number(props.cost ?? 0);
    if (Number.isFinite(tokens) || Number.isFinite(cost)) {
      return { kind: 'budget', tokensUsed: tokens || 0, costEstimate: cost || 0 };
    }
  }
  if (type.includes('message') || type.includes('part')) {
    return { kind: 'status', status: 'running' };
  }
  return undefined;
}
