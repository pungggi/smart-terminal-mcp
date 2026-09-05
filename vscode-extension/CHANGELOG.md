# Changelog

All notable changes to the Smart Terminal MCP VS Code extension are documented here.

## [Unreleased]

- Bundled the MCP server with esbuild into `dist/server.mjs` (node-pty kept external as a trimmed runtime dependency): VSIX shrinks from 1981 files / 17.9 MB to 42 files / 2.6 MB, no debug symbols shipped.

## 1.2.39

- Initial release: wraps `smart-terminal-mcp@1.2.39` as a VS Code extension.
- Registers the stdio MCP server through `vscode.lm.registerMcpServerDefinitionProvider`.
- Runs the bundled server with VS Code's runtime (`ELECTRON_RUN_AS_NODE`) — no system Node.js needed on Windows/macOS.
- Linux fallback: runs the published npm package via `npx` and compiles `node-pty` locally.
- `smartTerminalMcp.disabledTools` setting to control tool registration (mirrors `SMART_TERMINAL_DISABLED_TOOLS`).
