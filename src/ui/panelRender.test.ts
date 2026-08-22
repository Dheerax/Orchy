/**
 * Run with:  node out/ui/panelRender.test.js
 *
 * The window's renderer is a string inside a TypeScript template literal, so the
 * compiler never parses it and the build never fails on it. A typo there costs a
 * package-install-reload cycle to find, and the failure is silent: a script that
 * does not parse means a window that draws nothing, which looks exactly like a
 * pipeline with nothing in it.
 *
 * That happened. A newline escape written with one backslash became a real line
 * break in the emitted JavaScript, inside a quoted string, and the whole panel
 * died — through four releases, because the test read the TypeScript source,
 * where the escape is still two innocent characters.
 *
 * So this reads the HTML the extension actually serves, from the compiled
 * module, and parses the script the way a browser would.
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
      env: {},
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
    };
  }
  return original.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GraphPanel } = require('./graphPanel') as {
  GraphPanel: { prototype: { html: () => string } };
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

interface StubEl {
  innerHTML: string;
  textContent: string;
  className: string;
  style: { display: string; setProperty: () => void };
  classList: { add: () => void; remove: () => void; toggle: () => void };
  addEventListener: () => void;
  querySelector: () => StubEl;
  querySelectorAll: () => StubEl[];
  clientWidth: number;
  scrollHeight: number;
  appendChild: () => void;
}

function el(): StubEl {
  const node = {
    innerHTML: '',
    textContent: '',
    className: '',
    style: { display: '', setProperty: (): void => undefined },
    classList: {
      add: (): void => undefined,
      remove: (): void => undefined,
      toggle: (): void => undefined,
    },
    addEventListener: (): void => undefined,
    querySelectorAll: (): StubEl[] => [],
    clientWidth: 900,
    scrollHeight: 0,
    appendChild: (): void => undefined,
  } as unknown as StubEl;
  node.querySelector = (): StubEl => node;
  return node;
}

const html = GraphPanel.prototype.html.call({} as never);
const open = html.indexOf('<script');
const source = html.slice(html.indexOf('>', open) + 1, html.indexOf('</script>', open));

console.log('\nthe script the webview is actually served');

let parsed = true;
let why = '';
try {
  new vm.Script(source);
} catch (err) {
  parsed = false;
  why = err instanceof Error ? err.message : String(err);
}
ok('it parses as JavaScript', parsed, why);
ok('and it is the whole renderer, not a fragment', source.includes('function renderAgents'));

if (!parsed) {
  console.log(`\n${failures} of ${checks} FAILED\n`);
  process.exit(1);
}

console.log('\none window, with everything in it');

ok('the agents', html.includes('data-view="agents"'));
ok('the pipeline diagram', html.includes('id="dag-canvas"'));
ok('the branch history', html.includes('id="git-graph"'));
ok('the inspector', html.includes('id="inspector-drawer"'));
ok('a spawn control', html.includes('data-act="spawn"'));
ok('and a way to reach the project rules', html.includes('data-act="openConfig"'));
ok(
  'nothing is left of the workspace-layout command',
  !html.includes('setupLayout'),
  'splitting the editor stopped being necessary once everything shared a tab'
);

function boot(): { send: (data: unknown) => void; nodes: Record<string, StubEl> } {
  const nodes: Record<string, StubEl> = {};
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: (): void => undefined }),
    document: {
      getElementById: (id: string) => (nodes[id] = nodes[id] ?? el()),
      querySelector: () => el(),
      querySelectorAll: (): StubEl[] => [],
      createElementNS: () => ({ innerHTML: '', setAttribute: (): void => undefined }),
      body: { style: { setProperty: (): void => undefined } },
      addEventListener: (): void => undefined,
    },
    window: {
      addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
        if (type === 'message') {
          listeners.push(fn);
        }
      },
      removeEventListener: (): void => undefined,
    },
    setTimeout: (): number => 0,
    console: { log: (): void => undefined, error: (): void => undefined },
  };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  return {
    send: (data) => listeners.forEach((fn) => fn({ data: { type: 'snapshot', data } })),
    nodes,
  };
}

const base = { nodes: [], edges: [], gitTree: [], stats: null, showAllRuns: false };

console.log('\nnothing running');

const idle = boot();
idle.send({ ...base });
ok(
  'says what this view would show, rather than drawing an empty canvas',
  (idle.nodes['agents-body']?.innerHTML ?? '').includes('No agents yet')
);
// Three panes repeating one sentence is indistinguishable from a button that
// does not work — which is exactly how the mode switch read with no agents.
ok(
  'and each view says something different',
  !source.includes("lines[where] || lines[where]") && source.includes('No branches yet')
);

console.log('\nagents in a run');

const running = boot();
running.send({
  ...base,
  nodes: [
    {
      id: 'core-1',
      role: 'core',
      status: 'running',
      task: 'Build the interface',
      model: 'google/flash',
      spend: 0.02,
      merged: false,
      deliverablesCount: 2,
      deliverablesVerified: 1,
      dependsOn: [],
      dependents: [],
      provides: [],
      needs: [],
    },
  ],
});
const body = running.nodes['agents-body']?.innerHTML ?? '';
ok('the agent is listed', body.includes('core-1'));
ok('with what it has actually verified', body.includes('1/2 verified'));
ok('what it has cost', body.includes('0.020'));
ok('and a way into its terminal', body.includes('data-act="openTerminal"'));

console.log('\na plan awaiting approval');

const planning = boot();
planning.send({
  ...base,
  plan: {
    id: 'p1',
    summary: 'Pluggable event sinks',
    warnings: ['tests declares no deliverables'],
    agents: [
      {
        role: 'contract',
        task: 'Define the Sink interface',
        model: 'google/strong',
        dependsOn: [],
        provides: [{ symbol: 'Sink', file: 'src/sinks/types.js' }],
        needs: [],
        deliverables: [{ spec: 'src/sinks/types.js' }],
      },
      {
        role: 'console-sink',
        task: 'Write it',
        model: 'opencode/cheap',
        dependsOn: [0],
        provides: [],
        needs: ['Sink'],
        deliverables: [],
      },
    ],
  },
});
const planBody = planning.nodes['agents-body']?.innerHTML ?? '';
ok('the plan takes over the pane', planBody.includes('Pluggable event sinks'));
ok('every agent is shown', planBody.includes('contract') && planBody.includes('console-sink'));
ok('with the stage each runs in', planBody.includes('Stage 1') && planBody.includes('Stage 2'));
ok('and the interface it owes', planBody.includes('Sink'));
ok('warnings are not hidden behind the decision', planBody.includes('no deliverables'));
ok('it can be approved', planBody.includes('data-plan="approvePlan"'));
ok('or sent back for changes', planBody.includes('data-plan="revisePlan"'));

// The decision is the point of the screen; whatever is running can wait.
ok(
  'and a plan outranks the run behind it',
  !planBody.includes('data-act="openTerminal"'),
  'the pane shows the decision, not the agents behind it'
);

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
