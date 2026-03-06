import { basename } from 'node:path';

export function normalizeCommandName(cmd) {
  const name = basename(cmd || '').toLowerCase();
  return name.endsWith('.exe') ? name.slice(0, -4) : name;
}

export function parseCommandOutput({ cmd, args = [], stdout }) {
  if (!stdout) return null;

  const name = normalizeCommandName(cmd);
  if (name === 'git' && isGitLogOneline(args)) return parseGitLogOneline(stdout);
  if (name === 'git' && isGitStatusPorcelain(args)) return parseGitStatusPorcelain(stdout);
  if (name === 'tasklist' && isTasklistCsv(args)) return parseTasklistCsv(stdout);
  if ((name === 'where' || name === 'which') && args.length > 0) return parsePathList(stdout);
  return null;
}

function isGitLogOneline(args) {
  return args.length === 2 && args[0] === 'log' && args[1] === '--oneline';
}

function isGitStatusPorcelain(args) {
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  return args[0] === 'status' && args.length === 3 && lowerArgs.includes('--branch') && lowerArgs.includes('--porcelain=v1');
}

function isTasklistCsv(args) {
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  return lowerArgs.length === 3 && lowerArgs[0] === '/fo' && lowerArgs[1] === 'csv' && lowerArgs[2] === '/nh';
}

function parseGitLogOneline(stdout) {
  const commits = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([0-9a-f]+)\s+(.+)$/i);
      return match ? { hash: match[1], message: match[2] } : null;
    })
    .filter(Boolean);

  return commits.length > 0 ? { commits } : null;
}

function parseGitStatusPorcelain(stdout) {
  const result = { branch: null, staged: [], modified: [], untracked: [] };

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('## ')) {
      result.branch = parseGitBranch(line.slice(3));
      continue;
    }

    if (line.startsWith('?? ')) {
      result.untracked.push(line.slice(3));
      continue;
    }

    if (line.length < 4) continue;

    const status = line.slice(0, 2);
    const path = normalizeGitPath(line.slice(3));
    if (!path) continue;
    if (status[0] !== ' ') result.staged.push(path);
    if (status[1] !== ' ') result.modified.push(path);
  }

  return result;
}

function parseGitBranch(value) {
  const match = value.match(/^([^\.\s]+)(?:\.\.\.([^\s]+))?(?: \[(.+)\])?$/);
  if (!match) return { head: value };

  const [, head, upstream, tracking] = match;
  const branch = { head };
  if (upstream) branch.upstream = upstream;

  if (tracking) {
    const ahead = tracking.match(/ahead (\d+)/);
    const behind = tracking.match(/behind (\d+)/);
    if (ahead) branch.ahead = Number.parseInt(ahead[1], 10);
    if (behind) branch.behind = Number.parseInt(behind[1], 10);
  }

  return branch;
}

function normalizeGitPath(value) {
  if (!value) return null;
  const renameParts = value.split(' -> ');
  return renameParts.at(-1)?.trim() || null;
}

function parseTasklistCsv(stdout) {
  const processes = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseTasklistCsvLine)
    .filter(Boolean);

  return processes.length > 0 ? { processes } : null;
}

function parseTasklistCsvLine(line) {
  if (!line.startsWith('"') || !line.endsWith('"')) return null;

  const [imageName, pidValue, sessionName, sessionNumberValue, memUsage] = line.slice(1, -1).split('","');
  if (!imageName || !pidValue) return null;

  return {
    imageName,
    pid: toNumberOrRaw(pidValue),
    sessionName,
    sessionNumber: toNumberOrRaw(sessionNumberValue),
    memUsage,
  };
}

function parsePathList(stdout) {
  const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return paths.length > 0 ? { paths } : null;
}

function toNumberOrRaw(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? value : parsed;
}