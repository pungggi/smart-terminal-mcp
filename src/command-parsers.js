import { basename } from 'node:path';

export function normalizeCommandName(cmd) {
  const name = basename(cmd || '').toLowerCase();
  return name.endsWith('.exe') ? name.slice(0, -4) : name;
}

export function parseCommandOutput({ cmd, args = [], stdout }) {
  if (!stdout) return null;

  const name = normalizeCommandName(cmd);
  if (name === 'git') return parseGitCommandOutput(args, stdout);
  if (name === 'tasklist' && isTasklistCsv(args)) return parseTasklistCsv(stdout);
  if ((name === 'where' || name === 'which') && args.length > 0) return parsePathList(stdout);
  return null;
}

export function summarizeCommandOutput({ cmd, args = [], parsed }) {
  if (!parsed) return null;

  const name = normalizeCommandName(cmd);
  if (name === 'git') return summarizeGitCommandOutput(args, parsed);
  if (name === 'tasklist' && Array.isArray(parsed.processes)) {
    return { processCount: parsed.processes.length };
  }
  if ((name === 'where' || name === 'which') && Array.isArray(parsed.paths)) {
    return { pathCount: parsed.paths.length };
  }

  return null;
}

function parseGitCommandOutput(args, stdout) {
  if (isGitLogOneline(args)) return parseGitLogOneline(stdout);
  if (isGitStatusPorcelain(args)) return parseGitStatusPorcelain(stdout);
  if (isGitBranchVerbose(args)) return parseGitBranchVerbose(stdout);
  if (isGitBranchList(args)) return parseGitBranchList(stdout);
  if (isGitBranchShowCurrent(args)) return parseGitBranchShowCurrent(stdout);
  if (isGitRevParseShowToplevel(args)) return parseGitTopLevel(stdout);
  if (isGitRevParseIsInsideWorkTree(args)) return parseGitBooleanValue(stdout, 'isInsideWorkTree');
  if (isGitRevParseAbbrevRefHead(args)) return parseGitBranchShowCurrent(stdout);
  if (isGitDiffShortStat(args)) return parseGitDiffShortStat(stdout);
  if (isGitDiffStat(args)) return parseGitDiffStat(stdout);
  if (isGitDiffNameStatus(args)) return parseGitDiffNameStatus(stdout);
  if (isGitDiffNameOnly(args)) return parsePathList(stdout);
  if (isGitLsFiles(args)) return parsePathList(stdout);
  if (isGitRemoteVerbose(args)) return parseGitRemoteVerbose(stdout);
  return null;
}

function summarizeGitCommandOutput(args, parsed) {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === 'log' && Array.isArray(parsed.commits)) {
    return {
      commitCount: parsed.commits.length,
      ...(parsed.commits[0] ? { latestCommit: parsed.commits[0] } : {}),
    };
  }
  if (subcommand === 'status') return summarizeGitStatus(parsed);
  if (subcommand === 'branch') return summarizeGitBranches(parsed);
  if (subcommand === 'rev-parse') return parsed;
  if (subcommand === 'diff') return summarizeGitDiff(parsed);
  if (subcommand === 'ls-files' && Array.isArray(parsed.paths)) {
    return { pathCount: parsed.paths.length };
  }
  if (subcommand === 'remote' && Array.isArray(parsed.remotes)) {
    return {
      remoteCount: parsed.remotes.length,
      names: parsed.remotes.map((remote) => remote.name),
    };
  }

  return null;
}

function isGitLogOneline(args) {
  if (args[0] !== 'log') return false;

  const lowerArgs = args.slice(1).map((arg) => arg.toLowerCase());
  if (!lowerArgs.includes('--oneline')) return false;

  const otherArgs = lowerArgs.filter((arg) => arg !== '--oneline');
  return isSupportedGitLogOnelineArgs(otherArgs);
}

function isGitStatusPorcelain(args) {
  if (args[0] !== 'status') return false;

  const lowerArgs = args.slice(1).map((arg) => arg.toLowerCase());
  return lowerArgs.length > 0
    && lowerArgs.some(isGitStatusFormatArg)
    && lowerArgs.every(isGitStatusSupportedArg);
}

function isGitBranchList(args) {
  if (args[0] !== 'branch') return false;
  if (args.length === 1) return true;

  return args.length === 2 && isGitBranchListArg(args[1]);
}

function isGitBranchVerbose(args) {
  if (args[0] !== 'branch') return false;

  const flags = args.slice(1).map((arg) => arg.toLowerCase());
  return flags.length > 0
    && flags.some(isGitBranchVerboseArg)
    && flags.every((arg) => isGitBranchVerboseArg(arg) || isGitBranchListArg(arg));
}

