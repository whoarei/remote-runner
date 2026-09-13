//! 本机 shell 的独立交互终端：与运行执行共用同一 PTY 会话层。
use super::session::{ChildEvent, Session, SessionSpec};
use super::shells;
use crate::device::LocalConfig;
use crate::error::Result;
use crate::process::ConsoleMode;
use crate::terminal::{canceled, Control, Event as TerminalEvent};
use std::time::Duration;
use tokio::sync::{mpsc, watch};

/// 交互式登录 shell 的启动参数
fn interactive_args(shell: &shells::Shell) -> Vec<String> {
    match shell.flavor {
        shells::Flavor::Posix if shell.login => vec!["-li".into()],
        shells::Flavor::Posix => vec!["-i".into()],
        shells::Flavor::PowerShell => vec!["-NoProfile".into()],
        shells::Flavor::Cmd => Vec::new(),
    }
}

pub async fn execute(
    config: &LocalConfig,
    cols: u32,
    rows: u32,
    controls: &mut mpsc::Receiver<Control>,
    cancel: &mut watch::Receiver<bool>,
    mut emit: impl FnMut(TerminalEvent) -> Result<()>,
) -> Result<Option<u32>> {
    crate::terminal::validate_size(cols, rows)?;
    let shell = shells::resolve(config)?;
    let spec = SessionSpec {
        program: shell.path.clone(),
        args: interactive_args(&shell),
        cwd: super::default_working_directory(),
        env: Vec::new(),
        mode: ConsoleMode::Pty,
        cols,
        rows,
    };
    let spawn = tokio::task::spawn_blocking(move || Session::spawn(&spec));
    let mut session = tokio::select! {
        biased;
        _ = canceled(cancel) => return Ok(None),
        result = spawn => result.map_err(|e| crate::error::RunnerError::TaskFailed(e.to_string()))??,
    };
    emit(TerminalEvent::Connected)?;
    let exit = loop {
        let poll = tokio::time::sleep(Duration::from_millis(50));
        tokio::select! {
            biased;
            _ = canceled(cancel) => break None,
            control = controls.recv() => match control {
                Some(Control::Input(data)) => session.input(data),
                Some(Control::Resize { cols, rows }) => session.resize(cols, rows)?,
                None => break None,
            },
            Some(event) = session.next_event() => if let ChildEvent::Output { data, .. } = event {
                emit(TerminalEvent::Output(data))?;
            },
            _ = poll => if let Some(code) = session.try_wait()? { break Some(code); },
        }
    };
    if exit.is_none() {
        // 取消/通道关闭：终止 shell 进程树，并短暂等待退出
        session.force_kill();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            if session.try_wait()?.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    Ok(exit)
}
