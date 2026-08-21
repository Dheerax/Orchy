import * as vscode from 'vscode';
import { AgentBackend, BackendHandle } from '../backends/types';
import { SessionRegistry } from '../core/sessionRegistry';
import { Session } from '../core/types';
import { TranscriptPane } from './transcriptPane';
import {
  columnForIndex,
  MAX_VISIBLE,
  pageCount,
  pageSlice,
  planGrid,
  toEditorLayout,
} from './gridLayout';

const STATUS_COLORS: Record<string, string> = {
  running: 'terminal.ansiBlue',
  waiting_input: 'terminal.ansiYellow',
  idle_unverified: 'terminal.ansiMagenta',
  complete: 'terminal.ansiGreen',
  failed: 'terminal.ansiRed',
};

/**
 * Arranges agent terminals into a grid across the editor area.
 *
 * The layout follows the number of live agents — two sit side by side, three go
 * two-over-one, twelve fill three rows of four — and anything past twelve
 * paginates rather than shrinking panes into unreadable slivers.
 *
 * Terminals are views, never control surfaces: nothing here sends keystrokes to
 * an agent. Prompts go over HTTP through the Orchestrator, so tearing a terminal
 * down and rebuilding it in a new column costs nothing but a repaint — the
 * session itself lives on the OpenCode server and never notices.
 */
