import * as vscode from 'vscode';
import { SessionRegistry } from '../core/sessionRegistry';
import { OrchyEvent, Session } from '../core/types';

interface GraphNode {
  id: string;
  role: string;
  status: string;
  layer: number;
  lane: number;
  merged: boolean;
}

interface GraphEdge {
  from: string;
  to: string;
  kind: 'depends' | 'relay' | 'fork';
  label?: string;
}

/**
 * The pipeline as a picture: who depends on whom, who asked whom what, and what
 * has reached main.
 *
 * Its own tab rather than a strip above the agent panes. A graph squeezed into
 * 54px is decoration; given room it answers questions the session list cannot —
 * why is that agent still queued, what is actually parallel here, which branches
 * have landed.
 */
export class GraphPanel {
  private static current: GraphPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private pending: NodeJS.Timeout | undefined;

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

    const onChanged = (): void => this.schedulePush();
    this.registry.on('changed', onChanged);

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
        if (this.pending) {
          clearTimeout(this.pending);
        }
        for (const d of this.disposables) {
          d.dispose();
        }
        GraphPanel.current = undefined;
      },
      undefined,
      this.disposables
    );
  }

  static show(registry: SessionRegistry): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'orchy.graph',
      'Orchy — Pipeline',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false }
    );
    GraphPanel.current = new GraphPanel(panel, registry);
  }

  private schedulePush(): void {
    if (this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.push();
    }, 250);
  }

  /**
   * Place each session in a layer one past its deepest dependency.
   * That makes the horizontal axis mean something: everything in a column could
   * in principle run at the same time.
   */
  private layout(sessions: Session[]): GraphNode[] {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const layerOf = new Map<string, number>();

    const resolve = (id: string, seen: Set<string>): number => {
      if (layerOf.has(id)) {
        return layerOf.get(id) as number;
      }
      if (seen.has(id)) {
        return 0; // A cycle should not hang the drawing.
      }
      seen.add(id);
      const session = byId.get(id);
      const deps = (session?.dependsOn ?? []).filter((d) => byId.has(d));
      const layer = deps.length === 0 ? 0 : Math.max(...deps.map((d) => resolve(d, seen))) + 1;
      layerOf.set(id, layer);
      return layer;
    };

    const lanes = new Map<number, number>();
    return sessions.map((s) => {
      const layer = resolve(s.id, new Set());
      const lane = lanes.get(layer) ?? 0;
      lanes.set(layer, lane + 1);
      return {
        id: s.id,
        role: s.role,
        status: s.status,
        layer,
        lane,
        merged: false,
      };
    });
  }

  private push(): void {
    if (!this.panel.visible) {
      return;
    }
    const sessions = this.registry.all();
    const nodes = this.layout(sessions);
    const known = new Set(sessions.map((s) => s.id));

    const edges: GraphEdge[] = [];
    for (const session of sessions) {
      for (const dep of session.dependsOn) {
        if (known.has(dep)) {
          edges.push({ from: dep, to: session.id, kind: 'depends' });
        }
      }
    }

    const history = this.registry.history(200);
    const merged = new Set<string>();
    for (const event of history) {
      if (event.type === 'merged') {
        merged.add(event.session);
      }
    }
    for (const node of nodes) {
      node.merged = merged.has(node.id);
    }

    // Relays and forks live in the log rather than on the session, so they come
    // from the event stream.
    for (const event of this.registry.messages(120)) {
      if (known.has(event.session) && known.has(event.to)) {
        edges.push({
          from: event.session,
          to: event.to,
          kind: event.summary === 'forked' ? 'fork' : 'relay',
          label: event.summary === 'forked' ? undefined : event.summary,
        });
      }
    }

    void this.panel.webview.postMessage({
      type: 'snapshot',
      data: {
        nodes,
        edges,
        history: history.slice(0, 40).map((e) => this.describe(e)),
        mergedCount: merged.size,
      },
    });
  }

  private describe(event: OrchyEvent): { time: string; text: string; kind: string } {
    const time = new Date(event.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    switch (event.type) {
      case 'merged':
        return { time, kind: 'merged', text: `${event.session} merged into ${event.into}` };
      case 'spawned':
        return { time, kind: 'spawned', text: `${event.session} spawned` };
      case 'archived':
        return { time, kind: 'archived', text: `${event.session} archived` };
      case 'purged':
        return { time, kind: 'archived', text: `${event.session} deleted` };
      case 'status':
        return { time, kind: event.status, text: `${event.session} ${event.status}` };
      default:
        return { time, kind: 'other', text: `${event.session} ${event.type}` };
    }
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
    --merged: var(--vscode-charts-purple, #b180d7);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 12px; background: var(--bg); color: var(--fg);
         font-family: var(--vscode-font-family); font-size: 12.5px;
         display: flex; gap: 12px; }

  #left { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  h1 { font-size: 13px; margin: 0; font-weight: 600; }
  .sub { color: var(--muted); font-size: 11.5px; }
  .legend { margin-left: auto; display: flex; gap: 10px; color: var(--muted); font-size: 10.5px; }
  .legend i { display: inline-block; width: 14px; height: 0; border-top: 1.5px solid; margin-right: 3px;
              vertical-align: middle; }
  .legend .dep { color: var(--line); border-color: var(--muted); }
  .legend .rel { color: var(--running); border-color: var(--running); }
  .legend .frk { color: var(--merged); border-color: var(--merged); }

  #canvas { flex: 1 1 auto; overflow: auto; border: 1px solid var(--line);
            border-radius: 8px; background: var(--card); min-height: 0; }
  svg { display: block; }
  .edge { fill: none; stroke: var(--muted); stroke-width: 1.3; opacity: .55; }
  .edge.relay { stroke: var(--running); stroke-dasharray: 4 3; }
  .edge.fork { stroke: var(--merged); stroke-dasharray: 2 3; }
  .node rect { fill: var(--bg); stroke: var(--line); stroke-width: 1.4; rx: 7; cursor: pointer; }
  .node:hover rect { stroke: var(--running); }
  .node text.id { font-size: 11px; font-weight: 600; fill: var(--fg); }
  .node text.role { font-size: 9.5px; fill: var(--muted); }
  .node .pip { r: 4; }
  .running .pip { fill: var(--running); }
  .queued .pip { fill: var(--muted); }
  .waiting_input .pip { fill: var(--blocked); }
  .idle_unverified .pip { fill: var(--unverified); }
  .complete .pip { fill: var(--done); }
  .failed .pip { fill: var(--failed); }
  .archived .pip, .detached .pip, .spawning .pip { fill: var(--muted); }
  .node.merged rect { stroke: var(--merged); }
  .layerlabel { font-size: 9.5px; fill: var(--muted); }

  #right { flex: 0 0 300px; display: flex; flex-direction: column; min-height: 0; }
  #right h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
              color: var(--muted); margin: 0 0 6px; font-weight: 600; }
  #history { flex: 1 1 auto; overflow-y: auto; border: 1px solid var(--line);
             border-radius: 8px; background: var(--card); padding: 6px 8px; }
  .h { display: flex; gap: 8px; padding: 3px 0; font-size: 11.5px; align-items: baseline; }
  .h .t { color: var(--muted); font-family: var(--mono); font-size: 10.5px; flex: 0 0 auto; }
  .h .x { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .h.merged .x { color: var(--merged); }
  .h.complete .x { color: var(--done); }
  .h.failed .x { color: var(--failed); }
  .empty { color: var(--muted); margin: auto; text-align: center; line-height: 1.7; max-width: 420px; }
</style>
</head>
<body>
<div id="left">
  <header>
    <h1>Pipeline</h1>
    <span class="sub" id="sub"></span>
    <span class="legend">
      <span class="dep"><i></i>depends</span>
      <span class="rel"><i></i>asked</span>
      <span class="frk"><i></i>forked</span>
    </span>
  </header>
  <div id="canvas"></div>
</div>
<div id="right">
  <h2>History</h2>
  <div id="history"></div>
</div>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const canvas = document.getElementById('canvas');
  const historyEl = document.getElementById('history');
  const sub = document.getElementById('sub');

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const NW = 128, NH = 40, GAPX = 76, GAPY = 22, PADX = 26, PADY = 34;
  const cx = n => PADX + n.layer * (NW + GAPX);
  const cy = n => PADY + n.lane * (NH + GAPY);

  function render(d) {
    if (!d.nodes.length) {
      sub.textContent = '';
      canvas.innerHTML = '<p class="empty">Nothing to draw yet.<br><br>' +
        'Once agents exist, this shows which depend on which, what asked what, ' +
        'and which branches have reached main.</p>';
      historyEl.innerHTML = '';
      return;
    }

    const layers = Math.max(...d.nodes.map(n => n.layer)) + 1;
    const lanes = Math.max(...d.nodes.map(n => n.lane)) + 1;
    const W = PADX * 2 + layers * NW + (layers - 1) * GAPX;
    const H = PADY + lanes * (NH + GAPY) + 10;
    const pos = Object.fromEntries(d.nodes.map(n => [n.id, n]));

    sub.textContent = d.nodes.length + ' agents · ' + layers + ' stage' +
      (layers === 1 ? '' : 's') + ' · ' + d.mergedCount + ' merged';

    let svg = '<svg width="' + W + '" height="' + H + '">';

    for (let l = 0; l < layers; l++) {
      svg += '<text class="layerlabel" x="' + (PADX + l * (NW + GAPX)) + '" y="18">stage ' +
             (l + 1) + '</text>';
    }

    for (const e of d.edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const x1 = cx(a) + NW, y1 = cy(a) + NH / 2;
      const x2 = cx(b), y2 = cy(b) + NH / 2;
      const mid = (x1 + x2) / 2;
      const path = e.kind === 'depends'
        ? 'M' + x1 + ' ' + y1 + ' C' + mid + ' ' + y1 + ',' + mid + ' ' + y2 + ',' + x2 + ' ' + y2
        : 'M' + (cx(a) + NW / 2) + ' ' + cy(a) + ' C' + (cx(a) + NW / 2) + ' ' + (cy(a) - 30) +
          ',' + (cx(b) + NW / 2) + ' ' + (cy(b) - 30) + ',' + (cx(b) + NW / 2) + ' ' + cy(b);
      svg += '<path class="edge ' + esc(e.kind) + '" d="' + path + '"><title>' +
             esc(e.label || e.kind) + '</title></path>';
    }

    for (const n of d.nodes) {
      const x = cx(n), y = cy(n);
      svg += '<g class="node ' + esc(n.status) + (n.merged ? ' merged' : '') +
             '" data-id="' + esc(n.id) + '">' +
        '<rect x="' + x + '" y="' + y + '" width="' + NW + '" height="' + NH + '"/>' +
        '<circle class="pip" cx="' + (x + 13) + '" cy="' + (y + NH / 2) + '"/>' +
        '<text class="id" x="' + (x + 26) + '" y="' + (y + 17) + '">' + esc(n.id) + '</text>' +
        '<text class="role" x="' + (x + 26) + '" y="' + (y + 30) + '">' + esc(n.role) +
        (n.merged ? ' · merged' : '') + '</text>' +
        '<title>' + esc(n.id + ' — ' + n.status) + '</title></g>';
    }

    canvas.innerHTML = svg + '</svg>';

    historyEl.innerHTML = d.history.map(h =>
      '<div class="h ' + esc(h.kind) + '"><span class="t">' + esc(h.time) + '</span>' +
      '<span class="x">' + esc(h.text) + '</span></div>').join('') ||
      '<div class="h"><span class="x">Nothing yet.</span></div>';
  }

  canvas.addEventListener('click', e => {
    const n = e.target.closest('.node');
    if (n) api.postMessage({ type: 'focus', id: n.dataset.id });
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
