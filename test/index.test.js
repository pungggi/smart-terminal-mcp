import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SCAN_VALUES = ['1', 'true'];

test('src/index.js skips auto-start when SMITHERY_SCAN is truthy', () => {
  for (const value of SCAN_VALUES) {
    const result = spawnSync(process.execPath, ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, SMITHERY_SCAN: value },
      encoding: 'utf8',
      timeout: 3_000,
    });

    assert.equal(result.status, 0, `expected exit 0 for SMITHERY_SCAN=${value}, got status=${result.status}, signal=${result.signal}, stderr=${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
  }
});