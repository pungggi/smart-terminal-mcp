#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SessionManager } from './session-manager.js';
import { registerTools } from './tools.js';

const log = (msg) => process.stderr.write(`[smart-terminal-mcp] ${msg}\n`);

async function main() {
  const server = new McpServer({
    name: 'smart-terminal-mcp',
    version: '1.1.0',
  });

  const manager = new SessionManager();

  registerTools(server, manager);

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down, cleaning up sessions...');
    manager.destroyAll();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => manager.destroyAll());

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('Server started on stdio transport');
}

main().catch((err) => {
  process.stderr.write(`[smart-terminal-mcp] Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
