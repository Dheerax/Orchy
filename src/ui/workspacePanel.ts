import * as path from 'path';
import * as vscode from 'vscode';
import { AgentBackend, BackendHandle, TranscriptEntry } from '../backends/types';
import { SessionRegistry } from '../core/sessionRegistry';
import { Plan, Session } from '../core/types';
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
  tokens: number;
  /** How long this agent has been alive, in seconds. */
  age: number;
  deliverables: { spec: string; verified: boolean }[];
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
/**
 * Where the panel is drawing.
 *
 * The session manager belongs in the bottom panel next to the terminal — that
 * is where you keep something you glance at while working, rather than a tab
 * competing with your code. VS Code calls that a webview *view*, which is a
 * different object from the webview *panel* an editor tab gets, so the two are
 * flattened to the handful of things this class actually needs.
 */
interface Surface {
  readonly webview: vscode.Webview;
  readonly visible: boolean;
  reveal(): void;
  onDidChangeVisibility(listener: () => void): vscode.Disposable;
  onDidDispose(listener: () => void): vscode.Disposable;
}

function surfaceOfView(view: vscode.WebviewView): Surface {
  return {
    webview: view.webview,
    get visible(): boolean {
      return view.visible;
    },
    reveal: () => view.show(true),
    onDidChangeVisibility: (listener) => view.onDidChangeVisibility(listener),
    onDidDispose: (listener) => view.onDidDispose(listener),
  };
}

function surfaceOfPanel(panel: vscode.WebviewPanel): Surface {
  return {
    webview: panel.webview,
    get visible(): boolean {
      return panel.visible;
    },
    reveal: () => panel.reveal(),
    onDidChangeVisibility: (listener) => panel.onDidChangeViewState(() => listener()),
    onDidDispose: (listener) => panel.onDidDispose(listener),
  };
}

/** Everything the panel needs to build itself, captured once at activation. */
export interface PanelDeps {
  registry: SessionRegistry;
  /** This repository's rules, so the empty panel can show what agents will be told. */
  project: () => { path?: string; rules: string[]; verify?: string; warnings: string[] };
  /** Whether this machine can run anything, cached from the last check. */
  setup: () => { name: string; ok: boolean; detail: string; fix?: string }[];
  worktrees: WorktreeManager;
  backend: AgentBackend;
  handleOf: (id: string) => BackendHandle | undefined;
  onPlanDecision?: (id: string, decision: 'approved' | 'rejected', feedback?: string) => void;
}

export class WorkspacePanel {
  /** Must match the view contributed to the panel container in package.json. */
  static readonly viewId = 'orchy.workspaceView';

  private static current: WorkspacePanel | undefined;
  private static deps: PanelDeps | undefined;
  private ready = 0;
  private pushes = 0;
  private lastPush: string | undefined;
  private disposables: vscode.Disposable[] = [];
  private handles = new Map<string, BackendHandle>();
  private focused: string | undefined;
  private page = 0;
  /**
   * The agent being read in detail.
   *
   * A grid of twelve live transcripts answers "what is everything doing"; it
   * is no help at all with "what did this one actually produce". Clicking a
   * commit in the pipeline graph asks the second question, and the bottom
   * panel is wide enough to answer it beside the list.
   */
  private static inspected: string | undefined;
  /**
   * Static because a plan outlives any one surface: it can arrive before the
   * view has been resolved, survive the panel being closed and reopened, and
   * must be on screen whenever a surface next exists.
   */
  private static activePlan: Plan | undefined;
  private pending: NodeJS.Timeout | undefined;

  private readonly registry: SessionRegistry;
  private readonly project: () => {
    path?: string;
    rules: string[];
    verify?: string;
    warnings: string[];
  };
  private readonly setup: () => { name: string; ok: boolean; detail: string; fix?: string }[];
  private readonly worktrees: WorktreeManager;
  private readonly backend: AgentBackend;
  private readonly handleOf: (id: string) => BackendHandle | undefined;
  private readonly onPlanDecision?: (
    id: string,
    decision: 'approved' | 'rejected',
    feedback?: string
  ) => void;

