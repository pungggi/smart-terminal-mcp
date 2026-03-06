import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { parseCommandOutput } from './command-parsers.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;

export async function runCommand({
  cmd,
  args = [],
  cwd,
  timeout = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  parse = true,
  parseOnly = false,
}) {
  const resolvedCwd = resolvePath(cwd ?? process.cwd());
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;
    let timedOut = false;
    let maxOutputExceeded = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: resolvedCwd,
      shell: false,
      windowsHide: true,
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
      reject(new Error(`Failed to start command "${cmd}": ${err.message}`));
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
      if ((parse || parseOnly) && !timedOut && !maxOutputExceeded) {
        result.stdout.parsed = parseCommandOutput({ cmd, args, stdout: stdoutRaw });
        if (parseOnly && result.stdout.parsed) {
          result.stdout.raw = '';
        }
      }

      resolve(result);
    });
  });
}