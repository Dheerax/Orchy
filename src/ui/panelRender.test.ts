/**
 * Run with:  node out/ui/panelRender.test.js
 *
 * The panel's renderer is a string inside a TypeScript template literal, so the
 * compiler never parses it and the build never fails on it. A typo there costs a
 * package-install-reload cycle to find, and the failure is silent: a script that
 * does not parse means a panel that draws nothing, which looks exactly like a
 * pipeline with nothing in it.
 *
 * That happened. A `\n` inside the template literal became a real line break in
 * the emitted JavaScript, inside a quoted string, and the whole panel died —
 * through four releases, because the test read the TypeScript source, where the
 * escape is still two innocent characters.
 *
 * So this reads the HTML the extension actually serves, from the compiled
 * module, and parses the script the way a browser would.
 */
import * as Module from 'module';
import * as vm from 'vm';

/* eslint-disable @typescript-eslint/no-explicit-any */
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WorkspacePanel } = require('./workspacePanel') as {
  WorkspacePanel: { prototype: { html: (boot?: string) => string }; bootHtml: (p: unknown) => string };
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
  id: string;
  style: { setProperty: () => void };
  addEventListener: () => void;
  querySelectorAll: () => StubEl[];
  querySelector: () => StubEl | null;
}

function el(id = ''): StubEl {
  return {
    innerHTML: '',
    textContent: '',
    className: '',
    id,
    style: { setProperty: (): void => undefined },
    addEventListener: (): void => undefined,
    querySelectorAll: (): StubEl[] => [],
    querySelector: (): StubEl | null => null,
  };
}

/** The served HTML, and the script inside it, exactly as a webview would get them. */
function servedScript(): string {
  const html = WorkspacePanel.prototype.html.call({} as never);
  const open = html.indexOf('<script');
  return html.slice(html.indexOf('>', open) + 1, html.indexOf('</script>', open));
}

function boot(source: string): {
  send: (data: unknown) => void;
  grid: StubEl;
  count: StubEl;
  posted: { type: string }[];
} {
  const nodes: Record<string, StubEl> = {
    grid: el('grid'),
    count: el('count'),
    hint: el('hint'),
    pager: el('pager'),
  };
  const listeners: ((e: { data: unknown }) => void)[] = [];
  const posted: { type: string }[] = [];
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: (m: { type: string }) => posted.push(m) }),
    document: {
      getElementById: (id: string) => nodes[id] ?? el(id),
      body: { style: { setProperty: (): void => undefined } },
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
    console,
  };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  return {
    send: (data: unknown) => listeners.forEach((fn) => fn({ data: { type: 'snapshot', data } })),
    grid: nodes.grid,
    count: nodes.count,
    posted,
  };
}

const plan = {
  id: 'b35ef9f3',
  summary: 'Validation library with parallel validators',
  status: 'proposed',
  createdAt: new Date().toISOString(),
  warnings: [],
  agents: [
    {
      role: 'core',
      task: 'Build the Validator base class.',
      model: 'google/antigravity-claude-sonnet-4-6',
      dependsOn: [],
      provides: [{ symbol: 'Validator', file: 'src/validator.js' }],
      needs: [],
      deliverables: [{ kind: 'file', spec: 'src/validator.js', verified: false }],
    },
    ...['email', 'phone', 'postcode'].map((kind) => ({
      role: `${kind}-validator`,
      task: `Implement the ${kind} validator on top of Validator.`,
      model: 'opencode/ling-3.0-flash-free',
      dependsOn: [0],
      provides: [{ symbol: `${kind}Validator`, file: `src/${kind}.js` }],
      needs: ['Validator'],
      deliverables: [{ kind: 'file', spec: `src/${kind}.js`, verified: false }],
    })),
    {
      role: 'tests',
      task: 'Cover every validator.',
      model: undefined,
      dependsOn: [1, 2, 3],
      provides: [],
      needs: ['emailValidator', 'phoneValidator', 'postcodeValidator'],
      deliverables: [{ kind: 'command', spec: 'node test/validation.test.js', verified: false }],
    },
  ],
};

const base = {
  sessions: [],
  rows: [],
  focused: undefined,
  page: 0,
  pages: 1,
  blocked: 0,
  archived: 0,
};

console.log('\nthe script the webview is actually served');

let source = '';
let parsed = true;
let why = '';
try {
  source = servedScript();
  new vm.Script(source);
} catch (err) {
  parsed = false;
  why = err instanceof Error ? err.message : String(err);
}
ok('it parses as JavaScript', parsed, why);
ok('and it is the whole renderer, not a fragment', source.includes('function paint'));

if (!parsed) {
  console.log(`\n${failures} of ${checks} FAILED\n`);
  process.exit(1);
}

console.log('\npanel rendering');

const panel = boot(source);
ok('the script asks for state as soon as it loads', panel.posted[0]?.type === 'ready');

panel.send({ ...base, plan });
ok('a plan renders', panel.grid.innerHTML.includes('id="plan"'));
ok('with every agent', plan.agents.every((a) => panel.grid.innerHTML.includes(a.role)));
ok('and a diagram, since there is more than one stage', panel.grid.innerHTML.includes('class="arch"'));
ok('nothing fell over', !panel.grid.innerHTML.includes('could not draw'));
ok('the header says a decision is wanted', panel.count.textContent.includes('approval'));

panel.send({ ...base, plan: undefined });
ok('an empty pipeline says so rather than going blank', panel.grid.innerHTML.includes('No active agents'));

const broken = boot(source);
broken.send({ ...base, plan: { summary: 'x', warnings: [], agents: null } });
ok(
  'a render failure shows itself instead of leaving an empty panel',
  broken.grid.innerHTML.includes('could not draw')
);

console.log('\nthe panel with no script at all');

const fallback = WorkspacePanel.bootHtml(plan);
ok('the plan is written into the document itself', fallback.includes(plan.summary));
ok('with its agents', fallback.includes('postcode-validator'));
ok(
  'and approval reachable without JavaScript',
  fallback.includes('command:orchy.approvePlan') && fallback.includes('command:orchy.rejectPlan')
);
ok(
  'the served document carries it',
  WorkspacePanel.prototype.html.call({} as never, fallback).includes(plan.summary)
);

const idle = WorkspacePanel.bootHtml(undefined);
ok('and with no plan it says what a stuck panel means', idle.includes('did not start'));

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
