// ANSI escape code stripping and terminal output cleaning utility

// Matches all common ANSI escape sequences:
// - CSI sequences: ESC [ ... <final byte>
// - OSC sequences: ESC ] ... (ST | BEL)
// - Simple escapes: ESC followed by single char
// - C1 control codes
const ANSI_PATTERN = new RegExp(
  [
    // OSC sequences: ESC ] or C1 0x9D, terminated by BEL, ST (ESC \), or C1 ST (0x9C)
    '(?:\\u001B\\]|\\u009D)[^\\u0007\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\|\\u009C)',
    // CSI sequences and other structured escapes
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*|[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g'
);

// Matches C0/C1 control characters except \t (0x09) and \n (0x0A)
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

// Sentinel character used to preserve erase-to-end-of-line semantics across ANSI stripping.
// Uses Unicode non-character U+FFFE which will never appear in real terminal output.
const ERASE_EOL = '\uFFFE';

/**
 * Convert erase-in-line (EL) ANSI sequences into a sentinel character before
 * the general ANSI strip runs, so their clearing semantics survive into
 * collapseCarriageReturns().
 *
 * Handles:
 *   \x1b[K  / \x1b[0K — erase from cursor to end of line
 *   \x1b[2K           — erase entire line (converted to \r + sentinel)
 * @param {string} text
 * @returns {string}
 */
function applyEraseInLine(text) {
  // \x1b[2K — erase entire line: move cursor to start then truncate
  text = text.replace(/\x1b\[2K/g, '\r' + ERASE_EOL);
  // \x1b[K or \x1b[0K — erase from cursor to end of line
  text = text.replace(/\x1b\[0?K/g, ERASE_EOL);
  return text;
}

/**
 * Simulate destructive backspace: each \b removes the preceding character.
 * @param {string} text
 * @returns {string}
 */
function simulateBackspace(text) {
  if (!text.includes('\b')) return text;
  const out = [];
  for (const ch of text) {
    if (ch === '\b') {
      out.pop();
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

/**
 * Collapse carriage-return overwrites into final visible line content.
 * Simulates terminal behavior: \r resets cursor to column 0, subsequent
 * characters overwrite from position 0. Partial overwrites leave trailing
 * characters from longer previous writes.
 * @param {string} text
 * @returns {string}
 */
function collapseCarriageReturns(text) {
  // Normalize \r\n to \n first so Windows newlines are preserved
  text = text.replace(/\r\n/g, '\n');
  if (!text.includes('\r') && !text.includes(ERASE_EOL)) return text;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('\r')) continue;
    const segments = lines[i].split('\r');
    const chars = [];
    for (const segment of segments) {
      // Each \r resets cursor to column 0
      let cursor = 0;
      for (const ch of segment) {
        if (ch === ERASE_EOL) {
          // Truncate line from cursor position to end
          chars.length = cursor;
          continue;
        }
        if (cursor < chars.length) {
          chars[cursor] = ch;
        } else {
          chars.push(ch);
        }
        cursor++;
      }
    }
    lines[i] = chars.join('');
  }
  return lines.join('\n');
}

/**
 * Clean terminal output for consumption by AI models.
 * Pipeline: extract erase-in-line semantics → strip ANSI escapes → simulate backspace → collapse \r overwrites → remove control chars.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  // Extract erase-in-line semantics before the general ANSI strip removes them
  let result = applyEraseInLine(text);
  result = result.replace(ANSI_PATTERN, '');
  result = simulateBackspace(result);
  result = collapseCarriageReturns(result);
  result = result.replace(CONTROL_CHAR_PATTERN, '');
  return result;
}
