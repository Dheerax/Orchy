/**
 * Run with:  node out/ui/panelRender.test.js
 *
 * The panel's renderer lives as a string inside the extension, which means the
 * compiler never sees it and a typo in it costs a package-install-reload cycle
 * to find. Worse, the failure mode is silence: an exception mid-render leaves an
 * empty panel, which looks exactly like "no agents are running".
 *
 * So the script is pulled out of the source and run against a stub DOM here,
 * with the shapes the extension actually posts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

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

/** Barely enough DOM to render into: elements that remember their own HTML. */
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

function loadPanelScript(): {
  send: (data: unknown) => void;
  grid: StubEl;
  count: StubEl;
  posted: { type: string }[];
} {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'ui', 'workspacePanel.ts'),
    'utf8'
  );
  const start = source.indexOf('<script nonce=');
  const body = source.slice(source.indexOf('>', start) + 1, source.indexOf('</script>', start));

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
  new vm.Script(body).runInContext(sandbox);

  return {
    send: (data: unknown) => listeners.forEach((fn) => fn({ data: { type: 'snapshot', data } })),
    grid: nodes.grid,
    count: nodes.count,
    posted,
  };
}

const plan = {
  id: 'abc123',
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
      deliverables: [{ kind: 'command', spec: 'npm test', verified: false }],
    },
  ],
};

const base = { sessions: [], rows: [], focused: undefined, page: 0, pages: 1, blocked: 0, archived: 0 };

console.log('\npanel rendering');

const panel = loadPanelScript();
ok('the script asks for state as soon as it loads', panel.posted[0]?.type === 'ready');

panel.send({ ...base, plan });
ok('a plan renders', panel.grid.innerHTML.includes('id="plan"'));
ok('with every agent', plan.agents.every((a) => panel.grid.innerHTML.includes(a.role)));
ok('the fan-in stage included', panel.grid.innerHTML.includes('tests'));
ok('and a diagram, since there is more than one stage', panel.grid.innerHTML.includes('class="arch"'));
ok(
  'nothing fell over',
  !panel.grid.innerHTML.includes('could not draw'),
  panel.grid.innerHTML.slice(0, 200)
);
ok('the header says a decision is wanted', panel.count.textContent.includes('approval'));

// The blank-panel bug: an agent missing the fields the diagram reads must not
// take the whole view down with it.
panel.send({
  ...base,
  plan: { ...plan, agents: [{ role: 'lonely', task: 't', dependsOn: [], provides: [], needs: [], deliverables: [] }] },
});
ok('a single-agent plan still renders', panel.grid.innerHTML.includes('lonely'));
ok('with no diagram, having no stages to show', !panel.grid.innerHTML.includes('class="arch"'));

panel.send({ ...base, plan: undefined });
ok('and an empty pipeline says so rather than going blank', panel.grid.innerHTML.includes('No active agents'));

const broken = loadPanelScript();
broken.send({ ...base, plan: { summary: 'x', warnings: [], agents: null } });
ok(
  'a render failure shows itself instead of leaving an empty panel',
  broken.grid.innerHTML.includes('could not draw')
);

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
