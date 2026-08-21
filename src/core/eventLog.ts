import * as fs from 'fs';
import * as path from 'path';
import { DraftEvent, OrchyEvent } from './types';

const ROTATE_AT_BYTES = 50 * 1024 * 1024;

/**
 * Append-only event log. The source of truth for all pipeline state.
 *
 * Writes are synchronous and line-atomic: a single `appendFileSync` of one
 * newline-terminated JSON line. That is deliberate — an event that the registry
 * has acted on but that never reached disk would make the log a liar after a
 * crash, and every surface rebuilds from this file.
 *
 * Readers must tolerate a partial or corrupt trailing line: the process can be
 * killed mid-write, and a torn last line is normal rather than exceptional.
 */
export class EventLog {
  private seq = 0;
  private readonly logPath: string;

  constructor(private readonly dir: string) {
    this.logPath = path.join(dir, 'events.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    this.seq = this.lastSeqOnDisk();
  }

  get filePath(): string {
    return this.logPath;
  }

  append(draft: DraftEvent): OrchyEvent {
    this.rotateIfNeeded();
    const event = { ...draft, t: new Date().toISOString(), seq: ++this.seq } as OrchyEvent;
    fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  /**
   * Every event currently in the active log, oldest first.
   * Corrupt lines are skipped rather than thrown — one bad line must not make
   * the pipeline unrecoverable.
   */
  readAll(): OrchyEvent[] {
    return this.parse(this.rawLines());
  }

  /** The newest `n` events. What the graph reads — it never loads the whole log. */
  tail(n: number): OrchyEvent[] {
    const lines = this.rawLines();
    return this.parse(lines.slice(Math.max(0, lines.length - n)));
  }

  /** Number of lines that failed to parse. Surfaced in diagnostics, not hidden. */
  corruptLineCount(): number {
    const lines = this.rawLines();
    return lines.length - this.parse(lines).length;
  }

  private rawLines(): string[] {
    if (!fs.existsSync(this.logPath)) {
      return [];
    }
    return fs.readFileSync(this.logPath, 'utf8').split('\n').filter((l) => l.length > 0);
  }

  private parse(lines: string[]): OrchyEvent[] {
    const out: OrchyEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
          out.push(parsed as OrchyEvent);
        }
      } catch {
        // Torn or corrupt line. Skipped by design; counted by corruptLineCount().
      }
    }
    return out;
  }

  private lastSeqOnDisk(): number {
    const events = this.readAll();
    return events.length === 0 ? 0 : events[events.length - 1].seq;
  }

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.logPath)) {
      return;
    }
    if (fs.statSync(this.logPath).size < ROTATE_AT_BYTES) {
      return;
    }
    // Shift existing archives down: events.1.jsonl -> events.2.jsonl, etc.
    for (let i = 8; i >= 1; i--) {
      const from = path.join(this.dir, `events.${i}.jsonl`);
      if (fs.existsSync(from)) {
        fs.renameSync(from, path.join(this.dir, `events.${i + 1}.jsonl`));
      }
    }
    fs.renameSync(this.logPath, path.join(this.dir, 'events.1.jsonl'));
  }
}
