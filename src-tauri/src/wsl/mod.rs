//! Direct local WSL transport. No network socket, SSH server, or credentials.
pub mod filesync;

use crate::device::WslConfig;
use crate::error::{Result, RunnerError};
use crate::process::{OutputStream, SessionControl};
use crate::runner::{build_script, RunRequest};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::mpsc,
};

const HELPER: &str = include_str!("helper.py");
const FRAME_LIMIT: usize = 128 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(30);

pub enum Event {
    State(&'static str),
    Output { stream: OutputStream, data: Vec<u8> },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StopReason {
    User,
    Timeout,
}

pub struct Outcome {
    pub code: Option<u32>,
    pub stopped: Option<StopReason>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Message {
    Ready {
        version: u32,
        info: String,
    },
    Ack,
    Started,
    Output {
        stream: String,
        data: String,
    },
    Exit {
        code: Option<u32>,
        stopped: Option<StopReason>,
    },
    Error {
        message: String,
    },
}

fn failure(message: impl Into<String>) -> RunnerError {
    RunnerError::Wsl(message.into())
}

fn wsl_command() -> Result<Command> {
    #[cfg(windows)]
    {
        // Use the system binary, never an executable found in the workspace.
        let root =
            std::env::var_os("SystemRoot").ok_or_else(|| failure("SystemRoot is unavailable"))?;
        let mut command = Command::new(std::path::PathBuf::from(root).join("System32/wsl.exe"));
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        command.kill_on_drop(true);
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        Err(failure("direct WSL targets are supported on Windows only"))
    }
}

fn helper_command(config: &WslConfig) -> Result<Command> {
    config.validate()?;
    let mut command = wsl_command()?;
    command.arg("--distribution").arg(&config.distribution);
    if !config.user.is_empty() {
        command.arg("--user").arg(&config.user);
    }
    command
        .args(["--cd", "~", "--exec", "python3", "-I", "-u", "-c"])
        .arg(HELPER);
    Ok(command)
}

fn decode_wsl_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().any(|&b| b == 0) {
        let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
        String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string()
    }
}

pub async fn list_distributions() -> Result<Vec<String>> {
    let mut command = wsl_command()?;
    command.args(["--list", "--quiet"]).stdin(Stdio::null());
    let output = tokio::time::timeout(IO_TIMEOUT, command.output())
        .await
        .map_err(|_| failure("listing WSL distributions timed out"))??;
    if !output.status.success() {
        return Err(failure(format!(
            "cannot list WSL distributions: {} {}",
            decode_wsl_text(&output.stdout),
            decode_wsl_text(&output.stderr)
        )));
    }
    Ok(decode_wsl_text(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect())
}

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    buffer: Vec<u8>,
    diagnostics: Arc<parking_lot::Mutex<Vec<u8>>>,
    stderr_task: tokio::task::JoinHandle<()>,
    info: String,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stderr_task.abort();
    }
}

impl Bridge {
    async fn launch(mut command: Command) -> Result<Self> {
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                failure(format!(
                    "cannot start WSL (requires an installed distribution and python3): {e}"
                ))
            })?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let diagnostics = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let captured = diagnostics.clone();
        let stderr_task = tokio::spawn(async move {
            let mut chunk = [0; 4096];
            while let Ok(n) = stderr.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let mut data = captured.lock();
                let keep = n.min(16384_usize.saturating_sub(data.len()));
                data.extend_from_slice(&chunk[..keep]);
            }
        });
        let mut bridge = Self {
            child,
            stdin,
            stdout,
            buffer: Vec::new(),
            diagnostics,
            stderr_task,
            info: String::new(),
        };
        match tokio::time::timeout(IO_TIMEOUT, bridge.next())
            .await
            .map_err(|_| failure("WSL startup timed out"))??
        {
            Message::Ready { version: 1, info } => bridge.info = info,
            _ => return Err(failure("unsupported WSL helper handshake")),
        }
        Ok(bridge)
    }

    async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| failure(e.to_string()))?;
        if bytes.len() > FRAME_LIMIT {
            return Err(failure("WSL request exceeds 128 KiB"));
        }
        bytes.push(b'\n');
        tokio::time::timeout(IO_TIMEOUT, self.stdin.write_all(&bytes))
            .await
            .map_err(|_| failure("WSL control write timed out"))??;
        Ok(())
    }

    async fn next(&mut self) -> Result<Message> {
        loop {
            if let Some(end) = self.buffer.iter().position(|&b| b == b'\n') {
                let line: Vec<_> = self.buffer.drain(..=end).collect();
                let message: Message = serde_json::from_slice(&line).map_err(|_| {
                    failure(format!(
                        "invalid WSL helper response (check python3): {}",
                        decode_wsl_text(&line)
                    ))
                })?;
                return match message {
                    Message::Error { message } => Err(failure(message)),
                    other => Ok(other),
                };
            }
            let mut chunk = [0; 8192];
            let n = self.stdout.read(&mut chunk).await?;
            if n == 0 {
                // Give the stderr drain a chance to collect the startup diagnostic.
                tokio::task::yield_now().await;
                return Err(failure(format!(
                    "WSL helper closed without a completion message: {} {}",
                    decode_wsl_text(&self.buffer),
                    decode_wsl_text(&self.diagnostics.lock())
                )));
            }
            self.buffer.extend_from_slice(&chunk[..n]);
            if self.buffer.len() > FRAME_LIMIT {
                return Err(failure("WSL response exceeds 128 KiB"));
            }
        }
    }

    async fn request(&mut self, value: Value) -> Result<()> {
        self.send(value).await?;
        match tokio::time::timeout(IO_TIMEOUT, self.next())
            .await
            .map_err(|_| failure("WSL upload acknowledgement timed out"))??
        {
            Message::Ack => Ok(()),
            _ => Err(failure("unexpected WSL upload response")),
        }
    }

    async fn wait(&mut self) -> Result<()> {
        let status = tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .map_err(|_| failure("WSL helper did not shut down"))??;
        if !status.success() {
            return Err(failure(format!(
                "WSL helper failed: {}",
                decode_wsl_text(&self.diagnostics.lock())
            )));
        }
        Ok(())
    }
}

