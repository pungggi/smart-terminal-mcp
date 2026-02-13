// ANSI escape code stripping utility

// Matches all common ANSI escape sequences:
// - CSI sequences: ESC [ ... <final byte>
// - OSC sequences: ESC ] ... (ST | BEL)
// - Simple escapes: ESC followed by single char
// - C1 control codes
const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*|[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g'
);

/**
 * Strip ANSI escape codes from a string.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}
