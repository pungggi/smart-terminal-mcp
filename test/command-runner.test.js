import test from 'node:test';
import assert from 'node:assert/strict';
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