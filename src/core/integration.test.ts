/**
 * Integration test: real git worktrees, real filesystem, fake backend.
 *
 * Run with:  node out/core/integration.test.js
 *
 * The backend is faked because we are testing Orchy's rules, not OpenCode's.
 * Everything else — worktree creation, isolation, deliverable verification,
 * dirty-worktree refusal — runs for real against a throwaway repository.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentBackend,
  AgentEvent,
  BackendCapabilities,
  BackendHandle,
  SpawnOpts,
} from '../backends/types';
import { DeliverableVerifier } from './deliverableVerifier';
import { EventLog } from './eventLog';
import { Orchestrator } from './orchestrator';
import { SessionRegistry } from './sessionRegistry';
import { WorktreeDirtyError, WorktreeManager } from './worktreeManager';

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

function ok(label: string, condition: boolean): void {
  check(label, condition, true);
}

/** Wait for the auto-verify that a backend going idle kicks off. */
function onceVerified(orchestrator: Orchestrator, id: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      orchestrator.off('verified', onVerified);
      reject(new Error(`timed out waiting for ${id} to be verified`));
    }, timeoutMs);
    function onVerified(session: { id: string } | undefined): void {
      if (session?.id !== id) {
        return;
      }
      clearTimeout(timer);
      orchestrator.off('verified', onVerified);
      resolve();
    }
    orchestrator.on('verified', onVerified);
  });
}

class FakeBackend implements AgentBackend {
  readonly id = 'cli' as const;
  readonly displayName = 'Fake';
  private listeners = new Map<string, (e: AgentEvent) => void>();
  spawnedWith: SpawnOpts[] = [];

