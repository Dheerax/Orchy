import * as path from 'path';
import * as vscode from 'vscode';
import { OpenCodeBackend } from './backends/opencodeBackend';
import { DeliverableVerifier } from './core/deliverableVerifier';
import { Check, checkSetup, summarise } from './core/doctor';
import { EventLog } from './core/eventLog';
import { Orchestrator } from './core/orchestrator';
import { CONFIG_FILE, ensureProjectConfig } from './core/projectConfig';
import { Planner } from './core/planner';
import { SessionRegistry } from './core/sessionRegistry';
import { OrchyEvent, Session } from './core/types';
import {
  WorktreeDirtyError,
  WorktreeLockedError,
  WorktreeManager,
} from './core/worktreeManager';
import { DaemonServer } from './daemon/server';
import { TranscriptDocumentProvider, TRANSCRIPT_SCHEME } from './ui/transcriptDocument';
import { GraphPanel } from './ui/graphPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return; // Orchy is worktree-based; nothing to orchestrate without a workspace.
  }
  const root = folder.uri.fsPath;
  const orchyDir = path.join(root, '.orchy');

  const config = vscode.workspace.getConfiguration('orchy');
  const worktrees = new WorktreeManager(root);
  const registry = new SessionRegistry(new EventLog(orchyDir));
  const backend = new OpenCodeBackend(undefined, { mini: true });
  const planner = new Planner(orchyDir);
  const orchestrator = new Orchestrator(
    registry,
    worktrees,
    backend,
    new DeliverableVerifier(),
    {
      baseBranch: config.get<string>('baseBranch', 'main'),
      autoMerge: config.get<boolean>('autoMerge', false),
      // Declared in package.json since the beginning and never actually read,
      // so the cap could not fire however high the spend went.
      globalBudgetCap: config.get<number>('globalBudgetCap', 0),
    },
    planner
  );
  // Before anything reads state: this window owns no terminals and no backend
  // handles, whatever the log says a previous window was doing.
  registry.reconcileForFreshWindow();

  /*
   * Off by default: normally an agent runs headless and a terminal is
   * something you deliberately attach, per the design note above — an
   * extension rearranging the editor the moment it has something to say is
   * hostile. This exists for recording a run, where watching each agent's
   * terminal appear live is the point.
   *
   * The listener is always on; the setting is read fresh on every event
   * rather than captured once at startup. Reading it once was the bug: the
   * toggle in the Orchy panel (below) flips this same setting, and a value
   * only checked at activation cannot react to that without a window
   * reload — which defeats the point of a live toggle for a live recording.
   */
  const autoOpenedTerminals = new Set<string>();
  registry.on('event', (event: OrchyEvent) => {
    if (
      event.type === 'status' &&
      event.status === 'running' &&
      !autoOpenedTerminals.has(event.session) &&
      vscode.workspace.getConfiguration('orchy').get<boolean>('autoOpenTerminals', false)
    ) {
      autoOpenedTerminals.add(event.session);
      void vscode.commands.executeCommand('orchy.openTerminal', event.session, true);
    }
  });

  /*
   * Whether this machine can run anything, cached.
   *
   * Every one of these has failed for a real user, always after a plan had been
   * written and approved — and an agent that dies because OpenCode is not on
   * the PATH looks exactly like an agent that dies because its task was
   * impossible.
   */
  let setupChecks: Check[] = [];
  const runSetupCheck = async (): Promise<Check[]> => {
    setupChecks = await checkSetup({
      isGitRepo: () => worktrees.isGitRepo(),
      hasCommits: () => worktrees.hasCommits(),
      baseBranch: config.get<string>('baseBranch', 'main'),
      branchExists: (name) => worktrees.branchExists(name),
      backendInstalled: () => backend.isAvailable(),
      backendName: backend.displayName,
      modelCount: () => orchestrator.refreshModels(),
    });
    GraphPanel.refreshIfOpen();
    return setupChecks;
  };

  const decidePlan = (id: string, decision: 'approved' | 'rejected', feedback?: string): void => {
    // Whoever proposed the plan normally runs it on approval. But a plan
    // restored after a reload has no caller left — that request died with the
    // old window — so approving it would otherwise light up the panel and
    // spawn nothing. runPlan claims the run once, so this cannot double-spawn.
    const orphaned = !planner.hasWaiter(id);
    const plan = planner.settle(id, decision, feedback);
    if (decision === 'approved' && orphaned && plan) {
      void orchestrator.runPlan(plan).then(
        (sessions) =>
          output.appendLine(`Ran plan ${plan.id} from the panel: ${sessions.length} agent(s).`),
        (err: unknown) =>
          void vscode.window.showErrorMessage(
            `Orchy could not run the plan: ${err instanceof Error ? err.message : String(err)}`
          )
      );
    }
  };

  // Bound before anything else touches the panel: this also claims the webview
  // tab VS Code restores when the window reopens, which would otherwise sit
  // there empty forever.
  // One window, in the panel beside the terminal. Watching a single run used to
  // mean a tree in the sidebar, a session panel at the bottom and a pipeline tab
  // in the editor — three places showing three views of the same six agents.
  context.subscriptions.push(GraphPanel.bind({ registry, worktrees }, decidePlan));

  const transcripts = new TranscriptDocumentProvider(registry, backend, (id) =>
    orchestrator.handleOf(id)
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(TRANSCRIPT_SCHEME, transcripts)
  );

  const output = vscode.window.createOutputChannel('Orchy');
  const version = String(context.extension.packageJSON.version ?? 'unknown');
  const daemon = new DaemonServer(registry, orchestrator, orchyDir, root, version);

  context.subscriptions.push({
    dispose: () => {
      orchestrator.disposeAll();
      daemon.dispose();
    },
  });

  context.subscriptions.push(output);

  if (!worktrees.isGitRepo()) {
    void vscode.window
      .showWarningMessage(
        'Orchy needs a git repository — agent sessions are isolated with git worktrees.',
        'Initialize repository'
      )
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('git.init');
        }
      });
  }

  // Reclaim agents a previous window left running before anything reconciles
  // them away, so a reload does not strand live work off-screen.
  // What the backend can run, learned once at startup and again whenever a
  // plan is about to be resolved. A window left open for a day should not be
  // choosing models from yesterday's catalogue.
  void runSetupCheck().then((checks) => {
    for (const check of checks) {
      output.appendLine(`${check.ok ? 'ok  ' : 'BAD '} ${check.name} — ${check.detail}`);
    }
    const trouble = summarise(checks);
    if (trouble) {
      // Said once, in the panel and the log, rather than as a modal. The panel
      // is where someone with nothing running is already looking.
      output.appendLine(`Orchy: ${trouble}`);
      GraphPanel.show();
    }
  });

  void orchestrator.adoptExisting().then((adopted) => {
    if (adopted.length > 0) {
      output.appendLine(`Reconnected ${adopted.length} session(s) from a previous window.`);
    }
  });

  // A plan is minutes of orchestrator work and the user's decision to make.
  // Losing it to a window reload means paying for it twice, so a plan still
  // awaiting a decision comes back with the window.
  const restored = planner.pending()[0];
  if (restored) {
    GraphPanel.show();
    GraphPanel.showPlan(restored);
    output.appendLine(`Restored plan ${restored.id}, still awaiting your decision.`);
  }

  daemon.onPlanProposed = (plan) => {
    GraphPanel.showPlan(plan);
  };
  daemon.onDiagnostics = () => GraphPanel.diagnostics();

  try {
    const port = await daemon.start();
    output.appendLine(`Orchy ${version} — daemon listening on 127.0.0.1:${port}`);
    output.appendLine(`MCP handshake written to ${path.join(orchyDir, 'daemon.json')}`);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Orchy could not start its daemon: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // A spawn should put the workspace on screen, since it is the only surface
  // where the new agent will appear.
  orchestrator.on('spawned', () => {
    GraphPanel.show();
  });

  const pick = async (placeHolder: string): Promise<string | undefined> => {
    const sessions = registry.all().filter((s) => s.status !== 'archived');
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('Orchy: no active sessions.');
      return undefined;
    }
    const choice = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.id, description: s.status, detail: s.name })),
      { placeHolder }
    );
    return choice?.label;
  };

  /**
   * Session id from however a command was invoked.
   *
   * The command palette passes nothing, `TreeItem.command` passes the id as a
   * string, and a context menu or inline button passes the tree *element*. Left
   * unnormalised, the element sails through `id ?? pick()` as a truthy value and
   * every lookup quietly misses.
   */
  const idOf = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') {
      return arg;
    }
    if (arg && typeof arg === 'object' && typeof (arg as Session).id === 'string') {
      return (arg as Session).id;
    }
    return undefined;
  };

  const fail = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`ERROR ${message}`);
    void vscode.window.showErrorMessage(`Orchy: ${message}`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('orchy.openTranscript', async (id?: string, side?: boolean) => {
      const target = typeof id === 'string' ? id : await pick('Open which transcript?');
      if (!target) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument(
        TranscriptDocumentProvider.uriFor(target)
      );
      await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      });
      await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    }),

    vscode.commands.registerCommand('orchy.openTerminal', async (id?: unknown, side?: boolean) => {
      const target = idOf(id) ?? (await pick('Open a terminal for which session?'));
      if (!target) {
        return;
      }
      const session = registry.get(target);
      let handle = orchestrator.handleOf(target);
      if (!handle && session?.backend.handle && session.worktree) {
        handle = { id: session.backend.handle, directory: session.worktree.path };
      }
      if (!session || !handle) {
        void vscode.window.showWarningMessage(
          `Orchy: ${target} is not connected in this window, so there is no live session to attach to.`
        );
        return;
      }
      if (backend.ensureServer) {
        try {
          await backend.ensureServer();
        } catch (err) {
          output.appendLine(`[${target}] ensureServer warning: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const attach = backend.attachCommand(handle);
      if (!attach) {
        void vscode.window.showWarningMessage(
          `Orchy: ${backend.displayName} cannot attach a terminal to a running session.`
        );
        return;
      }
      // A real terminal running the backend's own TUI: interactive, so you can
      // type at the agent, which the transcript view deliberately cannot do.
      const terminal = vscode.window.createTerminal({
        name: `${session.id} · ${session.role}`,
        location: side
          ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }
          : undefined,
        cwd: session.worktree?.path,
        shellPath: attach.command,
        shellArgs: attach.args,
        iconPath: new vscode.ThemeIcon('robot'),
        isTransient: true,
        // shellPath bypasses the user's shell, so no profile runs. A TUI that
        // cannot identify the terminal may refuse to draw.
        env: { TERM: 'xterm-256color' },
      });
      terminal.show(false);
      if (!side) {
        void vscode.commands.executeCommand('workbench.action.terminal.focus');
      }
      output.appendLine(`[${target}] terminal: ${attach.command} ${attach.args.join(' ')}`);
    }),

    vscode.commands.registerCommand('orchy.openTerminalGrid', async () => {
      const active = registry.all().filter((s) => s.status !== 'archived');
      if (active.length === 0) {
        void vscode.window.showInformationMessage('Orchy: No active agent sessions to open terminals for.');
        return;
      }
      if (active.length > 2) {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
          orientation: 0,
          groups: [{ groups: [{}, {}], size: 0.5 }, { groups: [{}, {}], size: 0.5 }],
        });
      } else if (active.length === 2) {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
          orientation: 0,
          groups: [{ size: 0.5 }, { size: 0.5 }],
        });
      }
      for (let i = 0; i < active.length; i++) {
        const session = active[i];
        const handle = orchestrator.handleOf(session.id);
        if (!handle) {
          continue;
        }
        const attach = backend.attachCommand(handle);
        if (!attach) {
          continue;
        }
        const column = (i % 4) + 1;
        const terminal = vscode.window.createTerminal({
          name: `${session.id} · ${session.role}`,
          location: { viewColumn: column, preserveFocus: false },
          cwd: session.worktree?.path,
          shellPath: attach.command,
          shellArgs: attach.args,
          iconPath: new vscode.ThemeIcon('robot'),
          isTransient: true,
          env: { TERM: 'xterm-256color' },
        });
        terminal.show(false);
      }
    }),

    /*
     * Flips orchy.autoOpenTerminals, and nothing else — the listener above
     * always reads it live, so this takes effect on the very next agent that
     * starts, no reload needed. Workspace-scoped: turning this on to record
     * one project should not silently turn it on for every other project too.
     */
    vscode.commands.registerCommand('orchy.toggleAutoOpenTerminals', async () => {
      const cfg = vscode.workspace.getConfiguration('orchy');
      const next = !cfg.get<boolean>('autoOpenTerminals', false);
      await cfg.update('autoOpenTerminals', next, vscode.ConfigurationTarget.Workspace);
      output.appendLine(`Orchy: auto-open terminals ${next ? 'on' : 'off'}.`);
      GraphPanel.refreshIfOpen();
    }),

    /*
     * Writes the project's rules file.
     *
     * This replaced a command that seeded pipeline templates. Handing an
     * orchestrator a catalogue of pipeline shapes to choose from was solving a
     * problem it does not have — it can see the work, so it can see the shape.
     * What it cannot see is that this repository is CommonJS and takes no new
     * dependencies, and that is worth writing down once.
     */
    vscode.commands.registerCommand('orchy.createProjectConfig', async () => {
      const file = ensureProjectConfig(root);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: false });
      void vscode.window.showInformationMessage(
        `Orchy: ${CONFIG_FILE} is where this project's rules live. Every agent is given ` +
          `them verbatim, so commit it — the rest of the team gets them too.`
      );
    }),

    vscode.commands.registerCommand('orchy.focusSession', (arg?: unknown) => {
      const id = idOf(arg);
      if (!id) {
        return;
      }
      // Opens the session manager on that agent: roster on the left, everything
      // known about the one you picked on the right.
      GraphPanel.show();
    }),

    vscode.commands.registerCommand('orchy.spawn', async () => {
      const task = await vscode.window.showInputBox({
        title: 'Spawn an agent',
        prompt: 'What should this agent do?',
        placeHolder: 'Build the settings page',
        ignoreFocusOut: true,
      });
      if (!task) {
        return;
      }
      const deliverableSpec = await vscode.window.showInputBox({
        title: 'Deliverables (optional)',
        prompt:
          'Files, globs, or commands this agent must produce, comma-separated. ' +
          'Leave blank to skip — the session then cannot be marked complete automatically.',
        placeHolder: 'src/Settings.tsx, npm test',
        ignoreFocusOut: true,
      });
      const deliverables = (deliverableSpec ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((spec) => ({
          kind: (spec.includes('*') ? 'glob' : /\s/.test(spec) ? 'command' : 'file') as
            | 'file'
            | 'glob'
            | 'command',
          spec,
          verified: false,
        }));

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Orchy: spawning agent…' },
        async () => {
          try {
            await orchestrator.spawn({ role: 'agent', task, name: task.slice(0, 60), deliverables });
          } catch (err) {
            fail(err);
          }
        }
      );
    }),

    vscode.commands.registerCommand('orchy.purge', async (arg?: unknown) => {
      const target = idOf(arg) ?? (await pick('Remove which session from the list?'));
      if (!target) {
        return;
      }
      const session = registry.get(target);
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${target} from Orchy?`,
        {
          modal: true,
          detail:
            `${session?.name ?? target}

` +
            `This removes it from the list permanently. Its git branch` +
            `${session?.worktree ? ` (${session.worktree.branch})` : ''} is left alone, ` +
            `so any work it did is still recoverable from git.`,
        },
        'Remove'
      );
      if (confirm !== 'Remove') {
        return;
      }
      try {
        if (session && session.status !== 'archived') {
          await orchestrator.archive(target, { force: true });
        }
        } catch {
        // Worktree may already be gone; removal from the list still proceeds.
      }
      registry.record({ type: 'purged', session: target });
      orchestrator.settleQueue();
    }),

    vscode.commands.registerCommand('orchy.purgeAll', async () => {
      const removable = registry.all();
      if (removable.length === 0) {
        void vscode.window.showInformationMessage('Orchy: nothing to clear.');
        return;
      }
      const typed = await vscode.window.showInputBox({
        title: `Clear all ${removable.length} session(s)?`,
        prompt: "Type 'clear' to confirm. Git branches are left untouched.",
        ignoreFocusOut: true,
      });
      if (typed !== 'clear') {
        return;
      }
      for (const session of removable) {
        try {
          if (session.status !== 'archived') {
            await orchestrator.archive(session.id, { force: true });
          }
        } catch {
          // Best effort — clearing the list must not be blockable by a stuck worktree.
        }
        registry.record({ type: 'purged', session: session.id });
        orchestrator.settleQueue();
      }
    }),

    vscode.commands.registerCommand('orchy.verify', async (arg?: unknown) => {
      const target = idOf(arg) ?? (await pick('Verify which session?'));
      if (!target) {
        return;
      }
      try {
        const session = await orchestrator.verify(target);
        if (!session) {
          return;
        }
        const missing = session.deliverables.filter((d) => !d.verified);
        if (missing.length === 0) {
          void vscode.window.showInformationMessage(`Orchy: ${target} verified complete.`);
        } else {
          void vscode.window.showWarningMessage(
            `Orchy: ${target} is not done — ${missing.map((d) => `${d.spec} (${d.detail})`).join('; ')}`
          );
        }
      } catch (err) {
        fail(err);
      }
    }),

    vscode.commands.registerCommand('orchy.kill', async (arg?: unknown) => {
      const target = idOf(arg) ?? (await pick('Kill which session?'));
      if (!target) {
        return;
      }
      const session = registry.get(target);
      const elapsed = session
        ? Math.round((Date.now() - new Date(session.createdAt).getTime()) / 60_000)
        : 0;
      const confirm = await vscode.window.showWarningMessage(
        `Kill ${target}?`,
        {
          modal: true,
          detail:
            `${session?.name ?? target}\nRunning for ${elapsed} minute(s).\n\n` +
            `Its transcript and worktree are kept — you can inspect the branch afterwards.`,
        },
        'Kill session'
      );
      if (confirm !== 'Kill session') {
        return;
      }
      try {
        await orchestrator.kill(target);
        } catch (err) {
        fail(err);
      }
    }),

    vscode.commands.registerCommand('orchy.archive', async (arg?: unknown) => {
      const target = idOf(arg) ?? (await pick('Archive which session?'));
      if (!target) {
        return;
      }
      const session = registry.get(target);
      try {
        await orchestrator.archive(target);
        } catch (err) {
        if (err instanceof WorktreeLockedError) {
          // Half-done rather than failed: git no longer tracks it, the folder
          // survives. Say that, and let the session leave the list regardless.
              registry.record({ type: 'archived', session: target });
          void vscode.window.showWarningMessage(err.message, 'Prune worktrees').then((choice) => {
            if (choice) {
              void vscode.commands.executeCommand('orchy.pruneWorktrees');
            }
          });
          return;
        }
        if (!(err instanceof WorktreeDirtyError)) {
          fail(err);
          return;
        }
        // Mirror git's own refusal, and make discarding the work deliberate.
        const typed = await vscode.window.showInputBox({
          title: `${target} has ${err.changes.length} uncommitted change(s)`,
          prompt: `Type the branch name to discard them: ${session?.worktree?.branch ?? ''}`,
          placeHolder: session?.worktree?.branch,
        });
        if (typed && typed === session?.worktree?.branch) {
          try {
            await orchestrator.archive(target, { force: true });
                } catch (inner) {
            fail(inner);
          }
        } else if (typed !== undefined) {
          void vscode.window.showInformationMessage('Orchy: branch name did not match. Nothing removed.');
        }
      }
    }),

    vscode.commands.registerCommand('orchy.merge', async (arg?: unknown) => {
      const target = idOf(arg) ?? (await pick('Merge which session?'));
      if (!target) {
        return;
      }
      try {
        await orchestrator.merge(target);
        void vscode.window.showInformationMessage(`Orchy: merged ${target} into main.`);
      } catch (err) {
        fail(err);
      }
    }),

    vscode.commands.registerCommand('orchy.pruneWorktrees', () => {
      try {
        worktrees.prune();
        const orphans = worktrees.orphans();
        void vscode.window.showInformationMessage(
          orphans.length === 0
            ? 'Orchy: no orphaned worktrees.'
            : `Orchy: pruned metadata. ${orphans.length} orphan director(ies) remain on disk: ${orphans.join(', ')}`
        );
      } catch (err) {
        fail(err);
      }
    }),

    // Reachable from the panel as command: URIs, so a plan can be decided even
    // when the webview's script never started. The buttons post messages when
    // the script is alive; these are the same decision by another road.
    /*
     * The MCP server ships inside this extension, so its path is only knowable
     * at runtime — it moves with every version. Asking people to find it
     * themselves is the single largest piece of friction in getting started,
     * and getting it slightly wrong produces an orchestrator that silently has
     * no tools rather than an error.
     */
    vscode.commands.registerCommand('orchy.copyMcpConfig', async () => {
      const server = path.join(context.extensionPath, 'mcp', 'orchy-mcp.mjs');
      const snippet = JSON.stringify(
        { mcpServers: { orchy: { type: 'stdio', command: 'node', args: [server] } } },
        null,
        2
      );
      await vscode.env.clipboard.writeText(snippet);
      const choice = await vscode.window.showInformationMessage(
        'Orchy: MCP server config copied. Paste it into your orchestrator — for Claude Code ' +
          'that is ~/.claude.json. One entry covers every workspace.',
        'Show it'
      );
      if (choice) {
        const doc = await vscode.workspace.openTextDocument({
          content: snippet,
          language: 'json',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    }),

    /*
     * Close terminals whose agents are gone.
     *
     * Terminals are named "<id> · <role>" and outlive their session on purpose
     * — closing one must never kill an agent, so the reverse cannot be
     * automatic either. But a window that has run three pipelines accumulates a
     * row of dead TUIs attached to nothing, and closing them one at a time is
     * the sort of chore people simply live with instead.
     *
     * The button for this existed and called a command that was never
     * registered, which is worse than not having the button.
     */
    vscode.commands.registerCommand('orchy.cleanupTerminals', () => {
      const live = new Set(
        registry
          .all()
          .filter((s) => s.status !== 'archived')
          .map((s) => s.id)
      );
      let closed = 0;
      for (const terminal of vscode.window.terminals) {
        const id = terminal.name.split(' \u00b7 ')[0];
        // Only terminals this extension named, and only for agents that are
        // gone: anything else on screen belongs to the user.
        if (id && id !== terminal.name && !live.has(id)) {
          terminal.dispose();
          closed++;
        }
      }
      void vscode.window.showInformationMessage(
        closed === 0
          ? 'Orchy: no stale agent terminals to close.'
          : `Orchy: closed ${closed} terminal(s) whose agents are gone.`
      );
    }),

    vscode.commands.registerCommand('orchy.checkSetup', async () => {
      const checks = await runSetupCheck();
      const trouble = summarise(checks);
      await vscode.window.showInformationMessage(
        trouble ?? 'Orchy is ready: repository, backend and models all check out.',
        ...(trouble ? ['Show the panel'] : [])
      ).then((choice) => {
        if (choice) {
          GraphPanel.show();
        }
      });
    }),

    vscode.commands.registerCommand('orchy.approvePlan', (id: string) => {
      decidePlan(id, 'approved');
      GraphPanel.clearPlan(id);
    }),

    vscode.commands.registerCommand('orchy.rejectPlan', (id: string) => {
      decidePlan(id, 'rejected');
      GraphPanel.clearPlan(id);
    }),

    vscode.commands.registerCommand('orchy.revisePlan', async (id: string) => {
      const feedback = await vscode.window.showInputBox({
        title: 'What should change about this plan?',
        prompt: 'The orchestrator revises rather than guesses.',
        placeHolder: 'e.g. the three validators should not depend on each other',
      });
      if (feedback) {
        decidePlan(id, 'rejected', feedback);
        GraphPanel.clearPlan(id);
      }
    }),

    /*
     * Opens the one window everything lives in.
     *
     * This replaced a command that rearranged the editor into columns for agent
     * terminals. Splitting someone's editor to make room for a tool is a lot to
     * ask of them, and it stopped being necessary once the agents, the diagram
     * and the history shared a single tab.
     */
    vscode.commands.registerCommand('orchy.openWorkspace', () => GraphPanel.show()),
    vscode.commands.registerCommand('orchy.openInEditor', () => GraphPanel.openInEditor())
  );
}

export function deactivate(): void {
  // Subscriptions handle teardown; sessions deliberately outlive the window.
}
