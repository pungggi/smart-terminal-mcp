import test from 'node:test';
import assert from 'node:assert/strict';
import { PtySession } from '../src/pty-session.js';

function createSession() {
  return Object.create(PtySession.prototype);
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