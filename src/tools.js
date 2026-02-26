import { z } from 'zod';
import { SUPPORTED_KEYS } from './pty-session.js';
import { execPipeline, execWithRetry, execAndDiff, captureSnapshot, restoreFromSnapshot, execMultiplex } from './smart-tools.js';

/**
 * Register all 9 MCP tools on the server.
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
    },
    async ({ shell, cols, rows, cwd, name }) => {
      const session = await manager.create({ shell, cols, rows, cwd, name });
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
    'Execute a command in a terminal session. Uses marker-based completion detection. Returns clean output, exit code, and current working directory.',
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
    'Write raw data to a terminal session. Use for interactive programs (REPLs, prompts, etc). Follow with terminal_read to get output.',
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
    'Read buffered output from a terminal session. Uses idle detection — returns when output stops arriving.',
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

  // --- terminal_pipeline ---
  server.tool(
    'terminal_pipeline',
    'Execute a pipeline of commands sequentially. Each step can reference {{prev_output}} and {{prev_exitCode}} from the previous step. Stops on first error by default.',
    {
      sessionId: z.string().describe('Session ID from terminal_start'),
      commands: z.array(z.object({
        command: z.string().describe('Command to execute. Use {{prev_output}} / {{prev_exitCode}} to reference the previous step.'),
        timeout: z.number().int().min(1000).max(600000).optional().describe('Timeout in ms for this step (default 30s)'),
      })).min(1).max(20).describe('Ordered list of commands to execute'),
      stopOnError: z.boolean().default(true).describe('Stop pipeline on first non-zero exit code'),
      maxLines: z.number().int().min(10).max(10000).default(200).describe('Max output lines per step'),
    },
    async ({ sessionId, commands, stopOnError, maxLines }) => {
      const session = manager.get(sessionId);
      const result = await execPipeline(session, { commands, stopOnError, maxLines });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // --- terminal_retry ---
  server.tool(
    'terminal_retry',
    'Execute a command with automatic retries and configurable backoff. Useful for flaky commands, network operations, or waiting for resources to become available.',
    {
      sessionId: z.string().describe('Session ID from terminal_start'),
      command: z.string().describe('Command to execute'),
      maxRetries: z.number().int().min(1).max(10).default(3).describe('Maximum number of retries (total attempts = maxRetries + 1)'),
      backoff: z.enum(['fixed', 'exponential', 'linear']).default('exponential').describe('Backoff strategy: fixed (same delay), exponential (delay doubles), linear (delay increases linearly)'),
      delayMs: z.number().int().min(100).max(60000).default(1000).describe('Base delay between retries in ms'),
      timeout: z.number().int().min(1000).max(600000).default(30000).describe('Timeout per attempt in ms'),
      maxLines: z.number().int().min(10).max(10000).default(200).describe('Max output lines per attempt'),
      successExitCode: z.number().int().nullable().default(0).describe('Expected exit code for success (null = ignore exit code)'),
      successPattern: z.string().nullable().default(null).describe('Regex pattern that must appear in output for success (null = ignore output)'),
    },
    async ({ sessionId, command, maxRetries, backoff, delayMs, timeout, maxLines, successExitCode, successPattern }) => {
      const session = manager.get(sessionId);
      const result = await execWithRetry(session, {
        command, maxRetries, backoff, delayMs, timeout, maxLines, successExitCode, successPattern,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // --- terminal_diff ---
  server.tool(
    'terminal_diff',
    'Execute two commands and compare their outputs with a unified diff. Great for comparing configs, checking changes before/after, or regression testing.',
    {
      sessionId: z.string().describe('Session ID from terminal_start'),
      commandA: z.string().describe('First command (baseline)'),
      commandB: z.string().describe('Second command (to compare against)'),
      timeout: z.number().int().min(1000).max(600000).default(30000).describe('Timeout per command in ms'),
      maxLines: z.number().int().min(10).max(10000).default(200).describe('Max output lines per command'),
      contextLines: z.number().int().min(0).max(20).default(3).describe('Number of context lines in diff output'),
    },
    async ({ sessionId, commandA, commandB, timeout, maxLines, contextLines }) => {
      const session = manager.get(sessionId);
      const result = await execAndDiff(session, { commandA, commandB, timeout, maxLines, contextLines });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // --- terminal_snapshot ---
  server.tool(
    'terminal_snapshot',
    'Capture a snapshot of a terminal session (CWD, environment variables, shell config). Use with terminal_restore to recreate the session later.',
    {
      sessionId: z.string().describe('Session ID to snapshot'),
    },
    async ({ sessionId }) => {
      const session = manager.get(sessionId);
      const result = await captureSnapshot(session);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // --- terminal_restore ---
  server.tool(
    'terminal_restore',
    'Restore a terminal session from a previously captured snapshot. Creates a new session with the same CWD, env vars, and shell settings.',
    {
      snapshot: z.object({
        cwd: z.string().describe('Working directory'),
        envVars: z.record(z.string()).optional().describe('Environment variables to restore'),
        shell: z.string().optional().describe('Shell executable'),
        shellType: z.string().optional().describe('Shell type'),
        cols: z.number().int().optional().describe('Terminal width'),
        rows: z.number().int().optional().describe('Terminal height'),
        name: z.string().optional().describe('Session name'),
        capturedAt: z.string().optional().describe('When the snapshot was taken'),
      }).describe('Snapshot object from terminal_snapshot'),
    },
    async ({ snapshot }) => {
      const session = await restoreFromSnapshot(manager, snapshot);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sessionId: session.id,
            shell: session.shell,
            shellType: session.shellType,
            cwd: session.cwd,
            restoredFrom: snapshot.capturedAt || 'unknown',
            message: 'Session restored successfully.',
          }, null, 2),
        }],
      };
    }
  );

  // --- terminal_multiplex ---
  server.tool(
    'terminal_multiplex',
    'Execute multiple commands in parallel, each in its own temporary session. Sessions are auto-cleaned after execution. Perfect for running tests, builds, or checks concurrently.',
    {
      commands: z.array(z.object({
        command: z.string().describe('Command to execute'),
        name: z.string().optional().describe('Friendly name for this task'),
        cwd: z.string().optional().describe('Working directory for this task'),
        timeout: z.number().int().min(1000).max(600000).optional().describe('Timeout in ms (default 30s)'),
      })).min(1).max(8).describe('Commands to run in parallel (max 8)'),
      maxLines: z.number().int().min(10).max(10000).default(200).describe('Max output lines per command'),
    },
    async ({ commands, maxLines }) => {
      const result = await execMultiplex(manager, { commands, maxLines });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
