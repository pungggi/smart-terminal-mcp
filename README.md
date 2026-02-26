# smart-terminal-mcp

A Windows-native MCP server that gives AI agents (Claude, Cursor, etc.) real interactive terminal access via pseudo-terminals ([node-pty](https://github.com/microsoft/node-pty)).

Unlike simple `exec`-based approaches, this provides full PTY sessions with bidirectional communication, enabling interactive CLI tools, real-time output streaming, and proper terminal emulation.

## Features

- **Marker-based completion detection** -- 100% reliable command completion via unique markers injected into the shell
- **Interactive mode** -- `terminal_write` + `terminal_read` for REPLs, prompts, and interactive programs
- **Special key support** -- Send Ctrl+C, Tab, arrow keys, etc. without knowing escape codes
- **Pattern waiting** -- Wait for specific output (e.g. "server listening on port") before continuing
- **CWD tracking** -- Every `terminal_exec` response includes the current working directory
- **Output truncation** -- Large outputs are automatically truncated to head + tail
- **Session management** -- Named sessions, TTL auto-cleanup, max 10 concurrent sessions
- **Anti-blocking** -- Disables pagers (`GIT_PAGER=cat`), progress bars, and sets UTF-8 on Windows
- **Progress notifications** -- Real-time MCP progress updates during long-running commands
- **Shell auto-detection** -- Windows: `pwsh.exe` > `powershell.exe` > `cmd.exe`. Linux/macOS: `$SHELL` or `bash`
- **Command pipelines** -- Chain multiple commands sequentially with `{{prev_output}}` templating between steps
- **Smart retry** -- Automatic retries with fixed, linear, or exponential backoff and custom success conditions
- **Output diffing** -- Execute two commands and get a unified diff of their outputs
- **Session snapshots** -- Capture and restore full session state (CWD, env vars, shell settings)
- **Terminal multiplexing** -- Run multiple commands in parallel across auto-managed sessions

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

To pin a specific version, use `smart-terminal-mcp@1.1.0` instead.

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

### `terminal_pipeline`

Execute a chain of commands sequentially. Each step can reference the previous step's output via `{{prev_output}}` and `{{prev_exitCode}}` template variables.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `commands` | array | *required* | Ordered list of `{command, timeout?}` objects (max 20) |
| `stopOnError` | boolean | true | Stop pipeline on first non-zero exit code |
| `maxLines` | number | 200 | Max output lines per step |

**Returns**: `steps[]` (per-step results) + `summary` (total, executed, succeeded, failed, stopped)

### `terminal_retry`

Execute a command with automatic retries and configurable backoff strategy.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `command` | string | *required* | Command to execute |
| `maxRetries` | number | 3 | Maximum retry attempts (total attempts = maxRetries + 1) |
| `backoff` | string | `"exponential"` | `"fixed"`, `"exponential"`, or `"linear"` |
| `delayMs` | number | 1000 | Base delay between retries in ms |
| `timeout` | number | 30000 | Timeout per attempt in ms |
| `successExitCode` | number\|null | 0 | Expected exit code (null = ignore) |
| `successPattern` | string\|null | null | Regex that must match output for success |

**Returns**: `success`, `attempts`, `lastResult`, `history[]`

### `terminal_diff`

Execute two commands and compare their outputs with a unified diff.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `commandA` | string | *required* | First command (baseline) |
| `commandB` | string | *required* | Second command (comparison) |
| `timeout` | number | 30000 | Timeout per command in ms |
| `contextLines` | number | 3 | Context lines in diff output |

**Returns**: `resultA`, `resultB`, `diff` (unified diff string), `identical` (boolean)

### `terminal_snapshot`

Capture a snapshot of a session's state (CWD, environment variables, shell config).

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID to snapshot |

**Returns**: `sessionId`, `snapshot` object (cwd, envVars, shell, cols, rows, name, capturedAt)

### `terminal_restore`

Restore a terminal session from a previously captured snapshot. Creates a new session and applies the saved state.

| Param | Type | Description |
|-------|------|-------------|
| `snapshot` | object | Snapshot object from `terminal_snapshot` |

**Returns**: `sessionId` (new), `shell`, `cwd`, `restoredFrom`

### `terminal_multiplex`

Execute multiple commands in parallel, each in its own temporary session. Sessions are auto-cleaned up after execution.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `commands` | array | *required* | List of `{command, name?, cwd?, timeout?}` objects (max 8) |
| `maxLines` | number | 200 | Max output lines per command |

**Returns**: `results[]` (per-command output, exitCode, sessionId) + `summary` (total, succeeded, failed, durationMs)

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

### Build pipeline with dependency chain

```
terminal_pipeline({
  sessionId,
  commands: [
    { command: "npm install" },
    { command: "npm run lint" },
    { command: "npm test" },
    { command: "npm run build", timeout: 120000 }
  ],
  stopOnError: true
})
// -> Stops at first failure, returns per-step results + summary
```

### Retry a flaky network operation

```
terminal_retry({
  sessionId,
  command: "curl -f https://api.example.com/health",
  maxRetries: 5,
  backoff: "exponential",
  delayMs: 2000,
  successExitCode: 0
})
// -> Retries with 2s, 4s, 8s, 16s, 32s delays until success
```

### Compare outputs before/after a change

```
terminal_diff({
  sessionId,
  commandA: "cat config.old.json",
  commandB: "cat config.json",
  contextLines: 3
})
// -> Returns unified diff showing exactly what changed
```

### Snapshot and restore a session

```
terminal_snapshot({ sessionId })
// -> { snapshot: { cwd: "/project", envVars: {...}, ... } }

// Later, or in a new conversation:
terminal_restore({ snapshot: savedSnapshot })
// -> New session with same CWD, env vars, and shell settings
```

### Run tests in parallel

```
terminal_multiplex({
  commands: [
    { command: "npm test -- --shard=1/3", name: "shard-1" },
    { command: "npm test -- --shard=2/3", name: "shard-2" },
    { command: "npm test -- --shard=3/3", name: "shard-3" }
  ]
})
// -> All 3 shards run in parallel, results collected together
```

## Architecture

```
src/
  index.js            Entry point, server bootstrap, graceful shutdown
  tools.js            15 MCP tool registrations with Zod schemas
  pty-session.js      PTY session: marker injection, idle read, buffer mgmt
  session-manager.js  Session lifecycle, TTL cleanup, concurrency limits
  smart-tools.js      Pipeline, retry, diff, snapshot, multiplex logic
  shell-detector.js   Cross-platform shell auto-detection
  ansi.js             ANSI escape code stripping
```

## License

MIT
