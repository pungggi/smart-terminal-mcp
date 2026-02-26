import { stripAnsi } from './ansi.js';

/**
 * Execute a pipeline of commands sequentially in a session.
 * Each command can reference {{prev_output}} and {{prev_exitCode}} from the previous step.
 *
 * @param {import('./pty-session.js').PtySession} session
 * @param {object} opts
 * @param {Array<{command: string, timeout?: number}>} opts.commands
 * @param {boolean} [opts.stopOnError=true]
 * @param {number} [opts.maxLines=200]
 * @returns {Promise<{ steps: Array<{command: string, output: string, exitCode: number|null, cwd: string|null, timedOut: boolean}>, summary: { total: number, succeeded: number, failed: number, stopped: boolean } }>}
 */
export async function execPipeline(session, { commands, stopOnError = true, maxLines = 200 }) {
  const steps = [];
  let prevOutput = '';
  let prevExitCode = 0;
  let stopped = false;

  for (const step of commands) {
    // Template substitution: allow referencing previous step's results
    // Escape output based on shell type to prevent injection
    const escapedOutput = escapeForShell(session.shellType, prevOutput);
    let cmd = step.command
      .replace(/\{\{prev_output\}\}/g, escapedOutput)
      .replace(/\{\{prev_exitCode\}\}/g, String(prevExitCode));

    const result = await session.exec({
      command: cmd,
      timeout: step.timeout || 30000,
      maxLines,
    });

    steps.push({
      command: cmd,
      output: result.output,
      exitCode: result.exitCode,
      cwd: result.cwd,
      timedOut: result.timedOut,
    });

    prevOutput = result.output;
    prevExitCode = result.exitCode ?? -1;

    if (stopOnError && result.exitCode !== 0) {
      stopped = true;
      break;
    }
  }

  const succeeded = steps.filter((s) => s.exitCode === 0).length;
  return {
    steps,
    summary: {
      total: commands.length,
      executed: steps.length,
      succeeded,
      failed: steps.length - succeeded,
      stopped,
    },
  };
}

/**
 * Retry a command with configurable backoff strategy.
 *
 * @param {import('./pty-session.js').PtySession} session
 * @param {object} opts
 * @param {string} opts.command
 * @param {number} [opts.maxRetries=3]
 * @param {'fixed'|'exponential'|'linear'} [opts.backoff='exponential']
 * @param {number} [opts.delayMs=1000]
 * @param {number} [opts.timeout=30000]
 * @param {number} [opts.maxLines=200]
 * @param {number|null} [opts.successExitCode=0]
 * @param {string|null} [opts.successPattern=null]
 * @returns {Promise<{ success: boolean, attempts: number, lastResult: object, history: Array<{attempt: number, exitCode: number|null, timedOut: boolean, output: string}> }>}
 */
export async function execWithRetry(session, {
  command,
  maxRetries = 3,
  backoff = 'exponential',
  delayMs = 1000,
  timeout = 30000,
  maxLines = 200,
  successExitCode = 0,
  successPattern = null,
}) {
  const history = [];
  let lastResult = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = await session.exec({ command, timeout, maxLines });
    lastResult = result;

    history.push({
      attempt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: result.output,
    });

    // Check success conditions
    const exitOk = successExitCode === null || result.exitCode === successExitCode;
    const patternOk = !successPattern || new RegExp(successPattern).test(result.output);

    if (exitOk && patternOk) {
      return { success: true, attempts: attempt, lastResult: result, history };
    }

    // Don't wait after the last attempt
    if (attempt <= maxRetries) {
      const wait = computeDelay(backoff, delayMs, attempt);
      await sleep(wait);
    }
  }

  return { success: false, attempts: history.length, lastResult, history };
}

/**
 * Execute two commands and diff their outputs.
 *
 * @param {import('./pty-session.js').PtySession} session
 * @param {object} opts
 * @param {string} opts.commandA
 * @param {string} opts.commandB
 * @param {number} [opts.timeout=30000]
 * @param {number} [opts.maxLines=200]
 * @param {number} [opts.contextLines=3]
 * @returns {Promise<{ resultA: object, resultB: object, diff: string, identical: boolean }>}
 */
