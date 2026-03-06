import test from 'node:test';
import assert from 'node:assert/strict';
import { PtySession } from '../src/pty-session.js';

function createSession() {
  return Object.create(PtySession.prototype);
}

function createWaitSession(buffer = '') {
  const session = createSession();
  session.alive = true;
  session._buffer = buffer;
  session._dataListeners = [];
  return session;
}

test('PowerShell wrapper uses safe marker interpolation', () => {
  const session = createSession();
  session.shellType = 'powershell';

  const command = session._wrapCommand('echo hi', '__DONE__', '__CWD_', '__PRE__');

  assert.match(command, /__DONE___\$\{LASTEXITCODE\}__/);
  assert.match(command, /__CWD_\$\(\(Get-Location\)\.Path\)__/);
});

test('_parseOutput ignores echoed wrapper text and keeps real output', () => {
  const session = createSession();
  const preMarker = '__MCP_PRE_abc__';
  const marker = '__MCP_DONE_xyz__';
  const cwdMarker = '__MCP_CWD_';
  const raw = [
    `PS C:\\repo> Write-Host "${preMarker}"; echo hi; Write-Host "${marker}_\${LASTEXITCODE}__"`,
    `>> Write-Host "${cwdMarker}$((Get-Location).Path)__"`,
    preMarker,
    'hi',
    `${marker}_0__`,
    `${cwdMarker}C:\\repo__`,
    'PS C:\\repo>',
  ].join('\r\n');

  const result = session._parseOutput(raw, marker, cwdMarker, preMarker);

  assert.deepEqual(result, {
    output: 'hi\nPS C:\\repo>',
    exitCode: 0,
    cwd: 'C:\\repo',
  });
});

test('read returns unread buffered output once', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'echo hi\r\nhi\r\nPS C:\\repo> ';
  session._readCursor = 0;
  session._dataListeners = [];

  const first = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50 });
  const second = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50 });

  assert.equal(first.output, 'echo hi\r\nhi\r\nPS C:\\repo>');
  assert.equal(first.timedOut, false);
  assert.equal(second.output, '');
});

test('getHistory keeps the broader default history limit for agent context', () => {
  const session = createSession();
  session._history = Array.from({ length: 220 }, (_, index) => `line ${index + 1}`);
  session._historyTotalLines = 220;

  const result = session.getHistory();

  assert.equal(result.lines.length, 200);
  assert.equal(result.lines[0], 'line 21');
  assert.equal(result.lines.at(-1), 'line 220');
  assert.equal(result.returnedFrom, 20);
  assert.equal(result.returnedTo, 220);
});

test('waitForPattern returns only the tail by default', async () => {
  const session = createWaitSession('line 1\nline 2\nline 3\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', tailLines: 2, timeout: 50 });

  assert.deepEqual(result, {
    output: 'line 3\nready',
    matched: true,
    timedOut: false,
  });
});

test('waitForPattern can return the full output', async () => {
  const session = createWaitSession('line 1\nline 2\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', returnMode: 'full', tailLines: 1, timeout: 50 });

  assert.deepEqual(result, {
    output: 'line 1\nline 2\nready',
    matched: true,
    timedOut: false,
  });
});

test('waitForPattern can suppress output entirely', async () => {
  const session = createWaitSession('booting\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', returnMode: 'match-only', timeout: 50 });

  assert.deepEqual(result, {
    output: '',
    matched: true,
    timedOut: false,
  });
});

test('waitForPattern returns only the configured tail on timeout', async () => {
  const session = createWaitSession('line 1\nline 2\nline 3\n');

  const result = await session.waitForPattern({ pattern: 'ready', tailLines: 1, timeout: 20 });

  assert.deepEqual(result, {
    output: 'line 3',
    matched: false,
    timedOut: true,
  });
});