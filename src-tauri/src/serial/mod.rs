pub mod filesync;
pub mod protocol;
pub mod session;
#[cfg(test)]
mod tests;
pub mod transport;

use crate::device::DeviceProfile;
use crate::error::{Result, RunnerError};
use crate::process::SessionControl;
use crate::runner::{build_script, sh_quote, RunRequest, ScriptKind};
use session::{CommandResult, ShellSession};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

pub use session::StopReason;

pub enum Event {
    State(&'static str),
    Output(Vec<u8>),
}

pub async fn test_device(device: &DeviceProfile) -> Result<String> {
    device.validate()?;
    let config = device
        .serial
        .as_ref()
        .ok_or_else(|| RunnerError::InvalidInput("serial configuration is required".into()))?;
    let _lease = transport::PortLease::acquire(&config.port)?;
    let mut session = ShellSession::new(transport::open(config)?, config.baud_rate);
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let mut output = Vec::new();
    let result = session
        .execute(
            "command -v sh >/dev/null && command -v stty >/dev/null && command -v base64 >/dev/null && uname -a",
            None,
            Some(Duration::from_secs(5)),
            &mut rx,
            |data| {
                output.extend(
                    data.into_iter()
                        .take(64 * 1024 - output.len().min(64 * 1024)),
                )
            },
            |_| {},
        )
        .await?;
    if result.code != 0 || result.stopped.is_some() {
        return Err(RunnerError::Serial("serial shell probe failed".into()));
    }
    Ok(format!(
        "Serial shell ready ({} baud, 8N1)\n{}",
        config.baud_rate,
        String::from_utf8_lossy(&output)
    ))
}

/// Generic stream executor so the full protocol can be verified with a simulated device.
pub async fn execute<T: AsyncRead + AsyncWrite + Unpin>(
    io: T,
    baud_rate: u32,
    req: &RunRequest,
    remote: &str,
    files: Vec<filesync::UploadEntry>,
    controls: &mut mpsc::UnboundedReceiver<SessionControl>,
    events: impl Fn(Event),
) -> Result<CommandResult> {
    let mut session = ShellSession::new(io, baud_rate);
    let runtime_probe = match &req.kind {
        ScriptKind::Python => " && command -v python3 >/dev/null",
        ScriptKind::Shell => " && command -v bash >/dev/null",
        ScriptKind::Command => "",
    };
    let probe_command = format!(
        "command -v sh >/dev/null && command -v stty >/dev/null && command -v base64 >/dev/null{runtime_probe}"
    );
    let probe = session
        .execute(
            &probe_command,
            None,
            Some(Duration::from_secs(5)),
            controls,
            |_| {},
            |_| {},
        )
        .await?;
    if probe.stopped == Some(StopReason::Timeout) {
        return Err(RunnerError::Serial(
            "serial capability probe timed out".into(),
        ));
    }
    if probe.stopped.is_some() {
        return Ok(probe);
    }
    if probe.code != 0 {
        return Err(RunnerError::Serial(
            "serial shell is missing a required command (sh, stty, base64, or the selected runtime)".into(),
        ));
    }

    if req.workspace_dir.is_some() {
        events(Event::State("syncing"));
        let mkdir = session
            .execute(
                &format!("mkdir -p {}", sh_quote(remote)),
                None,
                Some(Duration::from_secs(10)),
                controls,
                |_| {},
                |_| {},
            )
            .await?;
        if mkdir.stopped == Some(StopReason::Timeout) {
            return Err(RunnerError::Serial(
                "workspace preparation timed out".into(),
            ));
        }
        if mkdir.stopped.is_some() {
            return Ok(mkdir);
        }
        if mkdir.code != 0 {
            return Err(RunnerError::Serial("cannot create remote workspace".into()));
        }
        for file in files {
            let result = session
                .execute(
                    &file.command(remote),
                    None,
                    Some(Duration::from_secs(30)),
                    controls,
                    |_| {},
                    |_| {},
                )
                .await?;
            if result.stopped == Some(StopReason::Timeout) {
                return Err(RunnerError::Serial(format!(
                    "upload timed out: {}",
                    file.path()
                )));
            }
            if result.stopped.is_some() {
                return Ok(result);
            }
            if result.code != 0 {
                return Err(RunnerError::Serial(format!(
                    "upload failed: {}",
                    file.path()
                )));
            }
        }
    }
    events(Event::State("starting"));
    let command = build_script(req, remote);
    session
        .execute(
            &command,
            Some((req.cols, req.rows)),
            (req.timeout_secs > 0).then(|| Duration::from_secs(req.timeout_secs)),
            controls,
            |data| events(Event::Output(data)),
            |state| events(Event::State(state)),
        )
        .await
}
