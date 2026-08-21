import * as path from 'path';
import * as vscode from 'vscode';
import { OpenCodeBackend } from './backends/opencodeBackend';
import { DeliverableVerifier } from './core/deliverableVerifier';
import { EventLog } from './core/eventLog';
import { Orchestrator } from './core/orchestrator';
import { SessionRegistry } from './core/sessionRegistry';
import { Session } from './core/types';
import { WorktreeDirtyError, WorktreeManager } from './core/worktreeManager';
import { DaemonServer } from './daemon/server';
import { GraphPanel } from './ui/graphPanel';
import { GridManager } from './ui/gridManager';
import { SessionTreeProvider } from './ui/sessionTree';

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
  const backend = new OpenCodeBackend(undefined, {
    mini: config.get<boolean>('miniTui', false),
  });
  const orchestrator = new Orchestrator(registry, worktrees, backend, new DeliverableVerifier(), {
    baseBranch: config.get<string>('baseBranch', 'main'),
  });
  // Before anything reads state: this window owns no terminals and no backend
  // handles, whatever the log says a previous window was doing.
  registry.reconcileForFreshWindow();

  const grid = new GridManager(registry, backend);
  const tree = new SessionTreeProvider(registry);
  const daemon = new DaemonServer(registry, orchestrator, orchyDir, root);

  context.subscriptions.push(grid, tree.register(), { dispose: () => daemon.dispose() });

  const output = vscode.window.createOutputChannel('Orchy');
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

  try {
    const port = await daemon.start();
    output.appendLine(`Orchy daemon listening on 127.0.0.1:${port}`);
    output.appendLine(`MCP handshake written to ${path.join(orchyDir, 'daemon.json')}`);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Orchy could not start its daemon: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Backend handles are per-window: a session replayed from the log has no live
  // handle until this window spawns it, so grid actions degrade to reveal-only.
  orchestrator.on('spawned', (session: Session) => {
    const handle = orchestrator.handleOf(session.id);
    if (handle) {
      grid.open(session, handle);
    }
    GraphPanel.refreshIfOpen();
  });

  registry.on('changed', () => {
    for (const session of registry.all()) {
      if (session.status !== 'waiting_input') {
        continue;
      }
      const handle = orchestrator.handleOf(session.id);
      if (handle && !grid.has(session.id)) {
        grid.promote(session, handle);
      }
    }
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
    vscode.commands.registerCommand('orchy.showGraph', () => GraphPanel.show(registry)),

    vscode.commands.registerCommand('orchy.focusSession', (arg?: unknown) => {
      const id = idOf(arg);
      if (!id) {
        return;
      }
      const session = registry.get(id);
      const handle = orchestrator.handleOf(id);
      if (session && handle && !grid.has(id)) {
        grid.promote(session, handle);
      } else {
        grid.reveal(id);
      }
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
        grid.detach(target);
      } catch {
        // Worktree may already be gone; removal from the list still proceeds.
      }
      registry.record({ type: 'purged', session: target });
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
          grid.detach(session.id);
        } catch {
          // Best effort — clearing the list must not be blockable by a stuck worktree.
        }
        registry.record({ type: 'purged', session: session.id });
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
        grid.detach(target);
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
        grid.detach(target);
      } catch (err) {
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
            grid.detach(target);
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

    vscode.commands.registerCommand('orchy.setupLayout', async () => {
      // Deliberately a command rather than something that fires on activation —
      // rearranging someone's editor the moment an extension installs is hostile.
      await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: 0.5 }, { size: 0.5 }],
      });
      await vscode.commands.executeCommand('workbench.view.extension.orchy');
      GraphPanel.show(registry);
      void vscode.window.showInformationMessage(
        'Orchy: layout ready. Agent terminals fill the editor columns; the topology panel is beside them.'
      );
    })
  );
}

export function deactivate(): void {
  // Subscriptions handle teardown; sessions deliberately outlive the window.
}
