use super::protocol::{wrap, FrameParser};
use crate::error::{Result, RunnerError};
use crate::process::SessionControl;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    User,
    Timeout,
}

#[derive(Debug)]
pub struct CommandResult {
    pub code: u32,
    pub stopped: Option<StopReason>,
}

pub struct ShellSession<T> {
    io: T,
    baud_rate: u32,
}

impl<T: AsyncRead + AsyncWrite + Unpin> ShellSession<T> {
    pub fn new(io: T, baud_rate: u32) -> Self {
        Self { io, baud_rate }
    }

    /// The only bytes accepted as completion are our exact framed exit marker.
    /// In particular, seeing '#' or '$' is never evidence that the process has exited.
    pub async fn execute(
        &mut self,
        command: &str,
        dimensions: Option<(u32, u32)>,
        timeout: Option<Duration>,
        controls: &mut mpsc::UnboundedReceiver<SessionControl>,
        mut output: impl FnMut(Vec<u8>),
        mut state: impl FnMut(&'static str),
    ) -> Result<CommandResult> {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let mut pending = wrap(command, &nonce, dimensions).into_bytes();
        if pending.split(|b| *b == b'\n').any(|line| line.len() > 2048) {
            return Err(RunnerError::InvalidInput("serial shell command line exceeds 2048 bytes; use a script file for long commands or arguments".into()));
        }
        let mut offset = 0;
        let mut submitted = false;
        let mut queued_input = Vec::new();
        let mut canceled_before_submit = false;
        let mut parser = FrameParser::new(&nonce);
        let transmission = pending.len() as u64 * 12 / u64::from(self.baud_rate.max(1));
        let mut deadline = Some(Instant::now() + Duration::from_secs(10 + transmission));
        let mut stopped = None;
        let mut controls_open = true;
        let mut read_buf = [0u8; 4096];
        let (mut reader, mut writer) = tokio::io::split(&mut self.io);
        loop {
            let timer = async {
                match deadline {
                    Some(when) => tokio::time::sleep_until(when).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                control = controls.recv(), if controls_open => {
                    match control {
                        Some(SessionControl::Input(data)) if stopped.is_none() => {
                            if queued_input.len() + pending.len() - offset + data.len() > 64 * 1024 {
                                return Err(RunnerError::Serial("pending input exceeds 64 KiB".into()));
                            }
                            if submitted && parser.started {
                                pending.drain(..offset);
                                offset = 0;
                                pending.extend(data);
                            } else {
                                queued_input.extend(data);
                            }
                        }
                        Some(SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill) | None => {
                            if control.is_none() { controls_open = false; }
                            if stopped.is_none() {
                                state("stopping");
                                stopped = Some(StopReason::User);
                                canceled_before_submit = !submitted;
                                pending = if submitted { vec![3] } else { vec![3, b'\n'] };
                                offset = 0;
                                deadline = Some(Instant::now() + Duration::from_secs(5));
                            }
                        }
                        // Serial shell cannot resize the running program via a separate channel.
                        _ => {}
                    }
                }
                result = writer.write(&pending[offset..pending.len().min(offset + 128)]), if offset < pending.len() => {
                    let n = result.map_err(|e| RunnerError::Serial(format!("write failed: {e}")))?;
                    if n == 0 { return Err(RunnerError::Serial("port closed during write".into())); }
                    offset += n;
                    if offset == pending.len() {
                        if canceled_before_submit {
                            return Ok(CommandResult { code: 130, stopped });
                        }
                        submitted = true;
                        pending.clear(); offset = 0;
                        if parser.started && !queued_input.is_empty() {
                            pending.extend(std::mem::take(&mut queued_input));
                        }
                    }
                }
                result = reader.read(&mut read_buf) => {
                    let n = result.map_err(|e| RunnerError::Serial(format!("read failed: {e}")))?;
                    if n == 0 { return Err(RunnerError::Serial("port disconnected before an exit marker; remote process state is unknown".into())); }
                    let was_started = parser.started;
                    let data = parser.push(&read_buf[..n])?;
                    if !was_started && parser.started {
                        if stopped.is_none() { state("running"); }
                        if stopped.is_none() { deadline = timeout.map(|d| Instant::now() + d); }
                        if submitted && !queued_input.is_empty() {
                            pending.extend(std::mem::take(&mut queued_input));
                        }
                    }
                    if !data.is_empty() { output(data); }
                    if let Some(code) = parser.code { return Ok(CommandResult { code, stopped }); }
                }
                _ = timer => {
                    if stopped.is_some() {
                        return Err(RunnerError::Serial("stop was not confirmed within 5s; remote process may still be running".into()));
                    }
                    if !parser.started {
                        // Do not send a login name, password or additional shell commands blindly.
                        let _ = tokio::time::timeout(Duration::from_secs(1), writer.write_all(&[3])).await;
                        return Err(RunnerError::Serial("no shell response within 10s; check baud rate and ensure the serial console is already logged into a Linux shell".into()));
                    }
                    stopped = Some(StopReason::Timeout);
                    state("stopping");
                    pending = vec![3]; offset = 0;
                    deadline = Some(Instant::now() + Duration::from_secs(5));
                }
            }
        }
    }
}
