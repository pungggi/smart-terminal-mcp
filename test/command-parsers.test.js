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

test('parseCommandOutput parses git log --oneline with max-count variants', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['log', '--oneline', '-n', '2'],
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

test('parseCommandOutput parses git status short aliases', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['status', '-b', '--short'],
    stdout: '## feature...origin/feature [ahead 1, behind 2]\n M changed.txt\n',
  });

  assert.deepEqual(parsed, {
    branch: { head: 'feature', upstream: 'origin/feature', ahead: 1, behind: 2 },
    staged: [],
    modified: ['changed.txt'],
    untracked: [],
  });
});

test('parseCommandOutput parses git status --short without branch metadata', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['status', '--short'],
    stdout: 'M  staged.txt\n M modified.txt\n?? new file.txt\n',
  });

  assert.deepEqual(parsed, {
    branch: null,
    staged: ['staged.txt'],
    modified: ['modified.txt'],
    untracked: ['new file.txt'],
  });
});

test('parseCommandOutput parses git branch output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['branch'],
    stdout: '* main\n  feature/test\n',
  });

  assert.deepEqual(parsed, {
    branches: [
      { name: 'main', current: true },
      { name: 'feature/test', current: false },
    ],
  });
});

test('parseCommandOutput parses git branch --all output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['branch', '--all'],
    stdout: '* main\n  remotes/origin/main\n',
  });

  assert.deepEqual(parsed, {
    branches: [
      { name: 'main', current: true },
      { name: 'remotes/origin/main', current: false },
    ],
  });
});

test('parseCommandOutput parses git branch -vv output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['branch', '-vv'],
    stdout: '* main abc1234 [origin/main: ahead 1] Main branch\n  old fedcba9 [origin/old: gone] Old branch\n',
  });

  assert.deepEqual(parsed, {
    branches: [
      {
        name: 'main',
        current: true,
        commit: 'abc1234',
        upstream: 'origin/main',
        ahead: 1,
        message: 'Main branch',
      },
      {
        name: 'old',
        current: false,
        commit: 'fedcba9',
        upstream: 'origin/old',
        gone: true,
        message: 'Old branch',
      },
    ],
  });
});

test('parseCommandOutput parses git branch --show-current', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['branch', '--show-current'],
    stdout: 'main\n',
  });

  assert.deepEqual(parsed, { current: 'main' });
});

test('parseCommandOutput parses git rev-parse --abbrev-ref HEAD', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    stdout: 'main\n',
  });

  assert.deepEqual(parsed, { current: 'main' });
});

test('parseCommandOutput parses git diff --name-only', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--cached', '--name-only'],
    stdout: 'src/index.js\nREADME.md\n',
  });

  assert.deepEqual(parsed, {
    paths: ['src/index.js', 'README.md'],
  });
});

test('parseCommandOutput parses git diff --name-status', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--name-status'],
    stdout: 'M\tsrc/index.js\nR100\told-name.js\tnew-name.js\n',
  });

  assert.deepEqual(parsed, {
    changes: [
      { status: 'M', path: 'src/index.js' },
      { status: 'R100', path: 'new-name.js', previousPath: 'old-name.js' },
    ],
  });
});

test('parseCommandOutput parses git diff --stat', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['diff', '--stat'],
    stdout: ' src/index.js | 2 +-\n README.md    | 3 ++-\n 2 files changed, 3 insertions(+), 2 deletions(-)\n',
  });

  assert.deepEqual(parsed, {
    files: [
      { path: 'src/index.js', changes: 2, histogram: '+-' },
      { path: 'README.md', changes: 3, histogram: '++-' },
    ],
    summary: {
      filesChanged: 2,
      insertions: 3,
      deletions: 2,
    },
  });
});

test('parseCommandOutput parses git remote -v output', () => {
  const parsed = parseCommandOutput({
    cmd: 'git',
    args: ['remote', '-v'],
    stdout: 'origin\thttps://github.com/example/repo.git (fetch)\norigin\thttps://github.com/example/repo.git (push)\n',
  });

  assert.deepEqual(parsed, {
    remotes: [
      {
        name: 'origin',
        fetchUrl: 'https://github.com/example/repo.git',
        pushUrl: 'https://github.com/example/repo.git',
      },
    ],
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