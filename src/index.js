#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log } from './logger.js';
import { SessionManager } from './session-manager.js';
import { registerTools } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;

export function createSandboxServer() {
  const server = new McpServer({
    name: 'smart-terminal-mcp',
    version,
  });
  const manager = new SessionManager();
  registerTools(server, manager);
  return { server, manager };
}
export default createSandboxServer;

async function main() {
  const manager = new SessionManager();
  const server = new McpServer({
    name: 'smart-terminal-mcp',
    version,
  });
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

// Skip auto-start when imported by Smithery scanner or other bundlers
const scriptPath = (process.argv[1] || '').replace(/\\/g, '/');
const isScanning = Boolean(process.env.SMITHERY_SCAN) || scriptPath.includes('.smithery') || scriptPath.includes('/scan-');

if (!isScanning) {
  main().catch((err) => {
    process.stderr.write(`[smart-terminal-mcp] Fatal: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
