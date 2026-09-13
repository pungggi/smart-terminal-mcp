import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'check-deps.mjs');

const run = (env = {}) =>
  spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('engine guard passes on the committed lockfile', () => {
  const r = run();
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /all production dependencies support Node >= 18\.14\.1/);
});

test('engine guard fails when a production dep raises the Node floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-guard-'));
  try {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    // Simulate the drift the guard exists to catch: @hono/node-server 2.x
    lock.packages['node_modules/@hono/node-server'].engines = { node: '>=20' };
    const tmp = join(dir, 'package-lock.json');
    writeFileSync(tmp, JSON.stringify(lock));

    const r = run({ LOCKFILE: tmp });
    assert.equal(r.status, 1, 'guard must fail on an engine regression');
    assert.match(r.stderr, /node_modules\/@hono\/node-server/);
    assert.match(r.stderr, />=20/);
    assert.match(r.stderr, /Patch runbook/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engine guard ignores dev-only and optional dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-guard-'));
  try {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/@hono/node-server'].dev = true;
    lock.packages['node_modules/hono'] = { version: '9.9.9', optional: true, engines: { node: '>=99' } };
    const tmp = join(dir, 'package-lock.json');
    writeFileSync(tmp, JSON.stringify(lock));

    const r = run({ LOCKFILE: tmp });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
