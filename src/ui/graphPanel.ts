import * as vscode from 'vscode';
import { SessionRegistry } from '../core/sessionRegistry';
import { OrchyEvent, Session } from '../core/types';

interface GraphNode {
  id: string;
  label: string;
  role: string;
  status: string;
  detail: string;
}

interface GraphSnapshot {
  nodes: GraphNode[];
  edges: { from: string; to: string; summary: string }[];
  blocked: number;
}

/**
 * The topology view: one webview showing every session as a node.
 *
 * One panel rather than one-per-session, because separate webviews are separate
 * sandboxed iframes with no shared drawing surface — an edge between two agents
 * can only be drawn if they live in the same document. This is also the only
 * surface where a "glow" is possible at all; terminals cannot be styled.
 *
 * The webview holds no state. It is destroyed whenever VS Code backgrounds it
 * and asks for a fresh snapshot when shown again.
 */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private recentMessages: { from: string; to: string; summary: string }[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly registry: SessionRegistry
  ) {
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; id?: string }) => {
        if (msg.type === 'ready') {
          this.push();
        } else if (msg.type === 'focus' && msg.id) {
          void vscode.commands.executeCommand('orchy.focusSession', msg.id);
        }
      },
      undefined,
      this.disposables
    );

    // Repaint on any state change, and on re-show after being backgrounded.
    const onChanged = (): void => this.push();
    this.registry.on('changed', onChanged);
    this.registry.on('event', this.onEvent);

    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          this.push();
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        this.registry.off('changed', onChanged);
        this.registry.off('event', this.onEvent);
        for (const d of this.disposables) {
          d.dispose();
        }
        GraphPanel.current = undefined;
      },
      undefined,
      this.disposables
    );
  }

  private onEvent = (event: OrchyEvent): void => {
    if (event.type === 'message') {
      this.recentMessages.push({
        from: event.session,
        to: event.to,
        summary: event.summary,
      });
      this.recentMessages = this.recentMessages.slice(-25);
    }
  };

  static show(registry: SessionRegistry): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'orchy.graph',
      'Orchy — Topology',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    GraphPanel.current = new GraphPanel(panel, registry);
  }

  static refreshIfOpen(): void {
    GraphPanel.current?.push();
  }

  private snapshot(): GraphSnapshot {
    const sessions = this.registry.all().filter((s) => s.status !== 'archived');
    return {
      nodes: sessions.map((s) => ({
        id: s.id,
        label: s.name,
        role: s.role,
        status: s.status,
        detail: this.detail(s),
      })),
      edges: this.recentMessages.filter(
        (m) => sessions.some((s) => s.id === m.from) && sessions.some((s) => s.id === m.to)
      ),
      blocked: this.registry.needingAttention().length,
    };
  }

  private detail(session: Session): string {
    if (session.status === 'idle_unverified') {
      const missing = session.deliverables.filter((d) => !d.verified);
      return missing.length > 0
        ? `missing: ${missing.map((d) => d.spec).join(', ')}`
        : 'unverified';
    }
    if (session.lastError) {
      return session.lastError.slice(0, 120);
    }
    return session.task.slice(0, 90);
  }

  private push(): void {
    if (!this.panel.visible) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'snapshot', data: this.snapshot() });
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
    --line: var(--vscode-panel-border, rgba(128,128,128,.35));
    --running: var(--vscode-charts-blue, #3794ff);
    --blocked: var(--vscode-charts-yellow, #cca700);
    --unverified: var(--vscode-charts-orange, #d18616);
    --done: var(--vscode-charts-green, #89d185);
    --failed: var(--vscode-charts-red, #f14c4c);
    --idle: var(--muted);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family); font-size: 13px;
  }
  header { display:flex; align-items:baseline; gap:12px; margin-bottom:18px; }
  h1 { font-size: 14px; font-weight: 600; margin: 0; }
  .count { color: var(--muted); }
  .count.alert { color: var(--blocked); font-weight: 600; }
  .grid { display:flex; flex-wrap:wrap; gap:16px; }
  .node {
    position: relative; width: 260px; padding: 14px;
    border: 1px solid var(--line); border-radius: 10px;
    background: var(--vscode-editorWidget-background, transparent);
    cursor: pointer; transition: transform .12s ease, border-color .12s ease;
  }
  .node:hover { transform: translateY(-2px); }
  .node:focus-visible { outline: 2px solid var(--running); outline-offset: 2px; }
  .node .top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; background: var(--idle); }
  .id { font-weight:600; }
  .role { color: var(--muted); font-size: 11px; margin-left:auto;
          border:1px solid var(--line); border-radius:99px; padding:1px 8px; }
  .label { margin-bottom:6px; }
  .detail { color: var(--muted); font-size:11.5px; line-height:1.45; word-break:break-word; }
  .status { margin-top:10px; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); }

  .running  { border-color: color-mix(in srgb, var(--running) 55%, var(--line)); }
  .running  .dot { background: var(--running); }
  .waiting_input   { border-color: var(--blocked); }
  .waiting_input   .dot { background: var(--blocked); }
  .idle_unverified { border-color: var(--unverified); }
  .idle_unverified .dot { background: var(--unverified); }
  .complete .dot { background: var(--done); }
  .failed { border-color: var(--failed); }
  .failed .dot { background: var(--failed); }

  /* The blocked node is the only thing on screen that moves. That is the point:
     past a few agents, the bottleneck is noticing which one needs you. */
  @keyframes pulse {
    0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--blocked) 55%, transparent); }
    50%     { box-shadow: 0 0 0 7px color-mix(in srgb, var(--blocked) 0%, transparent); }
  }
  .waiting_input { animation: pulse 1.9s ease-in-out infinite; }
  body.vscode-reduce-motion .waiting_input,
  body.vscode-reduce-motion .node { animation: none; transition: none; }

  .edges { margin-top:22px; border-top:1px solid var(--line); padding-top:14px; }
  .edges h2 { font-size:11px; text-transform:uppercase; letter-spacing:.05em;
              color:var(--muted); margin:0 0 8px; font-weight:600; }
  .edge { color:var(--muted); font-size:12px; padding:3px 0; }
  .edge b { color: var(--fg); font-weight:600; }
  .empty { color:var(--muted); max-width:520px; line-height:1.6; }
  .empty code { background: var(--vscode-textCodeBlock-background); padding:1px 5px; border-radius:3px; }
