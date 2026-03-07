import test from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi } from '../src/ansi.js';

// --- Basic ANSI stripping ---

test('strips SGR color codes', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('strips bold and multiple SGR params', () => {
  assert.equal(stripAnsi('\x1b[1;32mbold green\x1b[0m'), 'bold green');
});

test('strips cursor movement sequences', () => {
  assert.equal(stripAnsi('\x1b[2Jhello\x1b[H'), 'hello');
});

test('strips OSC sequences (e.g. title setting)', () => {
  assert.equal(stripAnsi('\x1b]0;My Title\x07content'), 'content');
});

test('strips C1 8-bit OSC sequences (0x9D ... 0x9C)', () => {
  assert.equal(stripAnsi('\x9D0;My Title\x9Ccontent'), 'content');
});

test('strips OSC terminated by ST (ESC backslash)', () => {
  assert.equal(stripAnsi('\x1b]0;My Title\x1b\\content'), 'content');
});

test('returns plain text unchanged', () => {
  assert.equal(stripAnsi('hello world'), 'hello world');
});

test('handles empty string', () => {
  assert.equal(stripAnsi(''), '');
});

// --- Carriage return collapsing ---

test('collapses simple \\r overwrite', () => {
  assert.equal(stripAnsi('aaa\rbbb'), 'bbb');
});

test('collapses progress bar style output', () => {
  assert.equal(
    stripAnsi('Loading 10%\rLoading 50%\rLoading 100%'),
    'Loading 100%'
  );
});

test('handles partial overwrite (shorter text)', () => {
  assert.equal(stripAnsi('ABCDEF\rXY'), 'XYCDEF');
});

test('preserves newlines with \\r overwrites', () => {
  assert.equal(
    stripAnsi('line1\nfoo\rbar\nline3'),
    'line1\nbar\nline3'
  );
});

test('preserves Windows \\r\\n as newlines', () => {
  assert.equal(stripAnsi('line1\r\nline2\r\n'), 'line1\nline2\n');
});

test('handles trailing \\r', () => {
  assert.equal(stripAnsi('hello\r'), 'hello');
});

test('handles multiple \\r in sequence', () => {
  assert.equal(stripAnsi('ABCDE\r\r\rXY'), 'XYCDE');
});

test('handles \\r at the start of text', () => {
  assert.equal(stripAnsi('\rhello'), 'hello');
});

// --- Backspace handling ---

test('simulates single backspace', () => {
  assert.equal(stripAnsi('abc\bd'), 'abd');
});

test('simulates multiple consecutive backspaces', () => {
  assert.equal(stripAnsi('abcd\b\b\b'), 'a');
});

test('backspace at start is no-op', () => {
  assert.equal(stripAnsi('\bhello'), 'hello');
});

test('backspace with replacement character', () => {
  assert.equal(stripAnsi('abc\b\bxy'), 'axy');
});

// --- Control character stripping ---

test('strips null bytes', () => {
  assert.equal(stripAnsi('hel\x00lo'), 'hello');
});

test('strips bell character', () => {
  assert.equal(stripAnsi('done\x07'), 'done');
});

test('preserves tabs', () => {
  assert.equal(stripAnsi('col1\tcol2'), 'col1\tcol2');
});

test('preserves newlines', () => {
  assert.equal(stripAnsi('line1\nline2'), 'line1\nline2');
});

test('strips mixed control characters', () => {
  assert.equal(stripAnsi('a\x01b\x02c\x7Fd'), 'abcd');
});

// --- Erase-in-line (EL) handling ---

test('\\r + erase-to-EOL clears trailing chars from previous write', () => {
  // Common pattern: \r\x1b[K means "go to col 0, erase rest of line"
  assert.equal(stripAnsi('Loading... 100%\r\x1b[KDone'), 'Done');
});

test('\\r + \\x1b[0K (explicit param) clears trailing chars', () => {
  assert.equal(stripAnsi('Loading... 100%\r\x1b[0KDone'), 'Done');
});

test('\\x1b[2K erases entire line', () => {
  assert.equal(stripAnsi('old content\x1b[2Knew'), 'new');
});

test('erase-to-EOL mid-line truncates at cursor position', () => {
  // cursor is at position 3 after "foo", erase clears the rest
  assert.equal(stripAnsi('foobar\rfoo\x1b[K'), 'foo');
});

test('progress bar with \\r + erase-to-EOL', () => {
  const input = [
    'Downloading 10%',
    '\r\x1b[KDownloading 50%',
    '\r\x1b[KDownloading 100%',
    '\r\x1b[KDone!',
  ].join('');
  assert.equal(stripAnsi(input), 'Done!');
});

test('standalone erase-to-EOL without \\r does not leak sentinel', () => {
  // \x1b[K at end of line should truncate but not leave sentinel in output
  assert.equal(stripAnsi('foobar\x1b[K'), 'foobar');
  // \x1b[K mid-content: erase from cursor to end, then continue writing
  assert.equal(stripAnsi('hello world\x1b[K done'), 'hello world done');
});

test('erase-to-EOL with ANSI colors', () => {
  assert.equal(
    stripAnsi('\x1b[32mlong output\x1b[0m\r\x1b[K\x1b[32mshort\x1b[0m'),
    'short'
  );
});

// --- Combined / integration tests ---

test('ANSI codes + carriage return overwrite', () => {
  assert.equal(
    stripAnsi('\x1b[32mLoading 10%\x1b[0m\r\x1b[32mLoading 100%\x1b[0m'),
    'Loading 100%'
  );
});

test('ANSI codes + backspace + control chars', () => {
  assert.equal(
    stripAnsi('\x1b[1mhelo\b\bllo\x1b[0m\x07'),
    'hello'
  );
});

test('realistic npm-style progress bar', () => {
  const input = [
    '\x1b[32m⸩\x1b[0m ░░░░░░░░░░░░░░░░░░ 0/10\r',
    '\x1b[32m⸩\x1b[0m ██░░░░░░░░░░░░░░░░ 1/10\r',
    '\x1b[32m⸩\x1b[0m ████████████████░░ 9/10\r',
    '\x1b[32m⸩\x1b[0m ██████████████████ 10/10',
  ].join('');
  assert.equal(stripAnsi(input), '⸩ ██████████████████ 10/10');
});

test('marker parsing compatibility — markers survive \\r processing', () => {
  const marker = '__MCP_DONE_abc123__';
  const preMarker = '__MCP_PRE_def456__';
  const input = `${preMarker}\r\ncommand output\r\n${marker}_0__\r\n`;
  const clean = stripAnsi(input);
  const lines = clean.split(/\r?\n/);
  assert.ok(lines.includes(preMarker));
  assert.ok(lines.some(l => l.includes(marker)));
});
