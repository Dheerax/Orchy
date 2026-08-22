/** Run with:  node out/core/doctor.test.js */
import { checkSetup, summarise, Environment } from './doctor';

let failures = 0;
let checks = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? '\n         ' + detail : ''}`);
  }
}

function env(over: Partial<Environment> = {}): Environment {
  return {
    isGitRepo: () => true,
    hasCommits: () => true,
    baseBranch: 'main',
    branchExists: () => true,
    backendInstalled: () => Promise.resolve(true),
    backendName: 'OpenCode',
    modelCount: () => Promise.resolve(12),
    ...over,
  };
}

const named = (list: { name: string; ok: boolean }[], part: string): boolean =>
  list.some((c) => c.name.includes(part) && !c.ok);

void (async (): Promise<void> => {
  console.log('\na machine that is ready');

  const healthy = await checkSetup(env());
  ok('everything passes', healthy.every((c) => c.ok));
  ok('and nothing is said about it', summarise(healthy) === undefined);

  console.log('\neach way it can fail');

  ok('no repository', named(await checkSetup(env({ isGitRepo: () => false })), 'Git repository'));

  // A fresh repository fails worktree creation with a git error several steps
  // removed from the cause, so it is asked about directly.
  const empty = await checkSetup(env({ hasCommits: () => false }));
  ok('no commits', named(empty, 'commit'));
  ok(
    'and the base branch is not also blamed for it',
    !empty.some((c) => c.name.includes('Base branch')),
    empty.map((c) => c.name).join(', ')
  );

  ok(
    'a base branch that does not exist',
    named(await checkSetup(env({ branchExists: () => false })), 'Base branch')
  );
  ok(
    'the backend missing',
    named(await checkSetup(env({ backendInstalled: () => Promise.resolve(false) })), 'installed')
  );
  ok(
    'no provider configured',
    named(await checkSetup(env({ modelCount: () => Promise.resolve(0) })), 'model')
  );

  // A backend that is not there cannot be asked about models, and saying both
  // makes the real problem harder to find.
  const noBackend = await checkSetup(env({ backendInstalled: () => Promise.resolve(false) }));
  ok(
    'a missing backend is not also reported as a missing model',
    !noBackend.some((c) => c.name.includes('model')),
    noBackend.map((c) => c.name).join(', ')
  );

  console.log('\nthings that throw rather than answer');

  const throwing = await checkSetup(
    env({
      backendInstalled: () => Promise.reject(new Error('spawn ENOENT')),
    })
  );
  ok('a throwing check counts as a failure, not a crash', named(throwing, 'installed'));

  console.log('\nwhat gets said');

  const one = await checkSetup(env({ isGitRepo: () => false }));
  ok('a single problem is stated in full', (summarise(one) || '').includes('git init'));
  const several = await checkSetup(
    env({ isGitRepo: () => false, backendInstalled: () => Promise.resolve(false) })
  );
  ok('several are counted rather than listed', (summarise(several) || '').includes('2 things'));

  console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
