# smart-terminal-mcp

A PTY-based MCP server with strong Windows support that gives AI agents (Claude, Cursor, etc.) interactive terminal access via pseudo-terminals ([node-pty](https://github.com/microsoft/node-pty)).

Unlike simple `exec`-based approaches, this provides full PTY sessions with bidirectional communication, enabling interactive CLI tools, incremental terminal reads, and PTY-backed terminal behavior.

## Features

- **Marker-based completion detection** -- Deterministic command completion via unique markers injected into the shell
- **Robust command echo removal** -- Pre-command marker helps keep output clean even with shell aliases and expansions
- **Interactive mode** -- `terminal_write` + `terminal_read` for REPLs, prompts, and interactive programs
- **Safer one-shot commands** -- `terminal_run` executes real binaries with `cmd + args` and `shell=false`
- **Structured parsers** -- Supported read-only commands can return both `stdout.raw` and `stdout.parsed`
- **Paged read-only output** -- `terminal_run_paged` returns a single page of stdout for large command output
- **Special key support** -- Send Ctrl+C, Tab, arrow keys, etc. without knowing escape codes
- **Pattern waiting** -- Wait for specific output (e.g. "server listening on port") before continuing
- **Retry helper** -- Retry flaky terminal commands with bounded backoff and optional output matching
- **Output diffing** -- Run two commands in one session and compare their outputs with a unified diff
- **CWD tracking** -- Every `terminal_exec` response includes the current working directory
- **Output truncation** -- `terminal_exec` and `terminal_read` truncate large outputs to head + tail
- **Session management** -- Named sessions, TTL auto-cleanup, max 10 concurrent sessions
- **Blocking mitigations** -- Disables pagers (`GIT_PAGER=cat`, `PAGER=cat`), suppresses PowerShell progress output, and sets UTF-8 for `cmd.exe` on Windows
- **Best-effort progress notifications** -- Emits MCP `notifications/progress` for long-running `terminal_exec` / `terminal_wait` calls when the client provides a progress token and surfaces those notifications
- **Shell auto-detection** -- Windows: `pwsh.exe` > `powershell.exe` > `cmd.exe`. Linux/macOS: `$SHELL` > `bash` > `sh`

Progress notifications are not the same as full stdout streaming: they currently send periodic status updates for `terminal_exec` and `terminal_wait`, typically based on elapsed time and the latest output line. Whether you actually see them depends on your MCP client.

## Installation

Recommended: run the stable release directly via `npx`:

```bash
npx smart-terminal-mcp@stable
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
      "args": ["-y", "smart-terminal-mcp@stable"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add smart-terminal -- npx -y smart-terminal-mcp@stable
```

### Augment Code

Add to your Augment MCP settings:

```json
{
  "mcpServers": {
    "Smart Terminal": {
      "command": "npx",
      "args": [
        "smart-terminal-mcp@stable"
      ]
    }
  }
}
```

If you want to pin an exact release instead of following the stable tag, replace `@stable` with a version such as `@1.0.1`.

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

Execute a command with deterministic completion detection. Large outputs are truncated to head + tail based on `maxLines`. If the MCP client sends a `progressToken`, long-running calls may also emit best-effort `notifications/progress` updates.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `command` | string | *required* | Command to execute |
| `timeout` | number | 30000 | Timeout in ms (max 10min) |
| `maxLines` | number | 200 | Max output lines before truncation |

**Returns**: `output`, `exitCode`, `cwd`, `timedOut`

### `terminal_run`

Run a one-shot non-interactive command using `cmd + args` with `shell=false`. Safer than `terminal_exec` for predictable automation. Output is capped by `maxOutputBytes` rather than head + tail truncation. Shell built-ins such as `dir` or `cd` are not supported. On Windows, `terminal_run` resolves `PATH`/`PATHEXT` and launches `.cmd` / `.bat` wrappers via `cmd.exe` when needed.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `cmd` | string | *required* | Executable to run |
| `args` | string[] | `[]` | Argument array passed directly to the executable |
| `cwd` | string | server CWD | Working directory |
| `timeout` | number | 30000 | Timeout in ms |
| `maxOutputBytes` | number | 102400 | Max combined stdout/stderr bytes to capture |
| `parse` | boolean | `true` | Attempt structured parsing for supported commands |
| `parseOnly` | boolean | `false` | Drop raw stdout if parsed |
| `summary` | boolean | `false` | Return a concise summary when supported |

**Returns**: `ok`, `cmd`, `args`, `cwd`, `exitCode`, `timedOut`, `durationMs`, `stdout.raw`, `stdout.parsed`, optional `stdout.summary`, `stderr.raw`, optional `hint`

### `terminal_run_paged`

Run a read-only one-shot command using `cmd + args` with `shell=false` and return a single page of stdout lines. This uses paging rather than head + tail truncation. Paged mode does not parse partial output, but it can return a concise summary for supported read-only commands when `summary: true`.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `cmd` | string | *required* | Read-only executable to run |
| `args` | string[] | `[]` | Argument array passed directly to the executable |
| `cwd` | string | server CWD | Working directory |
| `timeout` | number | 30000 | Timeout in ms |
| `maxOutputBytes` | number | 102400 | Max combined stdout/stderr bytes to capture |
| `page` | number | 0 | 0-indexed page number |
| `pageSize` | number | 100 | Lines per page |
| `summary` | boolean | `false` | Return a concise summary when supported |

**Returns**: Same envelope as `terminal_run`, plus `pageInfo.page`, `pageInfo.pageSize`, `pageInfo.totalLines`, `pageInfo.hasNext`

### `terminal_write`

Write raw data to a terminal (for interactive programs). Follow with `terminal_read`.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID |
| `data` | string | Data to write (`\r` for Enter, `\t` for Tab) |

### `terminal_read`

Read buffered output with idle detection. Large outputs are truncated to head + tail based on `maxLines`.

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
| `format` | string | `"lines"` | Response format: `lines` or `text` |

**Returns**: `lines` or `text`, plus `totalLines`, `returnedFrom`, `returnedTo`

These defaults favor agent usability while still allowing callers to lower `maxLines` or `pageSize` explicitly when they want tighter responses.

### `terminal_send_key`

Send a named special key.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID |
| `key` | string | Key name (see below) |

**Supported keys**: `ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+l`, `ctrl+a`, `ctrl+e`, `ctrl+u`, `ctrl+k`, `ctrl+w`, `tab`, `enter`, `escape`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `backspace`, `delete`, `f1`-`f12`

### `terminal_wait`

Wait for a specific pattern in the output stream. By default, responses return only the last `tailLines`; use `returnMode: "full"` for the full matched output or `"match-only"` to suppress output entirely. If the MCP client sends a `progressToken`, long-running waits may also emit best-effort `notifications/progress` updates.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `pattern` | string | *required* | String or regex pattern |
| `timeout` | number | 30000 | Timeout in ms |
| `returnMode` | string | `"tail"` | Response mode: `tail`, `full`, `match-only` |
| `tailLines` | number | 50 | Number of tail lines to return |

**Returns**: `output`, `matched`, `timedOut` (`output` may be empty in `match-only` mode)

### `terminal_retry`

Retry a command in the same terminal session until it succeeds or retries are exhausted.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `command` | string | *required* | Command to execute |
| `maxRetries` | number | 3 | Retry count after the first attempt |
| `backoff` | string | `"exponential"` | Backoff mode: `fixed`, `linear`, `exponential` |
| `delayMs` | number | 1000 | Base delay in ms |
| `timeout` | number | 30000 | Timeout per attempt in ms |
| `maxLines` | number | 200 | Max output lines per attempt |
| `successExitCode` | number or `null` | 0 | Exit code required for success |
| `successPattern` | string or `null` | `null` | Optional regex that must match output |

**Returns**: `success`, `attempts`, `lastResult`, `history`

### `terminal_diff`

Run two commands in the same terminal session and return a bounded unified diff of their outputs.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `commandA` | string | *required* | Baseline command |
| `commandB` | string | *required* | Comparison command |
| `timeout` | number | 30000 | Timeout per command in ms |
| `maxLines` | number | 200 | Max output lines per command |
| `contextLines` | number | 3 | Diff context lines |

**Returns**: `resultA`, `resultB`, `diff`, `identical`

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

### `terminal_write_file`

Write content directly to a file on disk. Resolves paths relative to the session's CWD. Safer and more robust than piping content through `echo` — handles special characters, newlines, and large files correctly.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID (used to resolve working directory) |
| `path` | string | *required* | File path (relative to session CWD, or absolute) |
| `content` | string | *required* | File content to write |
| `encoding` | string | `"utf-8"` | File encoding (`utf-8`, `ascii`, `base64`, `hex`, `latin1`) |
| `append` | boolean | `false` | Append to file instead of overwriting |

**Returns**: `success`, `path` (absolute), `size` (bytes), `append`

### `terminal_list`

List all active terminal sessions.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `verbose` | boolean | `true` | Include full metadata |

**Returns**: `sessions`, `count` (`verbose: false` returns `id`, `name`, `cwd`, `alive`, `busy` only)

## Usage Examples

### Run a command

```
terminal_start()                           -> { sessionId: "a1b2c3d4" }
terminal_exec({ sessionId, command: "ls -la" })  -> { output: "...", exitCode: 0, cwd: "/home/user" }
```

### Run a safe one-shot command

```
terminal_run({ cmd: "git", args: ["status", "--porcelain=v1", "--branch"] })
-> { ok: true, stdout: { raw: "...", parsed: { branch: {...}, staged: [], modified: [], untracked: [] } } }
```

### Page through large read-only output

```
terminal_run_paged({ cmd: "git", args: ["log", "--oneline"], page: 0, pageSize: 100 })
-> { ok: true, stdout: { raw: "...", parsed: null }, pageInfo: { totalLines: 120, hasNext: true } }
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
terminal_wait({ sessionId, pattern: "listening on port", returnMode: "full" })
```

### Retry a flaky command

```
terminal_retry({ sessionId, command: "npm test", maxRetries: 2, backoff: "fixed", delayMs: 1000 })
-> { success: true, attempts: 2, lastResult: { output: "...", exitCode: 0, cwd: "...", timedOut: false } }
```

### Diff two command outputs

```
terminal_diff({ sessionId, commandA: "git show HEAD~1:README.md", commandB: "type README.md" })
-> { identical: false, diff: "--- git show HEAD~1:README.md\n+++ type README.md\n@@ @@\n..." }
```

## Architecture

```
src/
  index.js            Entry point, server bootstrap, graceful shutdown
  tools.js            MCP tool registrations with Zod schemas
  command-runner.js   One-shot non-interactive command execution (shell=false)
  command-parsers.js  Structured parsers for supported read-only commands
  pager.js            Line-based pagination helper for large stdout
  pty-session.js      PTY session: marker injection, idle read, buffer mgmt
  smart-tools.js      Retry and diff helpers for higher-level terminal tools
  regex-utils.js      Shared user-regex validation and compilation
  session-manager.js  Session lifecycle, TTL cleanup, concurrency limits
  shell-detector.js   Cross-platform shell auto-detection
  ansi.js             ANSI escape code stripping
```

### Structured parser support

`terminal_run` currently parses a small set of read-only command signatures:

- `git log --oneline`
- `git log --oneline -n <count>`
- `git status --porcelain=v1 --branch`
- `git status --short --branch`
- `git status --short`
- `git branch`
- `git branch --all` / `git branch --remotes`
- `git branch -vv`
- `git branch --show-current`
- `git rev-parse --abbrev-ref HEAD`
- `git rev-parse --show-toplevel`
- `git rev-parse --is-inside-work-tree`
- `git diff --name-only`
- `git diff --name-status`
- `git diff --stat`
- `git diff --shortstat`
- `git ls-files`
- `git remote -v`
- `tasklist /fo csv /nh`
- `where <name>` / `which <name>`

Set `parseOnly: true` to omit `stdout.raw` when a supported parser succeeds. Unsupported commands still return `stdout.raw`; `stdout.parsed` is `null`.

Set `summary: true` to return `stdout.summary` and suppress `stdout.raw` for supported command signatures. If no summary is available, raw stdout is preserved.

`terminal_run_paged` supports `summary: true` for read-only commands: `git` (`branch`, `diff`, `log`, `ls-files`, `remote`, `rev-parse`, `status`), `tasklist`, `where`, and `which`.

When parsing was requested but no parser matched, `terminal_run` may include a short `hint` for parser-worthy command signatures with larger raw output:
- currently limited to `git` plus `where` / `which`
- only when the command succeeds and `stdout.raw` is large enough to be worth suggesting
- wording: `Structured parser unavailable for this command signature. If you need this often, propose one.`

## License

MIT
