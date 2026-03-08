import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';

const SERVER_URL = 'http://127.0.0.1:3456';
const READY_TEXT = 'MCP HTTP scan server';
const SERVER_CARD_PATH = new URL('../server-card.json', import.meta.url);

function startScanServer() {
  const child = spawn(process.execPath, ['scripts/http-scan-server.js'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for: ${READY_TEXT}`)), 10_000);
    child.stdout.on('data', () => {
      if (stdout.includes(READY_TEXT)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`HTTP scan server exited early with code ${code}`));
    });
  });

  return { child, ready };
}

async function stopScanServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await once(child, 'exit');
}

async function withServerCard() {
  const original = await readFile(SERVER_CARD_PATH, 'utf8').catch(() => null);
  if (original !== null) return () => writeFile(SERVER_CARD_PATH, original);

  await writeFile(SERVER_CARD_PATH, JSON.stringify({
    serverInfo: { name: 'smart-terminal-mcp', version: 'test' },
    tools: [],
    resources: [],
    prompts: [],
  }));

  return () => rm(SERVER_CARD_PATH, { force: true });
}

test('HTTP scan server returns 400 for invalid MCP JSON', async (t) => {
  const restoreServerCard = await withServerCard();
  t.after(async () => restoreServerCard());

  const { child, ready } = startScanServer();
  await ready;
  t.after(async () => stopScanServer(child));

  const response = await fetch(`${SERVER_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    jsonrpc: '2.0',
    error: { code: -32700, message: 'Invalid JSON body.' },
    id: null,
  });

  const health = await fetch(`${SERVER_URL}/.well-known/mcp/server-card.json`);
  assert.equal(health.status, 200);
});