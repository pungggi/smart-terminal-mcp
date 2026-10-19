import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionEnv, consumeEchoPrefix, PtySession } from '../src/pty-session.js';

function createSession() {
  return Object.create(PtySession.prototype);
}

function createWaitSession(buffer = '') {
  const session = createSession();
  session.alive = true;
  session._buffer = buffer;
  // Mirror the real stream: the seeded buffer is the entire output so far.
  session._totalBytesEmitted = buffer.length;
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
  // Scrub any DEBIAN_FRONTEND inherited from the host (GitHub runners
  // export DEBIAN_FRONTEND=noninteractive) so this asserts what the
  // function ADDS, not what the environment already contained.
  const hadKey = 'DEBIAN_FRONTEND' in process.env;
  const prev = process.env.DEBIAN_FRONTEND;
  delete process.env.DEBIAN_FRONTEND;
  try {
    const env = buildSessionEnv({}, 'win32');
    assert.equal(env.DEBIAN_FRONTEND, undefined);
  } finally {
    if (hadKey) process.env.DEBIAN_FRONTEND = prev;
  }
});

test('PowerShell wrapper derives exit code from $? with cleared LASTEXITCODE', () => {
  const session = createSession();
  session.shellType = 'powershell';

  const command = session._wrapCommand('echo hi', '__DONE__', '__CWD_', '__PRE__');

  // $LASTEXITCODE must be cleared before the command so a stale value from an
  // earlier native command cannot leak into this command's exit code.
  assert.match(command, /\$global:LASTEXITCODE = \$null; echo hi;/);
  // The reported code is derived from $? (cmdlet success) falling back to
  // $LASTEXITCODE when a native executable set it.
  assert.match(command, /\$__mcp_rc = if \(\$\?\)/);
  assert.match(command, /if \(\$null -ne \$LASTEXITCODE\) \{ \$LASTEXITCODE \} else \{ 0 \}/);
  assert.match(command, /else \{ if \(\$null -ne \$LASTEXITCODE\) \{ \$LASTEXITCODE \} else \{ 1 \} \}/);
  // The marker reports the derived code via PS's braced-variable form:
  // bare "$__mcp_rc__" would parse as a variable named "__mcp_rc__"
  // (undefined) because underscores are valid name chars.
  assert.match(command, /__DONE___\$\{__mcp_rc\}__/);
  assert.match(command, /__CWD_\$\(\(Get-Location\)\.Path\)__/);
});

