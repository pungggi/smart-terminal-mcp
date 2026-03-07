import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Check if an executable is available on the system.
 * @param {string} exe
 * @returns {boolean}
 */
export function isAvailable(exe) {
  try {
    const cmd = platform() === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [exe], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the best available shell for the current platform.
 * Windows priority: pwsh.exe > powershell.exe > cmd.exe
 * Linux/macOS: $SHELL or fallback to bash
 * @returns {{ shell: string, args: string[] }}
 */
export function detectShell() {
  if (platform() === 'win32') {
    return detectWindowsShell();
  }
  return detectUnixShell();
}

function detectWindowsShell() {
  // Check env var override first
  const pwshPath = process.env.PWSH_PATH;
  if (pwshPath && isAvailable(pwshPath)) {
    return { shell: pwshPath, args: ['-NoLogo', '-NoProfile'] };
  }

  if (isAvailable('pwsh.exe')) {
    return { shell: 'pwsh.exe', args: ['-NoLogo', '-NoProfile'] };
  }

  if (isAvailable('powershell.exe')) {
    return { shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] };
  }

  return { shell: 'cmd.exe', args: [] };
}

function detectUnixShell() {
  const userShell = process.env.SHELL;
  if (userShell) {
    return { shell: userShell, args: [] };
  }

  if (isAvailable('bash')) {
    return { shell: 'bash', args: [] };
  }

  return { shell: 'sh', args: [] };
}

/**
 * Determine the shell type from the shell path/name.
 * @param {string} shell
 * @returns {'powershell' | 'cmd' | 'bash'}
 */
export function getShellType(shell) {
  const lower = shell.toLowerCase();
  if (lower.includes('pwsh') || lower.includes('powershell')) {
    return 'powershell';
  }
  if (lower.includes('cmd')) {
    return 'cmd';
  }
  return 'bash';
}
