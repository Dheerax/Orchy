/**
 * Smoke test for the state layer. Run with:  node out/core/stateLayer.test.js
 *
 * Proves the property the whole architecture rests on: a registry rebuilt from
 * the log alone is indistinguishable from the live one. If this fails, every
 * "surfaces are disposable" claim in ARCHITECTURE.md is false.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventLog } from './eventLog';
import { SessionRegistry } from './sessionRegistry';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-test-'));
const log = new EventLog(dir);
const reg = new SessionRegistry(log);

console.log('\nstate layer');

reg.record({
  type: 'spawned',
  session: 'ui-1',
  name: 'Frontend — settings page',
  role: 'ui',
  task: 'Build the settings page',
  backend: { type: 'opencode', handle: 'oc-abc' },
  deliverables: [
    { kind: 'file', spec: 'src/Settings.tsx', verified: false },
    { kind: 'command', spec: 'npm test', verified: false },
  ],
});
check('spawned session starts in spawning', reg.get('ui-1')?.status, 'spawning');

reg.record({ type: 'status', session: 'ui-1', status: 'running' });
check('status advances to running', reg.get('ui-1')?.status, 'running');

// The core rule: a backend claiming completion is not evidence of completion.
reg.record({ type: 'status', session: 'ui-1', status: 'complete' });
check(
  'complete is refused while deliverables are unverified',
  reg.get('ui-1')?.status,
  'idle_unverified'
);
check('unverified session needs attention', reg.needingAttention().length, 1);

reg.record({ type: 'deliverable', session: 'ui-1', spec: 'src/Settings.tsx', verified: true });
check('one of two verified is still not complete', reg.get('ui-1')?.status, 'idle_unverified');

reg.record({ type: 'deliverable', session: 'ui-1', spec: 'npm test', verified: true });
check('verifying the last deliverable promotes to complete', reg.get('ui-1')?.status, 'complete');
check('complete session needs no attention', reg.needingAttention().length, 0);

// A session that never declared deliverables can never claim completion.
reg.record({
  type: 'spawned',
  session: 'docs-1',
  name: 'Docs',
  role: 'docs',
  task: 'Update the README',
  backend: { type: 'opencode', handle: 'oc-def' },
  deliverables: [],
});
reg.record({ type: 'status', session: 'docs-1', status: 'complete' });
check(
  'no declared deliverables caps at idle_unverified',
  reg.get('docs-1')?.status,
  'idle_unverified'
);

console.log('\nrebuild from log');

const rebuilt = new SessionRegistry(new EventLog(dir));
check('same session count', rebuilt.all().length, reg.all().length);
check('ui-1 status survives', rebuilt.get('ui-1')?.status, reg.get('ui-1')?.status);
check('docs-1 status survives', rebuilt.get('docs-1')?.status, reg.get('docs-1')?.status);
check(
  'full state is identical',
  rebuilt.all().sort((a, b) => a.id.localeCompare(b.id)),
  reg.all().sort((a, b) => a.id.localeCompare(b.id))
);

console.log('\ncorrupt log tolerance');

fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"broken": tru\n', 'utf8');
const afterCorruption = new SessionRegistry(new EventLog(dir));
check('torn trailing line does not break replay', afterCorruption.all().length, 2);
check('corruption is counted, not hidden', new EventLog(dir).corruptLineCount(), 1);

fs.rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nPASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
