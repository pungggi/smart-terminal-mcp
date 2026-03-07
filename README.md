# smart-terminal-mcp

A PTY-based MCP server with strong Windows support, giving MCP-capable AI clients and their agents persistent, interactive shell access via pseudo-terminals ([node-pty](https://github.com/microsoft/node-pty)).

Unlike simple `exec`-based approaches, this keeps PTY-backed shell sessions alive across steps, with bidirectional communication for interactive CLI tools, incremental reads, and session state that carries forward.

## Why use this instead of your AI client's built-in terminal?

Install this if you want a more consistent terminal workflow across AI clients, instead of relying on whatever built-in terminal behavior a single client happens to provide.

This MCP is most useful when you want:

- **Portable workflow across clients** -- The same terminal tools and habits work across Claude Code, Cursor, Trae, Antigravity, and other MCP-capable clients.
- **Reusable prompts and tooling** -- Workflows built around tools like `terminal_wait`, `terminal_retry`, `terminal_run_paged`, and `terminal_get_history` are easier to reuse across teams and clients, with less lock-in to one client's terminal behavior.
- **Persistent terminal state** -- Keep the same shell session alive across steps, including the current folder, environment, and running processes.
- **Better interactive behavior** -- Handle prompts, REPLs, dev servers, Ctrl+C, arrow keys, and other interactive terminal behavior.
- **More control over large output** -- Truncate, page, diff, retry, wait for patterns, or fetch history instead of dumping everything at once.
- **More predictable automation** -- Use deterministic completion markers instead of guessing when a command is done.

If your AI client already provides a stable, stateful, interactive terminal with good output handling, you may not need this MCP for basic command execution. The main reason to add it is to make terminal-driven workflows more explicit, reusable, and portable across clients.

## Features

Think of this as a **controlled keyboard + terminal for an agent running inside an MCP client**. It opens a persistent PTY-backed shell session so the agent can send commands and keystrokes, read output, and continue working in the same session.

### Core terminal features

- **Interactive terminal sessions** -- Keeps a persistent PTY-backed shell session open so the agent can send input, read output, and pick up where it left off.
- **Deterministic command completion** -- `terminal_exec` uses unique markers so it can tell when a command has finished.
- **Clean output** -- Pre-command markers help keep returned output readable, even when shells echo commands or expand aliases.
- **Working directory tracking** -- `terminal_exec` reports the current folder after each command.

### Long output and long-running commands

- **Interactive reads and writes** -- `terminal_write` + `terminal_read` support prompts, REPLs, and other interactive programs without leaving the current session.
- **Pattern waiting** -- `terminal_wait` can pause until specific text appears, such as `server listening on port`.
- **Retry helper** -- `terminal_retry` can re-run flaky commands with bounded backoff and optional output matching.
- **Best-effort progress notifications** -- Long `terminal_exec` / `terminal_wait` calls can emit `notifications/progress` when the client provides a progress token.
- **Output truncation** -- `terminal_exec` and `terminal_read` shorten very large output by returning the beginning and the end.
- **Paged read-only output** -- `terminal_run_paged` returns large read-only output one page at a time instead of sending the full result at once.
- **Output diffing** -- `terminal_diff` compares two command results and returns a unified diff.

### Safety and usability

- **Safer one-shot commands** -- `terminal_run` executes binaries directly with `cmd + args` and `shell=false` for more predictable automation.
- **Structured parsers** -- Some supported read-only commands can return both raw text and parsed output.
- **Blocking mitigations** -- Disables pagers (`GIT_PAGER=cat`, `PAGER=cat`), suppresses PowerShell progress output, and sets UTF-8 for `cmd.exe` on Windows.
- **Special key support** -- Can send Ctrl+C, Tab, arrow keys, and similar keys without manually constructing escape sequences.
- **Session management** -- Supports named sessions, idle cleanup, and up to 10 concurrent sessions.
- **Shell auto-detection** -- Windows: `pwsh.exe` > `powershell.exe` > `cmd.exe`. Linux/macOS: `$SHELL` > `bash` > `sh`.

Progress notifications are not the same as full stdout streaming. They currently send periodic status updates for `terminal_exec` and `terminal_wait`, usually based on elapsed time and the latest output line. Whether you see them depends on your MCP client.

## Token efficiency

This MCP does not magically compress terminal output, but it **can help agents use fewer tokens in terminal-heavy workflows** by returning smaller, more targeted responses and making it easier to revisit output only when needed.

The main benefit is **model-context efficiency**, not guaranteed savings in the underlying command's runtime or total bytes produced.

- Use **`terminal_run_paged`** for large read-only output when **the agent** wants one page of the returned result at a time.
- Lower **`maxLines`**, **`pageSize`**, or **`tailLines`** when **the agent** only needs a narrow slice of the output.
- Use **`summary: true`** or **`parseOnly: true`** with `terminal_run` when **the agent** benefits more from structured results than raw text.
- Use **`terminal_wait({ returnMode: "match-only" })`** when the agent only needs to know whether a pattern appeared.
- Use **`terminal_get_history`** when **the agent** needs to revisit earlier output without re-dumping the whole session into the conversation.

In practice, this lets agents inspect terminal state more selectively instead of repeatedly dumping large logs back into the conversation.

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

Run a one-shot non-interactive command using `cmd + args` with `shell=false`. Safer than `terminal_exec` for predictable automation. Output is capped by `maxOutputBytes` rather than head + tail truncation. Shell built-ins such as `dir` or `cd` are not supported. On Windows, `terminal_run` resolves `PATH`/`PATHEXT` and launches `.cmd` / `.bat` wrappers via `cmd.exe` when needed. Prefer passing the target executable directly as `cmd` instead of wrapping it in `powershell -Command` or `cmd /c`, especially when Windows paths contain spaces.

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

Run a read-only one-shot command using `cmd + args` with `shell=false` and return a single page of stdout lines from the captured output. This pages the returned result instead of using head + tail truncation. Paged mode does not parse partial output, but it can return a concise summary for supported read-only commands when `summary: true`.

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

These defaults favor agent usability while still allowing tool callers to lower `maxLines` or `pageSize` explicitly when they want tighter responses.

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

For Windows tools installed under `Program Files`, prefer this shape over `powershell -Command`:

```
terminal_run({ cmd: "C:\\Program Files\\Vendor\\Tool.exe", args: ["/flag:value", "/other"] })
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
