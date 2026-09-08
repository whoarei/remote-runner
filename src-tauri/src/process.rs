//! Transport-independent process console and control messages.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleMode {
    Pty,
    Pipe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug)]
pub enum SessionEvent {
    Output { stream: OutputStream, data: Vec<u8> },
    Exit { code: Option<u32> },
    Failed { error: String },
    Closed,
}

/// 上层对远程进程的控制消息
#[derive(Debug)]
pub enum SessionControl {
    Input(Vec<u8>),
    Resize {
        cols: u32,
        rows: u32,
    },
    /// Ctrl+C 语义：PTY 下发 0x03；pipe 下发 SIGINT
    Interrupt,
    Terminate,
    /// 尽力发送 KILL 并关闭 channel；远程进程仍需上层按 PID 清理。
    Kill,
}
