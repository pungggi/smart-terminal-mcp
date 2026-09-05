# Changelog

All notable changes to this project will be documented in this file.

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
