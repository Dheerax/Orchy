/**
 * Whether this machine can actually run a pipeline.
 *
 * Every one of these has failed for a real user, and each failed at the worst
 * possible moment: after a plan had been written, approved, and spawned. An
 * agent that dies because OpenCode is not on the PATH looks identical to an
 * agent that dies because its task was impossible, and the second is a much
 * more interesting thing to be wrong about.
 *
 * So they are checked up front, and each answer says what to do rather than
 * only what is broken.
 */

export interface Check {
  name: string;
  ok: boolean;
  /** What was found. Present whether or not the check passed. */
  detail: string;
  /** What to do about it. Only when it failed. */
  fix?: string;
}

export interface Environment {
  isGitRepo(): boolean;
  hasCommits(): boolean;
  baseBranch: string;
  branchExists(name: string): boolean;
  backendInstalled(): Promise<boolean>;
  backendName: string;
  modelCount(): Promise<number>;
}

export async function checkSetup(env: Environment): Promise<Check[]> {
  const checks: Check[] = [];

  const repo = env.isGitRepo();
  checks.push({
    name: 'Git repository',
    ok: repo,
    detail: repo ? 'This workspace is a git repository.' : 'This workspace is not a git repository.',
    fix: repo
      ? undefined
      : 'Agents are isolated with git worktrees, which need a repository. Run git init here.',
  });

  if (repo) {
    // A repository with no commits has nothing to branch from, and the failure
    // surfaces as a confusing git error several steps later.
    const commits = env.hasCommits();
    checks.push({
      name: 'A commit to branch from',
      ok: commits,
      detail: commits ? 'The repository has history.' : 'The repository has no commits yet.',
      fix: commits ? undefined : 'Make one commit. A worktree cannot be cut from nothing.',
    });

    if (commits) {
      const base = env.branchExists(env.baseBranch);
      checks.push({
        name: `Base branch '${env.baseBranch}'`,
        ok: base,
        detail: base
          ? `Worktrees will branch from '${env.baseBranch}'.`
          : `There is no branch called '${env.baseBranch}'.`,
        fix: base
          ? undefined
          : `Set orchy.baseBranch to the branch you actually use, or create '${env.baseBranch}'.`,
      });
    }
  }

  let installed = false;
  try {
    installed = await env.backendInstalled();
  } catch {
    installed = false;
  }
  checks.push({
    name: `${env.backendName} installed`,
    ok: installed,
    detail: installed
      ? `${env.backendName} is on the PATH and answering.`
      : `${env.backendName} could not be started.`,
    fix: installed
      ? undefined
      : `Install ${env.backendName} and make sure it is on your PATH. On Windows, check ` +
        `for an old copy shadowing the current one — 'where opencode' lists them in order.`,
  });

  if (installed) {
    let models = 0;
    try {
      models = await env.modelCount();
    } catch {
      models = 0;
    }
    checks.push({
      name: 'A model to run on',
      ok: models > 0,
      detail:
        models > 0
          ? `${models} model(s) available.`
          : 'No provider is configured, so there is nothing to run an agent on.',
      fix:
        models > 0
          ? undefined
          : 'Add a provider and its API key to your OpenCode config, then reload the window.',
    });
  }

  return checks;
}

/** One line for a status bar or a log: silent when everything is fine. */
export function summarise(checks: Check[]): string | undefined {
  const broken = checks.filter((c) => !c.ok);
  if (broken.length === 0) {
    return undefined;
  }
  return broken.length === 1
    ? broken[0].fix ?? broken[0].detail
    : `${broken.length} things need fixing before agents can run.`;
}
