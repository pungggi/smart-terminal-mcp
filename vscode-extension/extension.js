'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vscode = require('vscode');

const PROVIDER_ID = 'smart-terminal.mcpServer';
const SERVER_LABEL = 'Smart Terminal';

/** Path of the esbuild-bundled MCP server (dist/server.mjs, node-pty kept external). */
function bundledServerEntry(extensionUri) {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'server.mjs').fsPath;
}

/** node-pty 1.1.0 ships N-API prebuilds for win32/darwin only; Linux compiles from source. */
function hasBundledPtyPrebuild(extensionUri) {
  const nm = ['node_modules'];
  const candidates = [
    vscode.Uri.joinPath(extensionUri, ...nm, 'node-pty', 'prebuilds').fsPath,
    vscode.Uri.joinPath(extensionUri, ...nm, 'smart-terminal-mcp', ...nm, 'node-pty', 'prebuilds').fsPath,
  ];
  return candidates.some((dir) => fs.existsSync(path.join(dir, `${process.platform}-${process.arch}`)));
}

/** Best-effort check for a system Node.js (used for the npx fallback on Linux). */
function hasSystemNode() {
  try {
    const probe = spawnSync('node', ['--version'], { timeout: 5000, windowsHide: true });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function serverEnv() {
  const env = {};
  const disabledTools = vscode.workspace
    .getConfiguration('smartTerminalMcp')
    .get('disabledTools');
  if (typeof disabledTools === 'string' && disabledTools.length > 0) {
    env.SMART_TERMINAL_DISABLED_TOOLS = disabledTools;
  }
  return env;
}

function activate(context) {
  const version = String(context.extension.packageJSON.version || '0.0.0');
  const entry = bundledServerEntry(context.extensionUri);
  const bundledRuntimeWorks = hasBundledPtyPrebuild(context.extensionUri);

  let command = process.execPath;
  let args = [entry];
  let env = { ELECTRON_RUN_AS_NODE: '1' };

  if (!bundledRuntimeWorks) {
    // Linux: node-pty has no prebuild in the VSIX. Fall back to the published npm
    // package via npx, which compiles node-pty locally (requires build tools).
    if (hasSystemNode()) {
      command = 'npx';
      args = ['-y', 'smart-terminal-mcp@stable'];
      env = {};
      vscode.window.showInformationMessage(
        'Smart Terminal MCP: running via npx on this platform (node-pty is compiled locally).'
      );
    } else {
      vscode.window.showWarningMessage(
        'Smart Terminal MCP needs Node.js installed (node + build tools) on this platform because node-pty has no prebuilt binary for it.'
      );
    }
  }

  const provider = vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
    provideMcpServerDefinitions() {
      return [
        new vscode.McpStdioServerDefinition(
          SERVER_LABEL,
          command,
          args,
          { ...env, ...serverEnv() },
          version
        ),
      ];
    },
    resolveMcpServerDefinition(definition) {
      return definition;
    },
  });

  context.subscriptions.push(provider);
}

function deactivate() {}

module.exports = { activate, deactivate };
