import * as path from 'path';
import * as vscode from 'vscode';
import { EventLog } from './core/eventLog';
import { SessionRegistry } from './core/sessionRegistry';

let registry: SessionRegistry | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    // Orchy is worktree-based; without a workspace there is nothing to orchestrate.
    return;
  }

  const log = new EventLog(path.join(folder.uri.fsPath, '.orchy'));
  registry = new SessionRegistry(log);

  context.subscriptions.push(
    vscode.commands.registerCommand('orchy.showState', () => {
      const sessions = registry?.all() ?? [];
      if (sessions.length === 0) {
        vscode.window.showInformationMessage(
          'Orchy: no sessions yet. Ask your orchestrator to spawn one.'
        );
        return;
      }
      const blocked = registry?.needingAttention().length ?? 0;
      const lines = sessions.map((s) => `${s.id} [${s.status}] ${s.name}`);
      vscode.window.showInformationMessage(
        `Orchy: ${sessions.length} session(s), ${blocked} need attention.`,
        { modal: true, detail: lines.join('\n') }
      );
    })
  );
}

export function deactivate(): void {
  registry = undefined;
}
