import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { stripAnsi } from './ansi.js';
import { compileUserRegex } from './regex-utils.js';
import { getShellType } from './shell-detector.js';

const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB
const HISTORY_MAX_LINES = 10_000;
const BANNER_WAIT_MS = 2000;
const BANNER_IDLE_MS = 500;
export const DEFAULT_EXEC_MAX_LINES = 200;
export const DEFAULT_READ_MAX_LINES = 200;
export const DEFAULT_HISTORY_LIMIT = 200;
export const DEFAULT_HISTORY_FORMAT = 'lines';
const DEFAULT_WAIT_RETURN_MODE = 'tail';
const DEFAULT_WAIT_TAIL_LINES = 50;

export function buildSessionEnv(customEnv = {}, platformName = platform()) {
  const env = {
    ...process.env,
    ...customEnv,
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LESS: '-FRX',
    TERM: 'xterm-256color',
  };

  if (platformName !== 'win32') {
    env.DEBIAN_FRONTEND = 'noninteractive';
  }

  return env;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Key name to escape sequence mapping for terminal_send_key.
 */
const KEY_MAP = {
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+z': '\x1A',
  'ctrl+l': '\x0C',
  'ctrl+a': '\x01',
  'ctrl+e': '\x05',
  'ctrl+u': '\x15',
  'ctrl+k': '\x0B',
  'ctrl+w': '\x17',
  'tab': '\t',
  'enter': '\r',
  'escape': '\x1B',
  'up': '\x1B[A',
  'down': '\x1B[B',
  'right': '\x1B[C',
  'left': '\x1B[D',
  'home': '\x1B[H',
  'end': '\x1B[F',
  'pageup': '\x1B[5~',
  'pagedown': '\x1B[6~',
  'backspace': '\x7F',
  'delete': '\x1B[3~',
  'f1': '\x1BOP',
  'f2': '\x1BOQ',
  'f3': '\x1BOR',
  'f4': '\x1BOS',
  'f5': '\x1B[15~',
  'f6': '\x1B[17~',
  'f7': '\x1B[18~',
  'f8': '\x1B[19~',
  'f9': '\x1B[20~',
  'f10': '\x1B[21~',
  'f11': '\x1B[23~',
  'f12': '\x1B[24~',
};

export const SUPPORTED_KEYS = Object.keys(KEY_MAP);

export class PtySession {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.shell
   * @param {string[]} opts.shellArgs
   * @param {number} opts.cols
   * @param {number} opts.rows
   * @param {string} opts.cwd
   * @param {string} [opts.name]
   * @param {Record<string, string>} [opts.env]
   */
  constructor({ id, shell, shellArgs, cols, rows, cwd, name, env: customEnv }) {
    this.id = id;
    this.shell = shell;
    this.shellType = getShellType(shell);
    this.name = name || null;
    this.cols = cols;
    this.rows = rows;
    this.cwd = cwd;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.busy = false;
    this.alive = true;

    /** @type {string} */
    this._buffer = '';
    /** Monotonic byte counter — total bytes ever emitted. Never resets. */
    this._totalBytesEmitted = 0;
    /** @type {string[]} Rolling history of cleaned output lines */
    this._history = [];
    /** Total lines ever appended (monotonic counter for detecting eviction) */
    this._historyTotalLines = 0;
    /** Partial line not yet terminated by newline */
    this._historyPartial = '';
    /** Byte offset for unread output returned by terminal_read */
    this._readCursor = 0;
    /** @type {((data: string) => void)[]} */
    this._dataListeners = [];
    /** @type {string | null} */
    this._pendingMarker = null;
    /** Char offset of already-scanned buffer content for marker detection. */
    this._markerScanCursor = 0;
    /** @type {{ marker: string, withExit: RegExp, plain: RegExp } | null} */
    this._markerMatcherCache = null;

    const env = buildSessionEnv(customEnv);

    this.process = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      useConpty: false,
    });

    this.process.onData((data) => {
      this.lastActivity = Date.now();
      this._buffer += data;
      this._totalBytesEmitted += data.length;

      if (this._pendingMarker && this._scanForMarkerLine(this._pendingMarker)) {
        this.busy = false;
        this._pendingMarker = null;
      }

      // Enforce buffer cap — keep tail
      if (this._buffer.length > MAX_BUFFER_BYTES) {
        const overflow = this._buffer.length - MAX_BUFFER_BYTES;
        this._buffer = this._buffer.slice(-MAX_BUFFER_BYTES);
        this._readCursor = Math.max(0, this._readCursor - overflow);
        this._markerScanCursor = Math.max(0, this._markerScanCursor - overflow);
      }
      // Append cleaned output to rolling history
      this._appendToHistory(data);
      for (const listener of this._dataListeners) {
        listener(data);
      }
    });

    this.process.onExit(() => {
      this.alive = false;
    });
  }

  /**
   * Wait for the shell startup banner.
   * @returns {Promise<string>}
   */
  async waitForBanner() {
    const banner = await this._readUntilIdle(BANNER_WAIT_MS, BANNER_IDLE_MS);
    // Run shell-specific init commands after banner
    await this._initShell();
    return stripAnsi(banner).trim();
  }

  async _initShell() {
    if (this.shellType === 'powershell') {
      this.process.write('$ProgressPreference = \'SilentlyContinue\'\r');
      await this._readUntilIdle(3000, 500);
    } else if (this.shellType === 'cmd') {
      this.process.write('chcp 65001 > nul\r');
      await this._readUntilIdle(3000, 500);
    }
    // Clear buffer after init so it doesn't pollute first command output
    this._resetBuffer();
  }

  /**
   * Execute a command with marker-based completion detection.
   * @param {object} opts
   * @param {string} opts.command
   * @param {number} [opts.timeout=30000]
   * @param {number} [opts.maxLines=100]
   * @param {number} [opts.quietExitMs] - Return early if output is silent for this long after first output
   * @param {number} [opts.minOutputBytes=1] - Require at least this many bytes before quiet detection
   * @param {Function} [opts.sendNotification] - MCP sendNotification function for progress
   * @param {string|number} [opts.progressToken] - Progress token from client
   * @returns {Promise<{ output: string, exitCode: number|null, cwd: string|null, timedOut: boolean, quietExited?: boolean, hint?: string }>}
   */
  async exec({ command, timeout = 30000, maxLines = DEFAULT_EXEC_MAX_LINES, quietExitMs, minOutputBytes = 1, sendNotification, progressToken }) {
    if (this.busy) {
      throw new Error(`Session ${this.id} is busy with a background command. Wait for it to finish, or use terminal_read to check output, or terminal_send_key("ctrl+c") to abort it.`);
    }
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }

    this.busy = true;
    this._resetBuffer();

    const marker = `__MCP_DONE_${randomUUID().replace(/-/g, '')}__`;
    const cwdMarker = `__MCP_CWD_`;
    const preMarker = `__MCP_PRE_${randomUUID().replace(/-/g, '')}__`;
    const wrappedCommand = this._wrapCommand(command, marker, cwdMarker, preMarker);

    try {
      this.process.write(wrappedCommand + '\r');

      const { buffer: raw, reason } = await this._waitForMarker(marker, timeout, quietExitMs, minOutputBytes, sendNotification, progressToken);
      const markerFound = reason === 'marker';
      const timedOut = reason === 'timeout';
      const quietExited = reason === 'quiet';

      const { output, exitCode, cwd } = this._parseOutput(raw, marker, cwdMarker, preMarker);
      if (cwd) this.cwd = cwd;

      if (markerFound) {
        this.busy = false;
        this._pendingMarker = null;
      } else {
        this._pendingMarker = marker;
      }

      return {
        output: this._truncateOutput(output, maxLines),
        exitCode: markerFound ? exitCode : null,
        cwd: this.cwd,
        timedOut,
        ...(quietExited && { quietExited: true }),
        ...((timedOut || quietExited) && { hint: 'Command is still running in the background. Session remains busy. Use terminal_read to get new output, or terminal_send_key("ctrl+c") to abort.' }),
      };
    } catch (err) {
      this.busy = false;
      this._pendingMarker = null;
      throw err;
    }
  }

  /**
   * Write raw data to PTY (for interactive programs).
   * @param {string} data
   */
  write(data) {
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }
    this.process.write(data);
    if (data.includes('\x03') || data.includes('\x04')) {
      this.busy = false;
      this._pendingMarker = null;
    }
  }

  /**
   * Send a named special key.
   * @param {string} key
   */
  sendKey(key) {
    const seq = KEY_MAP[key.toLowerCase()];
    if (!seq) {
      throw new Error(`Unknown key: "${key}". Supported: ${SUPPORTED_KEYS.join(', ')}`);
    }
    this.write(seq);
  }

  /**
   * Read buffered output with idle detection.
   * @param {object} opts
   * @param {number} [opts.timeout=30000]
   * @param {number} [opts.idleTimeout=500]
   * @param {number} [opts.maxLines=80]
   * @param {number} [opts.since] - Absolute byte position; returns output emitted since that position
   * @returns {Promise<{ output: string, timedOut: boolean, position: number, truncated?: boolean }>}
   */
  async read({ timeout = 30000, idleTimeout = 500, maxLines = DEFAULT_READ_MAX_LINES, since } = {}) {
    if (!this.alive) {
      // Return whatever is left in buffer
      const leftover = stripAnsi(this._consumeUnreadBuffer()).trim();
      this._resetBuffer();
      return { output: leftover, timedOut: false, position: this._totalBytesEmitted };
    }

    // Position-based read: return only output since a prior byte position
    if (since !== undefined) {
      return this._readSince({ since, timeout, idleTimeout, maxLines });
    }

    await this._readUntilIdle(timeout, idleTimeout);
    const raw = this._consumeUnreadBuffer();
    const output = stripAnsi(raw).trim();

    return {
      output: this._truncateOutput(output, maxLines),
      timedOut: false,
      position: this._totalBytesEmitted,
    };
  }

  /**
   * Wait for a specific pattern in the output.
   * @param {object} opts
   * @param {string} opts.pattern - String or regex pattern to match
   * @param {number} [opts.timeout=30000]
   * @param {'tail'|'full'|'match-only'} [opts.returnMode='tail']
   * @param {number} [opts.tailLines=50]
   * @param {Function} [opts.sendNotification]
   * @param {string|number} [opts.progressToken]
   * @returns {Promise<{ output: string, matched: boolean, timedOut: boolean }>}
   */
  async waitForPattern({
    pattern,
    timeout = 30000,
    returnMode = DEFAULT_WAIT_RETURN_MODE,
    tailLines = DEFAULT_WAIT_TAIL_LINES,
    sendNotification,
    progressToken,
  }) {
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }

    const regex = compileUserRegex(pattern);
    const startTime = Date.now();
    let collected = '';
    let lastProgressAt = 0;
    const tailTracker = this._createTailTracker();

    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve({
          output: this._formatWaitOutput(stripAnsi(collected), returnMode, tailLines, tailTracker),
          matched: false,
          timedOut: true,
        });
      }, timeout);

      const onData = (data) => {
        collected += data;
        this._appendToTailTracker(tailTracker, stripAnsi(data), tailLines);
        const clean = stripAnsi(collected);

        // Send progress notifications
        if (sendNotification && progressToken && Date.now() - lastProgressAt > 1000) {
          lastProgressAt = Date.now();
          this._sendProgress(sendNotification, progressToken, clean, startTime, timeout);
        }

        if (regex.test(clean)) {
          cleanup();
          resolve({
            output: this._formatWaitOutput(clean, returnMode, tailLines, tailTracker),
            matched: true,
            timedOut: false,
          });
        }
      };

      // Check existing buffer first
      const existingClean = stripAnsi(this._buffer);
      this._appendToTailTracker(tailTracker, existingClean, tailLines);
      if (regex.test(existingClean)) {
        clearTimeout(timer);
        resolve({
          output: this._formatWaitOutput(existingClean, returnMode, tailLines, tailTracker),
          matched: true,
          timedOut: false,
        });
        return;
      }
      collected = this._buffer;

      this._dataListeners.push(onData);
    });
  }

  /**
   * Read output since an absolute byte position.
   * @param {object} opts
   * @param {number} opts.since
   * @param {number} opts.timeout
   * @param {number} opts.idleTimeout
   * @param {number} opts.maxLines
   * @returns {Promise<{ output: string, timedOut: boolean, position: number, truncated: boolean }>}
   */
  async _readSince({ since, timeout, idleTimeout, maxLines }) {
    const currentPos = this._totalBytesEmitted;

    // If since is at or beyond current position, wait for new data
    if (since >= currentPos) {
      await this._readUntilIdle(timeout, idleTimeout);
    }

    const newPos = this._totalBytesEmitted;
    const bufferStart = newPos - this._buffer.length;
    const truncated = since < bufferStart;
    const fromPos = truncated ? bufferStart : since;
    const offset = fromPos - bufferStart;

    const raw = offset < this._buffer.length ? this._buffer.slice(Math.max(0, offset)) : '';
    const output = stripAnsi(raw).trim();

    return {
      output: this._truncateOutput(output, maxLines),
      timedOut: false,
      position: newPos,
      truncated,
    };
  }

  /**
   * Wait for one of multiple patterns in session output.
   * Returns on first match, quiet detection, timeout, or process exit.
   * @param {object} opts
   * @param {Array<{id: string, pattern: string, isRegex?: boolean, cooldownMs?: number}>} opts.triggers
   * @param {number} [opts.timeout=60000]
   * @param {number} [opts.quietExitMs]
   * @param {number} [opts.contextLines=3]
   * @param {number} [opts.since]
   * @returns {Promise<{reason: 'trigger'|'quiet'|'timeout'|'exit', triggerId?: string, matchedLine?: string, context?: string[], position: number, timedOut: boolean}>}
   */
  watch({ triggers, timeout = 60000, quietExitMs, contextLines = 3, since } = {}) {
    const compiled = triggers.map((t) => ({
      id: t.id,
      regex: t.isRegex === false ? new RegExp(t.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : compileUserRegex(t.pattern),
      cooldownMs: t.cooldownMs ?? 0,
      lastFiredAt: 0,
    }));

    const sincePosition = since ?? this._totalBytesEmitted;

    return new Promise((resolve) => {
      const contextBuffer = [];
      let partialLine = '';
      let resolved = false;
      let quietTimer;
      let exitCheckTimer;

      const done = (result) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(hardTimer);
        clearTimeout(quietTimer);
        clearInterval(exitCheckTimer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
        resolve(result);
      };

      const hardTimer = setTimeout(() => {
        done({ reason: 'timeout', timedOut: true, position: this._totalBytesEmitted });
      }, timeout);

      const armQuiet = () => {
        if (!quietExitMs) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          done({ reason: 'quiet', timedOut: false, position: this._totalBytesEmitted });
        }, quietExitMs);
      };

      const testLine = (line) => {
        const now = Date.now();
        for (const trigger of compiled) {
          if (trigger.cooldownMs > 0 && now - trigger.lastFiredAt < trigger.cooldownMs) continue;
          if (trigger.regex.test(line)) {
            trigger.lastFiredAt = now;
            done({
              reason: 'trigger',
              triggerId: trigger.id,
              matchedLine: line,
              context: contextBuffer.slice(-contextLines),
              position: this._totalBytesEmitted,
              timedOut: false,
            });
            return;
          }
        }
      };

      const processCleanLine = (line) => {
        contextBuffer.push(line);
        if (contextBuffer.length > contextLines + 1) {
          contextBuffer.shift();
        }
        testLine(line);
      };

      const onData = (data) => {
        armQuiet();

        const clean = stripAnsi(data);
        const parts = clean.split(/\r?\n/);
        parts[0] = partialLine + parts[0];

        for (let i = 0; i < parts.length - 1; i++) {
          processCleanLine(parts[i]);
          if (resolved) return;
        }
        partialLine = parts[parts.length - 1];
      };

      // Check existing buffer for content since the specified position
      if (sincePosition < this._totalBytesEmitted) {
        const bufferStart = this._totalBytesEmitted - this._buffer.length;
        const fromPos = Math.max(sincePosition, bufferStart);
        const offset = fromPos - bufferStart;
        if (offset < this._buffer.length) {
          const existing = stripAnsi(this._buffer.slice(Math.max(0, offset)));
          const parts = existing.split(/\r?\n/);
          for (const line of parts) {
            if (line.trim()) {
              contextBuffer.push(line);
              if (contextBuffer.length > contextLines + 1) contextBuffer.shift();
              testLine(line);
              if (resolved) return;
            }
          }
        }
      }

      // Handle process exit during watch
      exitCheckTimer = setInterval(() => {
        if (!this.alive) {
          done({ reason: 'exit', timedOut: false, position: this._totalBytesEmitted });
        }
      }, 200);

      this._dataListeners.push(onData);
      armQuiet();
    });
  }

  /**
   * Resize terminal.
   * @param {number} cols
   * @param {number} rows
   */
  resize(cols, rows) {
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }
    this.process.resize(cols, rows);
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * Kill the PTY process and clean up.
   * On Unix, kills the entire process group to prevent orphan children.
   * @param {string} [signal='SIGTERM']
   */
  kill(signal = 'SIGTERM') {
    if (!this.alive) return;
    const pid = this.process.pid;

    if (process.platform !== 'win32' && pid) {
      try {
        process.kill(-pid, signal);
      } catch (err) {
        if (err.code !== 'ESRCH') {
          try { this.process.kill(signal); } catch {}
        }
      }
    } else {
      try { this.process.kill(); } catch {}
    }
    this.alive = false;
  }

  /**
   * Get session metadata for terminal_list.
   * @param {object} [opts]
   * @param {boolean} [opts.verbose=true]
   */
  getInfo({ verbose = true } = {}) {
    const baseInfo = {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      alive: this.alive,
      busy: this.busy,
    };

    if (!verbose) {
      return baseInfo;
    }

    return {
      ...baseInfo,
      shell: this.shell,
      shellType: this.shellType,
      cols: this.cols,
      rows: this.rows,
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivity: new Date(this.lastActivity).toISOString(),
      idleSeconds: Math.round((Date.now() - this.lastActivity) / 1000),
    };
  }

  /**
   * Retrieve past output without consuming it.
   * @param {object} opts
   * @param {number} [opts.offset=0] - Lines to skip from the end (for pagination)
   * @param {number} [opts.limit=100] - Max lines to return
   * @param {'lines'|'text'} [opts.format='lines'] - History response format
   * @returns {{ lines: string[], totalLines: number, returnedFrom: number, returnedTo: number } | { text: string, totalLines: number, returnedFrom: number, returnedTo: number }}
   */
  getHistory({ offset = 0, limit = DEFAULT_HISTORY_LIMIT, format = DEFAULT_HISTORY_FORMAT } = {}) {
    const len = this._history.length;
    const end = Math.max(0, len - offset);
    const start = Math.max(0, end - limit);
    const lines = this._history.slice(start, end);

    // Map buffer indices to absolute line numbers
    const evicted = this._historyTotalLines - len;
    const result = {
      totalLines: this._historyTotalLines,
      returnedFrom: evicted + start,
      returnedTo: evicted + end,
    };

    if (format === 'text') {
      return {
        ...result,
        text: lines.join('\n'),
      };
    }

    return {
      ...result,
      lines,
    };
  }

  // --- Private Methods ---

  /**
   * Append ANSI-stripped lines to the rolling history buffer.
   */
  _appendToHistory(rawData) {
    const clean = stripAnsi(rawData);
    const parts = clean.split(/\r?\n/);

    // First part completes the previous partial line
    this._historyPartial += parts[0];

    // Middle parts (if any) are complete lines — flush partial then push each
    for (let i = 1; i < parts.length; i++) {
      this._history.push(this._historyPartial);
      this._historyTotalLines++;
      this._historyPartial = parts[i];
    }

    // Evict oldest lines if over capacity
    const overflow = this._history.length - HISTORY_MAX_LINES;
    if (overflow > 0) {
      this._history.splice(0, overflow);
    }
  }

  _wrapCommand(command, marker, cwdMarker, preMarker) {
    switch (this.shellType) {
      case 'powershell':
        return `Write-Host "${preMarker}"; ${command}; Write-Host "${marker}_\${LASTEXITCODE}__"; Write-Host "${cwdMarker}$((Get-Location).Path)__"`;
      case 'cmd':
        return `echo ${preMarker} & ${command} & echo ${marker}_%ERRORLEVEL%__ & echo ${cwdMarker}%CD%__`;
      default: // bash/zsh
        return `echo "${preMarker}"; ${command}; echo "${marker}_$?__"; echo "${cwdMarker}$(pwd)__"`;
    }
  }

  _resetBuffer() {
    this._buffer = '';
    this._readCursor = 0;
    this._markerScanCursor = 0;
  }

  _consumeUnreadBuffer() {
    const start = Math.min(this._readCursor, this._buffer.length);
    const unread = this._buffer.slice(start);
    this._readCursor = this._buffer.length;
    return unread;
  }

  /**
   * Get (cached) line-anchored regexes for a completion marker.
   *
   * The real marker output is always a standalone line
   * (`__MCP_DONE_<id>__<exit>__` or the bare marker). The echoed wrapped
   * command only ever contains the marker mid-line, so full-line matching
   * ignores the echo. (Substring matching resolved on the echo before the
   * command even ran and produced empty output — see #echo-race.)
   */
  _getMarkerMatchers(marker) {
    if (!this._markerMatcherCache || this._markerMatcherCache.marker !== marker) {
      this._markerMatcherCache = {
        marker,
        withExit: new RegExp(`^${escapeRegExp(marker)}_(\\d*)__$`),
        plain: new RegExp(`^${escapeRegExp(marker)}$`),
      };
    }
    return this._markerMatcherCache;
  }

  /**
   * Scan NEW buffer content (plus a small overlap) for a real marker line.
   * Incremental: each call only inspects data appended since the last scan,
   * so chatty commands stay cheap.
   * @param {string} marker
   * @returns {boolean} true when a standalone marker line is present
   */
  _scanForMarkerLine(marker) {
    const overlap = marker.length + 24;
    const start = Math.max(0, (this._markerScanCursor || 0) - overlap);
    const region = start > 0 ? this._buffer.slice(start) : this._buffer;
    this._markerScanCursor = this._buffer.length;

    const { withExit, plain } = this._getMarkerMatchers(marker);
    for (const line of stripAnsi(region).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (withExit.test(trimmed) || plain.test(trimmed)) return true;
    }
    return false;
  }

  /**
   * Wait for the completion marker in the output stream.
   * @param {string} marker
   * @param {number} timeout
   * @param {number} [quietExitMs]
   * @param {number} [minOutputBytes]
   * @param {Function} [sendNotification]
   * @param {string|number} [progressToken]
   * @returns {Promise<{buffer: string, reason: 'marker'|'timeout'|'quiet'}>}
   */
  _waitForMarker(marker, timeout, quietExitMs, minOutputBytes = 1, sendNotification, progressToken) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastProgressAt = 0;
      let bytesSeen = 0;
      let quietTimer;

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(quietTimer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve({ buffer: this._buffer, reason: 'timeout' });
      }, timeout);

      const armQuiet = () => {
        if (!quietExitMs || bytesSeen < minOutputBytes) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          cleanup();
          resolve({ buffer: this._buffer, reason: 'quiet' });
        }, quietExitMs);
      };

      const checkBuffer = () => {
        if (this._scanForMarkerLine(marker)) {
          cleanup();
          resolve({ buffer: this._buffer, reason: 'marker' });
        }
      };

      const onData = (_data) => {
        bytesSeen += _data.length;
        // Send progress
        if (sendNotification && progressToken && Date.now() - lastProgressAt > 1000) {
          lastProgressAt = Date.now();
          const clean = stripAnsi(this._buffer);
          this._sendProgress(sendNotification, progressToken, clean, startTime, timeout);
        }
        armQuiet();
        checkBuffer();
      };

      this._dataListeners.push(onData);
      // Check if marker already in buffer
      checkBuffer();
    });
  }

  /**
   * Read output until no new data arrives for idleTimeout ms.
   */
  _readUntilIdle(timeout, idleTimeout) {
    return new Promise((resolve) => {
      let collected = '';
      let idleTimer;
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(hardTimer);
        clearTimeout(idleTimer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      };

      const done = () => {
        cleanup();
        resolve(collected);
      };

      const hardTimer = setTimeout(done, timeout);

      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(done, idleTimeout);
      };

      const onData = (data) => {
        collected += data;
        resetIdle();
      };

      this._dataListeners.push(onData);
      resetIdle();
    });
  }

  /**
   * Parse raw output: strip echoed command using preMarker, extract exit code, extract CWD.
   */
  _parseOutput(raw, marker, cwdMarker, preMarker) {
    const clean = stripAnsi(raw);
    const lines = clean.split(/\r?\n/);
    const outputLines = [];
    let exitCode = null;
    let cwd = null;
    // \d* — pwsh $LASTEXITCODE is empty for pure-cmdlet commands (e.g. echo)
    const markerRegex = new RegExp(`^${escapeRegExp(marker)}_(\\d*)__$`);
    const plainMarkerRegex = new RegExp(`^${escapeRegExp(marker)}$`);
    const cwdRegex = new RegExp(`^${escapeRegExp(cwdMarker)}(.+)__$`);

    // Find preMarker — start capturing output only after we see it
    let foundPreMarker = false;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Wait for preMarker before capturing any output
      if (!foundPreMarker) {
        if (trimmedLine === preMarker) {
          foundPreMarker = true;
        }
        continue;
      }

      // Extract exit code from marker line
      const markerMatch = trimmedLine.match(markerRegex);
      if (markerMatch) {
        exitCode = markerMatch[1] ? parseInt(markerMatch[1], 10) : null;
        continue;
      }

      // Plain marker without exit code
      if (plainMarkerRegex.test(trimmedLine)) {
        continue;
      }

      // Extract CWD
      const cwdMatch = trimmedLine.match(cwdRegex);
      if (cwdMatch) {
        cwd = cwdMatch[1].trim();
        // The CWD marker is always the last line of the wrapped command;
        // anything after it is the next interactive prompt — stop there.
        break;
        continue;
      }

      outputLines.push(line);
    }

    const output = outputLines.join('\n').trim();
    return { output, exitCode, cwd };
  }

  /**
   * Truncate output to maxLines: head(maxLines/2) + "...omitted..." + tail(maxLines/2).
   */
  _truncateOutput(output, maxLines) {
    const lines = output.split('\n');
    if (lines.length <= maxLines) return output;

    const headCount = Math.floor(maxLines / 2);
    const tailCount = Math.ceil(maxLines / 2);
    const head = lines.slice(0, headCount);
    const tail = lines.slice(-tailCount);
    const omitted = lines.length - headCount - tailCount;

    return [...head, `\n... ${omitted} lines omitted ...\n`, ...tail].join('\n');
  }

  _formatWaitOutput(output, returnMode, tailLines, tailTracker) {
    const trimmedOutput = output.trim();
    if (!trimmedOutput || returnMode === 'match-only') {
      return '';
    }
    if (returnMode === 'full') {
      return trimmedOutput;
    }
    if (tailTracker) {
      return this._tailTrackerToOutput(tailTracker);
    }
    return this._tailOutput(trimmedOutput, tailLines);
  }

  _tailOutput(output, tailLines) {
    const lines = output.split('\n');
    if (lines.length <= tailLines) {
      return output;
    }
    return lines.slice(-tailLines).join('\n');
  }

  _createTailTracker() {
    return {
      lines: [],
      partial: '',
    };
  }

  _appendToTailTracker(tracker, cleanData, tailLines) {
    const parts = cleanData.split(/\r?\n/);
    tracker.partial += parts[0] ?? '';

    for (let i = 1; i < parts.length; i++) {
      tracker.lines.push(tracker.partial);
      tracker.partial = parts[i];
    }

    const overflow = tracker.lines.length - tailLines;
    if (overflow > 0) {
      tracker.lines.splice(0, overflow);
    }
  }

  _tailTrackerToOutput(tracker) {
    const lines = tracker.partial ? [...tracker.lines, tracker.partial] : tracker.lines;
    return lines.join('\n').trim();
  }

  _sendProgress(sendNotification, progressToken, content, startTime, timeout) {
    try {
      const lines = content.split('\n').filter(Boolean);
      const lastLine = lines.length > 0 ? lines[lines.length - 1].slice(0, 200) : '';
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: Date.now() - startTime,
          total: timeout,
          message: `[${elapsed}s] ${lastLine}`,
        },
      });
    } catch {
      // Progress notifications are best-effort
    }
  }
}