function isGitBranchShowCurrent(args) {
  return args.length === 2 && args[0] === 'branch' && args[1].toLowerCase() === '--show-current';
}

function isGitRevParseAbbrevRefHead(args) {
  return args.length === 3
    && args[0] === 'rev-parse'
    && args[1].toLowerCase() === '--abbrev-ref'
    && args[2].toUpperCase() === 'HEAD';
}

function isGitRevParseShowToplevel(args) {
  return args.length === 2
    && args[0] === 'rev-parse'
    && args[1].toLowerCase() === '--show-toplevel';
}

function isGitRevParseIsInsideWorkTree(args) {
  return args.length === 2
    && args[0] === 'rev-parse'
    && args[1].toLowerCase() === '--is-inside-work-tree';
}

function isGitDiffShortStat(args) {
  return args[0] === 'diff' && args.slice(1).some((arg) => arg.toLowerCase() === '--shortstat');
}

function isGitDiffStat(args) {
  return args[0] === 'diff' && args.slice(1).some((arg) => arg.toLowerCase() === '--stat');
}

function isGitDiffNameOnly(args) {
  return args[0] === 'diff' && args.slice(1).some((arg) => arg.toLowerCase() === '--name-only');
}

function isGitDiffNameStatus(args) {
  return args[0] === 'diff' && args.slice(1).some((arg) => arg.toLowerCase() === '--name-status');
}

function isGitRemoteVerbose(args) {
  return args[0] === 'remote'
    && args.length === 2
    && ['-v', '--verbose'].includes(args[1].toLowerCase());
}

function isGitLsFiles(args) {
  return args[0] === 'ls-files' && args.slice(1).every((arg) => arg.startsWith('-'));
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

function parseGitBranchList(stdout) {
  const branches = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;

      return {
        name: trimmed.replace(/^[* ]+/, ''),
        current: trimmed.startsWith('*'),
      };
    })
    .filter(Boolean);

  return branches.length > 0 ? { branches } : null;
}

function parseGitBranchVerbose(stdout) {
  const branches = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseGitBranchVerboseLine)
    .filter(Boolean);

  return branches.length > 0 ? { branches } : null;
}

function parseGitBranchShowCurrent(stdout) {
  const current = stdout.trim();
  return current ? { current } : null;
}

function parseGitTopLevel(stdout) {
  const topLevel = stdout.trim();
  return topLevel ? { topLevel } : null;
}

function parseGitBooleanValue(stdout, key) {
  const value = stdout.trim().toLowerCase();
  if (value === 'true') return { [key]: true };
  if (value === 'false') return { [key]: false };
  return null;
}

function parseGitDiffShortStat(stdout) {
  const summary = parseGitDiffStatSummary(stdout.trim());
  return summary ? { summary } : null;
}

function parseGitDiffStat(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;

  const summary = parseGitDiffStatSummary(lines.at(-1));
  const fileLines = summary ? lines.slice(0, -1) : lines;
  const files = fileLines.map(parseGitDiffStatLine).filter(Boolean);

  if (files.length === 0 && !summary) return null;

  return {
    files,
    ...(summary ? { summary } : {}),
  };
}

function parseGitDiffNameStatus(stdout) {
  const changes = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseGitNameStatusLine)
    .filter(Boolean);

  return changes.length > 0 ? { changes } : null;
}

function parseGitRemoteVerbose(stdout) {
  const remotesByName = new Map();

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(.+?)\s+\((fetch|push)\)$/);
    if (!match) continue;

    const [, name, url, type] = match;
    const remote = remotesByName.get(name) ?? { name };
    if (type === 'fetch') remote.fetchUrl = url;
    if (type === 'push') remote.pushUrl = url;
    remotesByName.set(name, remote);
  }

  const remotes = Array.from(remotesByName.values());
  return remotes.length > 0 ? { remotes } : null;
}

function summarizeGitStatus(parsed) {
  const summary = {
    stagedCount: parsed.staged?.length ?? 0,
    modifiedCount: parsed.modified?.length ?? 0,
    untrackedCount: parsed.untracked?.length ?? 0,
  };

  if (parsed.branch?.head) summary.branch = parsed.branch.head;
  if (parsed.branch?.upstream) summary.upstream = parsed.branch.upstream;
  if (typeof parsed.branch?.ahead === 'number') summary.ahead = parsed.branch.ahead;
  if (typeof parsed.branch?.behind === 'number') summary.behind = parsed.branch.behind;

  return summary;
}

