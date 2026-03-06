import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { normalizeCommandName, parseCommandOutput, summarizeCommandOutput } from './command-parsers.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;
const STRUCTURED_PARSER_HINT = 'Structured parser unavailable for this command signature. If you need this often, propose one.';
const PARSER_HINT_MIN_STDOUT_BYTES = 200;
const PARSER_HINT_COMMANDS = new Set(['where', 'which']);
const PARSER_HINT_GIT_SUBCOMMANDS = new Set(['branch', 'diff', 'log', 'remote', 'rev-parse', 'status']);
const DEFAULT_WINDOWS_PATH_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
const WINDOWS_BATCH_EXTENSIONS = new Set(['.bat', '.cmd']);

export async function runCommand({
  cmd,
  args = [],
  cwd,
  timeout = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  parse = true,
  parseOnly = false,
  summary = false,
}) {
  const resolvedCwd = resolvePath(cwd ?? process.cwd());
  const startedAt = Date.now();
  const spawnPlan = buildSpawnPlan({ cmd, args, cwd: resolvedCwd });

  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    let timedOut = false;
    let maxOutputExceeded = false;
    let settled = false;

    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: resolvedCwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: spawnPlan.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stopProcess = (reason) => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'max_output') maxOutputExceeded = true;
      if (!child.killed) child.kill();
    };

    const appendChunk = (target, chunk) => {
      const remaining = maxOutputBytes - totalBytes;
      if (remaining <= 0) {
        stopProcess('max_output');
        return;
      }

      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      target.push(slice);
      totalBytes += slice.length;

      if (slice.length !== chunk.length) stopProcess('max_output');
    };

    const timeoutId = setTimeout(() => stopProcess('timeout'), timeout);
    timeoutId.unref?.();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(new Error(formatStartError({ cmd, err })));
    });

    child.stdout?.on('data', (chunk) => appendChunk(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk) => appendChunk(stderrChunks, chunk));

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      const stdoutRaw = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrRaw = Buffer.concat(stderrChunks).toString('utf8');
      const result = {
        ok: exitCode === 0 && !timedOut && !maxOutputExceeded,
        cmd,
        args,
        cwd: resolvedCwd,
        exitCode: exitCode ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: {
          raw: stdoutRaw,
          parsed: null,
        },
        stderr: {
          raw: stderrRaw,
        },
      };

      if (signal) result.signal = signal;
      if (maxOutputExceeded) result.maxOutputExceeded = true;
      const parseRequested = parse || parseOnly || summary;
      if (parseRequested && !timedOut && !maxOutputExceeded) {
        result.stdout.parsed = parseCommandOutput({ cmd, args, stdout: stdoutRaw });
        if (summary && result.stdout.parsed) {
          const stdoutSummary = summarizeCommandOutput({ cmd, args, parsed: result.stdout.parsed });
          if (stdoutSummary) {
            result.stdout.summary = stdoutSummary;
            result.stdout.parsed = null;
            result.stdout.raw = '';
          }
        }

        if (parseOnly && result.stdout.parsed) {
          result.stdout.raw = '';
        }
      }

      const hint = getStructuredParserHint({
        cmd,
        args,
        ok: result.ok,
        parseRequested,
        parsed: result.stdout.parsed,
        stdout: stdoutRaw,
      });
      if (hint) result.hint = hint;

      resolve(result);
    });
  });
}

function buildSpawnPlan({ cmd, args, cwd }) {
  if (process.platform !== 'win32') {
    return {
      command: cmd,
      args,
      windowsVerbatimArguments: false,
    };
  }

  const resolvedCommand = resolveWindowsCommand(cmd, cwd);
  if (!resolvedCommand || !isWindowsBatchCommand(resolvedCommand)) {
    return {
      command: resolvedCommand ?? cmd,
      args,
      windowsVerbatimArguments: false,
    };
  }

  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', formatWindowsBatchCommand(resolvedCommand, args)],
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsCommand(cmd, cwd) {
  const pathExts = getWindowsPathExtensions();
  if (looksLikePath(cmd)) {
    return findExistingCommandPath(buildPathCandidates(resolveWindowsPath(cmd, cwd), pathExts));
  }

  return findCommandOnPath(buildCommandCandidates(cmd, pathExts));
}

function getWindowsPathExtensions() {
  const rawPathExt = process.env.PATHEXT;
  if (!rawPathExt) return DEFAULT_WINDOWS_PATH_EXTENSIONS;

  const pathExts = rawPathExt
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return pathExts.length > 0 ? pathExts : DEFAULT_WINDOWS_PATH_EXTENSIONS;
}

function buildPathCandidates(commandPath, pathExts) {
  if (extname(commandPath)) return [commandPath];
  return [...pathExts.map((pathExt) => `${commandPath}${pathExt}`), commandPath];
}

function buildCommandCandidates(cmd, pathExts) {
  if (extname(cmd)) return [cmd];
  return [...pathExts.map((pathExt) => `${cmd}${pathExt}`), cmd];
}

function findCommandOnPath(candidates) {
  const rawPath = process.env.PATH ?? '';
  const pathDirs = rawPath.split(delimiter).map((value) => value.trim()).filter(Boolean);
  for (const pathDir of pathDirs) {
    for (const candidate of candidates) {
      const resolvedPath = join(pathDir, candidate);
      if (isExistingFile(resolvedPath)) return resolvedPath;
    }
  }

  return null;
}

function findExistingCommandPath(candidates) {
  for (const candidate of candidates) {
    if (isExistingFile(candidate)) return candidate;
  }

  return null;
}

function resolveWindowsPath(cmd, cwd) {
  if (isAbsolute(cmd)) return cmd;
  return resolvePath(cwd, cmd);
}

function looksLikePath(cmd) {
  return cmd.includes('\\') || cmd.includes('/') || cmd.startsWith('.');
}

function isExistingFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isWindowsBatchCommand(cmd) {
  return WINDOWS_BATCH_EXTENSIONS.has(extname(cmd).toLowerCase());
}

function formatWindowsBatchCommand(command, args) {
  const parts = [quoteWindowsBatchArgument(command), ...args.map(quoteWindowsBatchArgument)];
  return `"${parts.join(' ')}"`;
}

function quoteWindowsBatchArgument(value) {
  const stringValue = String(value);
  if (stringValue.length === 0) return '""';
  return `"${stringValue.replace(/(["%^&|<>!()])/g, '^$1')}"`;
}

function formatStartError({ cmd, err }) {
  const baseMessage = `Failed to start command "${cmd}": ${err.message}`;
  if (process.platform !== 'win32' || err?.code !== 'ENOENT' || looksLikePath(cmd)) {
    return baseMessage;
  }

  return `${baseMessage}. If this command should come from PATH, verify it is installed and visible to the server process. Shell built-ins such as dir or cd still require terminal_exec.`;
}

export function getStructuredParserHint({ cmd, args, ok, parseRequested, parsed, stdout }) {
  if (!ok || !parseRequested || parsed) return null;
  if (Buffer.byteLength(stdout, 'utf8') < PARSER_HINT_MIN_STDOUT_BYTES) return null;
  if (!isParserHintEligibleCommand(cmd, args)) return null;
  return STRUCTURED_PARSER_HINT;
}

function isParserHintEligibleCommand(cmd, args) {
  const name = normalizeCommandName(cmd);
  if (PARSER_HINT_COMMANDS.has(name)) return true;
  if (name !== 'git') return false;

  const subcommand = args[0]?.toLowerCase();
  return PARSER_HINT_GIT_SUBCOMMANDS.has(subcommand);
}