  capabilities(): BackendCapabilities {
    return { images: false, attachTui: true, checkpoints: false };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async spawn(opts: SpawnOpts): Promise<BackendHandle> {
    this.spawnedWith.push(opts);
    return { id: `fake-${opts.sessionId}`, directory: opts.directory };
  }
  async send(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async kill(): Promise<void> {}
  subscribe(handle: BackendHandle, listener: (e: AgentEvent) => void): () => void {
    this.listeners.set(handle.id, listener);
    return () => this.listeners.delete(handle.id);
  }
  attachCommand(): { command: string; args: string[] } {
    return { command: 'echo', args: ['fake'] };
  }
  /** Drive the orchestrator the way a real backend's event stream would. */
  emit(sessionId: string, event: AgentEvent): void {
    this.listeners.get(`fake-${sessionId}`)?.(event);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-int-'));
const repo = path.join(tmp, 'demo');
fs.mkdirSync(repo);

const git = (args: string[], cwd: string = repo): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

git(['init', '-b', 'main']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'Test']);
fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
git(['add', '-A']);
git(['commit', '-m', 'init']);

console.log('\nworktree manager');

const worktrees = new WorktreeManager(repo);
ok('detects a git repository', worktrees.isGitRepo());
check('no remote in a local-only repo', worktrees.hasRemote(), false);
check('falls back to the local base branch', worktrees.resolveBase('main').ref, 'main');

// .worktreeinclude carries gitignored-but-required files into fresh worktrees.
fs.writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n');
fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');

const wt = worktrees.create('ui-1', 'main');
ok('worktree directory exists', fs.existsSync(wt.path));
check('branch is derived from the session id', wt.branch, 'agent/ui-1');
ok('tracked files are present', fs.existsSync(path.join(wt.path, 'README.md')));
ok('gitignored .env was bootstrapped in', fs.existsSync(path.join(wt.path, '.env')));
check('worktree starts clean', worktrees.dirtyFiles(wt.path), []);

// Git itself guarantees two agents can never share a branch.
let sameBranchRejected = false;
try {
  execFileSync('git', ['worktree', 'add', path.join(tmp, 'dup'), 'agent/ui-1'], {
    cwd: repo,
    stdio: 'ignore',
  });
} catch {
  sameBranchRejected = true;
}
ok('git refuses the same branch in two worktrees', sameBranchRejected);

// Isolation: writing in one worktree must not touch the main checkout.
fs.writeFileSync(path.join(wt.path, 'agent-work.txt'), 'written by the agent\n');
ok('main checkout is untouched', !fs.existsSync(path.join(repo, 'agent-work.txt')));
check('dirty worktree is detected', worktrees.dirtyFiles(wt.path).length, 1);

let refusedDirty = false;
try {
  worktrees.remove(wt.path);
} catch (err) {
  refusedDirty = err instanceof WorktreeDirtyError;
}
ok('refuses to remove a dirty worktree', refusedDirty);
ok('worktree survived the refusal', fs.existsSync(wt.path));

worktrees.remove(wt.path, { force: true });
ok('force removes it', !fs.existsSync(wt.path));

console.log('\norchestrator: spawn, verify, complete');

const registry = new SessionRegistry(new EventLog(path.join(repo, '.orchy')));
const backend = new FakeBackend();
const orchestrator = new Orchestrator(
  registry,
  worktrees,
  backend,
  new DeliverableVerifier(),
  { baseBranch: 'main' }
);

void (async (): Promise<void> => {
  const session = await orchestrator.spawn({
    role: 'ui',
    task: 'Build the settings page',
    deliverables: [
      { kind: 'file', spec: 'Settings.tsx', verified: false },
      { kind: 'command', spec: 'git --version', verified: false },
    ],
  });

  check('session id skips the branch left by an earlier worktree', session.id, 'ui-2');
  check('spawned session is running', session.status, 'running');
  ok('a worktree was created for it', !!session.worktree && fs.existsSync(session.worktree.path));

  const prompt = backend.spawnedWith[0].task;
  ok('the agent is told its deliverables', prompt.includes('Settings.tsx'));
  ok('the agent is warned off shared git state', prompt.includes('git stash'));

  // The backend goes quiet without producing anything — the exact failure mode
  // that motivated this project.
  const firstVerify = onceVerified(orchestrator, session.id);
  backend.emit(session.id, { kind: 'status', status: 'idle_unverified' });
  await firstVerify;

  const afterIdle = registry.get(session.id);
  check('idle without deliverables is not complete', afterIdle?.status, 'idle_unverified');
  check(
    'the missing deliverable is named',
    afterIdle?.deliverables.find((d) => d.spec === 'Settings.tsx')?.detail,
    'file not found: Settings.tsx'
  );
  check(
    'a passing command deliverable is recognised',
    afterIdle?.deliverables.find((d) => d.spec === 'git --version')?.verified,
    true
  );
  check('it shows up as needing attention', registry.needingAttention().length, 1);

  // Now the agent actually does the work.
  fs.writeFileSync(path.join(session.worktree!.path, 'Settings.tsx'), 'export const S = 1;\n');
  const verified = await orchestrator.verify(session.id);
  check('verification promotes it to complete', verified?.status, 'complete');
  check('nothing needs attention once verified', registry.needingAttention().length, 0);

  console.log('\nempty files do not count as delivered');

  const empty = await orchestrator.spawn({
    role: 'docs',
    task: 'Write the guide',
    deliverables: [{ kind: 'file', spec: 'GUIDE.md', verified: false }],
  });
  // The agent creates the file but writes nothing, then reports done.
  fs.writeFileSync(path.join(empty.worktree!.path, 'GUIDE.md'), '');
  const emptyVerify = onceVerified(orchestrator, empty.id);
  backend.emit(empty.id, { kind: 'status', status: 'idle_unverified' });
  await emptyVerify;
  const emptyChecked = registry.get(empty.id);
  check('an empty file is not a deliverable', emptyChecked?.status, 'idle_unverified');
  check(
    'and it says why',
    emptyChecked?.deliverables[0].detail,
    'file is empty: GUIDE.md'
  );

  console.log('\ndependencies');

  const base = await orchestrator.spawn({
    role: 'base',
    task: 'Create BASE.md',
    deliverables: [{ kind: 'file', spec: 'BASE.md', verified: false }],
  });
  const startedBefore = backend.spawnedWith.length;
  const dependent = await orchestrator.spawn({
    role: 'dependent',
    task: 'Build on the base',
    deliverables: [{ kind: 'file', spec: 'DEP.md', verified: false }],
    dependsOn: [base.id],
  });

  check('a dependent session is queued, not started', registry.get(dependent.id)?.status, 'queued');
  check('it records what it waits on', registry.get(dependent.id)?.dependsOn, [base.id]);
  check('the backend was never asked to start it', backend.spawnedWith.length, startedBefore);

  // The base agent does its work and commits, so there is something to inherit.
  fs.writeFileSync(path.join(base.worktree!.path, 'BASE.md'), '# base\n');
  git(['add', '-A'], base.worktree!.path);
  git(['commit', '-m', 'base work'], base.worktree!.path);

  const released = onceVerified(orchestrator, base.id);
  backend.emit(base.id, { kind: 'status', status: 'idle_unverified' });
  await released;
  await new Promise((r) => setTimeout(r, 400));

  check('completing the base releases the dependent', registry.get(dependent.id)?.status, 'running');
  check('and the backend started it', backend.spawnedWith.length, startedBefore + 1);
  ok(
    'the dependent inherited the base commit',
    fs.existsSync(path.join(dependent.worktree!.path, 'BASE.md'))
  );

  console.log('\nrunPlan with inverted dependency order');

  const plan = orchestrator.planner.propose('Inverted pipeline', [
    {
      role: 'consumer',
      task: 'Consume API',
      deliverables: [{ kind: 'file', spec: 'CLIENT.md', verified: false }],
      dependsOn: [1],
      provides: [],
      needs: [],
    },
    {
      role: 'producer',
      task: 'Produce API',
      deliverables: [{ kind: 'file', spec: 'PROD.md', verified: false }],
      dependsOn: [],
      provides: [],
      needs: [],
    },
  ]);
  orchestrator.planner.settle(plan.id, 'approved');
  const planSessions = await orchestrator.runPlan(plan);
  check('runPlan creates all sessions', planSessions.length, 2);
  const consumerSession = planSessions.find((s) => s.role === 'consumer');
  const producerSession = planSessions.find((s) => s.role === 'producer');
  ok('consumer session exists', consumerSession !== undefined);
  ok('producer session exists', producerSession !== undefined);
  check('producer session is running', registry.get(producerSession!.id)?.status, 'running');
  check('consumer session is queued', registry.get(consumerSession!.id)?.status, 'queued');
  check(
    'consumer session depends on producer session id',
    registry.get(consumerSession!.id)?.dependsOn,
    [producerSession!.id]
  );

  console.log('\na dead dependency does not strand anyone');

  const doomed = await orchestrator.spawn({ role: 'doomed', task: 'x', deliverables: [] });
  const orphan = await orchestrator.spawn({
    role: 'orphan',
    task: 'y',
    deliverables: [],
    dependsOn: [doomed.id],
  });
  check('orphan starts queued', registry.get(orphan.id)?.status, 'queued');

  await orchestrator.kill(doomed.id);
  const other = await orchestrator.spawn({
    role: 'other',
    task: 'z',
    deliverables: [{ kind: 'file', spec: 'OTHER.md', verified: false }],
  });
  fs.writeFileSync(path.join(other.worktree!.path, 'OTHER.md'), 'x\n');
  const settled = onceVerified(orchestrator, other.id);
  backend.emit(other.id, { kind: 'status', status: 'idle_unverified' });
  await settled;
  await new Promise((r) => setTimeout(r, 300));

  check('orphan fails rather than waiting forever', registry.get(orphan.id)?.status, 'failed');
  ok(
    'and says which dependency killed it',
    (registry.get(orphan.id)?.lastError ?? '').includes(doomed.id)
  );

  console.log('\nmerge gating');

  let mergeRefused = '';
  try {
    await orchestrator.merge(empty.id);
  } catch (err) {
    mergeRefused = err instanceof Error ? err.message : String(err);
  }
  ok('unverified sessions cannot merge', mergeRefused.includes('not complete'));

  console.log('\nstate survives a reload');

  const reloaded = new SessionRegistry(new EventLog(path.join(repo, '.orchy')));
  check('session count survives', reloaded.all().length, registry.all().length);
  check('verified status survives', reloaded.get(session.id)?.status, 'complete');
  check('unverified status survives', reloaded.get(empty.id)?.status, 'idle_unverified');

  console.log('\ncleanup');

  await orchestrator.archive(session.id, { force: true });
  check('archived session is archived', registry.get(session.id)?.status, 'archived');
  ok('its worktree is gone', !fs.existsSync(session.worktree!.path));

  await orchestrator.archive(empty.id, { force: true });
  worktrees.prune();
  check('no orphaned worktrees remain', worktrees.orphans(), []);

  orchestrator.disposeAll();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(
    failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
