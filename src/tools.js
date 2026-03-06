import { z } from 'zod';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
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

/**
 * Format a filesystem error into a human-readable message with the error code.
 * @param {NodeJS.ErrnoException} err
 * @returns {string}
 */
function formatFsError(err) {
  const hint = FS_ERROR_MESSAGES[err.code];
  return hint ? `${hint} (${err.code})` : err.message;
}

/**
 * Register all 11 MCP tools on the server.
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sessionId: session.id,
            shell: session.shell,
            shellType: session.shellType,
            cwd: session.cwd,
            banner: banner || '(no banner)',
          }, null, 2),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, sessionId }),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ sessionId, ...result }, null, 2),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, cols, rows }),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, key }),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, message: `Session ${sessionId} stopped.` }),
        }],
      };
    }
  );

  // --- terminal_list ---
  server.tool(
    'terminal_list',
    'List all active terminal sessions with metadata (ID, shell, cwd, idle time, etc).',
    {},
    async () => {
      const sessions = manager.list();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ sessions, count: sessions.length }, null, 2),
        }],
      };
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            path: absolutePath,
            size,
            append,
          }, null, 2),
        }],
      };
    }
  );
}
