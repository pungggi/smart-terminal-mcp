import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { PtySession } from './pty-session.js';
import { detectShell } from './shell-detector.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 10;
const CLEANUP_INTERVAL_MS = 60 * 1000; // Check every minute
const CWD_ERROR_MESSAGES = {
  EACCES: 'Permission denied',
  ENOENT: 'Path does not exist',
  ENOTDIR: 'A component of the path is not a directory',
};

export class SessionManager {
  constructor({ SessionClass = PtySession } = {}) {
    /** @type {Map<string, PtySession>} */
    this._sessions = new Map();
    this._SessionClass = SessionClass;
    this._cleanupTimer = setInterval(() => this._cleanupExpired(), CLEANUP_INTERVAL_MS);
    // Don't keep process alive just for cleanup
    this._cleanupTimer.unref();
  }

  /**
   * Create a new PTY session.
   * @param {object} opts
   * @param {string} [opts.shell]
   * @param {number} [opts.cols=120]
   * @param {number} [opts.rows=30]
   * @param {string} [opts.cwd]
   * @param {string} [opts.name]
   * @param {Record<string, string>} [opts.env]
   * @returns {Promise<PtySession>}
   */
  async create({ shell, cols = 120, rows = 30, cwd, name, env } = {}) {
    if (this._sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum ${MAX_SESSIONS} concurrent sessions reached. Stop an existing session first.`);
    }

    const resolvedCwd = await resolveSessionCwd(cwd);
    const detected = detectShell();
    const resolvedShell = shell || detected.shell;
    const shellArgs = shell ? [] : detected.args;

    const id = randomUUID().slice(0, 8);
    const session = new this._SessionClass({
      id,
      shell: resolvedShell,
      shellArgs,
      cols,
      rows,
      cwd: resolvedCwd,
      name,
      env,
    });

    this._sessions.set(id, session);
    return session;
  }

  /**
   * Get a session by ID.
   * @param {string} id
   * @returns {PtySession}
   */
  get(id) {
    const session = this._sessions.get(id);
    if (!session) {
      throw new Error(`Session "${id}" not found. Use terminal_list to see active sessions.`);
    }
    return session;
  }

  /**
   * Stop and remove a session.
   * @param {string} id
   */
  stop(id) {
    const session = this._sessions.get(id);
    if (session) {
      session.kill();
      this._sessions.delete(id);
    }
  }

  /**
   * List all sessions.
   * @param {object} [opts]
   * @param {boolean} [opts.verbose=true]
   * @returns {object[]}
   */
  list({ verbose = true } = {}) {
    return Array.from(this._sessions.values()).map((session) => session.getInfo({ verbose }));
  }

  /**
   * Kill all sessions (for graceful shutdown).
   */
  destroyAll() {
    for (const session of this._sessions.values()) {
      session.kill();
    }
    this._sessions.clear();
    clearInterval(this._cleanupTimer);
  }

  /**
   * Remove expired idle sessions.
   */
  _cleanupExpired() {
    const now = Date.now();
    for (const [id, session] of this._sessions) {
      if (!session.alive || now - session.lastActivity > DEFAULT_TTL_MS) {
        session.kill();
        this._sessions.delete(id);
        log(`Session ${id} cleaned up (TTL expired or dead)`);
      }
    }
  }
}

export async function resolveSessionCwd(cwd) {
  const resolvedCwd = resolvePath(cwd ?? process.cwd());

  let stats;
  try {
    stats = await stat(resolvedCwd);
  } catch (err) {
    throw new Error(`Invalid cwd "${resolvedCwd}": ${formatCwdError(err)}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Invalid cwd "${resolvedCwd}": Path is not a directory.`);
  }

  return resolvedCwd;
}

function formatCwdError(err) {
  const hint = CWD_ERROR_MESSAGES[err?.code];
  if (hint) {
    return `${hint} (${err.code})`;
  }
  return err?.message ?? String(err);
}

function log(msg) {
  process.stderr.write(`[smart-terminal-mcp] ${msg}\n`);
}
