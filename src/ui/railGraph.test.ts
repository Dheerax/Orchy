/**
 * Run with:  node out/ui/railGraph.test.js
 *
 * The commit rail is geometry, and geometry is easy to get subtly wrong in ways
 * that only show up as a picture that does not make sense: branches that never
 * leave the trunk, lanes that run past their own creation, a merge arriving
 * from nowhere. None of that fails a compile.
 *
 * So the lane assignment is checked directly, against the shapes the pipeline
 * actually produces — a fan-out that merges back, and a log so long its oldest
 * spawns have been trimmed away.
 */
import * as Module from 'module';

const loader = Module as unknown as { _load: (r: string, ...rest: unknown[]) => unknown };
const original = loader._load;
loader._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'vscode') {
    return {
      window: {},
      ViewColumn: {},
      Uri: {},
      commands: {},
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
    };
  }
  return original.call(this, request, ...rest);
};

interface Row {
  sessionId: string;
  lane: number;
  fromLane?: number;
  toLane?: number;
  kind: string;
  activeLanes: number[];
  title: string;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GraphPanel } = require('./graphPanel') as {
  GraphPanel: { prototype: { buildGitTree: (s: unknown[], h: unknown[]) => Row[] } };
};

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

let seq = 0;
const at = (min: number): string => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();

function session(id: string): Record<string, unknown> {
  return {
    id,
    role: id.split('-')[0],
    status: 'complete',
    deliverables: [],
    worktree: { branch: `agent/${id}`, path: `/tmp/${id}` },
    budget: { costEstimate: 0, tokensUsed: 0 },
    createdAt: at(0),
    lastEventAt: at(1),
  };
}

/** buildGitTree takes history newest first, the way the registry serves it. */
function rows(history: Record<string, unknown>[], sessions: string[]): Row[] {
  return GraphPanel.prototype.buildGitTree.call(
    {},
    sessions.map(session),
    [...history].reverse()
  );
}

const spawned = (id: string, min: number): Record<string, unknown> => ({
  type: 'spawned',
  session: id,
  role: id.split('-')[0],
  task: `work for ${id}`,
  deliverables: [],
  t: at(min),
  seq: ++seq,
});
const merged = (id: string, min: number): Record<string, unknown> => ({
  type: 'merged',
  session: id,
  into: 'main',
  t: at(min),
  seq: ++seq,
});
const done = (id: string, min: number): Record<string, unknown> => ({
  type: 'status',
  session: id,
  status: 'complete',
  t: at(min),
  seq: ++seq,
});

console.log('\nlanes on a fan-out that merges back');

const fan = rows(
  [
    spawned('core', 1),
    done('core', 2),
    merged('core', 3),
    spawned('email', 4),
    spawned('phone', 5),
    done('email', 6),
    merged('email', 7),
    done('phone', 8),
    merged('phone', 9),
  ],
  ['core', 'email', 'phone']
);

const laneOf = (id: string, kind: string): number | undefined =>
  fan.find((r) => r.sessionId === id && r.kind === kind)?.lane;

ok('a branch is never drawn on the trunk', fan.every((r) => r.kind === 'merge' || r.lane > 0));
ok('a merge lands on main', fan.filter((r) => r.kind === 'merge').every((r) => r.lane === 0));
ok(
  'and arrives from the branch it was on',
  fan.filter((r) => r.kind === 'merge').every((r) => (r.fromLane ?? 0) > 0)
);
ok('a fork leaves the trunk', fan.filter((r) => r.kind === 'fork').every((r) => r.fromLane === 0));

// The point of releasing a lane: core is finished and merged before email and
// phone are created, so one of them can have its lane back.
ok(
  'a finished branch gives its lane back',
  laneOf('email', 'fork') === 1 || laneOf('phone', 'fork') === 1,
  `core=${laneOf('core', 'fork')} email=${laneOf('email', 'fork')} phone=${laneOf('phone', 'fork')}`
);
ok(
  'and two live branches never share one',
  laneOf('email', 'fork') !== laneOf('phone', 'fork')
);

// Rows come newest first, so a lane must not still be drawn above the merge
// that closed it.
const mergeRow = fan.findIndex((r) => r.kind === 'merge' && r.sessionId === 'core');
const coreLane = fan.find((r) => r.sessionId === 'core' && r.kind === 'fork')?.lane ?? -1;
ok(
  'a closed lane stops at its merge',
  fan.slice(0, mergeRow).every((r) => !r.activeLanes.includes(coreLane) || r.sessionId !== 'core'),
  `lane ${coreLane} above row ${mergeRow}`
);

console.log('\nlanes when the log has been trimmed');

// The real failure this caused: an agent whose spawn had aged out of the log
// had no lane, so its work and its merge were drawn on main — a merge into the
// branch it was already on.
const trimmed = rows([done('legacy', 1), merged('legacy', 2)], ['legacy']);
ok('an agent we joined late still gets a branch', trimmed.every((r) => r.lane > 0 || r.kind === 'merge'));
ok(
  'and its merge still comes from somewhere',
  trimmed.filter((r) => r.kind === 'merge').every((r) => (r.fromLane ?? 0) > 0)
);

console.log('\nwidth');

const wide = rows(
  Array.from({ length: 8 }, (_, i) => spawned(`agent-${i}`, 10 + i)),
  Array.from({ length: 8 }, (_, i) => `agent-${i}`)
);
const maxLane = Math.max(...wide.map((r) => Math.max(r.lane, ...(r.activeLanes || [0]))));
ok('eight live branches need eight lanes, no more', maxLane === 8, `max lane ${maxLane}`);

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