export async function execAndDiff(session, { commandA, commandB, timeout = 30000, maxLines = 200, contextLines = 3 }) {
  const resultA = await session.exec({ command: commandA, timeout, maxLines });
  const resultB = await session.exec({ command: commandB, timeout, maxLines });

  const linesA = resultA.output.split('\n');
  const linesB = resultB.output.split('\n');
  const diff = unifiedDiff(linesA, linesB, commandA, commandB, contextLines);
  const identical = resultA.output === resultB.output;

  return { resultA, resultB, diff, identical };
}

/**
 * Capture a session snapshot (CWD, env vars, shell aliases).
 *
 * @param {import('./pty-session.js').PtySession} session
 * @returns {Promise<{ sessionId: string, snapshot: object }>}
 */
export async function captureSnapshot(session) {
  const { envCommand, cwdCommand, parseEnv } = getSnapshotCommands(session.shellType);

  const envResult = await session.exec({ command: envCommand, timeout: 5000, maxLines: 1000 });
  const cwdResult = await session.exec({ command: cwdCommand, timeout: 5000, maxLines: 1 });

  const envVars = parseEnv(envResult.output);

  return {
    sessionId: session.id,
    snapshot: {
      cwd: cwdResult.output.trim() || session.cwd,
      envVars,
      shell: session.shell,
      shellType: session.shellType,
      cols: session.cols,
      rows: session.rows,
      name: session.name,
      capturedAt: new Date().toISOString(),
    },
  };
}

/**
 * Restore a session from a snapshot — creates a new session and applies the captured state.
 *
 * @param {import('./session-manager.js').SessionManager} manager
 * @param {object} snapshot
 * @returns {Promise<import('./pty-session.js').PtySession>}
 */
export async function restoreFromSnapshot(manager, snapshot) {
  const session = await manager.create({
    shell: snapshot.shell,
    cols: snapshot.cols || 120,
    rows: snapshot.rows || 30,
    cwd: snapshot.cwd,
    name: snapshot.name ? `${snapshot.name}-restored` : 'restored',
  });

  await session.waitForBanner();

  // Restore key env vars (skip system ones that are set automatically)
  const skipEnvKeys = new Set([
    'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'PWD', 'OLDPWD',
    'SHLVL', '_', 'LOGNAME', 'HOSTNAME', 'PAGER', 'GIT_PAGER', 'LESS',
    'DEBIAN_FRONTEND',
    // Windows system vars
    'COMPUTERNAME', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'SYSTEMROOT',
    'WINDIR', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
    'COMMONPROGRAMFILES', 'SYSTEMDRIVE', 'HOMEDRIVE', 'HOMEPATH',
    'PSModulePath',
  ]);

  const customEnvVars = Object.entries(snapshot.envVars || {})
    .filter(([key]) => !skipEnvKeys.has(key) && !key.startsWith('__MCP'));

  if (customEnvVars.length > 0) {
    for (const [key, value] of customEnvVars) {
      const cmd = buildSetEnvCommand(session.shellType, key, value);
      await session.exec({
        command: cmd,
        timeout: 3000,
        maxLines: 10,
      });
    }
  }

  return session;
}

/**
 * Execute multiple commands in parallel across separate sessions.
 *
 * @param {import('./session-manager.js').SessionManager} manager
 * @param {object} opts
 * @param {Array<{command: string, name?: string, cwd?: string, timeout?: number}>} opts.commands
 * @param {number} [opts.maxLines=200]
 * @returns {Promise<{ results: Array<{command: string, name: string|null, output: string, exitCode: number|null, cwd: string|null, timedOut: boolean, sessionId: string}>, summary: { total: number, succeeded: number, failed: number, durationMs: number } }>}
 */
export async function execMultiplex(manager, { commands, maxLines = 200 }) {
  const startTime = Date.now();
  const tasks = commands.map(async (cmd, idx) => {
    const session = await manager.create({
      name: cmd.name || `multiplex-${idx}`,
      cwd: cmd.cwd,
    });
    await session.waitForBanner();

    try {
      const result = await session.exec({
        command: cmd.command,
        timeout: cmd.timeout || 30000,
        maxLines,
      });
      return {
        command: cmd.command,
        name: cmd.name || null,
        output: result.output,
        exitCode: result.exitCode,
        cwd: result.cwd,
        timedOut: result.timedOut,
        sessionId: session.id,
      };
    } finally {
      // Auto-cleanup multiplex sessions after execution
      manager.stop(session.id);
    }
  });

  const results = await Promise.all(tasks);
  const succeeded = results.filter((r) => r.exitCode === 0).length;

  return {
    results,
    summary: {
      total: commands.length,
      succeeded,
      failed: commands.length - succeeded,
      durationMs: Date.now() - startTime,
    },
  };
}

