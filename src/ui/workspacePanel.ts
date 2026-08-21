import * as path from 'path';
import * as vscode from 'vscode';
import { AgentBackend, BackendHandle, TranscriptEntry } from '../backends/types';
import { SessionRegistry } from '../core/sessionRegistry';
import { Session } from '../core/types';
import { WorktreeManager } from '../core/worktreeManager';
import { planGrid } from './gridLayout';

/** How much of each transcript reaches the webview. Enough to follow, not enough to choke it. */
const TRANSCRIPT_TAIL = 40;

interface PanelSession {
  id: string;
  name: string;
  role: string;
  status: string;
  branch?: string;
  detail: string;
  spend: number;
  changes: { path: string; status: string }[];
  transcript: TranscriptEntry[];
}

/**
 * The Orchy workspace: every agent in a single editor tab.
 *
 * This replaced a grid of real terminals. That approach had to drive
 * `setEditorLayout`, which reshapes the whole editor area — including the user's
 * own files — so opening one agent rearranged everything on screen. Terminals
 * also cannot be styled beyond a tab icon, which ruled out any status treatment
 * worth having.
 *
 * A webview gives up nothing that was still being used: panes were already
 * read-only, and transcripts already came over HTTP rather than from a terminal.
 * In exchange the layout is ours, it is one stable tab, and the editor beside it
 * stays free for actual work.
 */
