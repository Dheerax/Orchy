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
import * as vm from 'vm';

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
  GraphPanel: {
    prototype: { buildGitTree: (s: unknown[], h: unknown[]) => Row[]; html: () => string };
  };
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
const archived = (id: string, min: number): Record<string, unknown> => ({
  type: 'archived',
  session: id,
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

console.log('\ntidying up is not part of a branch');

/*
 * Sessions are archived and their worktrees deleted a while after they merge.
 * Treating that as the end of the lane kept every merged branch drawn until
 * the last archive landed — lanes running the full height of the list, past
 * every merge that had already closed them.
 */
const tidied = rows(
  [
    spawned('a', 1),
    spawned('b', 2),
    merged('a', 3),
    merged('b', 4),
    archived('a', 5),
    archived('b', 6),
  ],
  ['a', 'b']
);
const laneA = tidied.find((r) => r.sessionId === 'a' && r.kind === 'fork')?.lane ?? -1;
const mergeB = tidied.findIndex((r) => r.kind === 'merge' && r.sessionId === 'b');
ok(
  'a merged branch is gone by the next merge',
  mergeB >= 0 && !(tidied[mergeB].activeLanes || []).includes(laneA),
  `lane ${laneA} still active at row ${mergeB}: ${JSON.stringify(tidied[mergeB]?.activeLanes)}`
);
ok(
  'so lanes thin out towards the newest row',
  (tidied[0]?.activeLanes || []).length <= (tidied[tidied.length - 1]?.activeLanes || []).length,
  `${JSON.stringify(tidied[0]?.activeLanes)} vs ${JSON.stringify(tidied[tidied.length - 1]?.activeLanes)}`
);

console.log('\nthe timeline as drawn');

/** Enough DOM for the graph script to boot and draw. */
function drawnRail(commits: Record<string, unknown>[]): string {
  const source = (() => {
    const html = GraphPanel.prototype.html.call({} as never);
    const open = html.indexOf('<script');
    return html.slice(html.indexOf('>', open) + 1, html.indexOf('</script>', open));
  })();

  const makeEl = (id: string): Record<string, unknown> => ({
    id,
    innerHTML: '',
    textContent: '',
    clientWidth: 900,
    scrollHeight: 0,
    style: { setProperty: (): void => undefined },
    classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
    addEventListener: () => undefined,
    appendChild: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
  });

  const nodes: Record<string, Record<string, unknown>> = {};
  for (const id of [
    'commit-count', 'd-body', 'd-close', 'd-title', 'dag-canvas', 'git-graph',
    'git-detail', 'git-tree-pane', 'hud', 'inspector-drawer', 'scope-btn',
    'search', 'workflow-pane',
  ]) {
    nodes[id] = makeEl(id);
  }

  const listeners: ((e: { data: unknown }) => void)[] = [];
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: {
      getElementById: (id: string) => nodes[id] ?? makeEl(id),
      createElementNS: () => ({ innerHTML: '', setAttribute: () => undefined }),
      querySelectorAll: () => [],
      body: { style: { setProperty: (): void => undefined } },
      addEventListener: () => undefined,
    },
    window: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    setTimeout: () => 0,
    console: { log: () => undefined, error: () => undefined },
  };
  // The script registers its snapshot listener on window; capture it directly.
  sandbox.window.addEventListener = ((type: string, fn: (e: { data: unknown }) => void) => {
    if (type === 'message') {
      listeners.push(fn);
    }
  }) as never;

  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);

  for (const fn of listeners) {
    fn({
      data: {
        type: 'snapshot',
        data: { nodes: [], edges: [], gitTree: commits, stats: null, showAllRuns: false },
      },
    });
  }
  return String(nodes['git-graph'].innerHTML ?? '');
}

const timeline = drawnRail(
  GraphPanel.prototype.buildGitTree.call(
    {},
    ['core', 'email', 'phone'].map(session),
    [
      spawned('core', 1), done('core', 2), merged('core', 3),
      spawned('email', 4), spawned('phone', 5),
      done('email', 6), merged('email', 7),
      done('phone', 8),
    ].reverse()
  ) as unknown as Record<string, unknown>[]
);

ok('something was drawn', timeline.includes('<svg'));
ok('main is labelled', timeline.includes('>main<'));

const dots = [...timeline.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map((m) => [
  Number(m[1]),
  Number(m[2]),
]);
const squares = [...timeline.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)"/g)].map((m) => [
  Number(m[1]) + 5.2,
  Number(m[2]) + 5.2,
]);
const targets = [...dots, ...squares];
/* Every fork and merge curve has to land on a commit. A curve ending in empty
   space is the "line coming out of nowhere" this graph kept producing. */
const ends = [...timeline.matchAll(/C[^"]*?,([-\d.]+) ([-\d.]+)"/g)].map((m) => [
  Number(m[1]),
  Number(m[2]),
]);
const near = (a: number[], b: number[]): boolean =>
  Math.abs(a[0] - b[0]) < 0.6 && Math.abs(a[1] - b[1]) < 0.6;
const orphans = ends.filter((e) => !targets.some((t) => near(e, t)));

ok('branches leave and rejoin', ends.length >= 3, `${ends.length} curves`);
ok(
  'every curve ends on a commit',
  orphans.length === 0,
  `${orphans.length} of ${ends.length} land in empty space: ${JSON.stringify(orphans.slice(0, 4))}`
);

console.log('\na branch that ends without merging');

/*
 * A branch archived rather than merged closes at its own dot. Its lane must
 * not carry on to the right of it — to the right is later, and there is no
 * later for a branch that has ended.
 */
const closing = drawnRail(
  GraphPanel.prototype.buildGitTree.call(
    {},
    [session('solo')],
    [spawned('solo', 1), done('solo', 2), archived('solo', 3)].reverse()
  ) as unknown as Record<string, unknown>[]
);

const stopDot = /<circle cx="([-\d.]+)" cy="([-\d.]+)"[^>]*stroke="var\(--muted\)"/.exec(closing);
ok('the closing commit draws a stop', stopDot !== null, closing.slice(0, 240));

if (stopDot) {
  const sx = Number(stopDot[1]);
  const sy = Number(stopDot[2]);
  const past = [...closing.matchAll(
    /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g
  )]
    .map((m) => ({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }))
    .filter((l) => Math.abs(l.y1 - sy) < 0.6 && Math.max(l.x1, l.x2) > sx + 0.6);
  ok(
    'and its lane stops there',
    past.length === 0,
    `${past.length} segment(s) past the stop at x=${sx}: ${JSON.stringify(past)}`
  );
}

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
