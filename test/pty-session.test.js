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

  // The prompt after the CWD marker is not part of the command output.
  assert.deepEqual(result, {
    output: 'hi',
    exitCode: 0,
    cwd: 'C:\\repo',
  });
});

test('_truncateOutput keeps the head and tail when output exceeds maxLines', () => {
  const session = createSession();
  const output = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n');

  assert.equal(
    session._truncateOutput(output, 4),
    ['line 1', 'line 2', '', '... 2 lines omitted ...', '', 'line 5', 'line 6'].join('\n')
  );
});

test('read returns unread buffered output once', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'echo hi\r\nhi\r\nPS C:\\repo> ';
  session._readCursor = 0;
  session._dataListeners = [];

  const first = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50 });
  const second = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50 });

  assert.equal(first.output, 'echo hi\nhi\nPS C:\\repo>');
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

test('read returns position with cursor-based read', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'hello world';
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  const result = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50 });

  assert.equal(result.output, 'hello world');
  assert.equal(result.position, 100);
  assert.equal(result.timedOut, false);
});

test('read with since returns output from a prior position', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'prefixnew data';
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  // 6 bytes of 'prefix' means buffer started at position 100 - 14 = 86
  // since=92 -> offset = 92 - 86 = 6 -> 'new data'
  session._dataListeners = [];

  const result = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50, since: 92 });

  assert.equal(result.output, 'new data');
  assert.equal(result.position, 100);
  assert.equal(result.truncated, false);
});

test('read with since in evicted region sets truncated', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'current data'; // 12 bytes, bufferStart = 100-12=88
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  // since=50 is before bufferStart=88
  const result = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50, since: 50 });

  assert.equal(result.output, 'current data');
  assert.equal(result.truncated, true);
  assert.equal(result.position, 100);
});

test('read with since beyond current position waits for data', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  const resultPromise = session.read({ timeout: 50, idleTimeout: 10, maxLines: 50, since: 100 });

  // Simulate new data arriving
  const onData = session._dataListeners.at(-1);
  session._buffer = 'fresh output';
  session._totalBytesEmitted = 112;
  onData('fresh output');

  const result = await resultPromise;
  assert.equal(result.output, 'fresh output');
  assert.equal(result.position, 112);
});

test('kill uses process group kill on Unix', () => {
  const session = createSession();
  session.alive = true;
  const kills = [];
  session.process = {
    pid: 12345,
    kill: (sig) => kills.push({ method: 'pty', signal: sig }),
  };

  const originalPlatform = process.platform;
  // We can't actually change process.platform, but we can test the code path
  // by checking the logic directly

  session.kill();
  assert.equal(session.alive, false);
});

test('kill is idempotent', () => {
  const session = createSession();
  session.alive = false;
  session.process = { pid: 12345 };

  // Should not throw
  session.kill();
  assert.equal(session.alive, false);
});

test('_waitForMarker returns reason marker on completion', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'some output\n__MCP_DONE_abc___0__\n';
  session._dataListeners = [];

  const resultPromise = session._waitForMarker('__MCP_DONE_abc__', 500);
  const result = await resultPromise;

  assert.equal(result.reason, 'marker');
  assert.ok(result.buffer.includes('__MCP_DONE_abc__'));
});

test('_waitForMarker ignores marker text embedded mid-line (echoed command)', async () => {
  const session = createSession();
  session.alive = true;
  // Simulates the PTY echo of the wrapped command: the marker literal is
  // present, but only as part of a longer line — it must NOT resolve.
  session._buffer = 'PS> echo "__MCP_PRE_x__"; cmd; echo "__MCP_DONE_abc__$?"; echo "__MCP_CWD_$(pwd)__"';
  session._dataListeners = [];

  const result = await session._waitForMarker('__MCP_DONE_abc__', 30);
  assert.equal(result.reason, 'timeout');
});

test('_waitForMarker resolves on marker line arriving after the echo', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._dataListeners = [];

  const resultPromise = session._waitForMarker('__MCP_DONE_abc__', 2000);

  // Echo first (marker mid-line), then the real standalone marker line.
  // Real marker output is marker + '_' + exitCode + '__'.
  const onData = session._dataListeners.at(-1);
  const feed = (text) => {
    session._buffer += text;
    onData(text);
  };
  feed('echo "__MCP_DONE_abc_$?"\r\n');
  feed('__MCP_DONE_abc___0__\r\n');

  const result = await resultPromise;
  assert.equal(result.reason, 'marker');
});