pub async fn test_device(config: &WslConfig) -> Result<String> {
    let mut bridge = Bridge::launch(helper_command(config)?).await?;
    let info = format!("WSL {}: {}", config.distribution, bridge.info);
    bridge.send(json!({"type":"shutdown"})).await?;
    bridge.wait().await?;
    Ok(info)
}

pub async fn execute(
    config: &WslConfig,
    req: &RunRequest,
    remote: &str,
    files: Vec<filesync::Entry>,
    controls: &mut mpsc::UnboundedReceiver<SessionControl>,
    emit: impl FnMut(Event),
) -> Result<Outcome> {
    execute_with_command(helper_command(config)?, req, remote, files, controls, emit).await
}

async fn execute_with_command(
    command: Command,
    req: &RunRequest,
    remote: &str,
    files: Vec<filesync::Entry>,
    controls: &mut mpsc::UnboundedReceiver<SessionControl>,
    mut emit: impl FnMut(Event),
) -> Result<Outcome> {
    let canceled = || Outcome {
        code: None,
        stopped: Some(StopReason::User),
    };
    let launch = Bridge::launch(command);
    tokio::pin!(launch);
    let mut bridge = loop {
        tokio::select! {
            biased;
            Some(control) = controls.recv() => if matches!(control, SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill) { return Ok(canceled()); },
            result = &mut launch => break result?,
        }
    };
    if req.workspace_dir.is_some() {
        emit(Event::State("syncing"));
    }
    let prepare = async {
        // The helper already changes directory using its verified directory fd.
        // Avoid resolving the workspace path again from shell code.
        let mut script_req = req.clone();
        script_req.workspace_dir = None;
        bridge
            .request(
                json!({"type":"init", "remote":req.workspace_dir.as_ref().map(|_| remote),
            "command":build_script(&script_req, remote), "mode":req.console_mode,
            "cols":req.cols, "rows":req.rows, "timeout":req.timeout_secs}),
            )
            .await?;
        for entry in files {
            if let Some(data) = entry.data {
                bridge
                    .request(json!({"type":"file", "path":entry.path, "mode":entry.mode}))
                    .await?;
                for chunk in data.chunks(48 * 1024) {
                    bridge
                        .request(json!({"type":"chunk", "data":STANDARD.encode(chunk)}))
                        .await?;
                }
                bridge.request(json!({"type":"end"})).await?;
            } else {
                bridge
                    .request(json!({"type":"directory", "path":entry.path}))
                    .await?;
            }
        }
        Ok::<_, RunnerError>(())
    };
    {
        tokio::pin!(prepare);
        loop {
            tokio::select! {
                biased;
                Some(control) = controls.recv() => if matches!(control, SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill) { return Ok(canceled()); },
                result = &mut prepare => { result?; break; },
            }
        }
    }
    emit(Event::State("starting"));
    bridge.send(json!({"type":"start"})).await?;
    let mut deadline = Some(tokio::time::Instant::now() + IO_TIMEOUT);
    let mut stopping = false;
    let mut started = false;
    loop {
        let watchdog = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            Some(control) = controls.recv() => match control {
                SessionControl::Input(data) if !stopping => {
                    for chunk in data.chunks(16 * 1024) { bridge.send(json!({"type":"input", "data":STANDARD.encode(chunk)})).await?; }
                }
                SessionControl::Resize { cols, rows } => {
                    if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 { return Err(failure("invalid terminal dimensions")); }
                    bridge.send(json!({"type":"resize", "cols":cols, "rows":rows})).await?;
                }
                SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill if !stopping => {
                    stopping = true;
                    deadline = Some(tokio::time::Instant::now() + Duration::from_secs(15));
                    emit(Event::State("stopping"));
                    bridge.send(json!({"type":"stop"})).await?;
                }
                _ => {}
            },
            _ = watchdog => return Err(failure("WSL did not confirm startup or termination")),
            message = bridge.next() => match message? {
                Message::Started if !started => {
                    started = true;
                    if !stopping {
                        // Also bound a broken helper when a run has a timeout.
                        deadline = if req.timeout_secs > 0 { Some(tokio::time::Instant::now() + Duration::from_secs(req.timeout_secs + 15)) } else { None };
                        emit(Event::State("running"));
                    }
                }
                Message::Output { stream, data } => {
                    let stream = match stream.as_str() { "stdout" => OutputStream::Stdout, "stderr" => OutputStream::Stderr, _ => return Err(failure("invalid output stream")) };
                    let data = STANDARD.decode(data).map_err(|_| failure("invalid output bytes"))?;
                    emit(Event::Output { stream, data });
                }
                Message::Exit { code, stopped } if started && code.is_some() => {
                    bridge.wait().await?;
                    return Ok(Outcome { code, stopped });
                }
                _ => return Err(failure("unexpected WSL execution response")),
            }
        }
    }
}

#[cfg(test)]
mod tests;
