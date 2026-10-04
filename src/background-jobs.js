import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createWriteStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { stripAnsi } from './ansi.js';
import { createThrottledMatcher } from './incremental-matcher.js';
import { log } from './logger.js';
import { killProcessTree } from './process-tree.js';
import { buildSessionEnv, WAIT_PATTERN_FLAGS } from './pty-session.js';
import { compileUserRegex } from './regex-utils.js';
import { detectShell as defaultDetectShell, getShellType } from './shell-detector.js';

export const MAX_BACKGROUND_JOBS = 10;
export const DEFAULT_JOB_READ_MAX_LINES = 200;
const MAX_JOB_BUFFER_CHARS = 1024 * 1024; // 1MB of retained output per job
const LOG_DIR_NAME = 'smart-terminal-mcp-jobs';
const LOG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;
const JOB_ID_LENGTH = 8;

/**
 * Build the argv that runs `command` through the given shell.
 * @param {string} shell
 * @param {string[]} shellArgs - Base args from shell detection
 * @param {string} command
 * @returns {{ args: string[], windowsVerbatimArguments: boolean }}
 */
export function buildShellInvocation(shell, shellArgs, command) {
  switch (getShellType(shell)) {
    case 'powershell':
      return { args: [...shellArgs, '-NonInteractive', '-Command', command], windowsVerbatimArguments: false };
    case 'cmd':
      // Same quoting Node uses for `shell: true`: cmd strips the outer quotes with /s.
      return { args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
    default:
      return { args: [...shellArgs, '-c', command], windowsVerbatimArguments: false };
  }
}

/**
 * Return only the last `maxLines` lines of `text`.
 * @param {string} text
 * @param {number} maxLines
 */
function tailText(text, maxLines) {
  const lines = text.split('\n');
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join('\n');
}

/**
 * A long-running command executed as a separate (non-PTY) process.
 * Emits 'data' (string) for each output chunk and 'exit' once.
 */
export class BackgroundJob extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.command
   * @param {string} opts.cwd
   * @param {string} opts.logPath
   * @param {import('node:child_process').ChildProcess} opts.child
   * @param {import('node:fs').WriteStream | null} opts.logStream
   */
  constructor({ id, command, cwd, logPath, child, logStream }) {
    super();
    this.id = id;
    this.command = command;
    this.cwd = cwd;
    this.logPath = logPath;
    this.pid = child.pid;
    this.startedAt = Date.now();
    this.alive = true;
    this.exitCode = null;
    this.signal = null;

    this._child = child;
    this._logStream = logStream;
    this._buffer = '';
    this._totalChars = 0;
    this._readPosition = 0;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this._onOutput(chunk));
    child.stderr?.on('data', (chunk) => this._onOutput(chunk));
    child.on('close', (code, signal) => this._onExit(code, signal));
    // Unhandled 'error' events would crash the server; record them instead.
    child.on('error', (err) => log(`Background job ${id} process error: ${err.message}`));
  }

  _onOutput(chunk) {
    this._buffer += chunk;
    this._totalChars += chunk.length;
    if (this._buffer.length > MAX_JOB_BUFFER_CHARS) {
      this._buffer = this._buffer.slice(-MAX_JOB_BUFFER_CHARS);
    }
    this._logStream?.write(chunk);
    this.emit('data', chunk);
  }

  _onExit(code, signal) {
    this.alive = false;
    this.exitCode = code;
    this.signal = signal;
    this._logStream?.end();
    this.emit('exit');
  }

  /**
   * Read output emitted since `since` (absolute char position), or since the
   * previous read when omitted.
   * @param {{ since?: number, maxLines?: number }} [opts]
   */
  read({ since, maxLines = DEFAULT_JOB_READ_MAX_LINES } = {}) {
    const position = this._totalChars;
    const bufferStart = position - this._buffer.length;
    const requested = since ?? this._readPosition;
    const truncated = requested < bufferStart;
    const offset = Math.max(requested, bufferStart) - bufferStart;
    this._readPosition = position;

    const output = stripAnsi(this._buffer.slice(offset)).trim();
    return {
      output: tailText(output, maxLines),
      position,
      truncated,
      alive: this.alive,
      exitCode: this.exitCode,
    };
  }

  /**
   * Wait until `regex` matches the output, the job exits, or the timeout hits.
   * @param {RegExp} regex
   * @param {number} timeout
   * @returns {Promise<'matched'|'exited'|'timeout'>}
   */
  waitFor(regex, timeout) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        scanner.dispose();
        this.off('data', onData);
        this.off('exit', onExit);
        resolve(reason);
      };

      const scanner = createThrottledMatcher(regex, {
        onMatch: () => finish('matched'),
        maxRetainedChars: MAX_JOB_BUFFER_CHARS,
      });
      const timer = setTimeout(() => finish(scanner.flush() ? 'matched' : 'timeout'), timeout);
      const onData = (chunk) => scanner.push(chunk);
      const onExit = () => finish(scanner.flush() ? 'matched' : 'exited');

      scanner.push(this._buffer);
      if (scanner.flush()) return;
      if (!this.alive) {
        onExit();
        return;
      }
      this.on('data', onData);
      this.on('exit', onExit);
    });
  }

  getInfo() {
    return {
      id: this.id,
      pid: this.pid,
      command: this.command,
      cwd: this.cwd,
      alive: this.alive,
      exitCode: this.exitCode,
      ...(this.signal && { signal: this.signal }),
      startedAt: new Date(this.startedAt).toISOString(),
      logPath: this.logPath,
    };
  }
}