</style>
</head>
<body>
<header>
  <h1>Pipeline</h1>
  <span class="count" id="count"></span>
</header>
<div id="root"></div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const root = document.getElementById('root');
  const count = document.getElementById('count');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function render(data) {
    if (!data.nodes.length) {
      count.textContent = '';
      root.innerHTML = '<p class="empty">No sessions yet. Ask your orchestrator to spawn one, ' +
        'or run <code>Orchy: Spawn Agent Session</code> from the command palette. ' +
        'Each session gets its own git worktree and shows up here as a node.</p>';
      return;
    }
    count.textContent = data.blocked > 0
      ? data.blocked + ' need attention'
      : data.nodes.length + ' active';
    count.className = data.blocked > 0 ? 'count alert' : 'count';

    const nodes = data.nodes.map(n =>
      '<div class="node ' + esc(n.status) + '" tabindex="0" data-id="' + esc(n.id) + '">' +
        '<div class="top"><span class="dot"></span>' +
          '<span class="id">' + esc(n.id) + '</span>' +
          '<span class="role">' + esc(n.role) + '</span></div>' +
        '<div class="label">' + esc(n.label) + '</div>' +
        '<div class="detail">' + esc(n.detail) + '</div>' +
        '<div class="status">' + esc(n.status.replace('_', ' ')) + '</div>' +
      '</div>').join('');

    const edges = data.edges.length
      ? '<div class="edges"><h2>Recent messages</h2>' + data.edges.map(e =>
          '<div class="edge"><b>' + esc(e.from) + '</b> → <b>' + esc(e.to) + '</b> — ' +
          esc(e.summary) + '</div>').join('') + '</div>'
      : '';

    root.innerHTML = '<div class="grid">' + nodes + '</div>' + edges;

    for (const el of root.querySelectorAll('.node')) {
      const focus = () => vscodeApi.postMessage({ type: 'focus', id: el.dataset.id });
      el.addEventListener('click', focus);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focus(); } });
    }
  }

  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'snapshot') { render(e.data.data); }
  });

  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
