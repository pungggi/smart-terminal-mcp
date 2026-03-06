import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionEnv, PtySession } from '../src/pty-session.js';

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

test('buildSessionEnv applies anti-blocking environment defaults', () => {
  const env = buildSessionEnv({ CUSTOM_ENV: 'yes', GIT_PAGER: 'less' }, 'linux');

  assert.equal(env.CUSTOM_ENV, 'yes');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.PAGER, 'cat');
  assert.equal(env.LESS, '-FRX');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.DEBIAN_FRONTEND, 'noninteractive');
});

test('buildSessionEnv skips noninteractive override on Windows', () => {
  const env = buildSessionEnv({}, 'win32');

  assert.equal(env.DEBIAN_FRONTEND, undefined);
});

test('PowerShell wrapper uses safe marker interpolation', () => {
  const session = createSession();
  session.shellType = 'powershell';

  const command = session._wrapCommand('echo hi', '__DONE__', '__CWD_', '__PRE__');

  assert.match(command, /__DONE___\$\{LASTEXITCODE\}__/);
  assert.match(command, /__CWD_\$\(\(Get-Location\)\.Path\)__/);
});

test('_initShell suppresses PowerShell progress output', async () => {
  const session = createSession();
  const writes = [];
  let resetCalls = 0;
  session.shellType = 'powershell';
  session.process = { write: (value) => writes.push(value) };
  session._readUntilIdle = async () => '';
  session._resetBuffer = () => {
    resetCalls++;
  };

  await session._initShell();

  assert.deepEqual(writes, ["$ProgressPreference = 'SilentlyContinue'\r"]);
  assert.equal(resetCalls, 1);
});

test('_initShell sets cmd sessions to UTF-8', async () => {
  const session = createSession();
  const writes = [];
  let resetCalls = 0;
  session.shellType = 'cmd';
  session.process = { write: (value) => writes.push(value) };
  session._readUntilIdle = async () => '';
  session._resetBuffer = () => {
    resetCalls++;
  };

  await session._initShell();

  assert.deepEqual(writes, ['chcp 65001 > nul\r']);
  assert.equal(resetCalls, 1);
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

test('getHistory can return text mode with the same metadata', () => {
  const session = createSession();
  session._history = ['line 1', 'line 2', 'line 3'];
  session._historyTotalLines = 5;

  const result = session.getHistory({ offset: 1, limit: 2, format: 'text' });

  assert.deepEqual(result, {
    text: 'line 1\nline 2',
    totalLines: 5,
    returnedFrom: 2,
    returnedTo: 4,
  });
});

test('getInfo can return minimal terminal_list metadata', () => {
  const session = createSession();
  session.id = 's1';
  session.name = 'main';
  session.cwd = 'C:/repo';
  session.alive = true;
  session.busy = false;
  session.shell = 'pwsh';
  session.shellType = 'powershell';
  session.cols = 120;
  session.rows = 30;
  session.createdAt = Date.now() - 1000;
  session.lastActivity = Date.now();

  assert.deepEqual(session.getInfo({ verbose: false }), {
    id: 's1',
    name: 'main',
    cwd: 'C:/repo',
    alive: true,
    busy: false,
  });
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

test('waitForPattern rejects invalid regex patterns', async () => {
  const session = createWaitSession('ready\n');

  await assert.rejects(
    session.waitForPattern({ pattern: '(', timeout: 20 }),
    /Invalid regex pattern in pattern/
  );
});

test('_readUntilIdle collects streamed data even if the buffer shifts', async () => {
  const session = createSession();
  session._buffer = 'seed';
  session._dataListeners = [];

  const resultPromise = session._readUntilIdle(50, 10);
  const onData = session._dataListeners.at(-1);

  session._buffer = 'trimmed-1';
  onData('first');
  session._buffer = 'trimmed-2';
  onData('second');

  await assert.doesNotReject(async () => {
    const result = await resultPromise;
    assert.equal(result, 'firstsecond');
  });
});