import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { stripAnsi } from './ansi.js';
import { getShellType } from './shell-detector.js';

const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB
const HISTORY_MAX_LINES = 10_000;
const BANNER_WAIT_MS = 2000;
const BANNER_IDLE_MS = 500;

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

    const env = {
      ...process.env,
      ...customEnv,
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      LESS: '-FRX',
      TERM: 'xterm-256color',
    };

    if (platform() !== 'win32') {
      env.DEBIAN_FRONTEND = 'noninteractive';
    }

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
      // Enforce buffer cap — keep tail
      if (this._buffer.length > MAX_BUFFER_BYTES) {
        const overflow = this._buffer.length - MAX_BUFFER_BYTES;
        this._buffer = this._buffer.slice(-MAX_BUFFER_BYTES);
        this._readCursor = Math.max(0, this._readCursor - overflow);
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
   * @param {number} [opts.maxLines=200]
   * @param {Function} [opts.sendNotification] - MCP sendNotification function for progress
   * @param {string|number} [opts.progressToken] - Progress token from client
   * @returns {Promise<{ output: string, exitCode: number|null, cwd: string|null, timedOut: boolean }>}
   */
  async exec({ command, timeout = 30000, maxLines = 200, sendNotification, progressToken }) {
    if (this.busy) {
      throw new Error(`Session ${this.id} is busy with another command. Wait or use terminal_write for interactive input.`);
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

      const raw = await this._waitForMarker(marker, timeout, sendNotification, progressToken);
      const timedOut = !raw.includes(marker);

      const { output, exitCode, cwd } = this._parseOutput(raw, marker, cwdMarker, preMarker);
      if (cwd) this.cwd = cwd;

      return {
        output: this._truncateOutput(output, maxLines),
        exitCode,
        cwd: this.cwd,
        timedOut,
        ...(timedOut && { hint: 'Command may be waiting for input. Use terminal_write to send input or terminal_send_key("ctrl+c") to abort.' }),
      };
    } finally {
      this.busy = false;
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
   * @param {number} [opts.maxLines=200]
   * @returns {Promise<{ output: string, timedOut: boolean }>}
   */
  async read({ timeout = 30000, idleTimeout = 500, maxLines = 200 } = {}) {
    if (!this.alive) {
      // Return whatever is left in buffer
      const leftover = stripAnsi(this._consumeUnreadBuffer()).trim();
      this._resetBuffer();
      return { output: leftover, timedOut: false };
    }

    await this._readUntilIdle(timeout, idleTimeout);
    const raw = this._consumeUnreadBuffer();
    const output = stripAnsi(raw).trim();

    return {
      output: this._truncateOutput(output, maxLines),
      timedOut: false,
    };
  }

  /**
   * Wait for a specific pattern in the output.
   * @param {object} opts
   * @param {string} opts.pattern - String or regex pattern to match
   * @param {number} [opts.timeout=30000]
   * @param {Function} [opts.sendNotification]
   * @param {string|number} [opts.progressToken]
   * @returns {Promise<{ output: string, matched: boolean, timedOut: boolean }>}
   */
  async waitForPattern({ pattern, timeout = 30000, sendNotification, progressToken }) {
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }

    const regex = new RegExp(pattern);
    const startTime = Date.now();
    let collected = '';
    let lastProgressAt = 0;

    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve({
          output: stripAnsi(collected).trim(),
          matched: false,
          timedOut: true,
        });
      }, timeout);

      const onData = (data) => {
        collected += data;
        const clean = stripAnsi(collected);

        // Send progress notifications
        if (sendNotification && progressToken && Date.now() - lastProgressAt > 1000) {
          lastProgressAt = Date.now();
          this._sendProgress(sendNotification, progressToken, clean, startTime, timeout);
        }

        if (regex.test(clean)) {
          cleanup();
          resolve({
            output: clean.trim(),
            matched: true,
            timedOut: false,
          });
        }
      };

      // Check existing buffer first
      const existingClean = stripAnsi(this._buffer);
      if (regex.test(existingClean)) {
        clearTimeout(timer);
        resolve({
          output: existingClean.trim(),
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
   */
  kill() {
    if (this.alive) {
      this.process.kill();
      this.alive = false;
    }
  }

  /**
   * Get session metadata for terminal_list.
   */
  getInfo() {
    return {
      id: this.id,
      name: this.name,
      shell: this.shell,
      shellType: this.shellType,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      busy: this.busy,
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivity: new Date(this.lastActivity).toISOString(),
      idleSeconds: Math.round((Date.now() - this.lastActivity) / 1000),
    };
  }

  /**
   * Retrieve past output without consuming it.
   * @param {object} opts
   * @param {number} [opts.offset=0] - Lines to skip from the end (for pagination)
   * @param {number} [opts.limit=200] - Max lines to return
   * @returns {{ lines: string[], totalLines: number, returnedFrom: number, returnedTo: number }}
   */
  getHistory({ offset = 0, limit = 200 } = {}) {
    const len = this._history.length;
    const end = Math.max(0, len - offset);
    const start = Math.max(0, end - limit);
    const lines = this._history.slice(start, end);

    // Map buffer indices to absolute line numbers
    const evicted = this._historyTotalLines - len;
    return {
      lines,
      totalLines: this._historyTotalLines,
      returnedFrom: evicted + start,
      returnedTo: evicted + end,
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
  }

  _consumeUnreadBuffer() {
    const start = Math.min(this._readCursor, this._buffer.length);
    const unread = this._buffer.slice(start);
    this._readCursor = this._buffer.length;
    return unread;
  }

  /**
   * Wait for the completion marker in the output stream.
   */
  _waitForMarker(marker, timeout, sendNotification, progressToken) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastProgressAt = 0;

      const cleanup = () => {
        clearTimeout(timer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(this._buffer);
      }, timeout);

      const checkBuffer = () => {
        if (this._buffer.includes(marker)) {
          cleanup();
          resolve(this._buffer);
        }
      };

      const onData = (_data) => {
        // Send progress
        if (sendNotification && progressToken && Date.now() - lastProgressAt > 1000) {
          lastProgressAt = Date.now();
          const clean = stripAnsi(this._buffer);
          this._sendProgress(sendNotification, progressToken, clean, startTime, timeout);
        }
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
      const startBuffer = this._buffer;
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
        const result = this._buffer.slice(startBuffer.length);
        cleanup();
        resolve(result);
      };

      const hardTimer = setTimeout(done, timeout);

      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(done, idleTimeout);
      };

      const onData = () => {
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
    const markerRegex = new RegExp(`^${escapeRegExp(marker)}_(\\d+)__$`);
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
        exitCode = parseInt(markerMatch[1], 10);
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
