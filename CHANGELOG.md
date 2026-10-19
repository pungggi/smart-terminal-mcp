# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **`terminal_job` wait action**: `action: "wait"` blocks until the background job exits (or a timeout) and returns the final exit code plus an output tail. MCP servers cannot push completion notifications to the client, so this replaces sleep-and-poll loops with a single tool call.
- **Byte cap on `terminal_exec`**: new `maxOutputBytes` parameter (default 128 KB) caps total PTY output at line boundaries with a head/notice/tail split. `maxLines` alone could not stop a single multi-megabyte line (minified bundle, base64 blob) from flooding the agent context.
- **Per-line character cap**: output lines longer than 2000 chars are truncated to head + tail with an explicit `[line truncated, N chars]` notice.
- **`description` audit field**: `terminal_exec` and `terminal_run` accept an optional `description` stating why the command is run; when present it is written to the server's stderr log next to the command, giving session logs an intent trail.
- **Multi-line here-string/heredoc guard**: `terminal_exec` now rejects PowerShell here-strings (`@'...'@`) and POSIX heredocs (`<<EOF`) up front. The PTY feeds the shell line by line, so a pasted here-string gets mangled (an eaten `@'` opener turns every apostrophe in the body into a string delimiter), and a heredoc never terminates at all because the completion markers land on the closing-delimiter line. Both used to hang the session until the timeout; the error now says exactly what to do instead (write the payload to a file with `terminal_write_file`, then `--body-file` / `< file` / `Get-Content -Raw`). `terminal_run` is unaffected: it spawns a one-shot process with no markers, where heredocs work.
- **Continuation-prompt hints**: when a command does not complete and the shell is sitting at a continuation prompt (`>>` in PowerShell, `>` in POSIX shells, `More?` in cmd.exe), the timeout hint now says so — unterminated statement, send the closing line with `terminal_write` or abort with `terminal_send_key("ctrl+c")` — instead of the generic "command is still running" message that sent agents diagnosing the wrong problem.

### Fixed
- **PowerShell stale exit codes**: the wrapper reported raw `$LASTEXITCODE`, which is only set by native executables. A cmdlet run after a failed native command inherited the stale code (success reported as failure), and a failed cmdlet after a successful native command reported success. The wrapper now clears `$LASTEXITCODE` before the command and derives the reported code from `$?`, covering both native and cmdlet commands.
- **cmd.exe stale markers**: cmd expands `%ERRORLEVEL%`/`%CD%` at parse time of the whole line, so a single-line `&` chain reported the PREVIOUS command's exit code and working directory. The wrapper now writes the marker line after the command line; cmd parses it only after the command finishes, so both values are fresh.
- **Windows PTY handle leak on kill**: node-pty's winpty path never releases its pipe sockets or conout worker thread when a session is killed (the ConPTY path does). Every `terminal_stop` leaked handles that kept the event loop alive; a long-lived MCP server would accumulate them indefinitely. `PtySession.kill()` now explicitly destroys the sockets and disposes the conout worker, so stopped sessions fully release.


## [1.2.40] - 2026-10-11

### Added
- **Background Jobs Tool**: Added `terminal_run_background` and `terminal_job` MCP tools for managing long-running detached processes (like `npm run dev`) natively via `child_process.spawn`. This frees up PTY session slots and avoids locking the session "busy", allowing agents to start servers and continue other work in parallel. Background output is routed to in-memory buffers and rotating disk logs.