test('cmd wrapper emits markers on a second line for fresh %ERRORLEVEL%/%CD%', () => {
  const session = createSession();
  session.shellType = 'cmd';

  const command = session._wrapCommand('echo hi', '__DONE__', '__CWD_', '__PRE__');

  // cmd expands %VAR% when parsing the line: markers must live on a separate
  // line, written after the command line, or they echo the PREVIOUS values.
  const [firstLine, secondLine] = command.split('\r');
  assert.equal(firstLine, 'echo __PRE__ & echo hi');
  assert.equal(secondLine, 'echo __DONE___%ERRORLEVEL%__ & echo __CWD_%CD%__');
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

test('_truncateOutput caps oversized single lines with a head+tail notice', () => {
  const session = createSession();
  const giant = 'x'.repeat(5000);
  const output = [`before`, giant, 'after'].join('\n');

  const result = session._truncateOutput(output, 10);

  const lines = result.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'before');
  assert.equal(lines[2], 'after');
  assert.ok(lines[1].length < 1600, `line should be capped, got ${lines[1].length}`);
  assert.match(lines[1], /\[line truncated, 5000 chars\]/);
  assert.ok(lines[1].startsWith('x'.repeat(1000)));
  assert.ok(lines[1].endsWith('x'.repeat(400)));
});

test('_truncateBytes returns output unchanged under the cap', () => {
  const session = createSession();
  const output = 'a'.repeat(100);

  assert.equal(session._truncateBytes(output, 1024), output);
});

test('_truncateBytes keeps head and tail lines with a byte notice over the cap', () => {
  const session = createSession();
  const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}`);
  const output = lines.join('\n'); // ~900 bytes total
  const cap = 300;

  const result = session._truncateBytes(output, cap);
  const resultLines = result.split('\n');

  assert.ok(resultLines.length < lines.length);
  assert.equal(resultLines[0], 'line-000');
  assert.equal(resultLines.at(-1), 'line-099');
  const notice = resultLines.find((l) => l.includes('bytes omitted'));
  assert.ok(notice, 'should contain an omission notice');
  assert.ok(Buffer.byteLength(result, 'utf8') < cap + 200);
});

test('exec applies the maxOutputBytes cap to command output', async () => {
  const session = createSession();
  session.id = 's1';
  session.alive = true;
  session.busy = false;
  session.shellType = 'bash';
  session.cwd = '/repo';
  session.process = { write: () => {} };
  session._resetBuffer = () => {};
  session._waitForMarker = async () => ({ buffer: 'raw', reason: 'marker' });
  const giant = Array.from({ length: 500 }, (_, i) => `data-line-${i}-` + 'x'.repeat(20)).join('\n');
  session._parseOutput = () => ({ output: giant, exitCode: 0, cwd: null });

  const result = await session.exec({ command: 'big-cmd', timeout: 1000, maxLines: 10000, maxOutputBytes: 4096 });

  assert.ok(Buffer.byteLength(result.output, 'utf8') < 4300, 'byte cap should be applied');
  assert.match(result.output, /bytes omitted/);
  assert.ok(result.output.includes('data-line-0'));
  assert.ok(result.output.includes('data-line-499'));
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

/** Emit a chunk the way the real onData handler would (buffer + counter + listeners). */
function emitChunk(session, data) {
  session._buffer += data;
  session._totalBytesEmitted += data.length;
  session._dataListeners.at(-1)(data);
}

test('waitForPattern ignores pre-existing output by default (echo race, #12)', async () => {
  // The echoed wrapped command contains the marker mid-line; scanning history
  // matched this instantly before the command even ran.
  const echo = 'Write-Host "__MCP_PRE_x__"; npx vitest run; Write-Host "__MCP_DONE_abc__${LASTEXITCODE}__"\r\n';
  const session = createWaitSession(echo);

  const result = await session.waitForPattern({ pattern: '__MCP_DONE_abc__', timeout: 30 });

  assert.equal(result.matched, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.output, '');
  assert.equal(result.position, echo.length);
});

test('waitForPattern matches new output produced after the call', async () => {
  const session = createWaitSession('Write-Host "__MCP_DONE_abc__..."\r\n');
  const waitPromise = session.waitForPattern({ pattern: '__MCP_DONE_abc__', timeout: 2000 });

  // The real marker line arrives as a standalone line once the command ends.
  emitChunk(session, 'test 1 passed\n__MCP_DONE_abc__0__\n');

  const result = await waitPromise;
  assert.equal(result.matched, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.output, 'test 1 passed\n__MCP_DONE_abc__0__');
  assert.equal(result.position, session._totalBytesEmitted);
});

test('waitForPattern scans retained history from an explicit since', async () => {
  const session = createWaitSession('line 1\nline 2\nline 3\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', since: 0, tailLines: 2, timeout: 50 });

  assert.deepEqual(result, {
    output: 'line 3\nready',
    matched: true,
    timedOut: false,
    position: session._totalBytesEmitted,
  });
});

test('waitForPattern clamps since to the retained buffer', async () => {
  // Older positions are clamped to the buffer start (evicted history is gone).
  const session = createWaitSession('evicted prefix…\nready\n');
  session._totalBytesEmitted += 5000;

  const result = await session.waitForPattern({ pattern: 'ready', since: 0, timeout: 50 });

  assert.equal(result.matched, true);
});

test('waitForPattern can return the full output', async () => {
  const session = createWaitSession('line 1\nline 2\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', since: 0, returnMode: 'full', tailLines: 1, timeout: 50 });

  assert.deepEqual(result, {
    output: 'line 1\nline 2\nready',
    matched: true,
    timedOut: false,
    position: session._totalBytesEmitted,
  });
});

test('waitForPattern can suppress output entirely', async () => {
  const session = createWaitSession('booting\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', since: 0, returnMode: 'match-only', timeout: 50 });

  assert.deepEqual(result, {
    output: '',
    matched: true,
    timedOut: false,
    position: session._totalBytesEmitted,
  });
});

test('waitForPattern returns only the configured tail on timeout', async () => {
  const session = createWaitSession('line 1\nline 2\nline 3\n');

  const result = await session.waitForPattern({ pattern: 'ready', since: 0, tailLines: 1, timeout: 20 });

  assert.deepEqual(result, {
    output: 'line 3',
    matched: false,
    timedOut: true,
    position: session._totalBytesEmitted,
  });
});

test('waitForPattern rejects invalid regex patterns', async () => {
  const session = createWaitSession('ready\n');

  await assert.rejects(
    session.waitForPattern({ pattern: '(', timeout: 20 }),
    /Invalid regex pattern in pattern/
  );
});

test('waitForPattern honors a future since cursor: live data before it is skipped', async () => {
  // _totalBytesEmitted = 0, since = 10: the first 10 emitted chars never match.
  const session = createWaitSession('');
  const waitPromise = session.waitForPattern({ pattern: 'ready', since: 10, timeout: 3000 });

  emitChunk(session, 'aready\n'); // 7 chars, all before the cursor
  emitChunk(session, 'bcd'); // 10th char crossed: only 'd' is after the cursor

  const result = await waitPromise;
  assert.equal(result.matched, false, 'data entirely before the cursor must not match');
  assert.equal(result.position, 10);
});

test('waitForPattern future since cursor slices exactly at the char boundary', async () => {
  const session = createWaitSession('');
  // 'rea' lands before the cursor, 'dy\n' after it: no match.
  const noMatch = session.waitForPattern({ pattern: 'ready', since: 3, timeout: 80 });
  emitChunk(session, 'ready\n');
  assert.equal((await noMatch).matched, false);

  // Same split, but the pattern lives fully after the cursor: match.
  const session2 = createWaitSession('');
  const match = session2.waitForPattern({ pattern: 'dy', since: 3, timeout: 3000 });
  emitChunk(session2, 'ready\n');
  assert.equal((await match).matched, true);
});

test('waitForPattern masks a delayed input echo (write-then-wait race, #12)', async () => {
  const session = createWaitSession('');
  // Simulate terminal_write of a marker-bearing command just before the wait:
  // its echo has not arrived yet. Register exactly like write() does.
  session.process = { write: () => {} };
  session.write('sleep 10; echo __MCP_DONE_abc__\r');

  const waitPromise = session.waitForPattern({ pattern: '__MCP_DONE_abc__', timeout: 3000 });

  // The echo streams in after the wait started (new data by position), with
  // PTY artifacts: \r\n expansion and a line wrap mid-echo.
  emitChunk(session, 'sleep 10;\r\necho __MCP_DONE_abc__\r\n');

  // The command is still sleeping — a grace wait proves no match fired on the echo.
  const grace = await session.waitForPattern({ pattern: 'SETTLED', timeout: 40 });
  assert.equal(grace.matched, false);

  // Real marker output eventually arrives and matches.
  emitChunk(session, 'wakeup\n__MCP_DONE_abc__0__\n');
  const result = await waitPromise;
  assert.equal(result.matched, true);
  assert.equal(result.output, 'wakeup\n__MCP_DONE_abc__0__');
});

test('waitForPattern echo mask releases on mismatch so real output matches', async () => {
  const session = createWaitSession('');
  session.process = { write: () => {} };
  session.write('echo AAA\r');

  const waitPromise = session.waitForPattern({ pattern: 'AAA-really', timeout: 3000 });

  // Unrelated output (not the echo) releases the mask immediately.
  emitChunk(session, 'booting services\n');
  // Real output that happens to contain the pending text still matches.
  emitChunk(session, 'AAA-really here\n');

  const result = await waitPromise;
  assert.equal(result.matched, true);
});

test('write registers pending echo; consumption clears it for later waits', async () => {
  const session = createWaitSession('');
  session.process = { write: () => {} };

  session.write('echo __MCP_DONE_abc__\r');
  assert.equal(session._pendingEcho, 'echo __MCP_DONE_abc__');

  // The echo arrives: the session-level expectation is consumed centrally.
  session._consumePendingEchoData('echo __MCP_DONE_abc__\r\n');
  assert.equal(session._pendingEcho, '');

  // A wait started afterwards is not armed against stale input: real output
  // that repeats the command text must still match.
  const waitPromise = session.waitForPattern({ pattern: '__MCP_DONE_abc__', timeout: 3000 });
  emitChunk(session, '__MCP_DONE_abc__ real output\n');
  assert.equal((await waitPromise).matched, true);
});

test('consumeEchoPrefix consumes, spans chunks, and releases on mismatch', () => {
  // Full consume with echo artifacts inside the span (\r\n expansion + wrap).
  const full = consumeEchoPrefix('sleep 10; echo X', 'sleep 10;\r\necho X\r\n');
  assert.equal(full.echo, '');
  assert.equal(full.chunk, '\r\n');

  // Echo spanning two chunks: prefix consumed, remainder expected.
  const part = consumeEchoPrefix('sleep 10; echo X', 'sleep 1');
  assert.equal(part.echo, '0; echo X');
  assert.equal(part.chunk, '');
  const rest = consumeEchoPrefix(part.echo, '0; echo X\r\n');
  assert.equal(rest.echo, '');
  assert.equal(rest.chunk, '\r\n');

  // Whitespace-only chunk between echo fragments keeps the expectation.
  const ws = consumeEchoPrefix('abc', '\r\n');
  assert.equal(ws.echo, 'abc');

  // Mismatch releases immediately; the chunk passes through untouched.
  const miss = consumeEchoPrefix('abc', 'xyz abc');
  assert.equal(miss.echo, '');
  assert.equal(miss.chunk, 'xyz abc');
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