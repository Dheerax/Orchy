/** Run with:  node out/core/projectConfig.test.js */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_FILE, loadProjectConfig, rulesBlock, exampleConfig } from './projectConfig';

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
function check(label: string, actual: unknown, expected: unknown): void {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-cfg-'));
const write = (text: string): void =>
  fs.writeFileSync(path.join(root, CONFIG_FILE), text, 'utf8');

console.log('\nno config at all');

const none = loadProjectConfig(root);
check('no rules', none.rules, []);
check('nothing to warn about', none.warnings, []);
ok('and no path, so surfaces can tell there is no file', none.path === undefined);

console.log('\na config someone actually wrote');

write(`{
  // The language matters more than anything else here.
  "baseBranch": "develop",
  "rules": ["Plain CommonJS.", "No new dependencies."],
  "verify": "npm test",
  "models": { "cheap": "opencode/free", "strong": "google/big" },
  "budgetCap": 2.5,
  "forbid": ["npm publish"]
}`);

const good = loadProjectConfig(root);
check('the base branch', good.baseBranch, 'develop');
check('the rules, in order', good.rules, ['Plain CommonJS.', 'No new dependencies.']);
check('the check every agent must pass', good.verify, 'npm test');
check('the preferred models', good.models, { cheap: 'opencode/free', strong: 'google/big' });
check('the cap', good.budgetCap, 2.5);
check('extra forbidden commands', good.forbid, ['npm publish']);
check('and nothing to complain about', good.warnings, []);
ok('a // comment does not break it', good.rules.length === 2);

console.log('\nrules reach the agent');

ok('as a block appended to the brief', rulesBlock(good).includes('No new dependencies.'));
ok('and nothing at all when there are none', rulesBlock(loadProjectConfig(root + '-gone')) === '');

console.log('\nconfigs people get wrong');

// A malformed config costs the settings that are wrong, never the ability to
// run anything: this is read on the spawn path.
write('{ this is not json ]');
const broken = loadProjectConfig(root);
check('nothing is used from a file that will not parse', broken.rules, []);
ok('but it says so', broken.warnings.some((w) => w.includes('not valid JSON')));
ok('and names the file', broken.path !== undefined);

write('["rules"]');
ok(
  'a config that is not an object is refused clearly',
  loadProjectConfig(root).warnings.some((w) => w.includes('must be a JSON object'))
);

write('{ "rules": "One rule as a string" }');
check('a lone string is taken as one rule', loadProjectConfig(root).rules, ['One rule as a string']);

write('{ "rules": [1, 2] }');
const wrongType = loadProjectConfig(root);
check('a list of the wrong type is dropped', wrongType.rules, []);
ok('with a warning', wrongType.warnings.length === 1);

write('{ "models": { "cheap": "just-a-name" } }');
ok(
  'a model without a provider is refused',
  loadProjectConfig(root).warnings.some((w) => w.includes('provider/model'))
);

write('{ "budgetCap": "lots" }');
ok(
  'a cap that is not a number is refused',
  loadProjectConfig(root).warnings.some((w) => w.includes('budgetCap'))
);

// Silence here looks exactly like a setting that does not work.
write('{ "baseBrunch": "main" }');
ok(
  'a misspelt setting is called out rather than ignored silently',
  loadProjectConfig(root).warnings.some((w) => w.includes('baseBrunch'))
);

console.log('\nthe file we hand people');

write(exampleConfig());
const example = loadProjectConfig(root);
check('the example parses cleanly', example.warnings, []);
ok('and sets something useful', example.rules.length > 0 && example.verify !== undefined);

fs.rmSync(root, { recursive: true, force: true });

console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
