/**
 * Regression test for opencode binary resolution on Windows.
 *
 * Run with:  node out/backends/binaryResolution.test.js
 *
 * This exists because of a real failure: a stale opencode.exe from an older
 * install sat on PATH next to npm's current shim. Picking it produced a terminal
 * that opened, showed a cursor, and did nothing — no error anywhere. The agent
 * was working fine; only the view was dead.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetOpenCodeBinaryCache, resolveOpenCodeBinary } from './opencodeBackend';

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

console.log('\nopencode binary resolution');

if (process.platform !== 'win32') {
  resetOpenCodeBinaryCache();
  check('non-Windows uses the bare name', resolveOpenCodeBinary('/usr/bin'), 'opencode');
  console.log('\nPASS — 1 check (Windows-specific cases skipped)\n');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchy-bin-'));
const shimDir = path.join(tmp, 'nodejs');
const realDir = path.join(shimDir, 'node_modules', 'opencode-ai', 'bin');
fs.mkdirSync(realDir, { recursive: true });

const realExe = path.join(realDir, 'opencode.exe');
fs.writeFileSync(realExe, 'current binary');

// npm's cmd-shim, byte-for-byte in shape with the real one.
fs.writeFileSync(
  path.join(shimDir, 'opencode.cmd'),
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  ].join('\r\n')
);

// The trap: a stale build sitting right beside the shim.
const staleExe = path.join(shimDir, 'opencode.exe');
fs.writeFileSync(staleExe, 'stale july build that hangs on startup');

resetOpenCodeBinaryCache();
check('follows the shim past a stale sibling .exe', resolveOpenCodeBinary(shimDir), realExe);

// With no shim present, the .exe on PATH is the best remaining option.
fs.rmSync(path.join(shimDir, 'opencode.cmd'));
resetOpenCodeBinaryCache();
check('falls back to the PATH .exe when no shim exists', resolveOpenCodeBinary(shimDir), staleExe);

// A shim pointing at something that no longer exists must not be trusted.
fs.writeFileSync(
  path.join(shimDir, 'opencode.cmd'),
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*'
);
fs.rmSync(realExe);
resetOpenCodeBinaryCache();
check('ignores a shim whose target is gone', resolveOpenCodeBinary(shimDir), staleExe);

resetOpenCodeBinaryCache();
check('degrades to the bare name when nothing is found', resolveOpenCodeBinary(tmp), 'opencode');

resetOpenCodeBinaryCache();
check('result is memoized', resolveOpenCodeBinary(shimDir), resolveOpenCodeBinary('/nonexistent'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? `\nPASS — ${checks} checks\n` : `\n${failures} of ${checks} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
