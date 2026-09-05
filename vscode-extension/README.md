# Smart Terminal MCP for VS Code

**Real, persistent terminal access for VS Code agent mode.**

This extension wraps [smart-terminal-mcp](https://github.com/pungggi/smart-terminal-mcp) — a PTY-based Model Context Protocol server built on [node-pty](https://github.com/microsoft/node-pty) — and registers it with VS Code's native MCP support.

Unlike simple `exec`-based approaches, the agent gets **interactive shell sessions that stay alive across steps**: bidirectional communication for interactive CLI tools, incremental output reads, session state that carries forward between tool calls.

## Features

- 🖥️ **Persistent PTY sessions** — start a shell, write to it, read output incrementally, keep state across agent steps
- 🔁 **Interactive CLI support** — answer prompts, send keystrokes, resize terminals (`terminal_send_key`, `terminal_resize`)
- 🧠 **Smart helpers** — retry with backoff (`terminal_retry`), command output diffing (`terminal_diff`), paged read-only commands (`terminal_run_paged`)
- 📉 **Low token overhead** — by default 8 core tools register full schemas; 7 convenience tools are available on demand through the `terminal_extra` meta-tool
- 🪟 **Strong Windows support** — ConPTY/Windows Terminal integration via node-pty prebuilt binaries; nothing to compile on Windows or macOS
- 🔌 **Zero-config** — the MCP server ships inside the extension and starts automatically; no `mcp.json` editing, no separate Node.js install required on Windows/macOS

## Requirements

- VS Code **desktop** 1.103+ (Insiders or Stable)
- Agent mode / Copilot Chat for the tools to be used
- **Windows / macOS:** nothing else — the extension runs the server with VS Code's own runtime and bundled `node-pty` binaries.
- **Linux:** `node-pty` has no prebuilt binary in the extension; the server runs via `npx` and compiles it locally, which needs Node.js plus a C++ toolchain (`make`, `g++`, `python3`).

## Getting started

1. Install the extension from the Marketplace.
2. Open **Chat → Agent mode**.
3. The server appears under MCP: run **MCP: List Servers** → **Smart Terminal** to inspect or restart it. Tools are toggled from the tools picker in the chat input.
4. Ask the agent to do something terminal-shaped, e.g.:

   > Start a terminal session, run the tests, and tell me which ones failed.

## Tools

Core tools registered with full schemas:

| Tool | Purpose |
| --- | --- |
| `terminal_start` | Start a new interactive terminal session |
| `terminal_exec` | Run a command in a session and capture output |
| `terminal_run` | One-shot non-interactive command execution |
| `terminal_read` | Incremental read of new session output |
| `terminal_write` | Write raw input to a session (answer prompts, send keys) |
| `terminal_wait` | Wait for a pattern to appear in session output |
| `terminal_stop` | Stop a session |
| `terminal_list` | List active sessions |

Extra tools available through `terminal_extra` (see [the server README](https://github.com/pungggi/smart-terminal-mcp#tools)):

`terminal_run_paged`, `terminal_retry`, `terminal_diff`, `terminal_resize`, `terminal_send_key`, `terminal_get_history`, `terminal_write_file`, `terminal_watch`

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `smartTerminalMcp.disabledTools` | *(the 8 convenience tools)* | Comma-separated tool names to move behind the `terminal_extra` meta-tool. Set to an empty string to register all 15 tools with full schemas. |

## Security notice

This extension gives the AI agent the ability to run **arbitrary commands in a real shell** on your machine. VS Code asks for confirmation before each tool runs unless a tool is marked read-only — review invocations carefully.

## Credits

Server: [smart-terminal-mcp](https://github.com/pungggi/smart-terminal-mcp) (MIT) · PTY layer: [node-pty](https://github.com/microsoft/node-pty) (MIT)

## Feedback & issues

Please report issues on [GitHub](https://github.com/pungggi/smart-terminal-mcp/issues).

## Development & publishing

The extension lives in [`vscode-extension/`](../vscode-extension) of the server repo and mirrors the MQL Clangd publishing workflow:

```bash
cd vscode-extension
npm run build                  # sync version -> install -> vsce package (local VSIX)
node scripts/publish.js vsce   # publish to the VS Code Marketplace
node scripts/publish.js ovsx   # publish to Open VSX
```

Credentials are read from `vscode-extension/.vscode/.env.json` (gitignored):

```json
{ "VSCE_PAT": "...", "OVSX_PAT": "..." }
```

`scripts/prepublish.js` pins the bundled `smart-terminal-mcp` dependency to the version in the repo root `package.json`, installs it, and verifies the bundled node-pty prebuilds before `vsce` reads `package.json`.
