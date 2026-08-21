import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentEvent, AgentBackend, BackendCapabilities, BackendHandle, SpawnOpts } from './types';
import { OpenCodeClient, OpenCodeEvent } from './opencodeClient';

const DEFAULT_PORT = 4096;

let cachedBinary: string | undefined;

/**
 * Absolute path to the opencode executable.
 *
 * On Windows this matters more than it looks. npm installs `opencode` (a POSIX
 * `#!/bin/sh` script, only runnable from a bash-like shell), `opencode.cmd`, and
 * `opencode.exe` side by side. Passing the bare name to `createTerminal` or
 * `spawn` resolves to the extensionless shell script, which Windows cannot
 * execute — the terminal opens and sits there blank forever with no error.
 *
 * Resolution follows npm's .cmd shim to the binary it actually execs, because a
 * stale opencode.exe from an older install can shadow the current one on PATH.
 */
export function resolveOpenCodeBinary(pathEnv = process.env.PATH ?? ''): string {
  if (cachedBinary) {
    return cachedBinary;
  }
  if (process.platform !== 'win32') {
    cachedBinary = 'opencode';
    return cachedBinary;
  }

  const dirs = pathEnv.split(path.delimiter).filter(Boolean);

  // Preferred: follow npm's .cmd shim to the binary it actually execs. A stale
  // opencode.exe from an older install can sit on PATH alongside the shim and
  // shadow it — picking that one gives you a binary that hangs on startup with
  // no error, which is a genuinely miserable thing to debug.
  for (const dir of dirs) {
    const shim = path.join(dir, 'opencode.cmd');
    if (!fs.existsSync(shim)) {
      continue;
    }
    const target = readShimTarget(shim, dir);
    if (target) {
      cachedBinary = target;
      return cachedBinary;
    }
  }

  for (const ext of ['.exe', '.bat', '.cmd']) {
    for (const dir of dirs) {
      const candidate = path.join(dir, `opencode${ext}`);
      if (fs.existsSync(candidate)) {
        cachedBinary = candidate;
        return cachedBinary;
      }
    }
  }

  cachedBinary = 'opencode';
  return cachedBinary;
}

/** Pull the real executable out of an npm cmd-shim, resolving %dp0%. */
function readShimTarget(shimPath: string, shimDir: string): string | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /"([^"]*opencode[^"]*\.exe)"/i.exec(line);
    if (!match) {
      continue;
    }
    const resolved = path
      .normalize(match[1].replace(/%dp0%/gi, `${shimDir}${path.sep}`))
      .replace(/[\\/]{2,}/g, path.sep);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

/** Test seam: clear the memoized lookup. */
export function resetOpenCodeBinaryCache(): void {
  cachedBinary = undefined;
}

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

  constructor(
    private readonly port = DEFAULT_PORT,
    /**
     * `--mini` is denser and suits a narrow grid column, but it hard-fails with
     * "requires a TTY stdout" in any context that lacks one. Off by default:
     * a readable pane beats a dense one that might render nothing.
     */
    private readonly options: { mini?: boolean; replayLimit?: number } = {}
  ) {
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
      execFile(resolveOpenCodeBinary(), ['--version'], { windowsHide: true }, (err) =>
        resolve(!err)
      );
    });
  }

  /** Start `opencode serve` if it isn't already up. Idempotent. */
  async ensureServer(timeoutMs = 20_000): Promise<void> {
    if (await this.client.health()) {
      return;
    }
    this.serverProcess = spawn(resolveOpenCodeBinary(), ['serve', '--port', String(this.port)], {
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
      command: resolveOpenCodeBinary(),
      args: [
        'attach',
        this.serverUrl,
        '--session',
        handle.id,
        '--dir',
        handle.directory,
        ...(this.options.mini ? ['--mini'] : []),
        '--replay-limit',
        String(this.options.replayLimit ?? 200),
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
