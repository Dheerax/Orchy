import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_FORBIDDEN_COMMANDS, WorktreeRef } from './types';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

export class WorktreeDirtyError extends Error {
  constructor(readonly worktreePath: string, readonly changes: string[]) {
    super(
      `Worktree has ${changes.length} uncommitted change(s). ` +
        `Refusing to remove — git refuses this too, and forcing past it loses work.`
    );
  }
}

/**
 * Owns the git worktree lifecycle for agent sessions.
 *
 * One worktree per agent, one branch per worktree. Git itself enforces that a
 * branch can only be checked out in one worktree at a time, which is what makes
 * "two agents never share a branch" a guarantee rather than a convention.
 *
 * What worktrees do NOT isolate: the stash (shared across every worktree of a
 * repo), destructive history operations, ports, and databases. The first two are
 * handled by the forbidden-command contract; ports are a known v1 gap.
 */
export class WorktreeManager {
  constructor(private readonly repoRoot: string) {}

  get root(): string {
    return this.repoRoot;
  }

  private git(args: string[], cwd = this.repoRoot): string {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err: unknown) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
      throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || e.message}`, stderr);
    }
  }

  isGitRepo(): boolean {
    try {
      return this.git(['rev-parse', '--is-inside-work-tree']) === 'true';
    } catch {
      return false;
    }
  }

  hasRemote(): boolean {
    try {
      return this.git(['remote']).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the ref new worktrees branch from. Prefers `origin/<base>` and
   * fetches first, because branching from a stale local ref is the documented
   * cause of silent regressions in parallel-agent setups. Falls back to the
   * local branch when there is no remote, so local-only repos still work.
   */
  resolveBase(baseBranch: string): { ref: string; sha: string } {
    if (this.hasRemote()) {
      try {
        this.git(['fetch', 'origin', baseBranch, '--quiet']);
        const ref = `origin/${baseBranch}`;
        return { ref, sha: this.git(['rev-parse', ref]) };
      } catch {
        // Remote exists but the branch isn't there yet (fresh repo). Fall through.
      }
    }
    return { ref: baseBranch, sha: this.git(['rev-parse', baseBranch]) };
  }

  /**
   * Create an isolated worktree for a session.
   * Branch name is derived from the session id, so it is stable and greppable.
   */
  create(sessionId: string, baseBranch: string): WorktreeRef {
    const base = this.resolveBase(baseBranch);
    const branch = `agent/${sessionId}`;
    const repoName = path.basename(this.repoRoot);
    const wtPath = path.resolve(this.repoRoot, '..', `${repoName}-${sessionId}`);

    if (fs.existsSync(wtPath)) {
      throw new Error(`Worktree path already exists: ${wtPath}`);
    }

    this.git(['worktree', 'add', wtPath, '-b', branch, base.sha]);
    this.bootstrap(wtPath);

    return { path: wtPath, branch, baseRef: base.ref, baseSha: base.sha };
  }

  /**
   * Copy gitignored-but-required files into a fresh worktree.
   *
   * A worktree checks out tracked files only, so `.env` and friends are absent
   * and agents fail in confusing ways. Patterns come from `.worktreeinclude` at
   * the repo root, one glob-free relative path per line.
   */
  bootstrap(worktreePath: string): string[] {
    const manifest = path.join(this.repoRoot, '.worktreeinclude');
    if (!fs.existsSync(manifest)) {
      return [];
    }
    const copied: string[] = [];
    const entries = fs
      .readFileSync(manifest, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    for (const entry of entries) {
      const from = path.join(this.repoRoot, entry);
      if (!fs.existsSync(from)) {
        continue;
      }
      const to = path.join(worktreePath, entry);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
      copied.push(entry);
    }

    if (copied.length > 0) {
      // Without this the files we just copied show as untracked, so a brand new
      // worktree reads as dirty and `remove()` refuses to clean up after us.
      // info/exclude is per-worktree, so this never leaks into the main checkout.
      const excludeFile = this.git(
        ['rev-parse', '--git-path', 'info/exclude'],
        worktreePath
      );
      const resolved = path.isAbsolute(excludeFile)
        ? excludeFile
        : path.join(worktreePath, excludeFile);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const existing = fs.existsSync(resolved) ? fs.readFileSync(resolved, 'utf8') : '';
      const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
      const additions = copied.filter((e) => !existingLines.has(e));
      if (additions.length > 0) {
        const block = ['', '# added by Orchy (.worktreeinclude)', ...additions, ''].join('\n');
        fs.appendFileSync(resolved, block, 'utf8');
      }
    }
    return copied;
  }

  branchExists(branch: string): boolean {
    try {
      this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Uncommitted changes in a worktree, as porcelain lines. Empty means clean. */
  dirtyFiles(worktreePath: string): string[] {
    return this.git(['status', '--porcelain'], worktreePath)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /**
   * Remove a worktree. Refuses when dirty unless `force` — mirroring git's own
   * refusal rather than routinely passing --force, because that refusal is the
   * last thing standing between an agent's uncommitted work and oblivion.
   */
  remove(worktreePath: string, opts: { force?: boolean; deleteBranch?: boolean } = {}): void {
    if (!fs.existsSync(worktreePath)) {
      this.prune();
      return;
    }
    const dirty = this.dirtyFiles(worktreePath);
    if (dirty.length > 0 && !opts.force) {
      throw new WorktreeDirtyError(worktreePath, dirty);
    }
    const branch = this.list().find(
      (w) => path.resolve(w.path) === path.resolve(worktreePath)
    )?.branch;

    this.git(['worktree', 'remove', ...(opts.force ? ['--force'] : []), worktreePath]);

    // Removing a worktree leaves its branch behind. Keep it by default — it is
    // the only remaining record of what the agent did — and delete it only when
    // the caller says the work is accounted for.
    if (opts.deleteBranch && branch && branch !== '(detached)') {
      try {
        this.git(['branch', '-D', branch]);
      } catch {
        // Branch already gone, or checked out elsewhere. Not fatal.
      }
    }
  }

  /** Drop admin files left behind by worktrees deleted outside git. */
  prune(): void {
    this.git(['worktree', 'prune']);
  }

  list(): { path: string; branch: string }[] {
    const out: { path: string; branch: string }[] = [];
    let current: { path?: string; branch?: string } = {};
    for (const line of this.git(['worktree', 'list', '--porcelain']).split('\n')) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace('refs/heads/', '');
      } else if (line.trim() === '' && current.path) {
        out.push({ path: current.path, branch: current.branch ?? '(detached)' });
        current = {};
      }
    }
    if (current.path) {
      out.push({ path: current.path, branch: current.branch ?? '(detached)' });
    }
    return out;
  }

  /** Worktree dirs matching our agent naming that git no longer tracks. */
  orphans(): string[] {
    const tracked = new Set(this.list().map((w) => path.resolve(w.path)));
    const parent = path.resolve(this.repoRoot, '..');
    const prefix = `${path.basename(this.repoRoot)}-`;
    if (!fs.existsSync(parent)) {
      return [];
    }
    return fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(prefix))
      .map((n) => path.join(parent, n))
      .filter((p) => !tracked.has(path.resolve(p)));
  }

  /**
   * Merge an agent branch back into the base branch.
   * Rebases onto a fresh base first so history stays linear and conflicts surface
   * in the agent's worktree rather than on the base branch.
   */
  mergeBack(worktreePath: string, branch: string, baseBranch: string): void {
    const base = this.resolveBase(baseBranch);
    this.git(['rebase', base.sha], worktreePath);
    this.git(['merge', '--ff-only', branch]);
  }

  /** Commands never permitted to a session, for the default contract. */
  static forbiddenCommands(): readonly string[] {
    return DEFAULT_FORBIDDEN_COMMANDS;
  }
}
