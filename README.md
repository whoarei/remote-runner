# Remote Runner

Remote Runner is a Tauri desktop tool for running scripts and commands on embedded Linux devices. It provides a small local workspace UI, an xterm console, run status/history, and a single runner API shared by the React frontend and Rust backend.

## Current status

| Capability | Status |
|---|---|
| SSH execution | Implemented |
| SSH PTY / pipe console | Implemented |
| SFTP workspace upload | Implemented |
| Serial Shell V1 | Implemented |
| Serial Agent protocol | Planned |
| Node.js, venv, managed runtimes | Planned |
| Artifact download and editor write-back | Planned |

## Features

- Python, Shell, and arbitrary command execution.
- SSH authentication with key/agent or password, host-key trust checks, SFTP upload, interactive stdin, PTY resize, stop escalation, and history persistence.
- Serial Shell V1 with Windows COM and Unix tty ports, configurable baud rate, 8N1/no flow control, nonce-framed completion, text workspace upload, stdin, Ctrl+C, and timeout reporting.
- Binary-safe output events: Rust sends base64 encoded bytes and the frontend renders them in xterm.js.

## Requirements

- Node.js and npm.
- Rust toolchain with Cargo.
- Tauri desktop prerequisites for the host operating system (on Windows, WebView2 and the usual C++/WebView tooling).
- For SSH runs: a reachable Linux device and supported authentication.
- For serial runs: a serial adapter/device whose console is already logged into a Linux shell. The application does not perform serial login or password negotiation.

## Run locally

Install frontend dependencies and start the Tauri development app:

```powershell
npm install
npm run tauri dev
```

The frontend-only Vite server can be started with `npm run dev`, but device commands require the Tauri backend.

## Use a device

1. Add an SSH or Serial device in the device bar.
2. Select a local workspace and choose a Python/Shell entry file or command mode.
3. Click **Run** and use the console for output and interactive input.

Serial device settings are port and baud rate. Serial uses 8 data bits, no parity, 1 stop bit, and no flow control. Its console output is a single combined stream; dimensions are set when the command starts and runtime resize is unavailable.

Serial workspace synchronization is deliberately conservative: UTF-8 text files only, up to 1 MiB per file and 8 MiB per workspace. Symbolic links, special files, redirected paths, NUL bytes, and `.git`/`.hg`/`.svn` directories are rejected or skipped according to the V1 rules.

Uploads use acknowledged chunks of up to 3 KiB, with at most 1024 files/directories. Generated shell wrappers are checked before opening the port (16 KiB per wrapper, 2048 bytes per physical line, no literal terminal control characters except newline). Put complex commands in uploaded scripts. Stop clears queued input and requires a remote completion marker once any bytes have been sent; an unconfirmed stop reports unknown remote state. Serial Shell shares the login shell's input channel and cannot fully isolate input racing with process exit; see the serial design notes below.

## Validation

```powershell
npm test
npm run build

cd src-tauri
cargo fmt --all -- --check
cargo test --offline --all-targets
```

Serial tests use simulated duplex streams and a local shell because this repository does not have a physical serial device available. SSH integration tests use a local simulated server and do not require a user SSH host.

## Documentation

- [Design](docs/00001_20260908_embedded-linux-remote-script-runner-design.md)
- [Implementation progress](docs/00002_20260908_implementation-progress.md)
- [Code review](docs/00003_20260908_code-review.md)
- [Serial Shell V1](docs/00004_20260908_serial-shell.md)
