import { z } from 'zod';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, runCommand } from './command-runner.js';
import { normalizeCommandName } from './command-parsers.js';
import { DEFAULT_PAGE_SIZE, paginateOutput } from './pager.js';
import { SUPPORTED_KEYS } from './pty-session.js';

const FS_ERROR_MESSAGES = {
  EACCES: 'Permission denied',
  ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system',
  ENOENT: 'Invalid path — a component does not exist',
  ENOTDIR: 'A component of the path is not a directory',
  ENAMETOOLONG: 'File name too long',
  EISDIR: 'Path is a directory, not a file',
};
const READ_ONLY_PAGED_COMMANDS = new Set(['tasklist', 'where', 'which']);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['branch', 'diff', 'log', 'status']);

/**
 * Format a filesystem error into a human-readable message with the error code.
 * @param {NodeJS.ErrnoException} err
 * @returns {string}
 */
function formatFsError(err) {
  const hint = FS_ERROR_MESSAGES[err.code];
  return hint ? `${hint} (${err.code})` : err.message;
}

function jsonContent(payload) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload),
    }],
  };
}

function assertPagedCommandIsReadOnly(cmd, args = []) {
  const commandName = normalizeCommandName(cmd);
  if (READ_ONLY_PAGED_COMMANDS.has(commandName)) return;

  if (commandName === 'git') {
    const subcommand = args[0]?.toLowerCase();
    if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return;
  }

  throw new Error('terminal_run_paged only supports read-only commands: git (branch, diff, log, status), tasklist, where, which.');
}

/**
 * Register all 13 MCP tools on the server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./session-manager.js').SessionManager} manager
 */
