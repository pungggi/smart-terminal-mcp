const LOG_PREFIX = '[smart-terminal-mcp]';

/**
 * Write a diagnostic line to stderr.
 * stdout is reserved for the MCP stdio transport, so all logs go to stderr.
 * @param {string} message
 */
export function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}
