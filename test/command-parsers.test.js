import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommandName, parseCommandOutput } from '../src/command-parsers.js';

test('normalizeCommandName removes executable extensions', () => {
  assert.equal(normalizeCommandName('C:\\Windows\\System32\\where.exe'), 'where');
});

test('parseCommandOutput parses git log --oneline', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['log', '--oneline'],
    stdout: 'a1b2c3d Add parser\nffeedd0 Fix tests\n',
  });

  assert.deepEqual(parsed, {
    commits: [
      { hash: 'a1b2c3d', message: 'Add parser' },
      { hash: 'ffeedd0', message: 'Fix tests' },
    ],
  });
});

test('parseCommandOutput parses git status porcelain output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['status', '--porcelain=v1', '--branch'],
    stdout: '## main...origin/main [ahead 2]\nM  staged.txt\n M modified.txt\n?? new file.txt\n',
  });

  assert.deepEqual(parsed, {
    branch: { head: 'main', upstream: 'origin/main', ahead: 2 },
    staged: ['staged.txt'],
    modified: ['modified.txt'],
    untracked: ['new file.txt'],
  });
});

test('parseCommandOutput parses tasklist csv output', () => {
  const parsed = parseCommandOutput({
    cmd: 'tasklist',
    args: ['/fo', 'csv', '/nh'],
    stdout: '"node.exe","1234","Console","1","25,000 K"\n',
  });

  assert.deepEqual(parsed, {
    processes: [{
      imageName: 'node.exe',
      pid: 1234,
      sessionName: 'Console',
      sessionNumber: 1,
      memUsage: '25,000 K',
    }],
  });
});

test('parseCommandOutput parses where or which output as paths', () => {
  const parsed = parseCommandOutput({
    cmd: 'where',
    args: ['git'],
    stdout: 'C:\\Program Files\\Git\\bin\\git.exe\nC:\\Windows\\System32\\git.exe\n',
  });

  assert.deepEqual(parsed, {
    paths: [
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Windows\\System32\\git.exe',
    ],
  });
});

test('parseCommandOutput returns null for unsupported commands', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['show'],
    stdout: 'raw output',
  });

  assert.equal(parsed, null);
});