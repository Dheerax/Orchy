/**
 * Core domain types for Orchy.
 *
 * Everything here is plain data — no VS Code imports, no I/O. The state layer
 * must be testable and replayable outside the extension host, because the
 * event log is the source of truth and the registry is only a projection of it.
 */

export type SessionStatus =
  /** Worktree and terminal are being created. */
  | 'spawning'
  /** Waiting on other sessions to finish before it may start. */
  | 'queued'
  /** Backend is actively working. */
  | 'running'
  /** Blocked on a human. The state the whole UI exists to surface. */
  | 'waiting_input'
  /** Backend reports done, but declared deliverables are NOT confirmed. */
  | 'idle_unverified'
  /** Deliverables verified. */
  | 'complete'
  /** Backend errored. `lastError` carries the real exception. */
  | 'failed'
  /** Alive and running, but no terminal on screen. */
  | 'detached'
  /** Finished. Transcript kept, worktree removed. */
  | 'archived';

/** Statuses from which a session will never make further progress on its own. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'complete',
  'failed',
  'archived',
]);

/** Statuses that mean a human needs to look at this session now. */
export const NEEDS_ATTENTION: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'waiting_input',
  'idle_unverified',
  'failed',
]);

export type BackendType = 'opencode' | 'agy' | 'cli' | 'codex' | 'claude-code';

export interface Deliverable {
  kind: 'file' | 'glob' | 'command';
  /** "src/routes/users.ts" | "docs/*.md" | "npm test" */
  spec: string;
  verified: boolean;
  checkedAt?: string;
  /** Exit code, stderr tail, or "file not found" — never a generic message. */
  detail?: string;
}

export interface Contract {
  maxDurationSeconds?: number;
  allowedPaths?: string[];
  maxFilesCreated?: number;
  /**
   * Commands the session may never run. Defaults always include the shared-state
   * footguns: git stashes are shared across every worktree of a repo, so one
   * agent running `git stash pop` can consume a sibling's entries.
   */
  forbiddenCommands?: string[];
}

export const DEFAULT_FORBIDDEN_COMMANDS: readonly string[] = [
  'git stash',
  'git reset --hard',
  'git push --force',
  'git push -f',
  'git worktree remove',
  'rm -rf',
];

export interface WorktreeRef {
  path: string;
  branch: string;
  /** Branch worktrees are cut from and merged back into. Always `main` in v1. */
  baseRef: string;
  /** SHA of baseRef at creation time — guards against silent base drift. */
  baseSha: string;
}

export interface Budget {
  tokensUsed: number;
  costEstimate: number;
  /** Cost cap in the same unit as costEstimate. Undefined means the global cap applies. */
  cap?: number;
}

export interface Session {
  /** Stable, human-readable, used as the branch suffix. e.g. "ui-1" */
  id: string;
  name: string;
  /** "ui" | "backend" | "ml" | "docs" | free text. Maps to an OpenCode --agent. */
  role: string;
  task: string;
  status: SessionStatus;
  backend: {
    type: BackendType;
    /** Backend-native session id (e.g. the OpenCode session id). */
    handle: string;
    model?: string;
  };
  worktree?: WorktreeRef;
  /** Sessions that must complete, and be merged in, before this one starts. */
  dependsOn: string[];
  surface: {
    terminalId?: string;
    gridSlot?: number;
    visible: boolean;
  };
  deliverables: Deliverable[];
  contract?: Contract;
  budget: Budget;
  /** The backend's real error, surfaced verbatim. Never a generic string. */
  lastError?: string;
  createdAt: string;
  lastEventAt: string;
}

/* ------------------------------------------------------------------ *
 * Events — the append-only source of truth
 * ------------------------------------------------------------------ */

interface EventBase {
  /** ISO timestamp. */
  t: string;
  /** Monotonic per-log sequence number. Gaps mean a rotated or truncated log. */
  seq: number;
  session: string;
}

export type OrchyEvent =
  | (EventBase & {
      type: 'spawned';
      name: string;
      role: string;
      task: string;
      backend: Session['backend'];
      worktree?: WorktreeRef;
      deliverables: Deliverable[];
      contract?: Contract;
      dependsOn?: string[];
    })
  | (EventBase & { type: 'status'; status: SessionStatus; error?: string })
  | (EventBase & { type: 'tool'; name: string; target?: string })
  | (EventBase & { type: 'message'; to: string; summary: string })
  | (EventBase & { type: 'deliverable'; spec: string; verified: boolean; detail?: string })
  | (EventBase & { type: 'budget'; tokensUsed: number; costEstimate: number })
  | (EventBase & { type: 'surface'; terminalId?: string; gridSlot?: number; visible: boolean })
  | (EventBase & { type: 'attached'; handle: string })
  | (EventBase & { type: 'merged'; branch: string; into: string })
  | (EventBase & { type: 'archived' })
  | (EventBase & { type: 'purged' });

export type OrchyEventType = OrchyEvent['type'];

/** An event before the log assigns it a sequence number and timestamp. */
export type DraftEvent =
  | Omit<Extract<OrchyEvent, { type: 'spawned' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'status' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'tool' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'message' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'deliverable' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'budget' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'surface' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'attached' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'merged' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'archived' }>, 't' | 'seq'>
  | Omit<Extract<OrchyEvent, { type: 'purged' }>, 't' | 'seq'>;