/**
 * Owns all background jobs: start, lookup, stop, and cleanup on shutdown.
 * Jobs run outside PTY sessions, so they never hold a session's busy lock.
 */
export class BackgroundJobManager {
  /**
   * @param {object} [deps]
   * @param {typeof nodeSpawn} [deps.spawn]
   * @param {() => { shell: string, args: string[] }} [deps.detectShell]
   * @param {(cwd?: string) => Promise<string>} [deps.resolveCwd]
   * @param {(pid: number) => { ok: boolean, reason?: string }} [deps.killTree]
   * @param {string | null} [deps.logDir] - null disables log files
   * @param {number} [deps.maxJobs]
   */
  constructor({
    spawn = nodeSpawn,
    detectShell = defaultDetectShell,
    resolveCwd = async (cwd) => resolvePath(cwd ?? process.cwd()),
    killTree = (pid) => killProcessTree(pid),
    logDir = join(tmpdir(), LOG_DIR_NAME),
    maxJobs = MAX_BACKGROUND_JOBS,
  } = {}) {
    this._spawn = spawn;
    this._detectShell = detectShell;
    this._resolveCwd = resolveCwd;
    this._killTree = killTree;
    this._logDir = logDir;
    this._maxJobs = maxJobs;
    this._shell = null;
    /** @type {Map<string, BackgroundJob>} */
    this._jobs = new Map();
    this._pendingStarts = 0;
  }

  /**
   * Start a command in the background.
   * @param {{ command: string, cwd?: string, env?: Record<string, string> }} opts
   * @returns {Promise<BackgroundJob>}
   */
  async start({ command, cwd, env }) {
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('command must be a non-empty string.');
    }
    this._ensureCapacity();
    this._pendingStarts++;

    try {
      const resolvedCwd = await this._resolveCwd(cwd);
      const { shell, args: baseArgs } = this._getShell();
      const { args, windowsVerbatimArguments } = buildShellInvocation(shell, baseArgs, command);
      const id = this._generateId();
      const { logPath, logStream } = this._openLog(id);

      const child = this._spawn(shell, args, {
        cwd: resolvedCwd,
        env: buildSessionEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments,
        // Unix: own process group so stop() can signal the whole tree.
        detached: process.platform !== 'win32',
      });

      try {
        await once(child, 'spawn');
      } catch (err) {
        logStream?.end();
        throw new Error(`Failed to start background job: ${err.message}`);
      }

      const job = new BackgroundJob({ id, command, cwd: resolvedCwd, logPath, child, logStream });
      this._jobs.set(id, job);
      return job;
    } finally {
      this._pendingStarts--;
    }
  }

  /**
   * Compile a waitFor pattern with the same rules as terminal_wait.
   * @param {string} pattern
   */
  compileWaitPattern(pattern) {
    return compileUserRegex(pattern, 'waitFor', WAIT_PATTERN_FLAGS);
  }

  /** @param {string} id */
  get(id) {
    const job = this._jobs.get(id);
    if (!job) {
      throw new Error(`Background job "${id}" not found. Use terminal_list to see jobs.`);
    }
    return job;
  }

  /**
   * Kill a job and its whole process tree. The job stays listed (exited)
   * so its output remains readable until evicted.
   * @param {string} id
   */
  stop(id) {
    const job = this.get(id);
    this._terminate(job, true);
    return job.getInfo();
  }

  list() {
    return [...this._jobs.values()].map((job) => job.getInfo());
  }

  /** Kill every running job (graceful shutdown). Synchronous. */
  stopAll() {
    for (const job of this._jobs.values()) {
      this._terminate(job, false);
    }
  }

  _terminate(job, throwOnError = false) {
    if (!job.alive || !job.pid) return;
    const result = this._killTree(job.pid);
    if (!result.ok) {
      const msg = `Failed to stop background job ${job.id}: ${result.reason}`;
      log(msg);
      if (throwOnError) throw new Error(msg);
    }
  }

  /** Evict the oldest finished job when full; refuse if all are running. */
  _ensureCapacity() {
    if ((this._jobs.size + this._pendingStarts) < this._maxJobs) return;
    const oldestFinished = [...this._jobs.values()].find((job) => !job.alive);
    if (!oldestFinished) {
      throw new Error(`Maximum ${this._maxJobs} background jobs running or starting. Stop one with terminal_job first.`);
    }
    this._jobs.delete(oldestFinished.id);
  }

  _getShell() {
    this._shell ??= this._detectShell();
    return this._shell;
  }

  _generateId() {
    let id;
    do {
      id = `job-${randomUUID().replace(/-/g, '').slice(0, JOB_ID_LENGTH)}`;
    } while (this._jobs.has(id));
    return id;
  }

  /** Open a private per-job log file. Logging is best-effort, never fatal. */
  _openLog(id) {
    if (!this._logDir) return { logPath: null, logStream: null };
    try {
      mkdirSync(this._logDir, { recursive: true, mode: LOG_DIR_MODE });
      const logPath = join(this._logDir, `${id}.log`);
      const logStream = createWriteStream(logPath, { flags: 'a', mode: LOG_FILE_MODE });
      logStream.on('error', (err) => log(`Background job ${id} log error: ${err.message}`));
      return { logPath, logStream };
    } catch (err) {
      log(`Background job ${id}: cannot open log file (${err.message})`);
      return { logPath: null, logStream: null };
    }
  }
}
