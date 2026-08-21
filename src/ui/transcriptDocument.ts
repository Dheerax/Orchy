import * as vscode from 'vscode';
import { AgentBackend, BackendHandle } from '../backends/types';
import { SessionRegistry } from '../core/sessionRegistry';

export const TRANSCRIPT_SCHEME = 'orchy-transcript';

/**
 * Serves a session's conversation as a real editor document.
 *
 * The workspace panel is good for watching several agents at once and poor for
 * reading one closely. Opening a transcript as a document hands that job back to
 * the editor: search, selection, copy, word wrap, and split all work without us
 * reimplementing any of them in a webview.
 */
export class TranscriptDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly backend: AgentBackend,
    private readonly handleOf: (id: string) => BackendHandle | undefined
  ) {
    // Open transcripts should follow the agent rather than freeze at open time.
    this.registry.on('changed', () => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === TRANSCRIPT_SCHEME) {
          this.changed.fire(doc.uri);
        }
      }
    });
  }

  static uriFor(sessionId: string): vscode.Uri {
    return vscode.Uri.parse(`${TRANSCRIPT_SCHEME}:${sessionId}.md`);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const id = uri.path.replace(/\.md$/, '');
    const session = this.registry.get(id);
    if (!session) {
      return `# ${id}\n\nThis session no longer exists.\n`;
    }

    const lines = [
      `# ${session.id} — ${session.name}`,
      '',
      `- status: \`${session.status}\``,
      `- role: ${session.role}`,
    ];
    if (session.worktree) {
      lines.push(`- branch: \`${session.worktree.branch}\``, `- worktree: ${session.worktree.path}`);
    }
    if (session.budget.costEstimate > 0) {
      lines.push(`- spend: ${session.budget.costEstimate.toFixed(4)}`);
    }
    if (session.deliverables.length > 0) {
      lines.push('', '## Deliverables', '');
      for (const d of session.deliverables) {
        lines.push(`- [${d.verified ? 'x' : ' '}] \`${d.spec}\`${d.detail ? ` — ${d.detail}` : ''}`);
      }
    }
    if (session.lastError) {
      lines.push('', '## Error', '', '```', session.lastError, '```');
    }

    lines.push('', '## Task', '', session.task, '', '## Transcript', '');

    const handle = this.handleOf(id);
    if (!handle || !this.backend.transcript) {
      lines.push('_No live connection to this session in this window._');
      return lines.join('\n');
    }

    try {
      const entries = await this.backend.transcript(handle);
      if (entries.length === 0) {
        lines.push('_Nothing yet._');
      }
      for (const entry of entries) {
        lines.push(`### ${entry.role}`, '');
        for (const part of entry.parts) {
          if (part.kind === 'tool') {
            lines.push(`\`▸ ${part.text}\``, '');
          } else if (part.kind === 'reasoning') {
            lines.push(`> ${part.text.split('\n').join('\n> ')}`, '');
          } else {
            lines.push(part.text, '');
          }
        }
      }
    } catch (err) {
      lines.push(`_Could not read the transcript: ${err instanceof Error ? err.message : String(err)}_`);
    }
    return lines.join('\n');
  }
}
