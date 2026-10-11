# smart-terminal-mcp
[![Smithery](https://img.shields.io/badge/Smithery-smart--terminal-blue)](https://smithery.ai/server/pungggi/smart-terminal)
[![Official Registry](https://img.shields.io/badge/MCP-Official--Registry-green)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.pungggi/smart-terminal)

A PTY-based MCP server with strong Windows support, giving MCP-capable AI clients and their agents persistent, interactive shell access via pseudo-terminals ([node-pty](https://github.com/microsoft/node-pty)).

Unlike simple `exec`-based approaches, this keeps PTY-backed shell sessions alive across steps, with bidirectional communication for interactive CLI tools, incremental reads, and session state that carries forward.

See the [Changelog](CHANGELOG.md) for recent updates.
## Why use this instead of your AI client's built-in terminal?

Install this if you want a more consistent terminal workflow across AI clients, instead of relying on whatever built-in terminal behavior a single client happens to provide.

This MCP is most useful when you want:

- **Portable workflow across clients** -- The same terminal tools and habits work across Claude Code, Cursor, Trae, Antigravity, and other MCP-capable clients.
- **Reusable prompts and tooling** -- Workflows built around tools like `terminal_wait`, `terminal_retry`, `terminal_run_paged`, and `terminal_get_history` are easier to reuse across teams and clients, with less lock-in to one client's terminal behavior.
- **Persistent terminal state** -- Keep the same shell session alive across steps, including the current folder, environment, and running processes.
- **Better interactive behavior** -- Safely handle tools that expect TTY behavior—such as `vim`, `npm` prompts, or interactive installers that often hang on standard piped stdin. Support full interactive sessions with REPLs, Ctrl+C, arrow keys, and dynamic prompts.
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
- **Incremental reads** -- `terminal_read` accepts a `since` byte position to return only new output since the last read, avoiding re-reading the full buffer on every poll.
- **Pattern waiting** -- `terminal_wait` can pause until specific text appears, such as `server listening on port`.
- **Event-driven monitoring** -- `terminal_watch` waits for trigger patterns in session output, returning only on match, quiet, timeout, or exit. Eliminates poll-loop token waste.
- **Quiet-exit detection** -- `terminal_exec` can return early when output goes silent (`quietExitMs`), instead of waiting for a hard timeout.
- **Retry helper** -- `terminal_retry` can re-run flaky commands with bounded backoff and optional output matching.
- **Best-effort progress notifications** -- Long `terminal_exec` / `terminal_wait` calls can emit `notifications/progress` when the client provides a progress token.
- **Output truncation** -- `terminal_exec` and `terminal_read` shorten very large output by returning the beginning and the end.
- **Paged read-only output** -- `terminal_run_paged` returns large read-only output one page at a time instead of sending the full result at once.
- **Output diffing** -- `terminal_diff` compares two command results and returns a unified diff.
- **Session snapshots** -- `terminal_stop` can capture a tail snapshot or write a full transcript to disk before stopping.

### Safety and usability

- **Safer one-shot commands** -- `terminal_run` executes binaries directly with `cmd + args` and `shell=false` for more predictable automation.
- **Structured parsers** -- Some supported read-only commands can return both raw text and parsed output.
- **Blocking mitigations** -- Disables pagers (`GIT_PAGER=cat`, `PAGER=cat`), suppresses PowerShell progress output, and sets UTF-8 for `cmd.exe` on Windows.
- **Special key support** -- Can send Ctrl+C, Tab, arrow keys, and similar keys without manually constructing escape sequences.
- **Process group cleanup** -- `terminal_stop` kills the entire process group on Unix, preventing orphan child processes.
- **Session management** -- Supports named sessions, idle cleanup, and up to 10 concurrent sessions. Session IDs are human-readable (e.g. `calm-reef`).
- **Shell auto-detection** -- Windows: `pwsh.exe` > `powershell.exe` > `cmd.exe`. Linux/macOS: `$SHELL` > `bash` > `sh`.

Progress notifications are not the same as full stdout streaming. They currently send periodic status updates for `terminal_exec` and `terminal_wait`, usually based on elapsed time and the latest output line. Whether you see them depends on your MCP client.

## Token efficiency

This MCP does not magically compress terminal output, but it **can help agents use fewer tokens in terminal-heavy workflows** by returning smaller, more targeted responses and making it easier to revisit output only when needed.

The main benefit is **model-context efficiency**, not guaranteed savings in the underlying command's runtime or total bytes produced.

### Polling and long-running processes

- Use **`terminal_read({ since })`** to read incrementally. Each call returns only new output since the last `position`, instead of re-reading the full buffer. Reduces token usage by up to ~87% on repeated polling.
- Use **`terminal_watch`** instead of a manual poll loop when waiting for a specific pattern. A single call returns on match, quiet, timeout, or exit — reduces token usage by up to ~99% for log-watching workflows.
- Use **`terminal_exec({ quietExitMs })`** for long-running commands (dev servers, watchers) that never produce a completion marker. Returns early when output stops, instead of waiting for a hard timeout. Reduces token usage by up to ~94%.

### Output size control

- Use **`terminal_run_paged`** for large read-only output when **the agent** wants one page of the returned result at a time.
- Lower **`maxLines`**, **`pageSize`**, or **`tailLines`** when **the agent** only needs a narrow slice of the output.
- Use **`summary: true`** or **`parseOnly: true`** with `terminal_run` when **the agent** benefits more from structured results than raw text.
- Use **`terminal_wait({ returnMode: "match-only" })`** when the agent only needs to know whether a pattern appeared.
- Use **`terminal_get_history`** when **the agent** needs to revisit earlier output without re-dumping the whole session into the conversation.
- Use **`terminal_stop({ transcriptPath })`** to offload large session history to disk instead of returning it in the response.

In practice, this lets agents inspect terminal state more selectively instead of repeatedly dumping large logs back into the conversation.

### Reducing tool definition overhead

By default, the 8 most-used tools are registered with full schemas and 8 convenience tools are collected behind a single lightweight `terminal_extra` meta-tool (~30 tokens instead of ~1,700).

**Default core tools**: `terminal_start`, `terminal_exec`, `terminal_run`, `terminal_read`, `terminal_write`, `terminal_wait`, `terminal_stop`, `terminal_list`

**Default extra tools** (behind `terminal_extra`): `terminal_run_paged`, `terminal_retry`, `terminal_diff`, `terminal_resize`, `terminal_send_key`, `terminal_get_history`, `terminal_write_file`, `terminal_watch`

Extra tools are **not hidden** — the agent sees the tool names in the `terminal_extra` description and can:

- **Discover schemas**: `terminal_extra({ list: true })` → returns full parameter schemas
- **Call any extra tool**: `terminal_extra({ tool: "terminal_resize", args: { sessionId: "...", cols: 200, rows: 50 } })`

Use `SMART_TERMINAL_DISABLED_TOOLS` to customize which tools are extra, or set it to an empty string to register all 15 tools with full schemas:

**All tools with full schemas** (no meta-tool):

```json
{
  "mcpServers": {
    "smart-terminal": {
      "command": "npx",
      "args": ["-y", "smart-terminal-mcp@stable"],
      "env": { "SMART_TERMINAL_DISABLED_TOOLS": "" }
    }
  }
}
```

**Minimal setup** — only `terminal_exec` for simple command execution:

```json
"env": {
  "SMART_TERMINAL_DISABLED_TOOLS": "terminal_run,terminal_run_paged,terminal_retry,terminal_diff,terminal_write_file,terminal_resize,terminal_send_key,terminal_get_history,terminal_watch"
}
```

5 core tools + `terminal_extra` holding 9 tools on demand.

**Agent-focused setup** -- `terminal_run` instead of `terminal_exec`:

```json
"env": {
  "SMART_TERMINAL_DISABLED_TOOLS": "terminal_exec,terminal_diff,terminal_retry,terminal_resize,terminal_send_key,terminal_write,terminal_read,terminal_get_history,terminal_watch"
}
```

7 core tools + `terminal_extra` holding 9 tools on demand.

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

By default, 8 core tools are registered with full schemas and 8 convenience tools are available on demand via `terminal_extra` (see [Reducing tool definition overhead](#reducing-tool-definition-overhead)).

### Core tools

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
| `quietExitMs` | number | -- | Return early if output is silent for N ms |
| `minOutputBytes` | number | 1 | Min bytes before quiet detection can trigger |

**Returns**: `output`, `exitCode`, `cwd`, `timedOut`, optional `quietExited`, optional `hint`

### `terminal_run`

Run a one-shot non-interactive command using `cmd + args` with `shell=false`. Safer than `terminal_exec` for predictable automation. Output is capped by `maxOutputBytes` rather than head + tail truncation. Shell built-ins such as `dir` or `cd` are not supported. On Windows, `terminal_run` resolves `PATH`/`PATHEXT` and launches `.cmd` / `.bat` wrappers via `cmd.exe` when needed. Prefer passing the target executable directly as `cmd` instead of wrapping it in `powershell -Command` or `cmd /c`, especially when Windows paths contain spaces. For tools that always exit `0`, you can require a specific exit code and/or validate a success regex against a file written by the command.

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
| `successExitCode` | number or `null` | 0 | Exit code required for success |
| `successFile` | string | -- | Optional file to validate after exit |
| `successFilePattern` | string | -- | Regex that must match `successFile` |

**Returns**: `ok`, `cmd`, `args`, `cwd`, `exitCode`, `timedOut`, `durationMs`, `stdout.raw`, `stdout.parsed`, optional `stdout.summary`, `stderr.raw`, optional `checks`, optional `hint`

### `terminal_write`

Write raw data to a terminal (for interactive programs). Follow with `terminal_read`.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID |
| `data` | string | Data to write (`\r` for Enter, `\t` for Tab) |

### `terminal_read`

Read buffered output with idle detection. Large outputs are truncated to head + tail based on `maxLines`. Pass `since` to read incrementally — returns only output emitted after the given byte position.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `timeout` | number | 30000 | Hard timeout in ms |
| `idleTimeout` | number | 500 | Return after this many ms of silence |
| `maxLines` | number | 200 | Max output lines |
| `since` | number | -- | Byte position from a prior read response |

**Returns**: `output`, `timedOut`, `position`, optional `truncated`

### `terminal_wait`

Wait for a specific pattern in the output stream. Only output produced **after the call** is matched by default — the echoed command line (which contains any pattern you typed, completion markers included) never triggers a match, including an echo that is still streaming in when the wait starts (written input is remembered and masked until its echo arrives or mismatches). Pass `since` (a `position` captured earlier from `terminal_read`/`terminal_wait`/`terminal_watch`) to also scan retained history from that point; a `since` beyond the current stream end acts as a future cursor (live data before it is skipped). By default, responses return only the last `tailLines`; use `returnMode: "full"` for the full matched output or `"match-only"` to suppress output entirely. If the MCP client sends a `progressToken`, long-running waits may also emit best-effort `notifications/progress` updates.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `pattern` | string | *required* | String or regex pattern |
| `timeout` | number | 30000 | Timeout in ms |
| `returnMode` | string | `"tail"` | Response mode: `tail`, `full`, `match-only` |
| `tailLines` | number | 50 | Number of tail lines to return |
| `since` | number | -- | Char position to match after; default is the stream end at call time (a future position is honored once output reaches it) |

**Returns**: `output`, `matched`, `timedOut`, `position` (`output` may be empty in `match-only` mode)

### `terminal_stop`

Stop and clean up a terminal session. Optionally capture a snapshot of recent output or write the full transcript to disk before stopping. On Unix, kills the entire process group to prevent orphan child processes.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID to stop |
| `snapshotLines` | number | 0 | Return last N lines of output (0 = none) |
| `transcriptPath` | string | -- | Write full history to this absolute path |

**Returns**: `success`, `message`, optional `snapshot`, optional `transcript`

### `terminal_list`

List all active terminal sessions.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `verbose` | boolean | `true` | Include full metadata |

**Returns**: `sessions`, `count` (`verbose: false` returns `id`, `name`, `cwd`, `alive`, `busy` only)

### Extra tools (via `terminal_extra`)

The following tools are available by default through the `terminal_extra` meta-tool. The agent can discover their schemas via `terminal_extra({ list: true })` and call them via `terminal_extra({ tool: "<name>", args: { ... } })`.

### `terminal_extra`

Meta-tool for discovering and calling extra tools.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `list` | boolean | `false` | Return full parameter schemas for all extra tools |
| `tool` | string | -- | Name of the extra tool to call |
| `args` | object | -- | Arguments to pass to the extra tool |

### `terminal_send_key`

Send a named special key.

| Param | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID |
| `key` | string | Key name (see below) |

**Supported keys**: `ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+l`, `ctrl+a`, `ctrl+e`, `ctrl+u`, `ctrl+k`, `ctrl+w`, `tab`, `enter`, `escape`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `backspace`, `delete`, `f1`-`f12`

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

### `terminal_get_history`

Retrieve past terminal output without consuming it. Non-destructive — returns historical output from a rolling buffer (last ~10,000 lines). Useful for reviewing output that was already read or missed.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `offset` | number | 0 | Lines to skip from the end (0 = most recent). Use for pagination. |
| `maxLines` | number | 200 | Max lines to return |
| `format` | string | `"lines"` | Response format: `lines` or `text` |

**Returns**: `lines` or `text`, plus `totalLines`, `returnedFrom`, `returnedTo`

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

### `terminal_watch`

Wait for one or more trigger patterns in session output. Returns on first match, quiet detection, timeout, or process exit. Replaces manual poll loops — a single call blocks until an event fires.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionId` | string | *required* | Session ID |
| `triggers` | array | *required* | 1–10 trigger objects (see below) |
| `timeout` | number | 60000 | Hard timeout in ms (max 1hr) |
| `quietExitMs` | number | -- | Return if no output for N ms |
| `contextLines` | number | 3 | Lines of context before match |
| `since` | number | -- | Only match output after this byte position |

**Trigger object**:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | *required* | Label returned in response |
| `pattern` | string | *required* | Regex or literal pattern |
| `isRegex` | boolean | `true` | Set `false` for literal match |
| `cooldownMs` | number | 0 | Min ms between matches for this trigger |

**Returns**: `reason` (`trigger`/`quiet`/`timeout`/`exit`), `position`, `timedOut`, optional `triggerId`, `matchedLine`, `context`

## Usage Examples

### Run a command

```
terminal_start()                           -> { sessionId: "calm-reef" }
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

For compilers that only report success in a log file:

```
terminal_run({
  cmd: "C:\\Program Files\\Vendor\\Tool.exe",
  args: ["/compile:script.mq5", "/log:build.log"],
  successFile: "build.log",
  successFilePattern: "0 error"
})
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

### Watch for build events

```
terminal_extra({ tool: "terminal_watch", args: {
  sessionId,
  triggers: [
    { id: "success", pattern: "webpack: Compiled successfully" },
    { id: "error", pattern: "ERROR in" }
  ],
  timeout: 120000,
  quietExitMs: 10000
}})
-> { reason: "trigger", triggerId: "success", matchedLine: "webpack: Compiled successfully", context: [...], position: 184320 }
```

### Incrementally poll a build log

```
const r1 = terminal_read({ sessionId })           -> { output: "Building...", position: 5000 }
const r2 = terminal_read({ sessionId, since: 5000 }) -> { output: "Done.", position: 5200 }
```

### Quiet-exit a dev server

```
terminal_exec({ sessionId, command: "npm run dev", quietExitMs: 3000, minOutputBytes: 50 })
-> { output: "webpack: Compiled successfully", quietExited: true, hint: "Command is still running..." }
```

### Stop with a transcript

```
terminal_stop({ sessionId, snapshotLines: 20, transcriptPath: "/tmp/session.log" })
-> { success: true, snapshot: { text: "...", lineCount: 20, totalLines: 500 }, transcript: { path: "/tmp/session.log", bytes: 12345 } }
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
  session-id.js       Human-readable session ID generation
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