### Fixed
- **Windows Zombie Processes**: Implemented cross-platform process tree killing (`taskkill /T /F` on Windows) for PTY sessions. This ensures that web servers and scripts launched inside a PowerShell PTY do not become permanently orphaned zombies (which block ports) when the session is closed.
- **Regex CPU Thrashing**: Replaced O(n²) string building and full-buffer regex matching in `waitForPattern` with an O(n) chunked stream incremental matcher. This prevents Node.js event loop blocks and CPU thrashing when processing massive output streams. Added support for evaluating multi-line `^`/`$` anchor semantics per-chunk.
- **`terminal_wait` matched the input echo (#12)**: `waitForPattern` scanned the session's retained buffer including the PTY's input echo, so any pattern also present in the submitted command line (notably smart-terminal-mcp's own `__MCP_PRE_`/`__MCP_DONE_` completion markers, which appear mid-line in the echoed wrapped command) matched instantly before the command produced output. Waiting now anchors at the stream end by default — only output produced after the call matches — and accepts an explicit `since` char position (same units as `terminal_read`'s `position`) to scan retained history from a caller-chosen point. The result additionally returns the current `position` for chaining. Two follow-ups from review: a `since` beyond the current stream end is honored as a future cursor (live data before it is skipped, sliced exactly at the char boundary), and input written via `terminal_write`/`exec` whose echo has not arrived yet is masked content-wise (`consumeEchoPrefix`: ordered, whitespace-insensitive, releases on first mismatch and after 5 s), so a delayed echo can no longer satisfy a pattern either.

## [1.2.39] - 2026-09-05

### Fixed
- **`terminal_exec` marker race on echoed commands**: the PTY echoes the wrapped command, which contains the completion marker literal mid-line. The old substring match (`buffer.includes(marker)`) could resolve on the echo before the command even ran, returning empty output with `exitCode: null`. Marker detection is now line-anchored (the real marker is always a standalone line) and scanned incrementally.
- **pwsh exit codes for cmdlet-only commands**: `echo` (Write-Output) never sets `$LASTEXITCODE`, so the marker expanded with an empty exit code and never matched. The marker matcher and `_parseOutput` now accept empty exit codes (`\d*`); exit code is `null` for such commands, numeric for native executables.
- **Prompt leak in `terminal_exec` output**: the interactive shell prompt printed after the CWD marker was captured as command output. Parsing now stops at the CWD marker (always the last wrapper line).

## [1.2.36] - 2026-04-30

### Added
- **Process group kill**: `terminal_stop` now kills the entire process group on Unix (via `kill(-pid)`), preventing orphan child processes when stopping sessions that spawned subprocess trees (e.g. `npm run dev` → webpack → esbuild). Windows behavior unchanged.
- **Incremental reads with `since`**: `terminal_read` accepts an optional `since` byte position and returns only output emitted since that position, along with the current `position`. Agents polling build logs or long-running processes can now read incrementally instead of re-reading the full buffer every poll. Reduces token usage by up to ~87% on repeated polling.
- **`terminal_watch` tool**: New event-driven monitoring tool that waits for regex/literal trigger matches in session output. Supports multiple triggers with per-trigger cooldowns, quiet detection (auto-return when output stops), process exit detection, context lines, and `since` filtering. Replaces manual poll loops — reduces token usage by up to ~99% for log-watching workflows. Available via `terminal_extra` by default.
- **Quiet-exit on `terminal_exec`**: New `quietExitMs` and `minOutputBytes` parameters let agents return early when a long-running command (e.g. `npm run dev`) stops producing output, instead of waiting for a hard timeout. Session stays busy so the agent can read incrementally. Reduces token usage by up to ~94% for dev-server commands.
- **Snapshot and transcript on `terminal_stop`**: `terminal_stop` now accepts `snapshotLines` (return last N lines in response) and `transcriptPath` (write full session history to disk before stopping). Transcript write failure safely prevents session termination.
- **Human-readable session IDs**: Sessions now get memorable IDs like `calm-reef` or `brisk-falcon` instead of hex fragments like `a1b2c3d4`. Easier to read in logs and agent references.

### Changed
- `terminal_read` now always includes a `position` field in the response (monotonic byte counter).
- `terminal_stop` accepts optional `snapshotLines` and `transcriptPath` parameters.

## [1.2.35] - 2026-04-26

### Added
- **`terminal_extra` meta-tool**: Convenience tools (`terminal_run_paged`, `terminal_retry`, `terminal_diff`, `terminal_resize`, `terminal_send_key`, `terminal_get_history`, `terminal_write_file`) are now collected behind a single lightweight meta-tool by default, reducing tool definition token overhead by ~50%. The agent can discover schemas via `list: true` and call any extra tool through `terminal_extra`.
- **`SMART_TERMINAL_DISABLED_TOOLS` env var**: Customize which tools are moved behind `terminal_extra`. Set to empty string to register all 15 tools with full schemas.

### Changed
- Stripped redundant `.describe()` calls from tool parameter schemas where the parameter name is self-documenting (e.g. `sessionId`, `command`, `cwd`, `timeout`). Keeps only 6 essential descriptions for non-obvious parameters.

### Fixed
- Fixed `pty-session` to properly track pending markers and allow smooth interruption of background commands.
- Handled `/mcp` POST parsing and transport errors gracefully in `http-scan-server` to avoid crashes.
- Fixed `terminal_start` test that expected auto-detect hint when no shell was explicitly provided.

## [1.2.12] - 2026-03-08

### Added
- Implemented a session manager with shell detection and robust CWD (Current Working Directory) validation.
- Added a robust command runner utility with output parsing, limits, timeouts, and success checks.

### Changed
- Stripped ANSI sequences, carriage-return animations, and control characters from PTY output to save tokens and improve readability for AI models.
- Added handling for C1 8-bit OSC sequences (`0x9D`) in ANSI stripping.
- Processed erase-in-line (EL) sequences before ANSI stripping to properly truncate lines and prevent partial character overwrites.

### Fixed
- Fixed a sentinel leak where standalone `ERASE_EOL` sequences appearing without a preceding carriage return were missed.

## [1.2.11] - 2026-03-07

### Changed
- Improved CWD validation and startup error handling for the `terminal_start` tool.

## [1.2.10] - 2026-03-07

### Added
- Added `successExitCode` and `successFilePattern` checks to the `terminal_run` tool to assert successful execution.
