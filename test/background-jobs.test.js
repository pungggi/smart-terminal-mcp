import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BackgroundJobManager, buildShellInvocation } from '../src/background-jobs.js';

function createMockChild() {
  const child = new EventEmitter();
  child.pid = 999;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  return child;
}

test('buildShellInvocation shapes shell arguments appropriately', () => {
  const pwsh = buildShellInvocation('pwsh.exe', ['-NoLogo'], 'echo hi');
  assert.deepEqual(pwsh.args, ['-NoLogo', '-NonInteractive', '-Command', 'echo hi']);
  assert.equal(pwsh.windowsVerbatimArguments, false);

  const cmd = buildShellInvocation('cmd.exe', [], 'echo hi');
  assert.deepEqual(cmd.args, ['/d', '/s', '/c', '"echo hi"']);
  assert.equal(cmd.windowsVerbatimArguments, true);

  const bash = buildShellInvocation('bash', [], 'echo hi');
  assert.deepEqual(bash.args, ['-c', 'echo hi']);
  assert.equal(bash.windowsVerbatimArguments, false);
});

test('BackgroundJobManager starts and tracks jobs', async () => {
  const child = createMockChild();
  const spawnCalls = [];
  const manager = new BackgroundJobManager({
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      setTimeout(() => child.emit('spawn'), 10);
      return child;
    },
    detectShell: () => ({ shell: 'bash', args: [] }),
    resolveCwd: async () => '/mock/cwd',
    logDir: null, // Disable file logging for tests
  });

  const job = await manager.start({ command: 'echo hello' });
  
  assert.equal(job.command, 'echo hello');
  assert.equal(job.cwd, '/mock/cwd');
  assert.equal(job.alive, true);
  
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, 'bash');
  assert.deepEqual(spawnCalls[0].args, ['-c', 'echo hello']);
  assert.equal(spawnCalls[0].opts.cwd, '/mock/cwd');
  
  const list = manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, job.id);
  
  // Test reading output
  child.stdout.emit('data', 'hello\n');
  child.stdout.emit('data', 'world');
  
  const read = job.read();
  assert.equal(read.output, 'hello\nworld');
  assert.equal(read.position, 11);
  
  // Test job exit
  child.emit('close', 0, null);
  assert.equal(job.alive, false);
  assert.equal(job.exitCode, 0);
  assert.equal(manager.list()[0].alive, false);
});

test('BackgroundJobManager stops job and invokes killTree', async () => {
  const child = createMockChild();
  let killTreePid = null;
  const manager = new BackgroundJobManager({
    spawn: () => {
      setTimeout(() => child.emit('spawn'), 1);
      return child;
    },
    detectShell: () => ({ shell: 'sh', args: [] }),
    resolveCwd: async () => '/',
    killTree: (pid) => {
      killTreePid = pid;
      return { ok: true };
    },
    logDir: null,
  });

  const job = await manager.start({ command: 'sleep 10' });
  manager.stop(job.id);
  
  assert.equal(killTreePid, child.pid);
});

test('BackgroundJobManager ensures capacity by evicting oldest finished', async () => {
  const manager = new BackgroundJobManager({
    spawn: () => {
      const child = createMockChild();
      setTimeout(() => child.emit('spawn'), 1);
      return child;
    },
    detectShell: () => ({ shell: 'sh', args: [] }),
    resolveCwd: async () => '/',
    logDir: null,
    maxJobs: 2,
  });

  const job1 = await manager.start({ command: '1' });
  const job2 = await manager.start({ command: '2' });
  
  // Mark job1 as finished
  job1._child.emit('close', 0, null);
  
  // Starting a 3rd job should evict job1 (max 2)
  const job3 = await manager.start({ command: '3' });
  
  const list = manager.list();
  assert.equal(list.length, 2);
  assert.ok(list.some(j => j.id === job2.id));
  assert.ok(list.some(j => j.id === job3.id));
  assert.ok(!list.some(j => j.id === job1.id));
});