export function registerTools(server, manager) {
  // --- terminal_start ---
  server.tool(
    'terminal_start',
    'Start a new interactive terminal session. Returns session ID and shell banner.',
    {
      shell: z.string().optional().describe('Shell to use (e.g. "pwsh.exe", "cmd.exe", "bash"). Auto-detected if omitted.'),
      cols: z.number().int().min(20).max(500).default(120).describe('Terminal width in columns'),
      rows: z.number().int().min(5).max(200).default(30).describe('Terminal height in rows'),
      cwd: z.string().optional().describe('Working directory. Defaults to server CWD.'),
      name: z.string().optional().describe('Optional friendly name for this session'),
      env: z.record(z.string()).optional().describe('Custom environment variables to set for the session (e.g. { "TEST_ENV": "true", "API_KEY": "secret" })'),
    },
    async ({ shell, cols, rows, cwd, name, env }) => {
      const session = await manager.create({ shell, cols, rows, cwd, name, env });
      const banner = await session.waitForBanner();
      return jsonContent({
        sessionId: session.id,
        shell: session.shell,
        shellType: session.shellType,
        cwd: session.cwd,
        banner: banner || '(no banner)',
      });
    }
  );

  // --- terminal_exec ---
  server.tool(
    'terminal_exec',
    'Execute a command and wait for it to complete (blocking). Returns clean output, exit code, and cwd. Only one command can run at a time per session — throws if session is busy.',
    {
      sessionId: z.string().describe('Session ID from terminal_start'),
      command: z.string().describe('Command to execute'),
      timeout: z.number().int().min(1000).max(600000).default(30000).describe('Timeout in ms (default 30s, max 10min)'),
      maxLines: z.number().int().min(10).max(10000).default(200).describe('Max output lines. Excess is truncated to head+tail.'),
    },
    async ({ sessionId, command, timeout, maxLines }, extra) => {
      const session = manager.get(sessionId);
      const result = await session.exec({
        command,
        timeout,
        maxLines,
        sendNotification: extra.sendNotification,
        progressToken: extra._meta?.progressToken,
      });
      return jsonContent(result);
    }
  );

  // --- terminal_run ---
  server.tool(
    'terminal_run',
    'Run a one-shot non-interactive command using cmd + args with shell=false. Safer than terminal_exec for predictable automation. Supports structured parsing for a small set of read-only commands. Only real executables are supported; shell built-ins such as dir or cd are not.',
    {
      cmd: z.string().describe('Executable to run, such as "git", "tasklist", or an absolute path to a binary'),
      args: z.array(z.string()).default([]).describe('Argument array passed directly to the executable (default: [])'),
      cwd: z.string().optional().describe('Working directory. Defaults to the server CWD.'),
      timeout: z.number().int().min(1000).max(600000).default(DEFAULT_TIMEOUT_MS).describe('Timeout in ms (default 30s, max 10min)'),
      maxOutputBytes: z.number().int().min(1024).max(1048576).default(DEFAULT_MAX_OUTPUT_BYTES).describe('Maximum combined stdout/stderr bytes to capture before stopping the process (default 102400)'),
      parse: z.boolean().default(true).describe('Attempt structured parsing for supported read-only commands (default: true)'),
    },
    async ({ cmd, args, cwd, timeout, maxOutputBytes, parse }) => {
      const result = await runCommand({ cmd, args, cwd, timeout, maxOutputBytes, parse });
      return jsonContent(result);
    }
  );

  // --- terminal_run_paged ---
  server.tool(
    'terminal_run_paged',
    'Run a read-only one-shot command using cmd + args with shell=false and return a single page of stdout lines. Structured parsing is disabled in paged mode because partial output is unsafe to parse.',
    {
      cmd: z.string().describe('Read-only executable to run, such as "git", "tasklist", "where", or "which"'),
      args: z.array(z.string()).default([]).describe('Argument array passed directly to the executable (default: [])'),
      cwd: z.string().optional().describe('Working directory. Defaults to the server CWD.'),
      timeout: z.number().int().min(1000).max(600000).default(DEFAULT_TIMEOUT_MS).describe('Timeout in ms (default 30s, max 10min)'),
      maxOutputBytes: z.number().int().min(1024).max(1048576).default(DEFAULT_MAX_OUTPUT_BYTES).describe('Maximum combined stdout/stderr bytes to capture before stopping the process (default 102400)'),
      page: z.number().int().min(0).default(0).describe('0-indexed page number (default: 0)'),
      pageSize: z.number().int().min(1).max(1000).default(DEFAULT_PAGE_SIZE).describe('Lines per page (default: 100)'),
    },
    async ({ cmd, args, cwd, timeout, maxOutputBytes, page, pageSize }) => {
      assertPagedCommandIsReadOnly(cmd, args);

      const result = await runCommand({
        cmd,
        args,
        cwd,
        timeout,
        maxOutputBytes,
        parse: false,
      });
      const pagination = paginateOutput(result.stdout.raw, { page, pageSize });

      return jsonContent({
        ...result,
        stdout: {
          raw: pagination.pageText,
          parsed: null,
        },
        pageInfo: {
          page: pagination.page,
          pageSize: pagination.pageSize,
          totalLines: pagination.totalLines,
          hasNext: pagination.hasNext,
        },
      });
    }
  );

  // --- terminal_write ---
  server.tool(
    'terminal_write',
    'Write raw data to a terminal session (fire-and-forget, no output returned). Use for interactive programs (REPLs, prompts, etc). Must call terminal_read afterwards to get output.',
    {
      sessionId: z.string().describe('Session ID'),
      data: z.string().describe('Data to write. Use \\r for Enter, \\t for Tab.'),
    },
    async ({ sessionId, data }) => {
      const session = manager.get(sessionId);
      // Interpret common escape sequences from the string
      const processed = data
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t');
      session.write(processed);
      return jsonContent({ success: true, sessionId });
    }
  );

  // --- terminal_read ---
  server.tool(
    'terminal_read',
    'Read new output from a terminal session. Only captures output arriving after this call — does not return past output. Use terminal_get_history to retrieve earlier output. Returns when output stops arriving (idle detection).',
    {
      sessionId: z.string().describe('Session ID'),
      timeout: z.number().int().min(500).max(300000).default(30000).describe('Hard timeout in ms'),
      idleTimeout: z.number().int().min(100).max(10000).default(500).describe('Idle timeout — return after this many ms of no new output'),
      maxLines: z.number().int().min(10).max(10000).default(200).describe('Max output lines'),
    },
    async ({ sessionId, timeout, idleTimeout, maxLines }) => {
      const session = manager.get(sessionId);
      const result = await session.read({ timeout, idleTimeout, maxLines });
      return jsonContent(result);
    }
  );

  // --- terminal_get_history ---
  server.tool(
    'terminal_get_history',
    'Retrieve past terminal output without consuming it. Unlike terminal_read, this is non-destructive and returns historical output from a rolling buffer (last ~10,000 lines). Useful for reviewing output that was already read or missed.',
    {
      sessionId: z.string().describe('Session ID'),
      offset: z.number().int().min(0).default(0).describe('Number of lines to skip from the end for pagination. offset=0 returns the most recent lines, offset=200 skips the last 200 lines to page backwards.'),
      maxLines: z.number().int().min(1).max(10000).default(200).describe('Max lines to return'),
    },
    async ({ sessionId, offset, maxLines }) => {
      const session = manager.get(sessionId);
      const result = session.getHistory({ offset, limit: maxLines });
      return jsonContent({ sessionId, ...result });
    }
  );

  // --- terminal_resize ---
  server.tool(
    'terminal_resize',
    'Resize terminal dimensions.',
    {
      sessionId: z.string().describe('Session ID'),
      cols: z.number().int().min(20).max(500).describe('New width in columns'),
      rows: z.number().int().min(5).max(200).describe('New height in rows'),
    },
    async ({ sessionId, cols, rows }) => {
      const session = manager.get(sessionId);
      session.resize(cols, rows);
      return jsonContent({ success: true, cols, rows });
    }
  );

  // --- terminal_send_key ---
  server.tool(
    'terminal_send_key',
    `Send a special key to the terminal. Supported keys: ${SUPPORTED_KEYS.join(', ')}`,
    {
      sessionId: z.string().describe('Session ID'),
      key: z.string().describe(`Key name: ${SUPPORTED_KEYS.join(', ')}`),
    },
    async ({ sessionId, key }) => {
      const session = manager.get(sessionId);
      session.sendKey(key);
      return jsonContent({ success: true, key });
    }
  );

  // --- terminal_wait ---
  server.tool(
    'terminal_wait',
    'Wait until a specific pattern appears in the terminal output. Useful for waiting for servers to start, builds to complete, etc.',
    {
      sessionId: z.string().describe('Session ID'),
      pattern: z.string().describe('String or regex pattern to wait for'),
      timeout: z.number().int().min(1000).max(600000).default(30000).describe('Timeout in ms'),
    },
    async ({ sessionId, pattern, timeout }, extra) => {
      const session = manager.get(sessionId);
      const result = await session.waitForPattern({
        pattern,
        timeout,
        sendNotification: extra.sendNotification,
        progressToken: extra._meta?.progressToken,
      });
      return jsonContent(result);
    }
  );

  // --- terminal_stop ---
  server.tool(
    'terminal_stop',
    'Stop and clean up a terminal session.',
    {
      sessionId: z.string().describe('Session ID to stop'),
    },
    async ({ sessionId }) => {
      manager.stop(sessionId);
      return jsonContent({ success: true, message: `Session ${sessionId} stopped.` });
    }
  );

  // --- terminal_list ---
  server.tool(
    'terminal_list',
    'List all active terminal sessions with metadata (ID, shell, cwd, idle time, etc).',
    {},
    async () => {
      const sessions = manager.list();
      return jsonContent({ sessions, count: sessions.length });
    }
  );

  // --- terminal_write_file ---
  server.tool(
    'terminal_write_file',
    'Write content directly to a file on disk. Path is resolved relative to the session\'s current working directory. Safer and more robust than piping content through echo commands — handles special characters, newlines, and large files correctly. For binary files, pass base64-encoded content with encoding "base64".',
    {
      sessionId: z.string().describe('Session ID (used to resolve working directory)'),
      path: z.string().describe('File path (relative to session CWD, or absolute)'),
      content: z.string().describe('File content to write. For binary files, pass base64-encoded string with encoding="base64".'),
      encoding: z.enum(['utf-8', 'ascii', 'base64', 'hex', 'latin1']).default('utf-8').describe('File encoding. Use "base64" to decode base64 content into binary. (default: utf-8)'),
      append: z.boolean().default(false).describe('Append to file instead of overwriting (default: false)'),
    },
    async ({ sessionId, path: filePath, content, encoding, append }) => {
      const session = manager.get(sessionId);
      const absolutePath = resolve(session.cwd, filePath);

      try {
        await mkdir(dirname(absolutePath), { recursive: true });
      } catch (err) {
        throw new Error(`Failed to create directory "${dirname(absolutePath)}": ${formatFsError(err)}`);
      }

      try {
        const writeFn = append ? appendFile : writeFile;
        await writeFn(absolutePath, content, { encoding });
      } catch (err) {
        throw new Error(`Failed to write "${absolutePath}": ${formatFsError(err)}`);
      }

      const size = Buffer.byteLength(content, encoding);
      return jsonContent({
        success: true,
        path: absolutePath,
        size,
        append,
      });
    }
  );
}