// --- Utility functions ---

function computeDelay(strategy, baseMs, attempt) {
  switch (strategy) {
    case 'exponential':
      return baseMs * Math.pow(2, attempt - 1);
    case 'linear':
      return baseMs * attempt;
    case 'fixed':
    default:
      return baseMs;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escape a string for safe embedding in a shell command, based on shell type.
 */
function escapeForShell(shellType, str) {
  switch (shellType) {
    case 'powershell':
      // PowerShell: use double-quotes, escape internal double-quotes and backticks
      return str.replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
    case 'cmd':
      // cmd.exe: escape special chars with ^
      return str.replace(/([&|<>^"%])/g, '^$1');
    default:
      // bash/zsh: escape single quotes
      return str.replace(/'/g, "'\\''");
  }
}

/**
 * Get shell-specific commands for capturing environment snapshots.
 */
function getSnapshotCommands(shellType) {
  switch (shellType) {
    case 'powershell':
      return {
        envCommand: 'Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" }',
        cwdCommand: '(Get-Location).Path',
        parseEnv: parseKeyValueEnv,
      };
    case 'cmd':
      return {
        envCommand: 'set',
        cwdCommand: 'cd',
        parseEnv: parseKeyValueEnv,
      };
    default:
      return {
        envCommand: 'env',
        cwdCommand: 'pwd',
        parseEnv: parseKeyValueEnv,
      };
  }
}

/**
 * Parse KEY=VALUE lines into an object. Works for all shells.
 */
function parseKeyValueEnv(output) {
  const envVars = {};
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      envVars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return envVars;
}

/**
 * Build a shell-specific command to set an environment variable.
 */
function buildSetEnvCommand(shellType, key, value) {
  switch (shellType) {
    case 'powershell': {
      const safeValue = value.replace(/'/g, "''");
      return `$env:${key} = '${safeValue}'`;
    }
    case 'cmd': {
      return `set "${key}=${value}"`;
    }
    default: {
      const safeValue = value.replace(/'/g, "'\\''");
      return `export ${key}='${safeValue}'`;
    }
  }
}

/**
 * Generate a unified diff between two arrays of lines.
 */
function unifiedDiff(linesA, linesB, labelA, labelB, contextLines = 3) {
  // Simple LCS-based diff
  const m = linesA.length;
  const n = linesB.length;

  // Build LCS table
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = linesA[i - 1] === linesB[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to find diff operations
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      ops.unshift({ type: ' ', line: linesA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: '+', line: linesB[j - 1] });
      j--;
    } else {
      ops.unshift({ type: '-', line: linesA[i - 1] });
      i--;
    }
  }

  // Format with context
  const output = [`--- ${labelA}`, `+++ ${labelB}`];
  let hunkStart = -1;
  const hunk = [];

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type !== ' ') {
      // Include context before
      const ctxStart = Math.max(hunkStart === -1 ? 0 : hunk.length, k - contextLines);
      if (hunkStart === -1) {
        for (let c = ctxStart; c < k; c++) {
          hunk.push(` ${ops[c].line}`);
        }
        hunkStart = ctxStart;
      }
      hunk.push(`${op.type}${op.line}`);
    } else if (hunkStart !== -1) {
      // Context after a change
      hunk.push(` ${op.line}`);
      // Check if we're past context window with no more changes nearby
      const nextChange = ops.findIndex((o, idx) => idx > k && o.type !== ' ');
      if (nextChange === -1 || nextChange - k > contextLines) {
        output.push(`@@ chunk @@`);
        output.push(...hunk);
        hunkStart = -1;
        hunk.length = 0;
      }
    }
  }

  if (hunk.length > 0) {
    output.push(`@@ chunk @@`);
    output.push(...hunk);
  }

  return output.join('\n');
}
