import * as vscode from 'vscode';
import { AgentBackend, BackendHandle, TranscriptEntry } from '../backends/types';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GREY = '\x1b[90m';

/**
 * A pane that renders an agent's conversation, driven by Orchy rather than by
 * the backend's own terminal UI.
 *
 * OpenCode's `attach` TUI proved unreliable here: it would come up showing an
 * empty prompt while the agent was demonstrably working — files on disk, a full
 * transcript in the API. A pane that shows nothing is worse than no pane, and
 * the data was always available over HTTP, so this renders it directly.
 *
 * Read-only by design. Terminals are views; prompts go through the Orchestrator.
 */
export class TranscriptPane implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.closeEmitter.event;

  private seen = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private refreshing = false;
  private queued = false;
  private closed = false;

  constructor(
    private readonly backend: AgentBackend,
    private readonly handle: BackendHandle,
    private readonly sessionId: string
  ) {}

  open(): void {
    this.write(`${DIM}Orchy — ${this.sessionId}${RESET}\r\n`);
    this.write(`${DIM}${this.handle.directory}${RESET}\r\n\r\n`);
    void this.refresh();

    this.unsubscribe = this.backend.subscribe(this.handle, () => {
      // Any activity on this session may have produced new turns. Re-reading is
      // cheap next to rendering partial state incorrectly.
      void this.refresh();
    });
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  handleInput(data: string): void {
    // Read-only. Say so once rather than swallowing keystrokes silently.
    if (data.trim().length > 0) {
      this.write(
        `\r\n${GREY}This pane is a view of the agent's work. To talk to it, use ` +
          `orchy_send from your orchestrator.${RESET}\r\n`
      );
    }
  }

  /**
   * Re-read the transcript and append anything new.
   * Coalesced: a burst of events must not start a dozen overlapping fetches.
   */
  private async refresh(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.refreshing) {
      this.queued = true;
      return;
    }
    this.refreshing = true;
    try {
      const entries = (await this.backend.transcript?.(this.handle)) ?? [];
      for (const entry of entries) {
        if (this.seen.has(entry.id)) {
          continue;
        }
        this.seen.add(entry.id);
        this.render(entry);
      }
    } catch (err) {
      this.write(
        `${YELLOW}Could not read the transcript: ${
          err instanceof Error ? err.message : String(err)
        }${RESET}\r\n`
      );
    } finally {
      this.refreshing = false;
      if (this.queued) {
        this.queued = false;
        void this.refresh();
      }
    }
  }

  private render(entry: TranscriptEntry): void {
    if (entry.parts.length === 0) {
      return;
    }
    const label =
      entry.role === 'user'
        ? `${BOLD}${CYAN}you${RESET}`
        : entry.role === 'system'
          ? `${BOLD}${GREY}system${RESET}`
          : `${BOLD}${GREEN}agent${RESET}`;
    this.write(`${label}\r\n`);

    for (const part of entry.parts) {
      if (part.kind === 'tool') {
        this.write(`  ${YELLOW}▸ ${part.text}${RESET}\r\n`);
      } else if (part.kind === 'reasoning') {
        this.write(this.wrap(part.text, `  ${GREY}`, RESET));
      } else {
        this.write(this.wrap(part.text, '  ', ''));
      }
    }
    this.write('\r\n');
  }

  /** Terminals need \r\n, and raw model output is full of bare \n. */
  private wrap(text: string, prefix: string, suffix: string): string {
    return (
      text
        .split('\n')
        .map((line) => `${prefix}${line}${suffix}`)
        .join('\r\n') + '\r\n'
    );
  }

  private write(text: string): void {
    if (!this.closed) {
      this.writeEmitter.fire(text);
    }
  }
}