export class WorkspacePanel {
  private static current: WorkspacePanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private handles = new Map<string, BackendHandle>();
  private focused: string | undefined;
  private pending: NodeJS.Timeout | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly registry: SessionRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly backend: AgentBackend,
    private readonly handleOf: (id: string) => BackendHandle | undefined
  ) {
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; id?: string; file?: string }) => void this.onMessage(msg),
      undefined,
      this.disposables
    );

    const onChanged = (): void => this.schedulePush();
    this.registry.on('changed', onChanged);

    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          void this.push();
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        this.registry.off('changed', onChanged);
        if (this.pending) {
          clearTimeout(this.pending);
        }
        for (const d of this.disposables) {
          d.dispose();
        }
        WorkspacePanel.current = undefined;
      },
      undefined,
      this.disposables
    );
  }

  static show(
    registry: SessionRegistry,
    worktrees: WorktreeManager,
    backend: AgentBackend,
    handleOf: (id: string) => BackendHandle | undefined
  ): void {
    if (WorkspacePanel.current) {
      WorkspacePanel.current.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'orchy.workspace',
      'Orchy',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    WorkspacePanel.current = new WorkspacePanel(panel, registry, worktrees, backend, handleOf);
  }

  static refreshIfOpen(): void {
    WorkspacePanel.current?.schedulePush();
  }

  /** Coalesce bursts: seven agents all emitting events must not mean seven repaints. */
  private schedulePush(): void {
    if (this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.push();
    }, 200);
  }

  private async onMessage(msg: { type: string; id?: string; file?: string }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.push();
        break;
      case 'focus':
        this.focused = this.focused === msg.id ? undefined : msg.id;
        await this.push();
        break;
      case 'diff':
        if (msg.id && msg.file) {
          await this.openDiff(msg.id, msg.file);
        }
        break;
      case 'verify':
      case 'kill':
      case 'archive':
        if (msg.id) {
          await vscode.commands.executeCommand(`orchy.${msg.type}`, msg.id);
        }
        break;
    }
  }

  /**
   * Diff an agent's file against the base checkout using VS Code's own editor.
   * A webview could draw a diff, but never as well as the thing already built
   * for it two panes away.
   */
  private async openDiff(sessionId: string, file: string): Promise<void> {
    const session = this.registry.get(sessionId);
    if (!session?.worktree) {
      return;
    }
    const agentSide = vscode.Uri.file(path.join(session.worktree.path, file));
    const baseSide = vscode.Uri.file(path.join(this.worktrees.root, file));
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        baseSide,
        agentSide,
        `${file} — main ↔ ${session.id}`,
        { preview: true, viewColumn: vscode.ViewColumn.Beside }
      );
    } catch {
      await vscode.window.showTextDocument(agentSide, {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }
  }

  private async push(): Promise<void> {
    if (!this.panel.visible) {
      return;
    }
    const live = this.registry.all().filter((s) => s.status !== 'archived');
    const sessions: PanelSession[] = [];

    for (const session of live.slice(0, 12)) {
      sessions.push({
        id: session.id,
        name: session.name,
        role: session.role,
        status: session.status,
        branch: session.worktree?.branch,
        detail: this.detail(session),
        spend: session.budget.costEstimate,
        changes: this.changesOf(session),
        transcript: await this.transcriptOf(session),
      });
    }

    void this.panel.webview.postMessage({
      type: 'snapshot',
      data: {
        sessions,
        rows: planGrid(sessions.length),
        focused: this.focused,
        blocked: this.registry.needingAttention().length,
        archived: this.registry.all().length - live.length,
      },
    });
  }

  private async transcriptOf(session: Session): Promise<TranscriptEntry[]> {
    const handle = this.handles.get(session.id) ?? this.handleOf(session.id);
    if (!handle || !this.backend.transcript) {
      return [];
    }
    this.handles.set(session.id, handle);
    try {
      const entries = await this.backend.transcript(handle);
      return entries.slice(-TRANSCRIPT_TAIL);
    } catch {
      // Session gone from the backend; the card still renders its metadata.
      return [];
    }
  }

  private changesOf(session: Session): { path: string; status: string }[] {
    if (!session.worktree) {
      return [];
    }
    try {
      return this.worktrees.changedFiles(session.worktree.path).slice(0, 20);
    } catch {
      return [];
    }
  }

  private detail(session: Session): string {
    if (session.status === 'idle_unverified') {
      const missing = session.deliverables.filter((d) => !d.verified);
      return missing.length > 0
        ? `missing: ${missing.map((d) => d.spec).join(', ')}`
        : 'unverified';
    }
    if (session.lastError) {
      return session.lastError.slice(0, 160);
    }
    return session.task.slice(0, 140);
  }

  private html(): string {
    const nonce = String(Math.random()).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --muted: var(--vscode-descriptionForeground);
    --line: var(--vscode-panel-border, rgba(128,128,128,.3));
    --card: var(--vscode-editorWidget-background, rgba(127,127,127,.06));
    --running: var(--vscode-charts-blue, #3794ff);
    --blocked: var(--vscode-charts-yellow, #cca700);
    --unverified: var(--vscode-charts-orange, #d18616);
    --done: var(--vscode-charts-green, #89d185);
    --failed: var(--vscode-charts-red, #f14c4c);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 14px;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family); font-size: 12.5px;
    display: flex; flex-direction: column; gap: 12px;
  }
  header { display: flex; align-items: baseline; gap: 14px; flex: 0 0 auto; }
  h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  .count { color: var(--muted); font-size: 12px; }
  .count.alert { color: var(--blocked); font-weight: 600; }
  .hint { margin-left: auto; color: var(--muted); font-size: 11px; }

  #grid { flex: 1 1 auto; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .row { flex: 1 1 0; display: flex; gap: 12px; min-height: 0; }

  .card {
    flex: 1 1 0; min-width: 0; min-height: 0;
    display: flex; flex-direction: column;
    border: 1px solid var(--line); border-radius: 10px;
    background: var(--card); overflow: hidden;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .card:hover { border-color: color-mix(in srgb, var(--running) 40%, var(--line)); }
  .card.running { border-color: color-mix(in srgb, var(--running) 45%, var(--line)); }
  .card.waiting_input { border-color: var(--blocked); animation: pulse 1.9s ease-in-out infinite; }
  .card.idle_unverified { border-color: var(--unverified); }
  .card.failed { border-color: var(--failed); }
  .card.complete { border-color: color-mix(in srgb, var(--done) 45%, var(--line)); }

  @keyframes pulse {
    0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--blocked) 45%, transparent); }
    50%     { box-shadow: 0 0 0 6px color-mix(in srgb, var(--blocked) 0%, transparent); }
  }
  body.vscode-reduce-motion .card { animation: none; transition: none; }

  .head {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-bottom: 1px solid var(--line); cursor: pointer;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
  .running .dot { background: var(--running); }
  .waiting_input .dot { background: var(--blocked); }
  .idle_unverified .dot { background: var(--unverified); }
  .complete .dot { background: var(--done); }
  .failed .dot { background: var(--failed); }
  .id { font-weight: 600; font-size: 12px; }
  .role { color: var(--muted); font-size: 10.5px; border: 1px solid var(--line);
          border-radius: 99px; padding: 0 7px; }
  .spend { margin-left: auto; color: var(--muted); font-size: 10.5px; font-family: var(--mono); }

  .body { flex: 1 1 auto; overflow-y: auto; padding: 8px 10px; font-family: var(--mono);
          font-size: 11.5px; line-height: 1.5; min-height: 0; }
  .turn { margin-bottom: 8px; }
  .who { font-weight: 600; font-size: 10.5px; text-transform: lowercase; }
  .who.assistant { color: var(--done); }
  .who.user { color: var(--running); }
  .text { white-space: pre-wrap; word-break: break-word; }
  .reasoning { white-space: pre-wrap; word-break: break-word; color: var(--muted); }
  .tool { color: var(--blocked); }
  .waiting { color: var(--muted); font-style: italic; }

  .foot { flex: 0 0 auto; border-top: 1px solid var(--line); padding: 6px 10px;
          display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .file { background: none; border: 1px solid var(--line); border-radius: 5px;
          color: var(--fg); font-family: var(--mono); font-size: 10.5px;
          padding: 1px 6px; cursor: pointer; max-width: 100%;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file:hover { background: var(--vscode-list-hoverBackground); border-color: var(--running); }
  .file .st { color: var(--unverified); margin-right: 4px; }
  .act { margin-left: auto; display: flex; gap: 4px; }
  .act button { background: none; border: 1px solid var(--line); border-radius: 5px;
                color: var(--muted); font-size: 10.5px; padding: 1px 7px; cursor: pointer; }
  .act button:hover { color: var(--fg); border-color: var(--running); }
  .act button.danger:hover { color: var(--failed); border-color: var(--failed); }

  .empty { color: var(--muted); max-width: 560px; line-height: 1.7; margin: auto; text-align: center; }
  .empty code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>Orchy</h1>
  <span class="count" id="count"></span>
  <span class="hint" id="hint"></span>
</header>
<div id="grid"></div>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const count = document.getElementById('count');
  const hint = document.getElementById('hint');
  let scrollMemory = {};

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function turnHtml(t) {
    const parts = t.parts.map(p => {
      if (p.kind === 'tool') return '<div class="tool">▸ ' + esc(p.text) + '</div>';
      if (p.kind === 'reasoning') return '<div class="reasoning">' + esc(p.text) + '</div>';
      return '<div class="text">' + esc(p.text) + '</div>';
    }).join('');
    if (!parts) return '';
    return '<div class="turn"><div class="who ' + esc(t.role) + '">' + esc(t.role) + '</div>' + parts + '</div>';
  }

  function cardHtml(s) {
    const body = s.transcript.length
      ? s.transcript.map(turnHtml).join('')
      : '<div class="waiting">waiting for the first turn…</div>';

    const files = s.changes.map(c =>
      '<button class="file" data-id="' + esc(s.id) + '" data-file="' + esc(c.path) + '">' +
      '<span class="st">' + esc(c.status) + '</span>' + esc(c.path) + '</button>').join('');

    return '<div class="card ' + esc(s.status) + '" data-id="' + esc(s.id) + '">' +
      '<div class="head" data-focus="' + esc(s.id) + '">' +
        '<span class="dot"></span><span class="id">' + esc(s.id) + '</span>' +
        '<span class="role">' + esc(s.role) + '</span>' +
        (s.spend > 0 ? '<span class="spend">' + s.spend.toFixed(3) + '</span>' : '') +
      '</div>' +
      '<div class="body" id="body-' + esc(s.id) + '">' + body + '</div>' +
      '<div class="foot">' + files +
        '<span class="act">' +
          '<button data-act="verify" data-id="' + esc(s.id) + '">verify</button>' +
          '<button class="danger" data-act="archive" data-id="' + esc(s.id) + '">archive</button>' +
        '</span>' +
      '</div>' +
    '</div>';
  }

  function render(d) {
    for (const el of grid.querySelectorAll('.body')) {
      scrollMemory[el.id] = { top: el.scrollTop, atEnd: el.scrollHeight - el.scrollTop - el.clientHeight < 24 };
    }

    if (!d.sessions.length) {
      count.textContent = '';
      hint.textContent = d.archived ? d.archived + ' archived' : '';
      grid.innerHTML = '<p class="empty">No active agents.<br><br>' +
        'Ask your orchestrator to spawn some, or run <code>Orchy: Spawn Agent Session</code>. ' +
        'Each gets its own git worktree and appears here.</p>';
      return;
    }

    count.textContent = d.blocked > 0 ? d.blocked + ' need attention' : d.sessions.length + ' active';
    count.className = d.blocked > 0 ? 'count alert' : 'count';
    hint.textContent = d.focused ? 'click the header again to show all' : 'click a header to focus';

    const shown = d.focused ? d.sessions.filter(s => s.id === d.focused) : d.sessions;
    const rows = d.focused ? [1] : d.rows;

    let html = '', i = 0;
    for (const width of rows) {
      html += '<div class="row">';
      for (let c = 0; c < width && i < shown.length; c++, i++) html += cardHtml(shown[i]);
      html += '</div>';
    }
    grid.innerHTML = html;

    // Keep panes pinned to the newest output unless the reader scrolled up.
    for (const el of grid.querySelectorAll('.body')) {
      const mem = scrollMemory[el.id];
      el.scrollTop = !mem || mem.atEnd ? el.scrollHeight : mem.top;
    }
  }

  grid.addEventListener('click', e => {
    const file = e.target.closest('.file');
    if (file) { api.postMessage({ type: 'diff', id: file.dataset.id, file: file.dataset.file }); return; }
    const act = e.target.closest('[data-act]');
    if (act) { api.postMessage({ type: act.dataset.act, id: act.dataset.id }); return; }
    const head = e.target.closest('[data-focus]');
    if (head) { api.postMessage({ type: 'focus', id: head.dataset.focus }); }
  });

  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'snapshot') render(e.data.data);
  });

  api.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
