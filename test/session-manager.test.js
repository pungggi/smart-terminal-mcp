import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { SessionManager, resolveSessionCwd } from '../src/session-manager.js';

test('resolveSessionCwd returns an absolute directory path', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'smart-terminal-mcp-'));

  try {
    const resolved = await resolveSessionCwd(tempDir);
    assert.equal(resolved, resolvePath(tempDir));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SessionManager.create rejects invalid cwd before creating a session', async () => {
  let constructed = 0;
  class FakeSession {
    constructor() {
      constructed++;
    }
  }

  const manager = new SessionManager({ SessionClass: FakeSession });
  const missingDir = join(tmpdir(), `smart-terminal-mcp-missing-${Date.now()}`);

  try {
    await assert.rejects(
      () => manager.create({ cwd: missingDir }),
      (error) => {
        assert.match(error.message, /^Invalid cwd ".+": Path does not exist \(ENOENT\)$/);
        return true;
      }
    );
    assert.equal(constructed, 0);
    assert.equal(manager.list().length, 0);
  } finally {
    manager.destroyAll();
  }
});

test('SessionManager.create rejects unknown shell before creating a session', async () => {
  let constructed = 0;
  class FakeSession {
    constructor() {
      constructed++;
    }
  }

  const manager = new SessionManager({ SessionClass: FakeSession });

  try {
    await assert.rejects(
      () => manager.create({ shell: 'nonexistent-shell-abc123' }),
      (error) => {
        assert.match(error.message, /Shell "nonexistent-shell-abc123" not found/);
        return true;
      }
    );
    assert.equal(constructed, 0);
    assert.equal(manager.list().length, 0);
  } finally {
    manager.destroyAll();
  }
});

test('SessionManager.create rejects file cwd values', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'smart-terminal-mcp-'));
  const filePath = join(tempDir, 'not-a-directory.txt');
  await writeFile(filePath, 'hello');

  const manager = new SessionManager({
    SessionClass: class FakeSession { },
  });

  try {
    await assert.rejects(
      () => manager.create({ cwd: filePath }),
      /Path is not a directory/
    );
    assert.equal(manager.list().length, 0);
  } finally {
    manager.destroyAll();
    await rm(tempDir, { recursive: true, force: true });
  }
});