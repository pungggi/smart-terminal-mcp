import { compileUserRegex } from './regex-utils.js';

const MAX_DIFF_LINES = 400;

/**
 * Retry a command until it succeeds or retries are exhausted.
 * @param {import('./pty-session.js').PtySession} session
 * @param {object} opts
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
  const successRegex = successPattern ? compileUserRegex(successPattern, 'successPattern') : null;
  let lastResult = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = await session.exec({ command, timeout, maxLines });
    lastResult = result;
    history.push({ attempt, ...result });

    const exitOk = successExitCode === null || result.exitCode === successExitCode;
    const patternOk = !successRegex || successRegex.test(result.output);
    if (exitOk && patternOk) {
      return { success: true, attempts: attempt, lastResult: result, history };
    }

    if (attempt <= maxRetries) {
      await sleep(getRetryDelay(backoff, delayMs, attempt));
    }
  }

  return { success: false, attempts: history.length, lastResult, history };
}

/**
 * Execute two commands and return a unified diff of their outputs.
 * @param {import('./pty-session.js').PtySession} session
 * @param {object} opts
 */
export async function execAndDiff(session, {
  commandA,
  commandB,
  timeout = 30000,
  maxLines = 200,
  contextLines = 3,
}) {
  const resultA = await session.exec({ command: commandA, timeout, maxLines });
  const resultB = await session.exec({ command: commandB, timeout, maxLines });
  const identical = resultA.output === resultB.output;

  return {
    resultA,
    resultB,
    diff: createUnifiedDiff(resultA.output, resultB.output, commandA, commandB, contextLines),
    identical,
  };
}

function getRetryDelay(strategy, delayMs, attempt) {
  switch (strategy) {
    case 'linear':
      return delayMs * attempt;
    case 'fixed':
      return delayMs;
    case 'exponential':
    default:
      return delayMs * (2 ** (attempt - 1));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createUnifiedDiff(outputA, outputB, labelA, labelB, contextLines) {
  const linesA = splitLines(outputA);
  const linesB = splitLines(outputB);
  const header = [`--- ${labelA}`, `+++ ${labelB}`];

  if (linesA.length > MAX_DIFF_LINES || linesB.length > MAX_DIFF_LINES) {
    return [
      ...header,
      '@@ @@',
      `Diff skipped: outputs exceed ${MAX_DIFF_LINES} lines.`,
    ].join('\n');
  }

  const ops = buildDiffOps(linesA, linesB);
  const ranges = buildHunkRanges(ops, contextLines);
  if (ranges.length === 0) {
    return header.join('\n');
  }

  const lines = [...header];
  for (const [start, end] of ranges) {
    lines.push('@@ @@');
    for (let index = start; index <= end; index++) {
      lines.push(`${ops[index].type}${ops[index].line}`);
    }
  }
  return lines.join('\n');
}

function splitLines(output) {
  return output === '' ? [] : output.split('\n');
}

function buildDiffOps(linesA, linesB) {
  const height = linesA.length + 1;
  const width = linesB.length + 1;
  const dp = Array.from({ length: height }, () => new Array(width).fill(0));

  for (let a = 1; a < height; a++) {
    for (let b = 1; b < width; b++) {
      dp[a][b] = linesA[a - 1] === linesB[b - 1]
        ? dp[a - 1][b - 1] + 1
        : Math.max(dp[a - 1][b], dp[a][b - 1]);
    }
  }

  const ops = [];
  let a = linesA.length;
  let b = linesB.length;
  while (a > 0 || b > 0) {
    if (a > 0 && b > 0 && linesA[a - 1] === linesB[b - 1]) {
      ops.unshift({ type: ' ', line: linesA[a - 1] });
      a--;
      b--;
    } else if (b > 0 && (a === 0 || dp[a][b - 1] >= dp[a - 1][b])) {
      ops.unshift({ type: '+', line: linesB[b - 1] });
      b--;
    } else {
      ops.unshift({ type: '-', line: linesA[a - 1] });
      a--;
    }
  }

  return ops;
}

function buildHunkRanges(ops, contextLines) {
  const changeIndexes = [];
  for (let index = 0; index < ops.length; index++) {
    if (ops[index].type !== ' ') {
      changeIndexes.push(index);
    }
  }

  if (changeIndexes.length === 0) {
    return [];
  }

  const ranges = [];
  let start = Math.max(0, changeIndexes[0] - contextLines);
  let end = Math.min(ops.length - 1, changeIndexes[0] + contextLines);
  for (let index = 1; index < changeIndexes.length; index++) {
    const changeIndex = changeIndexes[index];
    const nextStart = Math.max(0, changeIndex - contextLines);
    const nextEnd = Math.min(ops.length - 1, changeIndex + contextLines);
    if (nextStart <= end + 1) {
      end = Math.max(end, nextEnd);
      continue;
    }
    ranges.push([start, end]);
    start = nextStart;
    end = nextEnd;
  }
  ranges.push([start, end]);
  return ranges;
}