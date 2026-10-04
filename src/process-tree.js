import { spawnSync as nodeSpawnSync } from 'node:child_process';

const TASKKILL_TIMEOUT_MS = 5000;
/** taskkill exit code when the target process no longer exists. */
const TASKKILL_NOT_FOUND_EXIT_CODE = 128;

/**
 * @typedef {{ ok: boolean, alreadyExited?: boolean, reason?: string }} KillResult
 */

/**
 * Kill a Windows process and all of its descendants via `taskkill /T /F`.
 *
 * Synchronous on purpose: it must also work inside `process.on('exit')`
 * handlers, where asynchronous work never runs.
 * @param {number} pid
 * @param {{ spawnSync?: typeof nodeSpawnSync }} [deps]
 * @returns {KillResult}
 */
export function killWindowsProcessTree(pid, { spawnSync = nodeSpawnSync } = {}) {
  if (!isValidPid(pid)) return { ok: false, reason: `invalid pid: ${pid}` };

  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: TASKKILL_TIMEOUT_MS,
    stdio: 'ignore',
  });

  if (result.error) return { ok: false, reason: `taskkill failed: ${result.error.message}` };
  if (result.status === 0) return { ok: true };
  if (result.status === TASKKILL_NOT_FOUND_EXIT_CODE) return { ok: true, alreadyExited: true };
  return { ok: false, reason: `taskkill exited with code ${result.status}` };
}

/**
 * Signal an entire Unix process group (the process must be a group leader).
 * @param {number} pid
 * @param {NodeJS.Signals} [signal='SIGTERM']
 * @param {{ kill?: (pid: number, signal: NodeJS.Signals) => void }} [deps]
 * @returns {KillResult}
 */
export function killUnixProcessGroup(pid, signal = 'SIGTERM', { kill = (target, sig) => process.kill(target, sig) } = {}) {
  if (!isValidPid(pid)) return { ok: false, reason: `invalid pid: ${pid}` };

  try {
    kill(-pid, signal);
    return { ok: true };
  } catch (err) {
    if (err.code === 'ESRCH') return { ok: true, alreadyExited: true };
    return { ok: false, reason: `process group kill failed: ${err.message}` };
  }
}

/**
 * Kill a process together with its descendants on the given platform.
 * @param {number} pid
 * @param {{ platform?: string, signal?: NodeJS.Signals }} [opts]
 * @returns {KillResult}
 */
export function killProcessTree(pid, { platform = process.platform, signal = 'SIGTERM' } = {}) {
  return platform === 'win32'
    ? killWindowsProcessTree(pid)
    : killUnixProcessGroup(pid, signal);
}

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}
