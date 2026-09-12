# Remote Runner agent guide

## Project scope

Remote Runner is a Tauri desktop application for running Python, Shell, and command workloads on embedded Linux devices. The frontend is React/TypeScript; the backend is Rust with Tokio.

The supported transports are:

- **SSH**: SFTP workspace upload, PTY or pipe execution, interactive input, resize, stop escalation, and run history.
- **Serial Shell V1**: `tokio-serial`, 8N1, shell marker framing, UTF-8 text workspace upload, stdin, Ctrl+C, and timeout handling. It assumes the device is already logged into a Linux shell; it does not automate login credentials.
- **WSL**: Windows `wsl.exe` directly starts a bundled Python helper in a selected local distribution, without SSH. Supports binary workspace snapshots, Linux PTY or separate pipes, stdin, resize, process-group stop escalation, and history. Requires Python 3.8+ inside the distribution.

There is no hardware available in the development environment. Serial behavior is verified with Tokio duplex streams and a local POSIX/Git Bash shell.

## Repository map

- `src/`: React UI, API bindings, Zustand state, and xterm console.
- `tests/`: frontend tests, bundled by esbuild and run via `node --test`.
- `src-tauri/src/runner.rs`: request validation, run lifecycle, status/history, and transport dispatch.
- `src-tauri/src/ssh/`: SSH client, SFTP synchronization, and SSH process sessions.
- `src-tauri/src/serial/`: serial port leasing, shell framing, session control, and text workspace upload.
- `src-tauri/src/wsl/`: direct WSL process bridge, bounded workspace snapshots, Python helper, and opt-in WSL integration tests.
- `src-tauri/src/process.rs`: transport-independent console and session control types.
- `src-tauri/src/update.rs`: app self-update — update check against the GitHub `latest.json` manifest, Tauri updater install with minisign verification, installed-vs-portable detection with manual-download fallback (design: `docs/00011_20260912_app-upgrade.md`).
- `docs/`: design, implementation progress, review notes, and serial-shell behavior.
- `scripts/test.mjs`: frontend tests.

## Development commands

Run from the repository root unless noted otherwise:

```powershell
npm install
npm test
npm run build
```

Rust formatting and tests:

```powershell
cd src-tauri
cargo fmt --all -- --check
cargo test --offline --all-targets
```

Start the Tauri application with:

```powershell
npm run tauri dev
```

The `rr-cli` binary is an SSH-only smoke-test tool. It is useful only when an accessible SSH device is available; do not add a hardware dependency to the normal test suite.

WSL integration tests are opt-in and skipped by default. From `src-tauri`:

```powershell
$env:REMOTE_RUNNER_TEST_WSL = 'Ubuntu-24.04' # actual installed distribution name
cargo test --offline --lib wsl::tests -- --include-ignored
```

## Implementation rules

- Do not use Computer Use for this project. Verify changes with code inspection, automated tests, and command-line tools.
- Validate all device and run input at the Rust boundary. Do not rely on frontend validation for safety or path containment.
- Preserve raw output bytes through the backend event boundary. Output events are base64 encoded before reaching the frontend.
- Keep SSH and serial control semantics aligned at the `RunManager` level, while keeping transport-specific protocol code in its own module.
- Serial shell completion must use the nonce marker protocol. Shell prompts, command echo, EOF, or a disconnected port are not successful completion signals.
- Serial V1 uploads UTF-8 text only. Preserve the existing limits and reject symlinks, special files, redirected paths, NUL bytes, and oversized workspaces.
- A serial port is leased before opening and must be released on every success and failure path. Serial uses one combined output stream and cannot resize after launch.
- Do not add tests that require a physical serial device. Extend the duplex-stream simulator and local-shell smoke tests instead.
- Keep documentation in `docs/` synchronized when transport behavior, limits, or unsupported capabilities change.
- WSL must use structured process arguments and a separate control protocol; never interpolate distribution names, users, file contents, or paths into shell commands. Only an explicit helper exit message confirms completion; EOF is a failure. Do not terminate a whole WSL distribution to stop a run.

## Change verification

Before handing off a change, run the relevant Rust tests and frontend tests/build. For serial or runner changes, run the full commands above and check the working tree with `git diff --check`. Report any unavailable hardware validation explicitly.
