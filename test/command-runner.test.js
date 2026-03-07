import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStructuredParserHint, runCommand } from '../src/command-runner.js';

test('runCommand captures stdout for a successful command', async () => {
  const result = await runCommand({
    cmd: process.execPath,
    args: ['-e', 'process.stdout.write("hello")'],
    parse: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.raw, 'hello');
  assert.equal(result.stderr.raw, '');
});

test('runCommand keeps stderr and non-zero exit codes in-band', async () => {
  const result = await runCommand({
    cmd: process.execPath,
    args: ['-e', 'process.stderr.write("boom"); process.exit(3)'],
    parse: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr.raw, 'boom');
});

test('runCommand marks timed out processes', async () => {
  const result = await runCommand({
    cmd: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 1000)'],
    timeout: 50,
    parse: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('runCommand rejects invalid working directories', async () => {
  await assert.rejects(
    runCommand({
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: join(process.cwd(), '__missing__'),
      parse: false,
    }),
    /Failed to start command/
  );
});

test('runCommand stops when maxOutputBytes is exceeded', async () => {
  const result = await runCommand({
    cmd: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(4096))'],
    maxOutputBytes: 128,
    parse: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.maxOutputExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout.raw, 'utf8') <= 128);
});

test('runCommand can omit raw output when parseOnly is enabled', async () => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const result = await runCommand({
    cmd: lookupCommand,
    args: [lookupCommand],
    parse: false,
    parseOnly: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout.raw, '');
  assert.ok(Array.isArray(result.stdout.parsed?.paths));
  assert.ok(result.stdout.parsed.paths.length > 0);
});

test('runCommand can return concise summaries for supported commands', async () => {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const result = await runCommand({
    cmd: lookupCommand,
    args: [lookupCommand],
    parse: false,
    summary: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout.raw, '');
  assert.equal(result.stdout.parsed, null);
  assert.ok(result.stdout.summary?.pathCount > 0);
});

test('runCommand can use a custom successExitCode', async () => {
  const result = await runCommand({
    cmd: process.execPath,
    args: ['-e', 'process.exit(3)'],
    parse: false,
    successExitCode: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.checks, {
    exitCode: {
      ok: true,
      expected: 3,
      actual: 3,
    },
  });
});

test('runCommand can require a success file pattern', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'smart-terminal-mcp-'));

  try {
    const result = await runCommand({
      cmd: process.execPath,
      cwd: tempDir,
      args: ['-e', 'require("node:fs").writeFileSync("build.log", "BUILD OK\\n")'],
      parse: false,
      successFile: 'build.log',
      successFilePattern: 'BUILD OK',
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.checks, {
      exitCode: {
        ok: true,
        expected: 0,
        actual: 0,
      },
      successFile: {
        path: join(tempDir, 'build.log'),
        matched: true,
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCommand marks ok=false when success file pattern does not match', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'smart-terminal-mcp-'));

  try {
    const result = await runCommand({
      cmd: process.execPath,
      cwd: tempDir,
      args: ['-e', 'require("node:fs").writeFileSync("build.log", "BUILD FAILED\\n")'],
      parse: false,
      successFile: 'build.log',
      successFilePattern: 'BUILD OK',
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.checks, {
      exitCode: {
        ok: true,
        expected: 0,
        actual: 0,
      },
      successFile: {
        path: join(tempDir, 'build.log'),
        matched: false,
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCommand requires successFile and successFilePattern together', async () => {
  await assert.rejects(
    runCommand({
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      parse: false,
      successFile: 'build.log',
    }),
    /successFile and successFilePattern/
  );
});

test('runCommand keeps raw output when summary mode has no supported parser', async () => {
  const result = await runCommand({
    cmd: process.execPath,
    args: ['-e', 'process.stdout.write("hello")'],
    parse: false,
    summary: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout.raw, 'hello');
  assert.equal(result.stdout.parsed, null);
  assert.equal(result.stdout.summary, undefined);
});

test('runCommand resolves .cmd wrappers from PATH on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only behavior');
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'smart-terminal-mcp-'));
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;

  try {
    await writeFile(join(tempDir, 'echo-wrapper.cmd'), '@echo off\r\necho %~1\r\n');
    process.env.PATH = `${tempDir};${originalPath ?? ''}`;
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

    const result = await runCommand({
      cmd: 'echo-wrapper',
      args: ['hello'],
      parse: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.raw, /hello/);
  } finally {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCommand executes explicit .cmd files on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only behavior');
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'smart-terminal-mcp-'));

  try {
    const scriptPath = join(tempDir, 'args-wrapper.cmd');
    await writeFile(scriptPath, '@echo off\r\necho [%~1]\r\n');

    const result = await runCommand({
      cmd: scriptPath,
      args: ['hello world'],
      parse: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.raw, /\[hello world\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCommand handles explicit command paths with spaces', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'smart terminal mcp-'));

  try {
    const isWindows = process.platform === 'win32';
    const scriptPath = join(tempDir, isWindows ? 'space wrapper.cmd' : 'space-wrapper.sh');
    const scriptBody = isWindows
      ? '@echo off\r\necho [%~1]\r\n'
      : '#!/bin/sh\necho "[$1]"\n';

    await writeFile(scriptPath, scriptBody);
    if (!isWindows) await chmod(scriptPath, 0o755);

    const result = await runCommand({
      cmd: scriptPath,
      args: ['hello world'],
      parse: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout.raw, /\[hello world\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runCommand adds a helpful ENOENT hint on Windows for PATH commands', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only behavior');
    return;
  }

  await assert.rejects(
    runCommand({
      cmd: '__smart_terminal_missing_command__',
      parse: false,
    }),
    /verify it is installed and visible to the server process/
  );
});

test('getStructuredParserHint returns a hint for large unmatched parser-worthy output', () => {
  const hint = getStructuredParserHint({
    cmd: 'git',
    args: ['log', '--stat'],
    ok: true,
    parseRequested: true,
    parsed: null,
    stdout: 'commit summary line\n'.repeat(20),
  });

  assert.equal(hint, 'Structured parser unavailable for this command signature. If you need this often, propose one.');
});

test('getStructuredParserHint skips short unmatched output', () => {
  const hint = getStructuredParserHint({
    cmd: 'git',
    args: ['log', '--stat'],
    ok: true,
    parseRequested: true,
    parsed: null,
    stdout: 'short\n',
  });

  assert.equal(hint, null);
});

test('getStructuredParserHint skips commands when parsing was not requested', () => {
  const hint = getStructuredParserHint({
    cmd: 'git',
    args: ['log', '--stat'],
    ok: true,
    parseRequested: false,
    parsed: null,
    stdout: 'commit summary line\n'.repeat(20),
  });

  assert.equal(hint, null);
});

test('getStructuredParserHint skips non parser-worthy commands', () => {
  const hint = getStructuredParserHint({
    cmd: 'git',
    args: ['show'],
    ok: true,
    parseRequested: true,
    parsed: null,
    stdout: 'commit summary line\n'.repeat(20),
  });

  assert.equal(hint, null);
});