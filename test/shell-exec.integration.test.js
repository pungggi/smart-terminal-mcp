import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtySession } from '../src/pty-session.js';
import { isAvailable } from '../src/shell-detector.js';

// These tests drive REAL shells through the same path agents use, so they
// prove the wrapper fixes (exit codes, cwd tracking) rather than the mocks.
// Each test spins up its own session and kills it in cleanup.

const EXEC_TIMEOUT = 10_000;

async function withSession(shell, shellArgs, run) {
  const session = new PtySession({
    id: `it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    shell,
    shellArgs,
    cols: 120,
    rows: 30,
    cwd: tmpdir(),
  });
  // Timestamped raw-chunk trace: when integration tests fail on CI, the
  // ordering of writes/echo/DSR vs shell readiness is the thing we need.
  const t0 = Date.now();
  const trace = [];
  session._dataListeners.push((chunk) => {
    if (trace.length < 200) trace.push(`+${Date.now() - t0}ms ${JSON.stringify(chunk.slice(0, 120))}`);
  });
  try {
    await session.waitForBanner();
    trace.push(`+${Date.now() - t0}ms BANNER DONE`);
    const result = await run(session);
    trace.push(`+${Date.now() - t0}ms RUN DONE`);
    return result;
  } catch (err) {
    // Integration failures are environment-dependent; attach what the PTY actually
    // emitted so CI logs show ground truth instead of a bare assertion diff.
    const tail = String(session._buffer ?? '').slice(-1500);
    err.message += `\n[session ${session.id} buffer tail]\n${JSON.stringify(tail)}`;
    err.message += `\n[session ${session.id} chunk trace]\n${trace.join('\n')}`;
    throw err;
  } finally {
    session.kill();
  }
}

function pickShell(candidates) {
  for (const [shell, args] of candidates) {
    if (isAvailable(shell)) return { shell, args };
  }
  return null;
}

test('PowerShell exit codes: cmdlet failure reports 1 before any native command', { timeout: 30000 }, async (t) => {
  const found = pickShell([['pwsh.exe', ['-NoLogo', '-NoProfile']], ['powershell.exe', ['-NoLogo', '-NoProfile']], ['pwsh', ['-NoLogo', '-NoProfile']]]);
  if (!found) return t.skip('no PowerShell available');
  if (process.platform === 'win32' && !isAvailable('pwsh.exe') && !isAvailable('powershell.exe')) return t.skip('no PowerShell available');

  await withSession(found.shell, found.args, async (session) => {
    // Cmdlet failure with NO prior native command: old code reported null
    // (empty $LASTEXITCODE); the fixed wrapper must report 1.
    const missing = join(tmpdir(), `definitely-missing-${Date.now()}`);
    const result = await session.exec({ command: `Get-Item '${missing}'`, timeout: EXEC_TIMEOUT });

    assert.equal(result.exitCode, 1);
  });
});

test('PowerShell exit codes: cmdlet success after native failure reports 0', { timeout: 30000 }, async (t) => {
  const found = pickShell([['pwsh.exe', ['-NoLogo', '-NoProfile']], ['powershell.exe', ['-NoLogo', '-NoProfile']], ['pwsh', ['-NoLogo', '-NoProfile']]]);
  if (!found) return t.skip('no PowerShell available');

  await withSession(found.shell, found.args, async (session) => {
    const nativeFail = process.platform === 'win32' ? 'cmd /c exit 7' : 'sh -c "exit 7"';

    await session.exec({ command: nativeFail, timeout: EXEC_TIMEOUT });
    // The regression: the old wrapper reported the stale 7 here.
    const result = await session.exec({ command: 'Write-Output ok', timeout: EXEC_TIMEOUT });

    assert.equal(result.exitCode, 0);
    assert.match(result.output, /ok/);
  });
});

test('PowerShell exit codes: native failure reports the real exit code', { timeout: 30000 }, async (t) => {
  const found = pickShell([['pwsh.exe', ['-NoLogo', '-NoProfile']], ['powershell.exe', ['-NoLogo', '-NoProfile']], ['pwsh', ['-NoLogo', '-NoProfile']]]);
  if (!found) return t.skip('no PowerShell available');

  await withSession(found.shell, found.args, async (session) => {
    const nativeFail = process.platform === 'win32' ? 'cmd /c exit 7' : 'sh -c "exit 7"';

    const result = await session.exec({ command: nativeFail, timeout: EXEC_TIMEOUT });

    assert.equal(result.exitCode, 7);
  });
});

test('cmd markers: exit code and cwd reflect the executed command', { skip: process.platform !== 'win32' ? 'cmd is Windows-only' : false, timeout: 30000 }, async (t) => {
  if (!isAvailable('cmd.exe')) return t.skip('cmd.exe not available');

  await withSession('cmd.exe', [], async (session) => {
    // Stale-errorlevel regression: the old single-line wrapper expanded
    // %ERRORLEVEL% at parse time, before the command ran, so this reported
    // the PREVIOUS command's errorlevel (typically 0).
    const fail = await session.exec({ command: 'cmd /c exit 5', timeout: EXEC_TIMEOUT });
    assert.equal(fail.exitCode, 5);

    // Stale-cwd regression: %CD% used to expand before the cd executed.
    const cwdChange = await session.exec({ command: 'cd C:\\', timeout: EXEC_TIMEOUT });
    assert.equal(cwdChange.cwd, 'C:\\');
    assert.equal(session.cwd, 'C:\\');
  });
});

test('bash markers: exit code and cwd reflect the executed command', { skip: process.platform === 'win32' ? 'use the platform shell on Windows' : false, timeout: 30000 }, async (t) => {
  if (!isAvailable('bash')) return t.skip('bash not available');

  await withSession('bash', [], async (session) => {
    const fail = await session.exec({ command: 'sh -c "exit 3"', timeout: EXEC_TIMEOUT });
    assert.equal(fail.exitCode, 3);

    const cwdChange = await session.exec({ command: 'cd /tmp', timeout: EXEC_TIMEOUT });
    assert.equal(cwdChange.cwd, '/tmp');
  });
});

test('exec guard: PowerShell here-string commands fail fast with the file workaround', { timeout: 30000 }, async (t) => {
  const found = pickShell([['pwsh.exe', ['-NoLogo', '-NoProfile']], ['powershell.exe', ['-NoLogo', '-NoProfile']], ['pwsh', ['-NoLogo', '-NoProfile']]]);
  if (!found) return t.skip('no PowerShell available');

  await withSession(found.shell, found.args, async (session) => {
    // The exact shape from the incident: multi-line here-string body with an
    // apostrophe inside ("Track C's"). Pre-guard this hung the session until
    // the timeout with PS stuck at a `>>` continuation prompt.
    const command = "gh pr create --title t --body @'\n## Roadmap\nTrack C's 400 ms budget\n'@";

    await assert.rejects(
      session.exec({ command, timeout: EXEC_TIMEOUT }),
      (err) => {
        assert.match(err.message, /here-strings/);
        assert.match(err.message, /terminal_write_file/);
        assert.match(err.message, /--body-file/);
        return true;
      },
    );
    // The session must survive untouched and stay usable.
    const probe = await session.exec({ command: 'Write-Output alive', timeout: EXEC_TIMEOUT });
    assert.equal(probe.exitCode, 0);
    assert.match(probe.output, /alive/);
  });
});

test('exec timeout: unterminated PowerShell string reports the continuation hint', { timeout: 30000 }, async (t) => {
  const found = pickShell([['pwsh.exe', ['-NoLogo', '-NoProfile']], ['powershell.exe', ['-NoLogo', '-NoProfile']], ['pwsh', ['-NoLogo', '-NoProfile']]]);
  if (!found) return t.skip('no PowerShell available');

  await withSession(found.shell, found.args, async (session) => {
    // A bare unclosed double quote is not guarded (agents may legitimately
    // type one and complete it via terminal_write), so this exercises the
    // runtime path: PS sits at `>>`, exec times out, and the hint must name
    // the continuation prompt instead of claiming the command is running.
    const result = await session.exec({ command: 'Write-Output "unclosed', timeout: 4000 });

    assert.equal(result.timedOut, true);
    assert.match(result.hint, /continuation prompt \(>>\)/);
    assert.match(result.hint, /terminal_write|ctrl\+c/);

    // Recover the session so cleanup kills a healthy PTY.
    session.sendKey('ctrl+c');
    await session.exec({ command: 'Write-Output recovered', timeout: EXEC_TIMEOUT });
  });
});
