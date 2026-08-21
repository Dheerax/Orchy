/** Run with:  node out/core/planner.test.js */
import { Planner } from './planner';
import { PlannedAgent } from './types';

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  checks++;
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(
      `  FAIL ${label}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`
    );
  }
}
const ok = (label: string, cond: boolean): void => check(label, cond, true);

function agent(over: Partial<PlannedAgent> = {}): PlannedAgent {
  return {
    role: 'x',
    task: 't',
    deliverables: [{ kind: 'file', spec: 'f.ts', verified: false }],
    dependsOn: [],
    provides: [],
    needs: [],
    ...over,
  };
}

console.log('\nplan validation');

check(
  'a clean plan warns about nothing',
  Planner.validate([
    agent({ deliverables: [{ kind: 'file', spec: 'a.ts', verified: false }] }),
    agent({ role: 'y', deliverables: [{ kind: 'file', spec: 'b.ts', verified: false }] }),
  ]),
  []
);

const unmet = Planner.validate([agent({ role: 'api', needs: ['User'] })]);
ok(
  'a need nobody provides is caught',
  unmet.some((w) => w.includes('no agent in this plan provides'))
);

const unordered = Planner.validate([
  agent({ role: 'schema', provides: [{ symbol: 'User', file: 'user.ts' }] }),
  agent({ role: 'api', needs: ['User'] }),
]);
ok(
  'a need that exists but is not depended on is caught',
  unordered.some((w) => w.includes('does not depend on it'))
);

const ordered = Planner.validate([
  agent({ role: 'schema', provides: [{ symbol: 'User', file: 'user.ts' }] }),
  agent({ role: 'api', needs: ['User'], dependsOn: [0] }),
]);
check('depending on the provider clears it', ordered, []);

const transitive = Planner.validate([
  agent({ role: 'schema', provides: [{ symbol: 'User', file: 'user.ts' }] }),
  agent({ role: 'api', dependsOn: [0] }),
  agent({ role: 'tests', needs: ['User'], dependsOn: [1] }),
]);
check('a transitive dependency is enough', transitive, []);

const duplicated = Planner.validate([
  agent({ role: 'a', provides: [{ symbol: 'User', file: 'a.ts' }] }),
  agent({ role: 'b', provides: [{ symbol: 'User', file: 'b.ts' }] }),
]);
ok(
  'two agents promising one symbol is caught',
  duplicated.some((w) => w.includes('both promise'))
);

const cyclic = Planner.validate([
  agent({ role: 'a', dependsOn: [1] }),
  agent({ role: 'b', dependsOn: [0] }),
]);
ok(
  'a dependency cycle is caught',
  cyclic.some((w) => w.includes('cycle'))
);

const noDeliverables = Planner.validate([agent({ deliverables: [] })]);
ok(
  'an agent with no deliverables is caught',
  noDeliverables.some((w) => w.includes('never be verified'))
);

console.log('\nconflict prediction');

const collide = Planner.validate([
  agent({ role: 'a', deliverables: [{ kind: 'file', spec: 'src/app.ts', verified: false }] }),
  agent({ role: 'b', deliverables: [{ kind: 'file', spec: 'src/app.ts', verified: false }] }),
]);
ok(
  'two siblings writing one file is caught',
  collide.some((w) => w.includes('will conflict at merge'))
);

const chained = Planner.validate([
  agent({ role: 'a', deliverables: [{ kind: 'file', spec: 'src/app.ts', verified: false }] }),
  agent({
    role: 'b',
    dependsOn: [0],
    deliverables: [{ kind: 'file', spec: 'src/app.ts', verified: false }],
  }),
]);
check('a dependent editing the same file is fine', chained, []);

const differentFiles = Planner.validate([
  agent({ role: 'a', deliverables: [{ kind: 'file', spec: 'src/a.ts', verified: false }] }),
  agent({ role: 'b', deliverables: [{ kind: 'file', spec: 'src/b.ts', verified: false }] }),
]);
check('different files do not warn', differentFiles, []);

const viaProvides = Planner.validate([
  agent({ role: 'a', provides: [{ symbol: 'X', file: 'src/shared.ts' }] }),
  agent({ role: 'b', provides: [{ symbol: 'Y', file: './src/shared.ts' }] }),
]);
ok(
  'contract files count too, and paths normalise',
  viaProvides.some((w) => w.includes('src/shared.ts'))
);

console.log('\napproval');

const planner = new Planner();
const plan = planner.propose('Add profiles', [agent()]);
check('a new plan is proposed', plan.status, 'proposed');
check('and is pending', planner.pending().length, 1);

planner.settle(plan.id, 'approved');
check('approving settles it', planner.get(plan.id)?.status, 'approved');
check('and it stops being pending', planner.pending().length, 0);
check('settling twice does not flip it', planner.settle(plan.id, 'rejected')?.status, 'approved');

void (async (): Promise<void> => {
  const pending = planner.propose('Second', [agent()]);
  const decision = planner.awaitDecision(pending.id, 5000);
  planner.settle(pending.id, 'rejected');
  check('awaitDecision resolves on a decision', (await decision)?.status, 'rejected');

  const already = planner.propose('Third', [agent()]);
  planner.settle(already.id, 'approved');
  check(
    'awaiting an already-settled plan returns at once',
    (await planner.awaitDecision(already.id, 5000))?.status,
    'approved'
  );

  console.log(
    failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
