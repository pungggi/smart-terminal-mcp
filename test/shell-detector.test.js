import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectShell, isAvailable } from '../src/shell-detector.js';

const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile'];

function withEnv(overrides, run) {
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    return run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function makeFakeExecutable(name) {
  const dir = await mkdtemp(join(tmpdir(), 'smart-terminal-shell-'));
  const shell = join(dir, name);
  await writeFile(shell, '', { mode: 0o755 });
  return { dir, shell };
}

test('isAvailable accepts an absolute executable path', () => {
  assert.equal(isAvailable(process.execPath), true);
});

test('detectShell uses SMART_TERMINAL_SHELL with an absolute PowerShell path', async () => {
  const { dir, shell } = await makeFakeExecutable(process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');

  try {
    const detected = withEnv({
      SMART_TERMINAL_SHELL: shell,
      PWSH_PATH: process.execPath,
      SHELL: process.execPath,
    }, () => detectShell());

    assert.deepEqual(detected, { shell, args: POWERSHELL_ARGS });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectShell resolves a shell name from SMART_TERMINAL_SHELL', () => {
  const detected = withEnv({
    SMART_TERMINAL_SHELL: 'node',
    PWSH_PATH: undefined,
    SHELL: undefined,
  }, () => detectShell());

  assert.deepEqual(detected, { shell: 'node', args: [] });
});

test('detectShell falls back when SMART_TERMINAL_SHELL is unavailable', async () => {
  const { dir, shell } = await makeFakeExecutable(process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
  const missingShell = join(dir, 'missing-shell');

  try {
    const detected = withEnv({
      SMART_TERMINAL_SHELL: missingShell,
      PWSH_PATH: shell,
      SHELL: process.execPath,
    }, () => detectShell());

    const expected = process.platform === 'win32'
      ? { shell, args: POWERSHELL_ARGS }
      : { shell: process.execPath, args: [] };
    assert.deepEqual(detected, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
