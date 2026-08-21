import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Deliverable } from './types';

export interface VerificationResult {
  spec: string;
  verified: boolean;
  detail: string;
}

/**
 * Checks whether a session actually produced what it promised.
 *
 * This exists because a backend reporting `idle` is not evidence of completion.
 * Observed directly while researching this project: three delegated agents
 * reported idle repeatedly over an hour while producing zero files.
 */
export class DeliverableVerifier {
  constructor(private readonly commandTimeoutMs = 120_000) {}

  async verifyAll(deliverables: Deliverable[], cwd: string): Promise<VerificationResult[]> {
    return Promise.all(deliverables.map((d) => this.verify(d, cwd)));
  }

  async verify(deliverable: Deliverable, cwd: string): Promise<VerificationResult> {
    switch (deliverable.kind) {
      case 'file':
        return this.verifyFile(deliverable.spec, cwd);
      case 'glob':
        return this.verifyGlob(deliverable.spec, cwd);
      case 'command':
        return this.verifyCommand(deliverable.spec, cwd);
    }
  }

  private verifyFile(spec: string, cwd: string): VerificationResult {
    const target = path.resolve(cwd, spec);
    if (!fs.existsSync(target)) {
      return { spec, verified: false, detail: `file not found: ${spec}` };
    }
    const size = fs.statSync(target).size;
    if (size === 0) {
      return { spec, verified: false, detail: `file is empty: ${spec}` };
    }
    return { spec, verified: true, detail: `${size} bytes` };
  }

  /**
   * Minimal glob: supports `*` within a single directory segment and `**` as a
   * recursive prefix. Deliberately not a glob library — the dependency is not
   * worth it for patterns like `docs/*.md`.
   */
  private verifyGlob(spec: string, cwd: string): VerificationResult {
    const matches = this.expand(spec, cwd);
    return matches.length > 0
      ? { spec, verified: true, detail: `${matches.length} match(es)` }
      : { spec, verified: false, detail: `no files match: ${spec}` };
  }

  private expand(spec: string, cwd: string): string[] {
    const normalized = spec.replace(/\\/g, '/');
    const recursive = normalized.includes('**/');
    const dirPart = recursive
      ? normalized.slice(0, normalized.indexOf('**/'))
      : path.posix.dirname(normalized);
    const filePattern = path.posix.basename(normalized);
    const root = path.resolve(cwd, dirPart === '.' ? '' : dirPart);

    if (!fs.existsSync(root)) {
      return [];
    }
    const re = new RegExp(
      '^' + filePattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
    );

    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 12) {
        return;
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) {
            walk(full, depth + 1);
          }
        } else if (re.test(entry.name)) {
          out.push(full);
        }
      }
    };
    walk(root, 0);
    return out;
  }

  private verifyCommand(spec: string, cwd: string): Promise<VerificationResult> {
    return new Promise((resolve) => {
      const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
      const args = process.platform === 'win32' ? ['-NoProfile', '-Command', spec] : ['-c', spec];

      execFile(
        shell,
        args,
        { cwd, timeout: this.commandTimeoutMs, encoding: 'utf8', windowsHide: true },
        (err, _stdout, stderr) => {
          if (!err) {
            resolve({ spec, verified: true, detail: 'exit 0' });
            return;
          }
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) {
            resolve({
              spec,
              verified: false,
              detail: `timed out after ${this.commandTimeoutMs / 1000}s`,
            });
            return;
          }
          const code = (err as NodeJS.ErrnoException & { code?: number }).code ?? 1;
          const tail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
          resolve({ spec, verified: false, detail: `exit ${code}${tail ? `: ${tail}` : ''}` });
        }
      );
    });
  }
}
