# Changelog

All notable changes to this project will be documented in this file.

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