  private constructor(
    private readonly panel: Surface,
    deps: PanelDeps
  ) {
    this.registry = deps.registry;
    this.project = deps.project;
    this.setup = deps.setup;
    this.worktrees = deps.worktrees;
    this.backend = deps.backend;
    this.handleOf = deps.handleOf;
    this.onPlanDecision = deps.onPlanDecision;

    // A restored panel arrives with whatever options it was created with, but
    // its content is gone: it has to be rebuilt from scratch either way.
    // Command URIs are what makes the fallback below a real surface rather than
    // a picture of one: the plan can be approved without any script running.
    this.panel.webview.options = { enableScripts: true, enableCommandUris: true };
    this.panel.webview.html = this.html(WorkspacePanel.bootHtml(WorkspacePanel.activePlan));

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; id?: string; file?: string }) => void this.onMessage(msg),
      undefined,
      this.disposables
    );

    const onChanged = (): void => this.schedulePush();
    this.registry.on('changed', onChanged);

    this.disposables.push(
      this.panel.onDidChangeVisibility(() => {
        if (this.panel.visible) {
          void this.push();
        }
      })
    );

    this.disposables.push(
      this.panel.onDidDispose(() => {
        this.registry.off('changed', onChanged);
        if (this.pending) {
          clearTimeout(this.pending);
        }
        this.dispose();
        if (WorkspacePanel.current === this) {
          WorkspacePanel.current = undefined;
        }
      })
    );
  }

  /**
   * Hand the panel what it needs and let VS Code give back the tab it restored.
   *
   * VS Code reopens webview tabs when a window reopens, before the extension
   * has activated. An extension that does not claim them leaves the user
   * looking at a tab titled Orchy containing nothing at all — and no way to
   * tell that from a pipeline with nothing in it.
   */
  static bind(deps: PanelDeps): vscode.Disposable[] {
    WorkspacePanel.deps = deps;
    return [
      // The bottom panel is the default home, so this is what normally builds
      // the session manager. VS Code resolves it when the view is first shown.
      vscode.window.registerWebviewViewProvider(
        WorkspacePanel.viewId,
        {
          resolveWebviewView(view: vscode.WebviewView): void {
            WorkspacePanel.current?.dispose();
            WorkspacePanel.current = new WorkspacePanel(surfaceOfView(view), deps);
          },
        },
        // Same reason as the editor panel: a torn-down webview loses the DOM
        // and every scroll position with it.
        { webviewOptions: { retainContextWhenHidden: true } }
      ),

      // Windows reopened from before the session manager moved still restore an
      // Orchy editor tab. Adopt it rather than leave the user staring at a dead
      // one, and let them close it in their own time.
      vscode.window.registerWebviewPanelSerializer('orchy.workspace', {
        deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
          if (WorkspacePanel.current) {
            panel.dispose();
          } else {
            WorkspacePanel.current = new WorkspacePanel(surfaceOfPanel(panel), deps);
          }
          return Promise.resolve();
        },
      }),
    ];
  }

  /** Bring the session manager up wherever the user keeps it. */
  static show(): void {
    if (WorkspacePanel.current) {
      WorkspacePanel.current.panel.reveal();
      void WorkspacePanel.current.push();
      return;
    }
    // Nothing resolved yet: focusing the view is what makes VS Code build it,
    // and the plan waiting in `activePlan` is drawn as soon as it does.
    void vscode.commands.executeCommand(`${WorkspacePanel.viewId}.focus`);
  }

  private dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private static esc(text: string): string {
    return text.replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
    );
  }

  private static cmd(command: string, planId: string): string {
    return `command:${command}?${encodeURIComponent(JSON.stringify([planId]))}`;
  }

  /**
   * The panel as plain HTML, before a single line of script has run.
   *
   * The renderer is JavaScript talking to the extension over postMessage, and
   * when that link is down — a webview that never booted, a snapshot posted
   * into a page that was still loading — the panel showed nothing whatsoever,
   * which is indistinguishable from an empty pipeline. A decision the user is
   * being asked to make must not depend on the scripting layer being healthy,
   * so the plan is written into the document itself and its buttons are command
   * URIs. The script replaces all of this the moment it has real state.
   */
  private static bootHtml(plan: Plan | undefined): string {
    const esc = WorkspacePanel.esc;
    if (!plan) {
      return (
        '<p class="empty" id="boot">Loading the pipeline\u2026<br><br>' +
        '<span class="quiet">If this line stays put, the panel\u2019s script did not start. ' +
        'Reload the window, and tell Orchy \u2014 that is a bug, not an empty pipeline.</span></p>'
      );
    }

    const warns = plan.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
    const rows = plan.agents
      .map((a) => {
        const provides = a.provides.map((p) => p.symbol).join(', ');
        const io = [
          provides ? `<span class="pp">\u2192 ${esc(provides)}</span>` : '',
          a.needs.length ? `<span class="pn">\u2190 ${esc(a.needs.join(', '))}</span>` : '',
          a.deliverables.length
            ? `<span class="pv">${esc(a.deliverables.map((d) => d.spec).join(', '))}</span>`
            : '',
        ].join('');
        return (
          '<div class="prow open">' +
          `<div class="l1"><span class="pr">${esc(a.role)}</span>` +
          (a.model ? `<span class="pm">${esc(a.model)}</span>` : '') +
          '</div>' +
          (io ? `<div class="l2">${io}</div>` : '') +
          `<div class="ptask">${esc(a.task)}</div></div>`
        );
      })
      .join('');

    return (
      '<div id="plan"><h2>' +
      esc(plan.summary) +
      `</h2><div class="sub">${plan.agents.length} agent(s). Nothing runs until you approve.</div>` +
      warns +
      `<div class="ptree">${rows}</div>` +
      '<div class="actions">' +
      `<a class="go" href="${WorkspacePanel.cmd('orchy.approvePlan', plan.id)}">Approve and run</a>` +
      `<a href="${WorkspacePanel.cmd('orchy.revisePlan', plan.id)}">Request changes\u2026</a>` +
      `<a class="no" href="${WorkspacePanel.cmd('orchy.rejectPlan', plan.id)}">Reject</a>` +
      '</div></div>'
    );
  }

  /** What the panel is doing, for when it is doing nothing. */
  static diagnostics(): Record<string, unknown> {
    const panel = WorkspacePanel.current;
    return {
      open: Boolean(panel),
      bound: Boolean(WorkspacePanel.deps),
      visible: panel?.panel.visible ?? false,
      ready_messages: panel?.ready ?? 0,
      snapshots_pushed: panel?.pushes ?? 0,
      last_push: panel?.lastPush,
      plan_on_screen: WorkspacePanel.activePlan?.id,
    };
  }

  static refreshIfOpen(): void {
    WorkspacePanel.current?.schedulePush();
  }

  /** Open the panel on one agent, from wherever the user clicked. */
  static inspect(id: string | undefined): void {
    WorkspacePanel.inspected = id;
    WorkspacePanel.show();
    WorkspacePanel.current?.panel.reveal();
    void WorkspacePanel.current?.push();
  }

  /** Take a decided plan off the screen, script or no script. */
  static clearPlan(id: string): void {
    const panel = WorkspacePanel.current;
    if (!panel || WorkspacePanel.activePlan?.id !== id) {
      return;
    }
    WorkspacePanel.activePlan = undefined;
    panel.panel.webview.html = panel.html(WorkspacePanel.bootHtml(undefined));
    void panel.push();
  }

  /** Put a proposed plan in front of the user before anything runs. */
  static showPlan(plan: Plan): void {
    // Recorded before anything else. Opening the bottom panel takes a round
    // trip through VS Code, so the surface usually does not exist yet at this
    // point — and when it resolves a moment later it builds its document from
    // this, which is what puts the plan on screen. Returning quietly because no
    // panel happened to be open is how a plan gets proposed to nobody.
    WorkspacePanel.activePlan = plan;
    WorkspacePanel.show();
    if (!WorkspacePanel.current) {
      return;
    }
    const panel = WorkspacePanel.current;
    // Rebuilding the document costs a repaint the user will not notice and
    // guarantees the plan is visible even if the script never runs. A plan is
    // rare and it takes over the panel anyway; live sessions keep streaming
    // over postMessage.
    panel.panel.webview.html = panel.html(WorkspacePanel.bootHtml(plan));
    panel.panel.reveal();
    void panel.push();
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

  private get perPage(): number {
    const configured = vscode.workspace
      .getConfiguration('orchy')
      .get<number>('sessionsPerPage', 6);
    return Math.min(Math.max(configured, 1), 12);
  }

  private async onMessage(msg: {
    type: string;
    id?: string;
    file?: string;
    page?: number;
    text?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready++;
        await this.push();
        break;
      case 'focus':
        this.focused = this.focused === msg.id ? undefined : msg.id;
        await this.push();
        break;
      case 'inspect':
        WorkspacePanel.inspected = msg.id;
        await this.push();
        break;
      case 'copy':
        // Through the host rather than the webview: the clipboard API is
        // unavailable in a webview often enough that it cannot be relied on,
        // and silently copying nothing is worse than not offering it.
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          void vscode.window.showInformationMessage(
            'Copied. Paste it to your orchestrator to start this pipeline.'
          );
        }
        break;
      case 'closeInspect':
        WorkspacePanel.inspected = undefined;
        await this.push();
        break;
      case 'page':
        this.page = Math.max(0, msg.page ?? 0);
        this.focused = undefined;
        await this.push();
        break;
      case 'openTab':
      case 'openSide':
        // The live terminal, not the transcript: attaching lets you type at the
        // agent, which is the whole reason to open one rather than read one.
        if (msg.id) {
          await vscode.commands.executeCommand(
            'orchy.openTerminal',
            msg.id,
            msg.type === 'openSide'
          );
        }
        break;
      case 'openTranscript':
        if (msg.id) {
          await vscode.commands.executeCommand('orchy.openTranscript', msg.id, true);
        }
        break;
      case 'approvePlan':
      case 'rejectPlan':
        if (WorkspacePanel.activePlan) {
          this.onPlanDecision?.(
            WorkspacePanel.activePlan.id,
            msg.type === 'approvePlan' ? 'approved' : 'rejected'
          );
          WorkspacePanel.activePlan = undefined;
          await this.push();
        }
        break;
      case 'revisePlan':
        if (WorkspacePanel.activePlan) {
          // Sent back rather than refused: the orchestrator gets to revise
          // instead of guessing what was wrong with the shape it proposed.
          const feedback = await vscode.window.showInputBox({
            title: 'What should change about this plan?',
            prompt:
              'Goes back to the orchestrator, which will revise and propose again. ' +
              'e.g. "run the three validators in parallel" or "use a cheaper model for docs".',
            placeHolder: 'Describe the change you want',
            ignoreFocusOut: true,
          });
          if (feedback && WorkspacePanel.activePlan) {
            this.onPlanDecision?.(WorkspacePanel.activePlan.id, 'rejected', feedback);
            WorkspacePanel.activePlan = undefined;
            await this.push();
          }
        }
        break;
      case 'purge':
        if (msg.id) {
          await vscode.commands.executeCommand('orchy.purge', msg.id);
        }
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
    // Posting to a hidden panel is cheap and harmless; refusing to was not.
    // `retainContextWhenHidden` is off, so a hidden webview is reloaded when it
    // comes back and re-asks for state — but a plan arriving while it was
    // hidden had nowhere to go, and whether the reload or the reveal won the
    // race decided whether the user saw anything at all.
    const hidden = !this.panel.visible;
    const live = this.registry.all().filter((s) => s.status !== 'archived');
    const pages = Math.max(1, Math.ceil(live.length / this.perPage));
    this.page = Math.min(this.page, pages - 1);
    const onPage = live.slice(this.page * this.perPage, this.page * this.perPage + this.perPage);

    const sessions: PanelSession[] = [];
    for (const session of onPage) {
      sessions.push({
        id: session.id,
        name: session.name,
        role: session.role,
        status: session.status,
        branch: session.worktree?.branch,
        detail: this.detail(session),
        spend: session.budget.costEstimate,
        tokens: session.budget.tokensUsed,
        age: Math.max(0, Math.round((Date.now() - Date.parse(session.createdAt)) / 1000)),
        deliverables: session.deliverables.map((d) => ({ spec: d.spec, verified: d.verified })),
        changes: this.changesOf(session),
        transcript: hidden ? [] : await this.transcriptOf(session),
      });
    }

    this.pushes++;
    this.lastPush = new Date().toISOString();
    void this.panel.webview.postMessage({
      type: 'snapshot',
      data: {
        sessions,
        rows: planGrid(sessions.length),
        focused: this.focused,
        inspected: WorkspacePanel.inspected,
        page: this.page,
        pages,
        blocked: this.registry.needingAttention().length,
        archived: this.registry.all().length - live.length,
        plan: WorkspacePanel.activePlan,
        project: this.project(),
        // Only the failures. A working machine should not be told it is working.
        setup: this.setup().filter((c) => !c.ok),
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

  private html(boot = ''): string {
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

    /* Terminal surface, so a pane reads as a terminal rather than a text box. */
    --term-bg: var(--vscode-terminal-background, var(--vscode-panel-background, #0c0c0c));
    --term-fg: var(--vscode-terminal-foreground, var(--fg));
    --term-green: var(--vscode-terminal-ansiGreen, #23d18b);
    --term-cyan: var(--vscode-terminal-ansiCyan, #29b8db);
    --term-yellow: var(--vscode-terminal-ansiYellow, #f5f543);
    --term-dim: var(--vscode-terminal-ansiBrightBlack, #808080);

    /* Set per snapshot: one agent gets a readable pane, twelve get a dense one. */
    --pane-font: 12px;
    --pane-line: 1.5;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 8px;
    background: var(--bg); color: var(--fg);
    font-family: var(--vscode-font-family); font-size: 12.5px;
    display: flex; flex-direction: column; gap: 8px;
  }
  header { display: flex; align-items: baseline; gap: 14px; flex: 0 0 auto; }
  h1 { font-size: 13px; margin: 0; font-weight: 600; letter-spacing: .02em; }
  .count { color: var(--muted); font-size: 12px; }
  .count.alert { color: var(--blocked); font-weight: 600; }
  .hint { color: var(--muted); font-size: 11px; }

  #grid { flex: 1 1 auto; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
  /* Reading one agent: the roster stays on the left so you can move between
     them, and everything known about the chosen one fills the rest. */
  #grid.reading { flex-direction: row; gap: 10px; }
  .roster { flex: 0 0 210px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
            border-right: 1px solid var(--line); padding-right: 8px; }
  .rrow { display: flex; align-items: baseline; gap: 6px; padding: 4px 6px; cursor: pointer;
          border-radius: 5px; border: 1px solid transparent; font-size: 11.5px; }
  .rrow:hover { background: var(--vscode-list-hoverBackground); }
  .rrow.on { border-color: var(--running); background: var(--vscode-list-hoverBackground); }
  .rrow .rdot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
  .rrow .rid { font-family: var(--mono); font-size: 10.5px; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; }
  .rrow .rst { margin-left: auto; font-size: 9.5px; color: var(--muted); flex: 0 0 auto; }

  .reader { flex: 1 1 auto; min-width: 0; overflow-y: auto; display: flex;
            flex-direction: column; gap: 8px; }
  .reader h2 { margin: 0; font-size: 14px; display: flex; align-items: baseline; gap: 8px; }
  .reader .rmeta { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11px;
                   color: var(--muted); }
  .reader .rmeta b { color: var(--fg); font-weight: 500; font-family: var(--mono);
                     font-size: 10.5px; }
  .reader .sect { font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
                  color: var(--muted); margin-top: 2px; }
  .reader .rtask { font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; }
  .reader .rdeliv { display: flex; flex-wrap: wrap; gap: 4px; }
  .reader .rtranscript { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
                         max-height: 40vh; overflow-y: auto; background: var(--card); }
  .reader .close { margin-left: auto; background: none; border: 1px solid var(--line);
                   border-radius: 5px; color: var(--muted); cursor: pointer;
                   font-size: 11px; padding: 2px 9px; }
  .reader .close:hover { color: var(--fg); border-color: var(--running); }
  .row { flex: 1 1 0; display: flex; gap: 6px; min-height: 0; }

  .pager { display: flex; align-items: center; gap: 4px; margin-left: auto; }
  .pager button { background: none; border: 1px solid var(--line); border-radius: 5px;
                  color: var(--muted); font-size: 11px; padding: 1px 7px; cursor: pointer; }
  .pager button:hover:not(:disabled) { color: var(--fg); border-color: var(--running); }
  .pager button:disabled { opacity: .35; cursor: default; }
  .pager .of { color: var(--muted); font-size: 11px; padding: 0 4px; }

  .icons { display: flex; gap: 2px; margin-left: 6px; }
  .icons button { background: none; border: none; color: var(--muted); cursor: pointer;
                  font-size: 12px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
  .icons button:hover { color: var(--fg); background: var(--vscode-list-hoverBackground); }
  .icons button.danger:hover { color: var(--failed); }

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
    padding: 6px 10px; border-bottom: 1px solid var(--line); cursor: pointer;
    background: var(--card);
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

  .body {
    flex: 1 1 auto; overflow-y: auto; min-height: 0;
    padding: 8px 10px;
    background: var(--term-bg); color: var(--term-fg);
    font-family: var(--mono);
    font-size: var(--pane-font); line-height: var(--pane-line);
    font-variant-ligatures: none; tab-size: 2;
  }
  .body::-webkit-scrollbar { width: 10px; }
  .body::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background); border-radius: 5px;
  }
  .turn { margin-bottom: .7em; }
  .who { font-weight: 600; font-size: .88em; text-transform: lowercase; }
  .who::before { content: '❯ '; opacity: .7; }
  .who.assistant { color: var(--term-green); }
  .who.user { color: var(--term-cyan); }
  .who.system { color: var(--term-dim); }
  .text { white-space: pre-wrap; word-break: break-word; }
  .reasoning { white-space: pre-wrap; word-break: break-word; color: var(--term-dim); }
  .tool { color: var(--term-yellow); }
  .waiting { color: var(--term-dim); font-style: italic; }

  /* A live caret: the cheapest possible signal that a pane is not frozen. */
  .caret { display: inline-block; width: .55em; height: 1em; vertical-align: text-bottom;
           background: var(--term-green); animation: blink 1.1s steps(1) infinite; }
  @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  body.vscode-reduce-motion .caret { animation: none; }

  .foot { flex: 0 0 auto; border-top: 1px solid var(--line); padding: 5px 10px;
          background: var(--card);
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

  /* A plan takes over the panel: it is a decision, not a notification. */
  #plan { flex: 1 1 auto; overflow-y: auto; border: 1px solid var(--running);
          border-radius: 10px; background: var(--card); padding: 14px; }
  #plan h2 { margin: 0 0 2px; font-size: 13px; }
  #plan .sub { color: var(--muted); font-size: 11.5px; margin-bottom: 12px; }
  #plan .warn { border-left: 2px solid var(--blocked); background: rgba(204,167,0,.08);
                padding: 6px 10px; margin-bottom: 6px; font-size: 11.5px; }
  #plan .ptree { font-size: 12px; }
  #plan .prow { padding: 5px 8px; cursor: pointer; border-radius: 6px;
                border: 1px solid transparent; }
  #plan .prow:hover { background: var(--vscode-list-hoverBackground); border-color: var(--line); }
  #plan .l1 { display: flex; gap: 8px; align-items: baseline; }
  #plan .l2 { display: flex; gap: 10px; align-items: baseline; margin: 2px 0 0 22px; }
  #plan .tw { color: var(--muted); font-family: var(--mono); flex: 0 0 auto; }
  #plan .pr { font-weight: 600; }
  /* The model is reference, not headline: right-aligned so roles stay scannable. */
  #plan .pm { font-family: var(--mono); font-size: 10px; color: var(--running);
              margin-left: auto; opacity: .85; }
  #plan .pp { font-family: var(--mono); font-size: 10px; color: var(--done); }
  #plan .pn { font-family: var(--mono); font-size: 10px; color: var(--muted); }
  #plan .pv { font-family: var(--mono); font-size: 10px; color: var(--unverified);
              margin-left: auto; opacity: .85; }
  /* The brief is the longest thing here and the least glanceable: one line until asked for. */
  #plan .ptask { color: var(--muted); font-size: 11px; margin: 3px 0 0 22px;
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #plan .prow.open .ptask { white-space: pre-wrap; }
  /* The architecture, drawn. A list of agents is not a shape, and the shape is
     the thing being approved. */
  #plan .arch { position: relative; border: 1px solid var(--line); border-radius: 8px;
                margin-bottom: 10px; background: var(--bg); height: 268px; overflow: hidden; }
  #plan .arch svg { display: block; width: 100%; height: 100%; cursor: grab; }
  #plan .arch svg.dragging { cursor: grabbing; }
  #plan .archctl { position: absolute; top: 6px; right: 6px; display: flex; gap: 3px; z-index: 2; }
  #plan .archctl button { width: 22px; height: 22px; padding: 0; line-height: 1;
                          background: var(--card); border: 1px solid var(--line);
                          border-radius: 5px; color: var(--muted); cursor: pointer;
                          font-size: 12px; }
  #plan .archctl button:hover { color: var(--fg); border-color: var(--running); }
  #plan .arch .stagelabel { font-size: 9.5px; fill: var(--muted); }
  #plan .arch .edge { fill: none; stroke: var(--muted); stroke-width: 1.3; opacity: .6; }
  #plan .arch rect { fill: var(--card); stroke: var(--line); stroke-width: 1.4; rx: 7; }
  #plan .arch .r { font-size: 11px; font-weight: 600; fill: var(--fg); }
  #plan .arch .m { font-size: 9px; fill: var(--running); font-family: var(--mono); }
  #plan .arch .pv2 { font-size: 9px; fill: var(--done); font-family: var(--mono); }
  #plan .arch .nv2 { font-size: 9px; fill: var(--muted); font-family: var(--mono); }
  #plan .arch .par { fill: var(--done); font-size: 9.5px; }

  #plan .actions { display: flex; gap: 8px; margin-top: 12px; }
  #plan .actions button, #plan .actions a {
                          border-radius: 6px; border: 1px solid var(--line); cursor: pointer;
                          font-size: 12px; padding: 5px 14px; background: none; color: var(--fg);
                          text-decoration: none; display: inline-block; }
  #plan .actions .go { border-color: var(--done); color: var(--done); }
  .quiet { color: var(--muted); font-size: 11px; }
  #plan .actions .no:hover { border-color: var(--failed); color: var(--failed); }

  .empty { color: var(--muted); max-width: 640px; line-height: 1.7; margin: auto; }
  .empty p { text-align: center; }
  .shapes { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; text-align: left; }
  .shape { border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px;
           background: var(--card); }
  .shape:hover { border-color: var(--running); }
  .sname { display: flex; align-items: baseline; gap: 9px; font-weight: 600; color: var(--fg);
           font-size: 12.5px; }
  .scount { font-family: var(--mono); font-size: 10px; color: var(--muted); font-weight: 400; }
  .scopy { margin-left: auto; background: none; border: 1px solid var(--line);
           border-radius: 5px; color: var(--muted); cursor: pointer; font-size: 10.5px;
           padding: 2px 8px; }
  .scopy:hover { color: var(--running); border-color: var(--running); }
  .swhen { font-size: 11px; margin-top: 3px; line-height: 1.5; }
  .rules { margin: 5px 0 0; padding-left: 18px; font-size: 11.5px; line-height: 1.6; }
  .shape code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px;
                border-radius: 3px; font-family: var(--mono); font-size: 10.5px; }
  .broke { border: 1px solid var(--failed); border-left-width: 3px; border-radius: 8px;
           padding: 8px 11px; background: color-mix(in srgb, var(--failed) 7%, var(--card)); }
  .bname { font-weight: 600; color: var(--fg); font-size: 12.5px; }
  .bfix { font-size: 11px; margin-top: 3px; line-height: 1.5; }
  .empty code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <h1>Orchy</h1>
  <span class="count" id="count"></span>
  <span class="hint" id="hint"></span>
  <span class="pager" id="pager"></span>
</header>
<div id="grid">${boot}</div>
<script nonce="${nonce}">
  const api = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const count = document.getElementById('count');
  const hint = document.getElementById('hint');
  const pager = document.getElementById('pager');
  let scrollMemory = {};

  // The handshake, first thing and before any other wiring.
  //
  // A snapshot posted while this document was still loading is dropped by the
  // webview, and the old code asked for state exactly once — at the very bottom
  // of the script, where any exception above it meant the panel sat empty
  // forever with no way back. Ask immediately, and keep asking until something
  // arrives.
  let gotSnapshot = false;
  let asks = 0;
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'snapshot') {
      gotSnapshot = true;
      render(e.data.data);
    }
  });
  function ask() {
    if (gotSnapshot || asks++ > 6) return;
    api.postMessage({ type: 'ready' });
    setTimeout(ask, 500);
  }
  ask();

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
    const working = s.status === 'running' || s.status === 'spawning';
    const caret = working ? '<span class="caret"></span>' : '';
    // A turn with no renderable parts produces '', so a transcript can be
    // non-empty and still render to nothing. Decide the empty state on what
    // actually came out, not on the array length — otherwise a queued agent
    // shows a blank void that is indistinguishable from a broken one.
    const turns = s.transcript.map(turnHtml).join('');
    const body = turns
      ? turns + caret
      : '<div class="waiting">waiting for the first turn…' + caret + '</div>';

    const files = s.changes.map(c =>
      '<button class="file" data-id="' + esc(s.id) + '" data-file="' + esc(c.path) + '">' +
      '<span class="st">' + esc(c.status) + '</span>' + esc(c.path) + '</button>').join('');

    return '<div class="card ' + esc(s.status) + '" data-id="' + esc(s.id) + '">' +
      '<div class="head" data-focus="' + esc(s.id) + '">' +
        '<span class="dot"></span><span class="id">' + esc(s.id) + '</span>' +
        '<span class="role">' + esc(s.role) + '</span>' +
        (s.tokens > 0 ? '<span class="spend">' + compact(s.tokens) + ' tok</span>' : '') +
        (s.spend > 0 ? '<span class="spend">$' + s.spend.toFixed(3) + '</span>' : '') +
        '<span class="icons">' +
          '<button data-act="openTab" data-id="' + esc(s.id) + '" title="Open a live terminal for this agent">&#10697;</button>' +
          '<button data-act="openSide" data-id="' + esc(s.id) + '" title="Open a live terminal to the side">&#8677;</button>' +
          '<button data-act="openTranscript" data-id="' + esc(s.id) + '" title="Open the transcript as a document">&#128196;</button>' +
          '<button class="danger" data-act="purge" data-id="' + esc(s.id) + '" title="Delete this session">&#10005;</button>' +
        '</span>' +
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

  // Type scales with how many panes share the space: one agent should be
  // comfortably readable, twelve should still fit something worth reading.
  function scaleType(n) {
    const font = n <= 1 ? 14 : n === 2 ? 13 : n <= 4 ? 12.5 : n <= 6 ? 12 : n <= 9 ? 11 : 10.2;
    const line = n <= 2 ? 1.6 : n <= 6 ? 1.5 : 1.42;
    document.body.style.setProperty('--pane-font', font + 'px');
    document.body.style.setProperty('--pane-line', String(line));
  }

  function renderPager(d) {
    if (d.pages <= 1) { pager.innerHTML = ''; return; }
    pager.innerHTML =
      '<button data-page="' + (d.page - 1) + '"' + (d.page === 0 ? ' disabled' : '') + '>&lsaquo;</button>' +
      '<span class="of">' + (d.page + 1) + ' / ' + d.pages + '</span>' +
      '<button data-page="' + (d.page + 1) + '"' + (d.page >= d.pages - 1 ? ' disabled' : '') + '>&rsaquo;</button>';
  }

  // Lay agents out by dependency depth, so a column is a stage: everything in
  // one could run at the same time. That makes the width of the widest stage —
  // the actual parallelism being bought — visible at a glance.
  function planLayers(agents) {
    const layer = [];
    const depth = (i, seen) => {
      if (layer[i] !== undefined) return layer[i];
      if (seen.has(i)) return 0;
      seen.add(i);
      const deps = (agents[i].dependsOn || []).filter(d => agents[d]);
      layer[i] = deps.length ? Math.max(...deps.map(d => depth(d, seen))) + 1 : 0;
      return layer[i];
    };
    agents.forEach((_, i) => depth(i, new Set()));
    const lanes = {};
    const lane = agents.map((_, i) => {
      const l = layer[i];
      lanes[l] = (lanes[l] || 0);
      return lanes[l]++;
    });
    return { layer, lane, lanes };
  }

  // SVG text neither wraps nor ellipsizes, so anything too wide simply runs out
  // of its box and over its neighbours. Trim to what the box can hold.
  function fit(text, px, perChar) {
    const max = Math.floor(px / perChar);
    return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '\u2026';
  }

  function archSvg(agents) {
    const { layer, lane, lanes } = planLayers(agents);
    const stages = Math.max(...layer) + 1;
    // One stage means no ordering to show, and a single row of boxes says nothing
    // the tree below does not.
    if (stages < 2) {
      return '';
    }

    const NW = 176, NH = 62, GX = 58, GY = 14, PX = 12, PY = 26, INNER = NW - 20;
    const widest = Math.max(...Object.values(lanes));
    const W = PX * 2 + stages * NW + (stages - 1) * GX;
    const H = PY + widest * (NH + GY) + 8;
    const x = i => PX + layer[i] * (NW + GX);
    const y = i => PY + lane[i] * (NH + GY);

    let g = '';
    for (let l = 0; l < stages; l++) {
      const n = lanes[l] || 0;
      g += '<text class="stagelabel" x="' + (PX + l * (NW + GX)) + '" y="14">stage ' + (l + 1) +
        (n > 1 ? '</text><tspan class="par"> \u00b7 ' + n + ' in parallel</tspan>' : '</text>');
    }
    agents.forEach((a, i) => {
      for (const d of a.dependsOn || []) {
        if (!agents[d]) continue;
        const x1 = x(d) + NW, y1 = y(d) + NH / 2, x2 = x(i), y2 = y(i) + NH / 2;
        const mid = (x1 + x2) / 2;
        g += '<path class="edge" d="M' + x1 + ' ' + y1 + ' C' + mid + ' ' + y1 + ',' +
             mid + ' ' + y2 + ',' + x2 + ' ' + y2 + '"/>';
      }
    });
    agents.forEach((a, i) => {
      const provides = a.provides.map(v => v.symbol).join(', ');
      const needs = a.needs.join(', ');
      g += '<g><rect x="' + x(i) + '" y="' + y(i) + '" width="' + NW + '" height="' + NH + '"/>' +
        '<text class="r" x="' + (x(i) + 10) + '" y="' + (y(i) + 16) + '">' +
          esc(fit(a.role, INNER, 6.6)) + '</text>' +
        '<text class="m" x="' + (x(i) + 10) + '" y="' + (y(i) + 29) + '">' +
          esc(fit(a.model || 'default model', INNER, 5.2)) + '</text>' +
        (provides ? '<text class="pv2" x="' + (x(i) + 10) + '" y="' + (y(i) + 42) + '">' +
          esc(fit('\u2192 ' + provides, INNER, 5.2)) + '</text>' : '') +
        (needs ? '<text class="nv2" x="' + (x(i) + 10) + '" y="' + (y(i) + 54) + '">' +
          esc(fit('\u2190 ' + needs, INNER, 5.2)) + '</text>' : '') +
        '<title>' + esc(a.role + (a.model ? ' \u00b7 ' + a.model : '') +
          // Escaped twice on purpose. This whole script is a TypeScript template
          // literal, so a single-backslash newline escape is turned into a real
          // line break at build time — and inside a single-quoted JavaScript
          // string that is a syntax error, which stops the entire panel from
          // running. Even this comment cannot spell it out unescaped.
          (provides ? '\\nprovides ' + provides : '') +
          (needs ? '\\nneeds ' + needs : '')) + '</title></g>';
    });

    // A long pipeline will not fit whatever height we pick, so the viewport is
    // fixed and the content moves instead: wheel to zoom, drag to pan,
    // double-click to reset.
    return '<div class="arch">' +
      '<div class="archctl">' +
        '<button data-zoom="out" title="Zoom out">\u2212</button>' +
        '<button data-zoom="in" title="Zoom in">+</button>' +
        '<button data-zoom="fit" title="Reset">\u2922</button>' +
      '</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
      '<g class="pan">' + g + '</g></svg></div>';
  }

  function planHtml(p) {
    const warns = p.warnings.map(w => '<div class="warn">' + esc(w) + '</div>').join('');
    const { layer } = planLayers(p.agents);
    const order = p.agents.map((_, i) => i).sort((a, b) => layer[a] - layer[b] || a - b);

    // A compact tree rather than a wall of prose. The task is the longest thing
    // on any agent and the least useful at a glance, so it is one line until
    // asked for; the structure and the interface are what the shape is judged on.
    const rows = order.map(i => {
      const a = p.agents[i];
      const stage = layer[i];
      const last = order.filter(j => layer[j] === stage).pop() === i;
      const branch = stage === 0 ? '' : (last ? '\u2514\u2500 ' : '\u251c\u2500 ');
      const provides = a.provides.map(v => v.symbol).join(', ');
      const needs = a.needs.join(', ');
      const verifies = a.deliverables.map(d => d.spec).join(', ');
      const io = (provides ? '<span class="pp">\u2192 ' + esc(provides) + '</span>' : '') +
                 (needs ? '<span class="pn">\u2190 ' + esc(needs) + '</span>' : '');
      return '<div class="prow" data-row="' + i + '" style="margin-left:' + (stage * 16) + 'px">' +
        '<div class="l1"><span class="tw">' + branch + '</span>' +
          '<span class="pr">' + esc(a.role) + '</span>' +
          (a.model ? '<span class="pm">' + esc(a.model) + '</span>' : '') + '</div>' +
        (io || verifies
          ? '<div class="l2">' + io +
            (verifies ? '<span class="pv">' + esc(verifies) + '</span>' : '') + '</div>'
          : '') +
        '<div class="ptask">' + esc(a.task) + '</div>' +
      '</div>';
    }).join('');

    return '<div id="plan"><h2>' + esc(p.summary) + '</h2>' +
      '<div class="sub">' + p.agents.length +
      ' agent(s). Nothing runs until you approve. Click an agent for its full brief.</div>' +
      archSvg(p.agents) + warns +
      '<div class="ptree">' + rows + '</div>' +
      '<div class="actions">' +
        '<button class="go" data-plan="approvePlan">Approve and run</button>' +
        '<button data-plan="revisePlan">Request changes&hellip;</button>' +
        '<button class="no" data-plan="rejectPlan">Reject</button>' +
      '</div></div>';
  }

  function render(d) {
    // A thrown error used to leave the panel empty and indistinguishable from
    // "nothing is running", which is the worst thing a status surface can do.
    try {
      paint(d);
    } catch (err) {
      grid.innerHTML = '<p class="empty">Orchy could not draw this view.<br><br><code>' +
        esc((err && err.message) || String(err)) + '</code></p>';
    }
  }

  /* One agent, in full: what it was asked for, what it owes, what it changed
     and what it has been saying — beside a roster to move between them. */
  function readerHtml(d, chosen) {
    const roster = d.sessions.map(s =>
      '<div class="rrow ' + (s.id === chosen.id ? 'on' : '') + '" data-inspect="' + esc(s.id) + '">' +
        '<span class="rdot" style="background:' + statusColor(s.status) + '"></span>' +
        '<span class="rid">' + esc(s.id) + '</span>' +
        '<span class="rst">' + esc(s.status.replace('_', ' ')) + '</span>' +
      '</div>').join('');

    const deliv = chosen.deliverables && chosen.deliverables.length
      ? chosen.deliverables.map(x =>
          '<span class="pv" style="opacity:1">' + (x.verified ? '\u2713 ' : '\u26a0 ') +
          esc(x.spec) + '</span>').join('')
      : '<span class="quiet">none declared, so it can never verify complete</span>';

    const files = chosen.changes.length
      ? chosen.changes.map(c =>
          '<button class="file" data-id="' + esc(chosen.id) + '" data-file="' + esc(c.path) + '">' +
          '<span class="st">' + esc(c.status) + '</span>' + esc(c.path) + '</button>').join('')
      : '<span class="quiet">nothing changed yet</span>';

    const turns = chosen.transcript.map(turnHtml).join('');

    return '<div class="roster">' + roster + '</div>' +
      '<div class="reader">' +
        '<h2>' + esc(chosen.role) + '<span class="pm">' + esc(chosen.id) + '</span>' +
          '<button class="close" data-close="1">Back to the grid</button></h2>' +
        '<div class="rmeta">' +
          '<span>status <b>' + esc(chosen.status.replace('_', ' ')) + '</b></span>' +
          (chosen.branch ? '<span>branch <b>' + esc(chosen.branch) + '</b></span>' : '') +
          (chosen.spend > 0 ? '<span>spend <b>$' + chosen.spend.toFixed(3) + '</b></span>' : '') +
          (chosen.tokens > 0 ? '<span>tokens <b>' + compact(chosen.tokens) + '</b></span>' : '') +
          '<span>alive <b>' + duration(chosen.age) + '</b></span>' +
          (chosen.detail ? '<span>' + esc(chosen.detail) + '</span>' : '') +
        '</div>' +
        '<div class="sect">Brief</div><div class="rtask">' + esc(chosen.name || '') + '</div>' +
        '<div class="sect">Deliverables</div><div class="rdeliv">' + deliv + '</div>' +
        '<div class="sect">Changed files</div><div class="foot">' + files + '</div>' +
        '<div class="sect">Transcript</div>' +
        '<div class="rtranscript body" id="body-' + esc(chosen.id) + '">' +
          (turns || '<div class="waiting">waiting for the first turn\u2026</div>') +
        '</div>' +
        '<div class="foot"><span class="act">' +
          '<button data-act="openTab" data-id="' + esc(chosen.id) + '">Open terminal</button>' +
          '<button data-act="verify" data-id="' + esc(chosen.id) + '">verify</button>' +
          '<button class="danger" data-act="archive" data-id="' + esc(chosen.id) + '">archive</button>' +
        '</span></div>' +
      '</div>';
  }

  /* Token counts are read at a glance or not at all: 128k, not 128,431. */
  function compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  function duration(seconds) {
    if (seconds < 90) return seconds + 's';
    if (seconds < 5400) return Math.round(seconds / 60) + 'm';
    return (seconds / 3600).toFixed(1) + 'h';
  }

  /*
   * What to do when nothing is running.
   *
   * "No active agents" is true and useless. The hard part of using this tool is
   * not spawning an agent, it is deciding what shape the work should take — so
   * the empty panel offers the shapes, and hands over an instruction that can
   * be pasted straight to an orchestrator rather than describing one.
   */
  /*
   * What to say when nothing is running.
   *
   * Only two things belong here: anything that would stop a pipeline from
   * working, and what to do next. An earlier version offered to create the
   * project's config file from this panel, which was a settings dialogue
   * wearing an empty state — the config is a file, edited like a file, and
   * putting a button for it in front of someone who has not started anything
   * yet answers a question they have not asked.
   */
  function emptyHtml(d) {
    const trouble = [
      ...(d.setup || []).map(c => ({ name: c.name, text: c.fix || c.detail })),
      ...(((d.project || {}).warnings) || []).map(w => ({ name: 'Project config', text: w })),
    ];

    const broken = trouble.map(t =>
      '<div class="broke">' +
        '<div class="bname">' + esc(t.name) + '</div>' +
        '<div class="bfix">' + esc(t.text) + '</div>' +
      '</div>').join('');

    return '<div class="empty">' +
      (broken ? '<div class="shapes">' + broken + '</div>' : '') +
      '<p>' +
      (broken
        ? 'Agents cannot run until those are fixed.'
        : 'Nothing is running. Describe the work to your orchestrator and it will ' +
          'propose a pipeline for you to approve. Each agent gets its own git ' +
          'worktree and appears here.') +
      '</p></div>';
  }

  function statusColor(status) {
    if (status === 'complete') return 'var(--done)';
    if (status === 'failed') return 'var(--failed)';
    if (status === 'running' || status === 'spawning') return 'var(--running)';
    if (status === 'queued') return 'var(--muted)';
    return 'var(--unverified)';
  }

  function paint(d) {
    renderPager(d);

    if (d.plan) {
      count.textContent = 'plan awaiting your approval';
      count.className = 'count alert';
      hint.textContent = '';
      grid.innerHTML = planHtml(d.plan);
      return;
    }
    for (const el of grid.querySelectorAll('.body')) {
      scrollMemory[el.id] = { top: el.scrollTop, atEnd: el.scrollHeight - el.scrollTop - el.clientHeight < 24 };
    }

    const chosen = d.inspected && d.sessions.find(s => s.id === d.inspected);
    if (chosen) {
      count.textContent = 'reading ' + chosen.id;
      count.className = 'count';
      hint.textContent = d.sessions.length + ' agent(s) in this run';
      grid.className = 'reading';
      grid.innerHTML = readerHtml(d, chosen);
      const body = grid.querySelector('.rtranscript');
      if (body) body.scrollTop = body.scrollHeight;
      return;
    }
    grid.className = '';

    if (!d.sessions.length) {
      count.textContent = '';
      hint.textContent = d.archived ? d.archived + ' archived' : '';
      grid.innerHTML = emptyHtml(d);
      return;
    }

    count.textContent = d.blocked > 0 ? d.blocked + ' need attention' : d.sessions.length + ' active';
    count.className = d.blocked > 0 ? 'count alert' : 'count';
    hint.textContent = d.focused ? 'click the header again to show all' : 'click a header to focus';

    const shown = d.focused ? d.sessions.filter(s => s.id === d.focused) : d.sessions;
    const rows = d.focused ? [1] : d.rows;
    scaleType(shown.length);

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
    const zoom = e.target.closest('[data-zoom]');
    if (zoom) {
      if (zoom.dataset.zoom === 'fit') { view = { k: 1, x: 0, y: 0 }; applyView(); }
      else { zoomBy(zoom.dataset.zoom === 'in' ? 1.25 : 1 / 1.25); }
      return;
    }
    const plan = e.target.closest('[data-plan]');
    if (plan) { api.postMessage({ type: plan.dataset.plan }); return; }
    const pick = e.target.closest('[data-inspect]');
    if (pick) { api.postMessage({ type: 'inspect', id: pick.dataset.inspect }); return; }
    if (e.target.closest('[data-close]')) { api.postMessage({ type: 'closeInspect' }); return; }
    const prow = e.target.closest('[data-row]');
    if (prow) { prow.classList.toggle('open'); return; }
    const file = e.target.closest('.file');
    if (file) { api.postMessage({ type: 'diff', id: file.dataset.id, file: file.dataset.file }); return; }
    const act = e.target.closest('[data-act]');
    if (act) { api.postMessage({ type: act.dataset.act, id: act.dataset.id }); return; }
    const head = e.target.closest('[data-focus]');
    if (head) { api.postMessage({ type: 'focus', id: head.dataset.focus }); }
  });

  pager.addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (b && !b.disabled) api.postMessage({ type: 'page', page: Number(b.dataset.page) });
  });

  // Pan and zoom for the architecture view. Re-derived from the DOM each time,
  // since the plan is re-rendered wholesale on every snapshot.
  let view = { k: 1, x: 0, y: 0 };
  function applyView() {
    const g = grid.querySelector('.arch .pan');
    if (g) {
      g.setAttribute('transform',
        'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
    }
  }
  function zoomBy(factor) {
    view.k = Math.min(4, Math.max(0.3, view.k * factor));
    applyView();
  }

  grid.addEventListener('wheel', e => {
    if (!e.target.closest('.arch')) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  grid.addEventListener('mousedown', e => {
    const svg = e.target.closest('.arch svg');
    if (!svg || e.button !== 0) return;
    const start = { x: e.clientX - view.x, y: e.clientY - view.y };
    svg.classList.add('dragging');
    const move = ev => {
      view.x = ev.clientX - start.x;
      view.y = ev.clientY - start.y;
      applyView();
    };
    const up = () => {
      svg.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  grid.addEventListener('dblclick', e => {
    if (e.target.closest('.arch')) { view = { k: 1, x: 0, y: 0 }; applyView(); }
  });

</script>
</body>
</html>`;
  }
}
