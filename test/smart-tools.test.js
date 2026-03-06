import test from 'node:test';
import assert from 'node:assert/strict';
import { execAndDiff, execWithRetry } from '../src/smart-tools.js';

test('execWithRetry retries until the exit code and pattern succeed', async () => {
  const calls = [];
  const results = [
    { output: 'booting', exitCode: 1, cwd: 'C:/repo', timedOut: false },
    { output: 'service ready', exitCode: 0, cwd: 'C:/repo', timedOut: false },
  ];
  const session = {
    exec: async (opts) => {
      calls.push(opts);
      return results.shift();
    },
  };

  const result = await execWithRetry(session, {
    command: 'npm run dev',
    maxRetries: 2,
    backoff: 'fixed',
    delayMs: 0,
    timeout: 1234,
    maxLines: 50,
    successPattern: 'ready',
  });

  assert.deepEqual(calls, [
    { command: 'npm run dev', timeout: 1234, maxLines: 50 },
    { command: 'npm run dev', timeout: 1234, maxLines: 50 },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.lastResult.output, 'service ready');
  assert.equal(result.history.length, 2);
});

test('execWithRetry rejects invalid success patterns', async () => {
  const session = {
    exec: async () => ({ output: 'ready', exitCode: 0, cwd: 'C:/repo', timedOut: false }),
  };

  await assert.rejects(
    execWithRetry(session, { command: 'npm test', successPattern: '(' }),
    /Invalid regex pattern in successPattern/
  );
});

test('execAndDiff returns a unified diff for changed output', async () => {
  const calls = [];
  const session = {
    exec: async (opts) => {
      calls.push(opts);
      return calls.length === 1
        ? { output: 'alpha\nbeta', exitCode: 0, cwd: 'C:/repo', timedOut: false }
        : { output: 'alpha\ngamma', exitCode: 0, cwd: 'C:/repo', timedOut: false };
    },
  };

  const result = await execAndDiff(session, {
    commandA: 'type before.txt',
    commandB: 'type after.txt',
    timeout: 500,
    maxLines: 20,
    contextLines: 1,
  });

  assert.deepEqual(calls, [
    { command: 'type before.txt', timeout: 500, maxLines: 20 },
    { command: 'type after.txt', timeout: 500, maxLines: 20 },
  ]);
  assert.equal(result.identical, false);
  assert.match(result.diff, /--- type before.txt/);
  assert.match(result.diff, /\+\+\+ type after.txt/);
  assert.match(result.diff, /-beta/);
  assert.match(result.diff, /\+gamma/);
});