import { z } from 'zod';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, runCommand } from './command-runner.js';
import { normalizeCommandName } from './command-parsers.js';
import { DEFAULT_PAGE_SIZE, paginateOutput } from './pager.js';

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
    'Start a new interactive terminal session.',
    {
      shell: z.string().optional().describe('Shell'),
      cols: z.number().int().min(20).max(500).default(120).describe('Terminal width in columns'),
      rows: z.number().int().min(5).max(200).default(30).describe('Terminal height in rows'),
      cwd: z.string().optional().describe('Working directory'),
      name: z.string().optional().describe('Session name'),
      env: z.record(z.string()).optional().describe('Environment variables'),
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
    'Execute a command in a terminal session and wait for it to finish.',
    {
      sessionId: z.string().describe('Session ID'),
      command: z.string().describe('Command to execute'),
      timeout: z.number().int().min(1000).max(600000).default(30000).describe('Timeout in ms'),
      maxLines: z.number().int().min(10).max(10000).default(200).describe('Max output lines'),
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
    'Run a one-shot non-interactive command.',
    {
      cmd: z.string().describe('Executable'),
      args: z.array(z.string()).default([]).describe('Arguments'),
      cwd: z.string().optional().describe('Working directory'),
      timeout: z.number().int().min(1000).max(600000).default(DEFAULT_TIMEOUT_MS).describe('Timeout in ms'),
      maxOutputBytes: z.number().int().min(1024).max(1048576).default(DEFAULT_MAX_OUTPUT_BYTES).describe('Max output bytes'),
      parse: z.boolean().default(true).describe('Parse structured output'),
    },
    async ({ cmd, args, cwd, timeout, maxOutputBytes, parse }) => {
      const result = await runCommand({ cmd, args, cwd, timeout, maxOutputBytes, parse });
      return jsonContent(result);
    }
  );

  // --- terminal_run_paged ---
  server.tool(
    'terminal_run_paged',
    'Run a read-only command and return one page of output.',
    {
      cmd: z.string().describe('Executable'),
      args: z.array(z.string()).default([]).describe('Arguments'),
      cwd: z.string().optional().describe('Working directory'),
      timeout: z.number().int().min(1000).max(600000).default(DEFAULT_TIMEOUT_MS).describe('Timeout in ms'),
      maxOutputBytes: z.number().int().min(1024).max(1048576).default(DEFAULT_MAX_OUTPUT_BYTES).describe('Max output bytes'),
      page: z.number().int().min(0).default(0).describe('Page number'),
      pageSize: z.number().int().min(1).max(1000).default(DEFAULT_PAGE_SIZE).describe('Page size'),
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
    'Write raw data to a terminal session.',
    {
      sessionId: z.string().describe('Session ID'),
      data: z.string().describe('Data to write'),
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
    'Read new output from a terminal session.',
    {
      sessionId: z.string().describe('Session ID'),
      timeout: z.number().int().min(500).max(300000).default(30000).describe('Hard timeout in ms'),
      idleTimeout: z.number().int().min(100).max(10000).default(500).describe('Idle timeout in ms'),
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
    'Get past output from a terminal session.',
    {
      sessionId: z.string().describe('Session ID'),
      offset: z.number().int().min(0).default(0).describe('History offset'),
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
    'Send a key to the terminal.',
    {
      sessionId: z.string().describe('Session ID'),
      key: z.string().describe('Key name'),
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
    'Wait for a pattern to appear in terminal output.',
    {
      sessionId: z.string().describe('Session ID'),
      pattern: z.string().describe('Pattern'),
      timeout: z.number().int().min(1000).max(600000).default(30000).describe('Timeout in ms'),
      returnMode: z.enum(['tail', 'full', 'match-only']).default('tail').describe('Return mode'),
      tailLines: z.number().int().min(1).max(1000).default(50).describe('Tail lines'),
    },
    async ({ sessionId, pattern, timeout, returnMode, tailLines }, extra) => {
      const session = manager.get(sessionId);
      const result = await session.waitForPattern({
        pattern,
        timeout,
        returnMode,
        tailLines,
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
    'List active terminal sessions.',
    {},
    async () => {
      const sessions = manager.list();
      return jsonContent({ sessions, count: sessions.length });
    }
  );

  // --- terminal_write_file ---
  server.tool(
    'terminal_write_file',
    'Write content to a file.',
    {
      sessionId: z.string().describe('Session ID'),
      path: z.string().describe('File path'),
      content: z.string().describe('File content'),
      encoding: z.enum(['utf-8', 'ascii', 'base64', 'hex', 'latin1']).default('utf-8').describe('File encoding'),
      append: z.boolean().default(false).describe('Append mode'),
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
