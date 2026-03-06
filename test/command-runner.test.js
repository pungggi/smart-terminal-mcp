import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runCommand } from '../src/command-runner.js';

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