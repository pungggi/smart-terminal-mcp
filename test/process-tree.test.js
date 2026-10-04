import test from 'node:test';
import assert from 'node:assert/strict';
import { killUnixProcessGroup, killWindowsProcessTree } from '../src/process-tree.js';

function fakeSpawnSync(result) {
  const calls = [];
  const spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  return { calls, spawnSync };
}

test('killWindowsProcessTree runs taskkill /T /F for the pid', () => {
  const { calls, spawnSync } = fakeSpawnSync({ status: 0 });

  const result = killWindowsProcessTree(1234, { spawnSync });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/PID', '1234', '/T', '/F']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.ok(calls[0].opts.timeout > 0);
});

test('killWindowsProcessTree treats "not found" as already exited', () => {
  const { spawnSync } = fakeSpawnSync({ status: 128 });
  assert.deepEqual(killWindowsProcessTree(1234, { spawnSync }), { ok: true, alreadyExited: true });
});

test('killWindowsProcessTree reports spawn errors and other exit codes', () => {
  assert.equal(killWindowsProcessTree(1, { spawnSync: () => ({ error: new Error('boom') }) }).ok, false);
  assert.match(killWindowsProcessTree(1, { spawnSync: () => ({ status: 1 }) }).reason, /code 1/);
});

test('killWindowsProcessTree rejects invalid pids without spawning', () => {
  const { calls, spawnSync } = fakeSpawnSync({ status: 0 });
  for (const pid of [0, -5, 1.5, undefined, '12']) {
    assert.equal(killWindowsProcessTree(pid, { spawnSync }).ok, false);
  }
  assert.equal(calls.length, 0);
});

test('killUnixProcessGroup signals the negative pid', () => {
  const calls = [];
  const result = killUnixProcessGroup(42, 'SIGTERM', { kill: (pid, sig) => calls.push([pid, sig]) });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [[-42, 'SIGTERM']]);
});

test('killUnixProcessGroup maps ESRCH to already exited and surfaces other errors', () => {
  const esrch = Object.assign(new Error('gone'), { code: 'ESRCH' });
  const eperm = Object.assign(new Error('nope'), { code: 'EPERM' });
  assert.deepEqual(killUnixProcessGroup(42, 'SIGTERM', { kill: () => { throw esrch; } }), { ok: true, alreadyExited: true });
  assert.equal(killUnixProcessGroup(42, 'SIGTERM', { kill: () => { throw eperm; } }).ok, false);
});