export class GridManager implements vscode.Disposable {
  private terminals = new Map<string, vscode.Terminal>();
  private handles = new Map<string, BackendHandle>();
  /** Placement order, which determines the page a session lands on. */
  private order: string[] = [];
  private page = 0;
  /** Suppresses close handling while we tear the grid down ourselves. */
  private rebuilding = false;
  private pending: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly registry: SessionRegistry,
    private readonly backend: AgentBackend,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => this.onTerminalClosed(terminal))
    );
  }

  /** Whether panes run the backend's own TUI instead of Orchy's transcript view. */
  private get useBackendTui(): boolean {
    return vscode.workspace.getConfiguration('orchy').get<boolean>('useBackendTui', false);
  }

  private get capacity(): number {
    const configured = vscode.workspace
      .getConfiguration('orchy')
      .get<number>('visibleSlots', MAX_VISIBLE);
    return Math.min(Math.max(configured, 1), MAX_VISIBLE);
  }

  /** Sessions that should be on screen right now, dropping any that are gone. */
  private visibleIds(): string[] {
    this.order = this.order.filter((id) => {
      const status = this.registry.get(id)?.status;
      return status !== undefined && status !== 'archived';
    });
    return pageSlice(this.order, this.page).slice(0, this.capacity);
  }

  get pages(): number {
    return pageCount(this.order.length);
  }

  get currentPage(): number {
    return Math.min(this.page, this.pages - 1);
  }

  /** Register a session for placement. The grid rearranges to fit it. */
  open(session: Session, handle: BackendHandle): boolean {
    this.handles.set(session.id, handle);
    if (!this.order.includes(session.id)) {
      this.order.push(session.id);
    }
    // Turn to the page the new agent landed on: spawning should always show you
    // the thing you just spawned.
    this.page = Math.floor((this.order.length - 1) / this.capacity);
    this.scheduleRelayout();
    return true;
  }

  showPage(page: number): void {
    this.page = Math.min(Math.max(page, 0), this.pages - 1);
    this.scheduleRelayout();
  }

  nextPage(): void {
    this.showPage(this.currentPage + 1);
  }

  previousPage(): void {
    this.showPage(this.currentPage - 1);
  }

  /**
   * Rebuild the grid shortly.
   *
   * Debounced: an orchestrator spawning four agents fires four times in quick
   * succession, and relaying out on each one makes the editor thrash.
   */
  private scheduleRelayout(): void {
    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.relayout();
    }, 250);
  }

  private async relayout(): Promise<void> {
    const ids = this.visibleIds();
    const plan = planGrid(ids.length);

    this.rebuilding = true;
    try {
      for (const terminal of this.terminals.values()) {
        terminal.dispose();
      }
      this.terminals.clear();

      if (ids.length === 0) {
        return;
      }

      try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', toEditorLayout(plan));
      } catch (err) {
        // Keep going: terminals still open, just in whatever layout exists.
        // Silently aborting here would tear down every pane and show nothing.
        this.log(
          `layout for ${ids.length} agent(s) rejected: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      ids.forEach((id, index) => {
        const session = this.registry.get(id);
        const handle = this.handles.get(id);
        if (!session || !handle) {
          return;
        }
        const column = columnForIndex(plan, index);
        const common = {
          name: `${session.id} · ${session.role}`,
          location: { viewColumn: column as vscode.ViewColumn, preserveFocus: true },
          iconPath: new vscode.ThemeIcon('robot'),
          color: new vscode.ThemeColor(STATUS_COLORS[session.status] ?? 'terminal.ansiBlue'),
        };

        let options: vscode.TerminalOptions | vscode.ExtensionTerminalOptions;
        if (this.useBackendTui) {
          const attach = this.backend.attachCommand(handle);
          if (!attach) {
            return;
          }
          this.log(`[${id}] column ${column}: ${attach.command} ${attach.args.join(' ')}`);
          options = {
            ...common,
            cwd: session.worktree?.path,
            shellPath: attach.command,
            shellArgs: attach.args,
            isTransient: true,
            // shellPath bypasses the user's shell, so no profile runs. A TUI
            // that cannot identify the terminal may refuse to draw.
            env: { TERM: 'xterm-256color' },
          };
        } else {
          this.log(`[${id}] column ${column}: transcript pane`);
          options = { ...common, pty: new TranscriptPane(this.backend, handle, id) };
        }

        const terminal = vscode.window.createTerminal(options);
        // Creating a terminal does not surface it; without this it can sit as a
        // background tab, indistinguishable from never having opened.
        terminal.show(true);
        this.terminals.set(id, terminal);

        this.registry.record({
          type: 'surface',
          session: id,
          terminalId: id,
          gridSlot: index,
          visible: true,
        });
      });

      for (const id of this.order) {
        if (!ids.includes(id) && this.registry.get(id)?.surface.visible) {
          this.registry.record({ type: 'surface', session: id, visible: false });
        }
      }
    } finally {
      this.rebuilding = false;
    }
  }

  reveal(sessionId: string): void {
    const terminal = this.terminals.get(sessionId);
    if (terminal) {
      // preserveFocus: a session surfacing itself must never steal the cursor
      // out from under someone mid-keystroke.
      terminal.show(true);
      return;
    }
    // Off-page: turn to the page holding it rather than failing silently.
    const index = this.order.indexOf(sessionId);
    if (index >= 0) {
      this.showPage(Math.floor(index / this.capacity));
    }
  }

  /** Bring a blocked session onto the visible page. */
  promote(session: Session, handle: BackendHandle): void {
    if (!vscode.workspace.getConfiguration('orchy').get<boolean>('autoPromoteOnBlocked', true)) {
      return;
    }
    if (!this.handles.has(session.id)) {
      this.open(session, handle);
      return;
    }
    this.reveal(session.id);
  }

  /** Drop a session from the grid without killing it. */
  detach(sessionId: string): void {
    this.order = this.order.filter((id) => id !== sessionId);
    this.handles.delete(sessionId);
    const terminal = this.terminals.get(sessionId);
    this.terminals.delete(sessionId);
    this.rebuilding = true;
    terminal?.dispose();
    this.rebuilding = false;
    this.registry.record({ type: 'surface', session: sessionId, visible: false });
    this.scheduleRelayout();
  }

  private onTerminalClosed(terminal: vscode.Terminal): void {
    if (this.rebuilding) {
      return; // Our own teardown, not the user closing anything.
    }
    let closedId: string | undefined;
    for (const [id, t] of this.terminals) {
      if (t === terminal) {
        closedId = id;
        break;
      }
    }
    if (!closedId) {
      return;
    }
    this.terminals.delete(closedId);
    this.order = this.order.filter((id) => id !== closedId);

    const session = this.registry.get(closedId);
    if (session) {
      this.registry.record({ type: 'surface', session: closedId, visible: false });
      // Closing a terminal is window management, not a kill. The agent keeps
      // working; losing an hour of its work to a stray Ctrl+W would be a
      // uniquely infuriating way to lose data.
      if (!['complete', 'failed', 'archived'].includes(session.status)) {
        this.registry.record({ type: 'status', session: closedId, status: 'detached' });
      }
    }
    this.scheduleRelayout();
  }

  has(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }

  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending);
    }
    this.rebuilding = true;
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
  }
}
