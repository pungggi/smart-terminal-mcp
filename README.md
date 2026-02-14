# smart-terminal-mcp

A Windows-native MCP server that gives AI agents (Claude, Cursor, etc.) real interactive terminal access via pseudo-terminals ([node-pty](https://github.com/microsoft/node-pty)).

Unlike simple `exec`-based approaches, this provides full PTY sessions with bidirectional communication, enabling interactive CLI tools, real-time output streaming, and proper terminal emulation.

## Features

- **Marker-based completion detection** -- 100% reliable command completion via unique markers injected into the shell
- **Robust command echo removal** -- Pre-command marker ensures clean output, handles shell aliases and expansions correctly
- **Interactive mode** -- `terminal_write` + `terminal_read` for REPLs, prompts, and interactive programs
- **Special key support** -- Send Ctrl+C, Tab, arrow keys, etc. without knowing escape codes
- **Pattern waiting** -- Wait for specific output (e.g. "server listening on port") before continuing
- **CWD tracking** -- Every `terminal_exec` response includes the current working directory
- **Output truncation** -- Large outputs are automatically truncated to head + tail
- **Session management** -- Named sessions, TTL auto-cleanup, max 10 concurrent sessions
- **Anti-blocking** -- Disables pagers (`GIT_PAGER=cat`), progress bars, and sets UTF-8 on Windows
- **Progress notifications** -- Real-time MCP progress updates during long-running commands
- **Shell auto-detection** -- Windows: `pwsh.exe` > `powershell.exe` > `cmd.exe`. Linux/macOS: `$SHELL` or `bash`

## Requirements

- **Node.js** >= 18

`node-pty` ships prebuilt binaries for most platforms. If prebuilds are unavailable for your OS/architecture, a C/C++ toolchain is needed as fallback:

- **Windows**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++")
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `build-essential` and Python 3 (`sudo apt install build-essential python3`)

## Installation

No installation needed — run directly via `npx`:

```bash
npx smart-terminal-mcp
```

Or install globally:

```bash
npm install -g smart-terminal-mcp
```

Or clone for development:

```bash
git clone <repo-url>
cd smart-terminal-mcp
npm install
```

## Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "smart-terminal": {
      "command": "npx",
      "args": ["-y", "smart-terminal-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add smart-terminal -- npx -y smart-terminal-mcp
```

### Cursor

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "smart-terminal": {
      "command": "npx",
      "args": ["-y", "smart-terminal-mcp"]
    }
  }
}
```

To pin a specific version, use `smart-terminal-mcp@1.0.1` instead.

## Tools

### `terminal_start`

Start a new interactive terminal session.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `shell` | string | auto-detected | Shell executable (e.g. `pwsh.exe`, `bash`) |
| `cols` | number | 120 | Terminal width |
| `rows` | number | 30 | Terminal height |
| `cwd` | string | server CWD | Working directory |
| `name` | string | -- | Friendly session name |
| `env` | object | -- | Custom environment variables (e.g. `{ "NODE_ENV": "test" }`) |

**Returns**: `sessionId`, `shell`, `shellType`, `cwd`, `banner`

### `terminal_exec`

Execute a command with deterministic completion detection.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `command` | string | *required* | Command to execute |
| `timeout` | number | 30000 | Timeout in ms (max 10min) |
| `maxLines` | number | 200 | Max output lines before truncation |

**Returns**: `output`, `exitCode`, `cwd`, `timedOut`

### `terminal_write`

Write raw data to a terminal (for interactive programs). Follow with `terminal_read`.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID |
| `data` | string | Data to write (`\r` for Enter, `\t` for Tab) |

### `terminal_read`

Read buffered output with idle detection.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `timeout` | number | 30000 | Hard timeout in ms |
| `idleTimeout` | number | 500 | Return after this many ms of silence |
| `maxLines` | number | 200 | Max output lines |

**Returns**: `output`, `timedOut`

### `terminal_get_history`

Retrieve past terminal output without consuming it. Non-destructive — returns historical output from a rolling buffer (last ~10,000 lines). Useful for reviewing output that was already read or missed.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `offset` | number | 0 | Lines to skip from the end (0 = most recent). Use for pagination. |
| `maxLines` | number | 200 | Max lines to return |

**Returns**: `lines`, `totalLines`, `returnedFrom`, `returnedTo`

### `terminal_send_key`

Send a named special key.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID |
| `key` | string | Key name (see below) |

**Supported keys**: `ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+l`, `ctrl+a`, `ctrl+e`, `ctrl+u`, `ctrl+k`, `ctrl+w`, `tab`, `enter`, `escape`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `backspace`, `delete`, `f1`-`f12`

### `terminal_wait`

Wait for a specific pattern in the output stream.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `pattern` | string | *required* | String or regex pattern |
| `timeout` | number | 30000 | Timeout in ms |

**Returns**: `output`, `matched`, `timedOut`

### `terminal_resize`

Resize terminal dimensions.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID |
| `cols` | number | New width |
| `rows` | number | New height |

### `terminal_stop`

Stop and clean up a terminal session.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID to stop |

### `terminal_list`

List all active terminal sessions with metadata (ID, name, shell, cwd, idle time, alive/busy status).

## Usage Examples

### Run a command

```
terminal_start()                           -> { sessionId: "a1b2c3d4" }
terminal_exec({ sessionId, command: "ls -la" })  -> { output: "...", exitCode: 0, cwd: "/home/user" }
```

### Interactive Python REPL

```
terminal_start({ name: "python" })
terminal_write({ sessionId, data: "python3\r" })
terminal_read({ sessionId })                     -> Python banner
terminal_write({ sessionId, data: "2 + 2\r" })
terminal_read({ sessionId })                     -> "4"
terminal_send_key({ sessionId, key: "ctrl+d" })  -> exit Python
```

### Wait for a server to start

```
terminal_start({ name: "dev-server" })
terminal_write({ sessionId, data: "npm run dev\r" })
terminal_wait({ sessionId, pattern: "listening on port", timeout: 60000 })
```

## Architecture

```
src/
  index.js            Entry point, server bootstrap, graceful shutdown
  tools.js            10 MCP tool registrations with Zod schemas
  pty-session.js      PTY session: marker injection, idle read, buffer mgmt
  session-manager.js  Session lifecycle, TTL cleanup, concurrency limits
  shell-detector.js   Cross-platform shell auto-detection
  ansi.js             ANSI escape code stripping
```

## License

MIT
