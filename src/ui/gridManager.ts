import * as vscode from 'vscode';
import { AgentBackend, BackendHandle } from '../backends/types';
import { SessionRegistry } from '../core/sessionRegistry';
import { NEEDS_ATTENTION, Session } from '../core/types';

const MAX_SLOTS = 4;

const STATUS_COLORS: Record<string, string> = {
  running: 'terminal.ansiBlue',
  waiting_input: 'terminal.ansiYellow',
  idle_unverified: 'terminal.ansiMagenta',
  complete: 'terminal.ansiGreen',
  failed: 'terminal.ansiRed',
};

/**
 * Places agent terminals into editor grid slots.
 *
 * Terminals, not webviews, because `opencode attach` gives us the real TUI for
 * free. The cost is that a terminal cannot be styled beyond its tab icon colour,
 * so per-session status shows up there and the expressive view lives in the
 * graph panel.
 *
 * Terminals are views, never control surfaces: nothing here sends keystrokes to
 * an agent. Prompts go over HTTP through the Orchestrator.
 */
export class GridManager implements vscode.Disposable {
  private terminals = new Map<string, vscode.Terminal>();
  /** Editor column the agent grid starts at, fixed on first placement. */
  private baseColumn: number | undefined;
  /** Session ids whose terminal the user focused recently, for eviction safety. */
  private lastFocused = new Map<string, number>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly registry: SessionRegistry,
    private readonly backend: AgentBackend,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => this.onTerminalClosed(terminal)),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        const id = this.sessionIdOf(terminal);
        if (id) {
          this.lastFocused.set(id, Date.now());
        }
      })
    );
  }

  private get maxSlots(): number {
    const configured = vscode.workspace.getConfiguration('orchy').get<number>('visibleSlots', 2);
    return Math.min(Math.max(configured, 1), MAX_SLOTS);
  }

  /**
   * Which editor column a slot maps to.
   *
   * Anchored beside whatever the user already has open rather than at column
   * one, because targeting a column that already holds their files just adds a
   * background tab there — the terminal exists, is never seen, and looks like
   * nothing happened. The anchor is fixed on first placement so the grid stays
   * put as agents come and go.
   */
  private targetColumn(slot: number): vscode.ViewColumn {
    if (this.baseColumn === undefined) {
      const existingGroups = vscode.window.tabGroups.all.length;
      this.baseColumn = Math.min(existingGroups + 1, MAX_SLOTS + 4);
    }
    return Math.min(this.baseColumn + slot, 9) as vscode.ViewColumn;
  }

  private sessionIdOf(terminal: vscode.Terminal | undefined): string | undefined {
    if (!terminal) {
      return undefined;
    }
    for (const [id, t] of this.terminals) {
      if (t === terminal) {
        return id;
      }
    }
    return undefined;
  }

  /**
   * Open a terminal for a session, if a slot is free.
   * Returns false when the grid is full — the session still runs, detached.
   */
  open(session: Session, handle: BackendHandle): boolean {
    if (this.terminals.has(session.id)) {
      this.reveal(session.id);
      return true;
    }
    const slot = this.freeSlot();
    if (slot === undefined) {
      this.registry.record({ type: 'surface', session: session.id, visible: false });
      return false;
    }

    const attach = this.backend.attachCommand(handle);
    if (!attach) {
      return false;
    }

    // Logged verbatim: when a pane comes up blank this is the one thing worth
    // seeing, and it can be pasted straight into a normal terminal to compare.
    this.log(`[${session.id}] ${attach.command} ${attach.args.join(' ')}`);

    const terminal = vscode.window.createTerminal({
      name: `${session.id} · ${session.role}`,
      location: { viewColumn: this.targetColumn(slot), preserveFocus: true },
      cwd: session.worktree?.path,
      shellPath: attach.command,
      shellArgs: attach.args,
      // shellPath bypasses the user's shell, so no profile runs. A TUI that
      // cannot identify the terminal may refuse to draw.
      env: { TERM: 'xterm-256color' },
      iconPath: new vscode.ThemeIcon('robot'),
      color: new vscode.ThemeColor(STATUS_COLORS[session.status] ?? 'terminal.ansiBlue'),
      isTransient: true,
    });

    // Creating a terminal does not surface it. Without this it can sit as a
    // background tab in its group, indistinguishable from never having opened.
    terminal.show(true);

    this.terminals.set(session.id, terminal);
    this.registry.record({
      type: 'surface',
      session: session.id,
      terminalId: session.id,
      gridSlot: slot,
      visible: true,
    });
    return true;
  }

  private freeSlot(): number | undefined {
    const taken = new Set(
      this.registry
        .all()
        .filter((s) => s.surface.visible && s.surface.gridSlot !== undefined)
        .map((s) => s.surface.gridSlot as number)
    );
    for (let i = 0; i < this.maxSlots; i++) {
      if (!taken.has(i)) {
        return i;
      }
    }
    return undefined;
  }

  reveal(sessionId: string): void {
    // preserveFocus: a session surfacing itself must never steal the cursor
    // out from under someone mid-keystroke.
    this.terminals.get(sessionId)?.show(true);
  }

  /**
   * Bring a blocked session into view.
   * Evicts the least-recently-focused visible session, but never one the user
   * touched in the last 30 seconds.
   */
  promote(session: Session, handle: BackendHandle): void {
    if (!vscode.workspace.getConfiguration('orchy').get<boolean>('autoPromoteOnBlocked', true)) {
      return;
    }
    if (this.terminals.has(session.id)) {
      this.reveal(session.id);
      return;
    }
    if (this.open(session, handle)) {
      return;
    }

    const cutoff = Date.now() - 30_000;
    const evictable = [...this.terminals.keys()]
      .filter((id) => (this.lastFocused.get(id) ?? 0) < cutoff)
      .filter((id) => !NEEDS_ATTENTION.has(this.registry.get(id)?.status ?? 'running'))
      .sort((a, b) => (this.lastFocused.get(a) ?? 0) - (this.lastFocused.get(b) ?? 0));

    const victim = evictable[0];
    if (!victim) {
      return; // Everything on screen is either busy being read or also blocked.
    }
    this.detach(victim);
    this.open(session, handle);
  }

  /** Close a session's terminal without killing the session. */
  detach(sessionId: string): void {
    const terminal = this.terminals.get(sessionId);
    this.terminals.delete(sessionId);
    terminal?.dispose();
    this.registry.record({ type: 'surface', session: sessionId, visible: false });
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    const id = this.sessionIdOf(terminal);
    if (!id) {
      return;
    }
    this.terminals.delete(id);
    if (this.terminals.size === 0) {
      // Grid is empty; re-anchor next time against the layout as it is then.
      this.baseColumn = undefined;
    }
    const session = this.registry.get(id);
    if (!session) {
      return;
    }
    this.registry.record({ type: 'surface', session: id, visible: false });
    // Closing a terminal is a window-management action, not a kill. The agent
    // keeps working; losing an hour of its work to a stray Ctrl+W would be a
    // uniquely infuriating way to lose data.
    if (!['complete', 'failed', 'archived'].includes(session.status)) {
      this.registry.record({ type: 'status', session: id, status: 'detached' });
    }
  }

  has(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
  }
}
