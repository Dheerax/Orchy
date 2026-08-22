/**
 * Smoke test for orchy-mcp: does it speak JSON-RPC, list its tools, and fail
 * usefully when the extension isn't running?
 *
 * Run with:  node mcp/smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, 'orchy-mcp.mjs');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-mcp-'));

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
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
const ok = (label, cond) => check(label, cond, true);

function rpc(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server, workspace], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          responses.push(JSON.parse(line));
        }
      }
      if (responses.length >= requests.length) {
        child.kill();
        resolve(responses);
      }
    });
    child.on('error', reject);
    setTimeout(() => {
      child.kill();
      resolve(responses);
    }, 8000);
    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + '\n');
    }
  });
}

console.log('\norchy-mcp protocol');

const [init, list, call] = await rpc([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'orchy_list', arguments: {} } },
]);

check('initialize returns a protocol version', init?.result?.protocolVersion, '2024-11-05');
check('server identifies itself', init?.result?.serverInfo?.name, 'orchy-mcp');

const names = (list?.result?.tools ?? []).map((t) => t.name).sort();
check('all tools are listed', names, [
  'orchy_archive',
  'orchy_fork',
  'orchy_guide',
  'orchy_interrupt',
  'orchy_kill',
  'orchy_list',
  'orchy_merge',
  'orchy_models',
  'orchy_plan',
  'orchy_plan_status',
  'orchy_relay',
  'orchy_send',
  'orchy_set_model',
  'orchy_spawn',
  'orchy_status',
  'orchy_templates',
  'orchy_verify',
  'orchy_wait',
]);

const spawnTool = (list?.result?.tools ?? []).find((t) => t.name === 'orchy_spawn');
ok('spawn requires a role and a task', JSON.stringify(spawnTool?.inputSchema?.required) === '["role","task"]');
ok(
  'spawn documents why deliverables matter',
  spawnTool?.inputSchema?.properties?.deliverables?.description?.includes('not evidence of work')
);

// With no extension running there is no daemon handshake file. The tool must say
// so plainly rather than hanging or returning something that looks like success.
ok('a call without a running extension is an error', call?.result?.isError === true);
ok(
  'and the error explains what to do',
  call?.result?.content?.[0]?.text?.includes('not running')
);

// The guide must answer without a running extension, or an orchestrator cannot
// learn how to drive the pipeline until the pipeline is already up.
const [, , guideCall] = await rpc([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'orchy_guide', arguments: {} } },
]);
const guideText = guideCall?.result?.content?.[0]?.text ?? '';
ok('the guide answers with no extension running', !guideCall?.result?.isError);
ok('and it explains deliverables', guideText.includes('deliverables'));
ok('and it explains depends_on', guideText.includes('depends_on'));
ok('and it tells the orchestrator not to sleep-poll', guideText.includes('never sleep'));

fs.rmSync(workspace, { recursive: true, force: true });
console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
