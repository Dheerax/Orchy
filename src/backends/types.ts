import { BackendType, Contract, SessionStatus } from '../core/types';

export interface SpawnOpts {
  /** Orchy session id — used for logging and correlation, not by the backend. */
  sessionId: string;
  task: string;
  /** Working directory. For an isolated session this is its worktree. */
  directory: string;
  /** Backend-native agent/role name, e.g. an OpenCode --agent. */
  agent?: string;
  model?: string;
  contract?: Contract;
  /** Auto-approve permissions that are not explicitly denied. Dangerous; opt-in. */
  autoApprove?: boolean;
}

export interface BackendHandle {
  /** Backend-native session id. */
  id: string;
  directory: string;
}

/** A backend event, normalized so surfaces never learn backend-specific shapes. */
export type AgentEvent =
  | { kind: 'status'; status: SessionStatus; error?: string }
  | { kind: 'tool'; name: string; target?: string }
  | { kind: 'budget'; tokensUsed: number; costEstimate: number }
  | { kind: 'text'; text: string };

export interface BackendCapabilities {
  /** Can generate images reliably. OpenCode currently cannot; agy can. */
  images: boolean;
  /** Can attach a live TUI to an existing session — required for the grid. */
  attachTui: boolean;
  checkpoints: boolean;
}

/** One turn in a session, flattened for display. */
export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: { kind: 'text' | 'reasoning' | 'tool'; text: string }[];
}

/**
 * The public contract for adding an agent backend.
 *
 * Adding support for a new agent should mean writing one file that implements
 * this interface and registering it — with no changes to the extension host.
 * Codex is the reference third-party adapter.
 */
export interface AgentBackend {
  readonly id: BackendType;
  readonly displayName: string;

  capabilities(): BackendCapabilities;

  /** True when the backend's runtime is installed and reachable. */
  isAvailable(): Promise<boolean>;

  spawn(opts: SpawnOpts): Promise<BackendHandle>;

  /**
   * Optional two-step start: create the session, then send the opening prompt.
   *
   * Subscribing between the two closes a real gap — a backend that starts work
   * during `spawn` can emit its first events before anyone is listening, so the
   * agent that finishes its round-trip last also has the least visible progress.
   */
  prepare?(opts: SpawnOpts): Promise<BackendHandle>;
  begin?(handle: BackendHandle, task: string): Promise<void>;
  send(handle: BackendHandle, text: string): Promise<void>;
  interrupt(handle: BackendHandle, reason: string): Promise<void>;
  kill(handle: BackendHandle): Promise<void>;

  /** Subscribe to normalized events. Returns an unsubscribe function. */
  subscribe(handle: BackendHandle, listener: (event: AgentEvent) => void): () => void;

  /**
   * Argv for a terminal that attaches a live view to an existing session.
   * Returns undefined when `capabilities().attachTui` is false, in which case
   * the grid renders a read-only transcript instead.
   */
  attachCommand(handle: BackendHandle): { command: string; args: string[] } | undefined;

  /**
   * The session's conversation so far, oldest first.
   *
   * Orchy renders this itself rather than relying on a backend's own TUI to
   * replay history — an attached TUI that shows an empty prompt while the agent
   * is demonstrably working is worse than no pane at all.
   */
  transcript?(handle: BackendHandle): Promise<TranscriptEntry[]>;

  /**
   * Switch the model mid-session, from the next turn onward.
   *
   * Work is not uniform: the same session can start on something cheap for
   * scaffolding and be moved up for the part that actually needs reasoning,
   * without losing the context it has already built.
   */
  setModel?(handle: BackendHandle, model: string): Promise<void>;

  /** Tokens and cost so far, summed from the transcript. */
  usage?(handle: BackendHandle): Promise<{ tokensUsed: number; costEstimate: number }>;

  /**
   * Whether the session is still working, asked directly rather than inferred
   * from events.
   *
   * OpenCode's stream reports tool calls but never a terminal event we can
   * recognise, so a session that had finished sat at `running` forever and its
   * dependents never released. Deriving the answer ourselves is cheap — local
   * HTTP, no tokens — and does not depend on guessing event names.
   */
  pollState?(handle: BackendHandle): Promise<{
    state: 'working' | 'idle';
    tokensUsed: number;
    costEstimate: number;
  }>;
}
