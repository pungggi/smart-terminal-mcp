import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { platform } from 'node:os';
import { extname, isAbsolute } from 'node:path';

/**
 * Check if an executable is available on the system.
 * @param {string} exe
 * @returns {boolean}
 */
export function isAvailable(exe) {
  try {
    if (isAbsolute(exe)) {
      accessSync(exe, constants.X_OK);
      return statSync(exe).isFile();
    }

    const cmd = platform() === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [exe], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the best available shell for the current platform.
 * SMART_TERMINAL_SHELL pins a shell by name or absolute path.
 * Windows priority: pwsh.exe > powershell.exe > cmd.exe
 * Linux/macOS: $SHELL or fallback to bash
 * @returns {{ shell: string, args: string[] }}
 */
export function detectShell() {
  const pinnedShell = process.env.SMART_TERMINAL_SHELL;
  if (pinnedShell) {
    const shell = findAvailableShell(pinnedShell);
    if (shell) return { shell, args: getShellArgs(shell) };
  }

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

const WINDOWS_SHELL_EXTENSIONS = ['.exe', '.cmd', '.bat'];

/**
 * Resolve an available shell by name or absolute path.
 * On Windows, tries appending common extensions to bare names.
 * @param {string} shell
 * @returns {string | null}
 */
export function findAvailableShell(shell) {
  if (isAvailable(shell)) return shell;

  if (platform() === 'win32' && !extname(shell)) {
    for (const ext of WINDOWS_SHELL_EXTENSIONS) {
      const candidate = `${shell}${ext}`;
      if (isAvailable(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Return non-interactive startup arguments for a shell.
 * @param {string} shell
 * @returns {string[]}
 */
export function getShellArgs(shell) {
  return getShellType(shell) === 'powershell' ? ['-NoLogo', '-NoProfile'] : [];
}

/**
 * Determine the shell type from the shell path/name.
 * @param {string} shell
 * @returns {'powershell' | 'cmd' | 'bash'}
 */
export function getShellType(shell) {
  const executable = shell.split(/[\\/]/).pop().toLowerCase();
  if (executable.includes('pwsh') || executable.includes('powershell')) {
    return 'powershell';
  }
  if (executable.includes('cmd')) {
    return 'cmd';
  }
  return 'bash';
}