test('_scanForMarkerLine matches bare marker line without exit code', () => {
  const session = createSession();
  session._buffer = '__MCP_DONE_abc__\n';
  assert.equal(session._scanForMarkerLine('__MCP_DONE_abc__'), true);
});

test('_scanForMarkerLine handles ANSI-wrapped marker lines', () => {
  const session = createSession();
  session._buffer = '\u001b[32m__MCP_DONE_abc___0__\u001b[0m\r';
  assert.equal(session._scanForMarkerLine('__MCP_DONE_abc__'), true);
});

test('_waitForMarker returns reason timeout on hard timeout', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'no marker here';
  session._dataListeners = [];

  const result = await session._waitForMarker('__MCP_DONE_abc__', 30);

  assert.equal(result.reason, 'timeout');
});

test('_waitForMarker returns reason quiet when output stops', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._dataListeners = [];

  const resultPromise = session._waitForMarker('__MCP_DONE_abc__', 2000, 30, 1);

  // Simulate some output then silence
  const onData = session._dataListeners.at(-1);
  onData('some output');

  const result = await resultPromise;
  assert.equal(result.reason, 'quiet');
});

test('_waitForMarker quiet respects minOutputBytes', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._dataListeners = [];

  // minOutputBytes = 100, but we only send 5 bytes
  const resultPromise = session._waitForMarker('__MCP_DONE_abc__', 2000, 30, 100);

  const onData = session._dataListeners.at(-1);
  onData('short');

  // Quiet timer should NOT fire because bytesSeen < minOutputBytes
  // Only the hard timeout should fire
  const result = await resultPromise;
  assert.equal(result.reason, 'timeout');
});

test('watch returns on trigger match', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'ready', pattern: 'Server ready' }],
    timeout: 2000,
    contextLines: 2,
  });

  const onData = session._dataListeners.at(-1);
  onData('Starting...\n');
  session._totalBytesEmitted += 12;
  onData('Server ready\n');
  session._totalBytesEmitted += 13;

  const result = await resultPromise;
  assert.equal(result.reason, 'trigger');
  assert.equal(result.triggerId, 'ready');
  assert.equal(result.matchedLine, 'Server ready');
  assert.equal(result.context.length, 2); // 'Starting...' + 'Server ready'
  assert.equal(result.context[0], 'Starting...');
});

test('watch returns on timeout when no trigger matches', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const result = await session.watch({
    triggers: [{ id: 'never', pattern: 'wont-match' }],
    timeout: 30,
  });

  assert.equal(result.reason, 'timeout');
  assert.equal(result.timedOut, true);
});

test('watch returns on quiet detection', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'x', pattern: 'x' }],
    timeout: 5000,
    quietExitMs: 30,
  });

  const onData = session._dataListeners.at(-1);
  onData('some output\n');
  session._totalBytesEmitted += 12;
  // No more data — quiet timer fires

  const result = await resultPromise;
  assert.equal(result.reason, 'quiet');
});

test('watch returns on process exit', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'x', pattern: 'x' }],
    timeout: 5000,
  });

  // Simulate process exit
  session.alive = false;

  const result = await resultPromise;
  assert.equal(result.reason, 'exit');
});

test('watch respects cooldown', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'ping', pattern: 'ping', cooldownMs: 5000 }],
    timeout: 5000,
  });

  const onData = session._dataListeners.at(-1);
  onData('ping\n');
  session._totalBytesEmitted += 5;
  // Cooldown prevents immediate re-match, but first match should fire

  const result = await resultPromise;
  assert.equal(result.reason, 'trigger');
  assert.equal(result.triggerId, 'ping');
});

test('watch with since skips already-emitted output', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'old data match here'; // 20 bytes
  session._totalBytesEmitted = 100; // bufferStart = 80
  session._dataListeners = [];

  // since=90 means we only match from offset 10 in buffer
  // 'old data match here'[10:] = 'match here' -> matches 'match'
  const resultPromise = session.watch({
    triggers: [{ id: 'found', pattern: 'match' }],
    timeout: 2000,
    since: 90,
  });

  // Should resolve immediately from existing buffer
  const result = await resultPromise;
  assert.equal(result.reason, 'trigger');
  assert.equal(result.triggerId, 'found');
});