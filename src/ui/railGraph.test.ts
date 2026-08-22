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

console.log('\nthe rail as drawn');

/** Enough DOM for the graph script to boot and measure rows. */
function drawnRail(commits: Record<string, unknown>[]): string {
  const source = (() => {
    const html = GraphPanel.prototype.html.call({} as never);
    const open = html.indexOf('<script');
    return html.slice(html.indexOf('>', open) + 1, html.indexOf('</script>', open));
  })();

  let overlayHtml = '';
  const ROW_H = 90;

  const makeEl = (id: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      id,
      innerHTML: '',
      textContent: '',
      clientWidth: 520,
      scrollHeight: 0,
      style: { setProperty: (): void => undefined },
      classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
      addEventListener: () => undefined,
      appendChild: (child: { outerKind?: string; innerHTML?: string }) => {
        if (child && child.outerKind === 'svg') {
          overlayHtml = String(child.innerHTML ?? '');
        }
      },
      querySelector: () => null,
      querySelectorAll: (sel: string) => {
        if (sel === '.git-row') {
          const n = String(el.innerHTML ?? '').split('class="git-row').length - 1;
          return Array.from({ length: n }, (_, i) => ({
            offsetTop: i * ROW_H,
            offsetHeight: ROW_H,
          }));
        }
        return [];
      },
    };
    return el;
  };

  const nodes: Record<string, Record<string, unknown>> = {};
  for (const id of [
    'commit-count', 'd-body', 'd-close', 'd-title', 'dag-canvas', 'git-tree-list',
    'git-tree-pane', 'hud', 'inspector-drawer', 'scope-btn', 'search', 'workflow-pane',
  ]) {
    nodes[id] = makeEl(id);
  }

  const listeners: ((e: { data: unknown }) => void)[] = [];
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: () => undefined }),
    document: {
      getElementById: (id: string) => nodes[id] ?? makeEl(id),
      createElementNS: () => ({
        outerKind: 'svg',
        innerHTML: '',
        setAttribute: () => undefined,
      }),
      body: { style: { setProperty: (): void => undefined } },
      addEventListener: () => undefined,
    },
    window: {
      addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
        if (type === 'message') {
          listeners.push(fn);
        }
      },
      removeEventListener: () => undefined,
    },
    setTimeout: () => 0,
    console: { log: () => undefined, error: () => undefined },
  };
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
  return overlayHtml;
}

const rail = drawnRail(
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

ok('something was drawn', rail.length > 0);

/* Every curve has to land on a commit dot. A path ending in empty space is
   precisely the "line coming out of nowhere" this graph kept producing. */
const dots = [...rail.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map((m) => [
  Number(m[1]),
  Number(m[2]),
]);
const squares = [...rail.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)"/g)].map((m) => [
  Number(m[1]) + 5.2,
  Number(m[2]) + 5.2,
]);
const targets = [...dots, ...squares];
const ends = [...rail.matchAll(/C[^"]*?,([-\d.]+) ([-\d.]+)"/g)].map((m) => [
  Number(m[1]),
  Number(m[2]),
]);

const near = (a: number[], b: number[]): boolean =>
  Math.abs(a[0] - b[0]) < 0.6 && Math.abs(a[1] - b[1]) < 0.6;
const orphans = ends.filter((e) => !targets.some((t) => near(e, t)));

ok('curves exist at all', ends.length > 0, `${ends.length} curves, ${targets.length} dots`);
ok(
  'every curve ends on a dot',
  orphans.length === 0,
  `${orphans.length} of ${ends.length} land in empty space: ${JSON.stringify(orphans.slice(0, 4))}`
);

/* And nothing is drawn outside the list. */
const ys = [...rail.matchAll(/y[12]?="([-\d.]+)"/g)].map((m) => Number(m[1]));
ok('nothing is drawn above the first row', Math.min(...ys) >= -0.01, `min y ${Math.min(...ys)}`);

console.log('\na branch that ends on the newest row');

/*
 * The last of the stray lines: a branch archived without merging closes on the
 * very top row, and the rail carried on above its dot to the edge of the list.
 * Drawn beside the trunk it read as a second main line.
 */
const closing = drawnRail(
  GraphPanel.prototype.buildGitTree.call(
    {},
    [session('solo')],
    [spawned('solo', 1), done('solo', 2), archived('solo', 3)].reverse()
  ) as unknown as Record<string, unknown>[]
);

const stopDot = /<circle cx="([-\d.]+)" cy="([-\d.]+)"[^>]*stroke="var\(--muted\)"/.exec(closing);
ok('the closing row draws a stop', stopDot !== null, closing.slice(0, 200));

if (stopDot) {
  const cx = Number(stopDot[1]);
  const cy = Number(stopDot[2]);
  const above = [...closing.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="[-\d.]+" y2="([-\d.]+)"/g)]
    .map((m) => ({ x: Number(m[1]), y1: Number(m[2]), y2: Number(m[3]) }))
    .filter((l) => Math.abs(l.x - cx) < 0.6 && Math.min(l.y1, l.y2) < cy - 0.6);
  ok(
    'and nothing runs above it',
    above.length === 0,
    `${above.length} segment(s) above the stop at y=${cy}: ${JSON.stringify(above)}`
  );
}

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
