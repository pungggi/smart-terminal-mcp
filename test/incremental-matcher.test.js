import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncrementalMatcher, createThrottledMatcher } from '../src/incremental-matcher.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('incremental matcher finds a match split across chunks', () => {
  const matcher = createIncrementalMatcher(/server ready/);
  matcher.push('booting...\nserver re');
  assert.equal(matcher.scan(), false);
  matcher.push('ady on :3000\n');
  assert.equal(matcher.scan(), true);
});

test('incremental matcher strips ANSI sequences split across chunks', () => {
  const matcher = createIncrementalMatcher(/ready/);
  matcher.push('\x1b[3');
  assert.equal(matcher.scan(), false);
  matcher.push('2mready\x1b[0m');
  assert.equal(matcher.scan(), true);
});

test('incremental matcher only rescans the overlap, not old output', () => {
  const matcher = createIncrementalMatcher(/needle/, { overlapChars: 10 });
  matcher.push('needle'.padEnd(1000, 'x'));
  assert.equal(matcher.scan(), true);
  // Old "needle" is outside the overlap window, so new output alone decides.
  matcher.push('more output');
  assert.equal(matcher.scan(), false);
});

test('incremental matcher returns false when nothing new arrived', () => {
  const matcher = createIncrementalMatcher(/x/);
  matcher.push('abc');
  assert.equal(matcher.scan(), false);
  assert.equal(matcher.scan(), false);
  assert.equal(matcher.pendingChars, 0);
});

test('incremental matcher caps retained output', () => {
  const matcher = createIncrementalMatcher(/zzz/, { maxRetainedChars: 100 });
  matcher.push('a'.repeat(500));
  assert.equal(matcher.text().length, 100);
});

test('incremental matcher rejects global/sticky regexes', () => {
  assert.throws(() => createIncrementalMatcher(/a/g), /without g\/y/);
});

test('multiline anchors match per line inside a window', () => {
  const matcher = createIncrementalMatcher(/^ready$/m);
  matcher.push('starting\nready\nmore');
  assert.equal(matcher.scan(), true);
});

test('throttled matcher defers small chunks until the interval', async () => {
  let matches = 0;
  const scanner = createThrottledMatcher(/done/, { onMatch: () => matches++, intervalMs: 20, minChars: 1000 });
  scanner.push('done');
  assert.equal(matches, 0, 'small chunk should not scan synchronously');
  await sleep(40);
  assert.equal(matches, 1);
  scanner.dispose();
});

test('throttled matcher scans immediately once minChars is pending', () => {
  let matches = 0;
  const scanner = createThrottledMatcher(/done/, { onMatch: () => matches++, intervalMs: 10_000, minChars: 10 });
  scanner.push('0123456789done');
  assert.equal(matches, 1);
  scanner.dispose();
});

test('throttled matcher flush scans pending output and fires onMatch once', () => {
  let matches = 0;
  const scanner = createThrottledMatcher(/done/, { onMatch: () => matches++, intervalMs: 10_000, minChars: 1000 });
  scanner.push('done');
  assert.equal(scanner.flush(), true);
  assert.equal(scanner.flush(), true);
  scanner.push('done again');
  assert.equal(matches, 1);
});

test('throttled matcher handles large streams in linear time', () => {
  const chunk = 'x'.repeat(4096) + '\n';
  const scanner = createThrottledMatcher(/never-matches/, { onMatch: () => {} });
  const started = performance.now();
  for (let i = 0; i < 5000; i++) scanner.push(chunk); // ~20 MB
  scanner.flush();
  scanner.dispose();
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 5000, `20MB scan took ${elapsedMs.toFixed(0)}ms`);
  assert.ok(scanner.text().length <= 1024 * 1024, 'retained output is capped');
});