function summarizeGitBranches(parsed) {
  if (typeof parsed.current === 'string') return { current: parsed.current };
  if (!Array.isArray(parsed.branches)) return null;

  const current = parsed.branches.find((branch) => branch.current)?.name;
  return {
    branchCount: parsed.branches.length,
    ...(current ? { current } : {}),
  };
}

function summarizeGitDiff(parsed) {
  if (parsed.summary) return parsed.summary;
  if (Array.isArray(parsed.paths)) return { pathCount: parsed.paths.length };
  if (Array.isArray(parsed.files)) return { fileCount: parsed.files.length };
  if (!Array.isArray(parsed.changes)) return null;

  const statuses = parsed.changes.reduce((accumulator, change) => {
    const key = change.status;
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});

  return {
    changeCount: parsed.changes.length,
    statuses,
  };
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

function parseGitBranchVerboseLine(line) {
  const match = line.match(/^([*+ ])\s+(\S+)\s+([0-9a-f]+)\s+(?:\[(.+?)\]\s+)?(.*)$/i);
  if (!match) return null;

  const [, marker, name, commit, tracking, message] = match;
  const branch = {
    name,
    current: marker === '*',
    commit,
  };

  const trimmedMessage = message.trim();
  if (trimmedMessage) branch.message = trimmedMessage;

  if (tracking) Object.assign(branch, parseGitBranchVerboseTracking(tracking));
  return branch;
}

function parseGitBranchVerboseTracking(value) {
  const [upstream, rawState] = value.split(': ', 2);
  const tracking = { upstream };
  if (!rawState) return tracking;

  if (rawState.includes('gone')) tracking.gone = true;

  const ahead = rawState.match(/ahead (\d+)/);
  const behind = rawState.match(/behind (\d+)/);
  if (ahead) tracking.ahead = Number.parseInt(ahead[1], 10);
  if (behind) tracking.behind = Number.parseInt(behind[1], 10);

  return tracking;
}

function parseGitDiffStatLine(line) {
  const match = line.match(/^\s*(.+?)\s+\|\s+([0-9]+)\s+(.+)$/);
  if (!match) return null;

  const [, path, changes, histogram] = match;
  return {
    path: path.trim(),
    changes: Number.parseInt(changes, 10),
    histogram: histogram.trim(),
  };
}

function parseGitDiffStatSummary(line) {
  const filesChanged = line.match(/(\d+) files? changed/);
  if (!filesChanged) return null;

  const summary = { filesChanged: Number.parseInt(filesChanged[1], 10) };
  const insertions = line.match(/(\d+) insertions?\(\+\)/);
  const deletions = line.match(/(\d+) deletions?\(-\)/);
  if (insertions) summary.insertions = Number.parseInt(insertions[1], 10);
  if (deletions) summary.deletions = Number.parseInt(deletions[1], 10);

  return summary;
}

function normalizeGitPath(value) {
  if (!value) return null;
  const renameParts = value.split(' -> ');
  return renameParts.at(-1)?.trim() || null;
}

function parseGitNameStatusLine(line) {
  const parts = line.split('\t');
  if (parts.length < 2) return null;

  const status = parts[0]?.trim();
  const path = parts.at(-1)?.trim();
  if (!status || !path) return null;

  if (parts.length >= 3) {
    const previousPath = parts[1]?.trim();
    return previousPath ? { status, path, previousPath } : { status, path };
  }

  return { status, path };
}

function isSupportedGitLogOnelineArgs(args) {
  if (args.length === 0) return true;
  if (args.length === 1) return isGitLogCountArg(args[0]);
  if (args.length === 2) {
    return ['-n', '--max-count'].includes(args[0]) && isPositiveInteger(args[1]);
  }

  return false;
}

function isGitLogCountArg(arg) {
  return /^-[0-9]+$/.test(arg)
    || /^--max-count=[0-9]+$/.test(arg);
}

function isPositiveInteger(value) {
  return /^[0-9]+$/.test(value);
}

function isGitStatusFormatArg(arg) {
  return ['--short', '--porcelain', '--porcelain=v1'].includes(arg);
}

function isGitStatusSupportedArg(arg) {
  return isGitStatusFormatArg(arg) || ['--branch', '-b'].includes(arg);
}

function isGitBranchListArg(arg) {
  return ['--list', '-a', '--all', '-r', '--remotes'].includes(arg.toLowerCase());
}

function isGitBranchVerboseArg(arg) {
  return ['-v', '-vv', '--verbose'].includes(arg.toLowerCase());
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