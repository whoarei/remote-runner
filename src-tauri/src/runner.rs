use crate::device::DeviceProfile;
use crate::error::{Result, RunnerError};
use crate::ssh::client::SshConnection;
use crate::ssh::filesync;
use crate::ssh::session::{self, ConsoleMode, OutputStream, SessionControl, SessionEvent, SpawnSpec};
use chrono::Local;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptKind {
    Python,
    Shell,
    Command,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRequest {
    pub device_id: String,
    /// 本地工作区目录（Command 类型可为空）
    pub workspace_dir: Option<String>,
    pub kind: ScriptKind,
    /// python/shell 的入口文件（相对 workspace），command 类型忽略
    pub entry: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// command 类型的原始命令
    pub command: Option<String>,
    #[serde(default = "default_console_mode")]
    pub console_mode: ConsoleMode,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
    /// 超时（秒），0 = 不限
    #[serde(default)]
    pub timeout_secs: u64,
}

fn default_console_mode() -> ConsoleMode {
    ConsoleMode::Pty
}
fn default_cols() -> u32 {
    80
}
fn default_rows() -> u32 {
    24
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunStatus {
    pub run_id: String,
    pub device_name: String,
    pub label: String,
    pub state: String,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

impl RunStatus {
    fn new(run_id: String, device_name: String, label: String) -> Self {
        Self {
            run_id,
            device_name,
            label,
            state: "preparing".to_string(),
            exit_code: None,
            error: None,
            started_at: Local::now().to_rfc3339(),
            ended_at: None,
        }
    }
}

/// 后端向前端（或 CLI）推送的运行事件
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    Output {
        run_id: String,
        stream: String,
        /// base64 编码的原始字节
        data: String,
    },
    Status {
        status: RunStatus,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopKind {
    User,
    Timeout,
}

struct RunHandle {
    control: mpsc::UnboundedSender<SessionControl>,
    stop_tx: mpsc::UnboundedSender<StopKind>,
    status: RunStatus,
}

#[derive(Clone)]
pub struct RunManager {
    handles: Arc<Mutex<HashMap<String, RunHandle>>>,
    history: Arc<Mutex<VecDeque<RunStatus>>>,
    history_path: PathBuf,
    event_tx: mpsc::UnboundedSender<RunEvent>,
}

const HISTORY_LIMIT: usize = 200;
/// 输出流中携带远程 PID 的标记
const PID_MARKER_PREFIX: &str = "__DEVRUNNER_PID_";
const PID_MARKER_SUFFIX: &str = "__";

impl RunManager {
    pub fn new(config_dir: &std::path::Path, event_tx: mpsc::UnboundedSender<RunEvent>) -> Self {
        let history_path = config_dir.join("history.json");
        let history = std::fs::read_to_string(&history_path)
            .ok()
            .and_then(|s| serde_json::from_str::<VecDeque<RunStatus>>(&s).ok())
            .unwrap_or_default();
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(history)),
            history_path,
            event_tx,
        }
    }

    pub fn status(&self, run_id: &str) -> Option<RunStatus> {
        self.handles.lock().get(run_id).map(|h| h.status.clone())
    }

    pub fn list_running(&self) -> Vec<RunStatus> {
        self.handles
            .lock()
            .values()
            .filter(|h| is_active(&h.status.state))
            .map(|h| h.status.clone())
            .collect()
    }

    pub fn history(&self) -> Vec<RunStatus> {
        self.history.lock().iter().cloned().collect()
    }

    pub fn send_input(&self, run_id: &str, data: Vec<u8>) -> Result<()> {
        self.control(run_id)?
            .send(SessionControl::Input(data))
            .map_err(|_| RunnerError::RunNotFound(run_id.to_string()))
    }

    pub fn resize(&self, run_id: &str, cols: u32, rows: u32) -> Result<()> {
        self.control(run_id)?
            .send(SessionControl::Resize { cols, rows })
            .map_err(|_| RunnerError::RunNotFound(run_id.to_string()))
    }

    /// 停止：置状态为 stopping 并通知执行循环做分级 kill（INT → TERM → KILL → 本地关闭）
    pub fn stop(&self, run_id: &str) -> Result<()> {
        let stop_tx = self
            .handles
            .lock()
            .get(run_id)
            .map(|h| h.stop_tx.clone())
            .ok_or_else(|| RunnerError::RunNotFound(run_id.to_string()))?;
        self.set_state(run_id, "stopping");
        let _ = stop_tx.send(StopKind::User);
        Ok(())
    }

    fn control(&self, run_id: &str) -> Result<mpsc::UnboundedSender<SessionControl>> {
        self.handles
            .lock()
            .get(run_id)
            .map(|h| h.control.clone())
            .ok_or_else(|| RunnerError::RunNotFound(run_id.to_string()))
    }

    fn set_state(&self, run_id: &str, state: &str) {
        let mut map = self.handles.lock();
        if let Some(h) = map.get_mut(run_id) {
            h.status.state = state.to_string();
            let _ = self.event_tx.send(RunEvent::Status {
                status: h.status.clone(),
            });
        }
    }

    fn finish(&self, run_id: &str, state: &str, exit_code: Option<u32>, error: Option<String>) {
        let status = {
            let mut map = self.handles.lock();
            match map.get_mut(run_id) {
                Some(h) => {
                    h.status.state = state.to_string();
                    h.status.exit_code = exit_code;
                    h.status.error = error;
                    h.status.ended_at = Some(Local::now().to_rfc3339());
                    h.status.clone()
                }
                None => return,
            }
        };
        let _ = self.event_tx.send(RunEvent::Status {
            status: status.clone(),
        });
        {
            let mut hist = self.history.lock();
            hist.push_front(status);
            while hist.len() > HISTORY_LIMIT {
                hist.pop_back();
            }
            if let Ok(data) = serde_json::to_string_pretty(&*hist) {
                if let Some(parent) = self.history_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&self.history_path, data);
            }
        }
        // 终态后移除句柄
        self.handles.lock().remove(run_id);
    }

    pub fn start(&self, req: RunRequest, device: DeviceProfile, config_dir: PathBuf) -> Result<String> {
        let run_id = uuid::Uuid::new_v4().to_string()[..8].to_string();
        let label = describe_request(&req);
        let status = RunStatus::new(run_id.clone(), device.name.clone(), label);

        // 预占位：control 待 spawn 成功后替换；stop 通道立即生效
        let (placeholder, rx) = mpsc::unbounded_channel::<SessionControl>();
        drop(rx);
        let (stop_tx, stop_rx) = mpsc::unbounded_channel::<StopKind>();
        self.handles.lock().insert(
            run_id.clone(),
            RunHandle {
                control: placeholder,
                stop_tx,
                status: status.clone(),
            },
        );
        let _ = self.event_tx.send(RunEvent::Status {
            status: status.clone(),
        });

        let this = self.clone();
        let rid = run_id.clone();
        tokio::spawn(async move {
            this.execute(rid, req, device, config_dir, stop_rx).await;
        });
        Ok(run_id)
    }

    async fn execute(
        &self,
        run_id: String,
        req: RunRequest,
        device: DeviceProfile,
        config_dir: PathBuf,
        stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) {
        match self
            .execute_inner(&run_id, &req, &device, &config_dir, stop_rx)
            .await
        {
            Ok(outcome) => match outcome {
                RunOutcome::Exited { code } => self.finish(&run_id, "exited", code, None),
                RunOutcome::Canceled { code } => self.finish(&run_id, "canceled", code, None),
                RunOutcome::TimedOut { secs } => self.finish(
                    &run_id,
                    "failed",
                    None,
                    Some(format!("timeout after {secs}s")),
                ),
            },
            Err(e) => {
                self.finish(&run_id, "failed", None, Some(e.to_string()));
            }
        }
    }

    async fn execute_inner(
        &self,
        run_id: &str,
        req: &RunRequest,
        device: &DeviceProfile,
        config_dir: &std::path::Path,
        mut stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) -> Result<RunOutcome> {
        // 1. 建立 SSH 连接
        let conn = SshConnection::connect(device, config_dir).await?;
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }

        // 2. 同步 workspace（如有）
        let remote_dir = format!(
            "{}/{}",
            device.workspace_root.trim_end_matches('/'),
            run_id
        );
        if let Some(local_dir) = &req.workspace_dir {
            self.set_state(run_id, "syncing");
            let sftp = filesync::open_sftp(&conn).await?;
            let n =
                filesync::upload_dir(&sftp, std::path::Path::new(local_dir), &remote_dir).await?;
            tracing::info!("run {run_id}: uploaded {n} files to {remote_dir}");
        }
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }

        // 3. 构造启动命令（含远程 PID 捕获包装）
        let command = build_command(req, &remote_dir);
        tracing::debug!("run {run_id} command: {command}");

        // pipe 模式下包装层使用 setsid，远程 PID 即独立进程组 ID，可整组 kill
        let group_kill = req.console_mode == ConsoleMode::Pipe;

        // 4. 启动进程
        self.set_state(run_id, "running");
        let (session_tx, mut session_rx) = mpsc::unbounded_channel::<SessionEvent>();
        let proc = session::spawn(
            &conn,
            SpawnSpec {
                command,
                mode: req.console_mode,
                cols: req.cols,
                rows: req.rows,
            },
            session_tx,
        )
        .await?;

        // 替换占位 control sender
        if let Some(h) = self.handles.lock().get_mut(run_id) {
            h.control = proc.control.clone();
        }

        // 5. 事件循环：转发输出 / 捕获 PID / 处理停止与超时
        let timeout_secs = req.timeout_secs;
        let timeout_deadline = if timeout_secs > 0 {
            Some(tokio::time::Instant::now() + Duration::from_secs(timeout_secs))
        } else {
            None
        };

        let mut exit_code: Option<u32> = None;
        let mut remote_pid: Option<u32> = None;
        let mut pid_scan_buf: Vec<u8> = Vec::new();
        let mut stop_kind: Option<StopKind> = None;
        // 停止升级阶段：1=已发 Ctrl+C/SIGINT，2=已发 kill TERM，3=已发 kill KILL，4=已本地关闭
        let mut stop_stage: u8 = 0;
        let mut stop_deadline: Option<tokio::time::Instant> = None;

        loop {
            let sleep_until_timeout = async {
                match timeout_deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending().await,
                }
            };
            let sleep_until_stop_step = async {
                match stop_deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending().await,
                }
            };

            tokio::select! {
                ev = session_rx.recv() => {
                    let Some(ev) = ev else { break };
                    match ev {
                        SessionEvent::Output { stream, mut data } => {
                            // 从 stdout 中捕获远程 PID 标记并剥离
                            if remote_pid.is_none() && stream == OutputStream::Stdout {
                                pid_scan_buf.extend_from_slice(&data);
                                match extract_pid_marker(&mut pid_scan_buf) {
                                    Some((pid, rest)) => {
                                        remote_pid = Some(pid);
                                        tracing::info!("run {run_id}: remote pid = {pid}");
                                        data = rest;
                                    }
                                    None => {
                                        if pid_scan_buf.len() <= 64 {
                                            // 标记未收全，暂不转发
                                            continue;
                                        }
                                        // 放弃扫描，按原样转发
                                        data = std::mem::take(&mut pid_scan_buf);
                                    }
                                }
                            }
                            if data.is_empty() {
                                continue;
                            }
                            let _ = self.event_tx.send(RunEvent::Output {
                                run_id: run_id.to_string(),
                                stream: match stream {
                                    OutputStream::Stdout => "stdout".to_string(),
                                    OutputStream::Stderr => "stderr".to_string(),
                                },
                                data: base64::Engine::encode(
                                    &base64::engine::general_purpose::STANDARD,
                                    &data,
                                ),
                            });
                        }
                        SessionEvent::Exit { code } => {
                            exit_code = code;
                        }
                        SessionEvent::Closed => break,
                    }
                }
                stop = stop_rx.recv() => {
                    if stop.is_none() || stop_kind.is_some() {
                        continue;
                    }
                    let kind = stop.unwrap();
                    stop_kind = Some(kind);
                    if kind == StopKind::User {
                        self.set_state(run_id, "stopping");
                    }
                    // 第一步：Ctrl+C / SIGINT 尽力而为
                    let _ = proc.control.send(SessionControl::Interrupt);
                    stop_stage = 1;
                    stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                }
                _ = sleep_until_timeout => {
                    if stop_kind.is_none() {
                        stop_kind = Some(StopKind::Timeout);
                        self.set_state(run_id, "stopping");
                        let _ = proc.control.send(SessionControl::Interrupt);
                        stop_stage = 1;
                        stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                    }
                }
                _ = sleep_until_stop_step => {
                    match stop_stage {
                        1 => {
                            // TERM：按 PID 杀进程树/进程组
                            if let Some(pid) = remote_pid {
                                kill_remote_tree(&conn, pid, "TERM", group_kill).await;
                            }
                            stop_stage = 2;
                            stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(2));
                        }
                        2 => {
                            // KILL
                            if let Some(pid) = remote_pid {
                                kill_remote_tree(&conn, pid, "KILL", group_kill).await;
                            }
                            // 同时本地关闭 channel（服务端可能不回 close，双保险）
                            let _ = proc.control.send(SessionControl::Kill);
                            stop_stage = 3;
                            stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                        }
                        _ => {
                            // 服务端始终未回 close：本地强制结束
                            tracing::warn!("run {run_id}: channel not closed by server, force finish");
                            break;
                        }
                    }
                }
            }
        }

        Ok(match stop_kind {
            None => RunOutcome::Exited { code: exit_code },
            Some(StopKind::User) => RunOutcome::Canceled { code: exit_code },
            Some(StopKind::Timeout) => RunOutcome::TimedOut {
                secs: timeout_secs,
            },
        })
    }
}

enum RunOutcome {
    Exited { code: Option<u32> },
    Canceled { code: Option<u32> },
    TimedOut { secs: u64 },
}

/// 从输出缓冲中提取 `__DEVRUNNER_PID_<digits>__` 标记，返回 (pid, 剩余字节)
fn extract_pid_marker(buf: &mut Vec<u8>) -> Option<(u32, Vec<u8>)> {
    let text = String::from_utf8_lossy(buf);
    let start = text.find(PID_MARKER_PREFIX)?;
    let after = &text[start + PID_MARKER_PREFIX.len()..];
    let end = after.find(PID_MARKER_SUFFIX)?;
    let pid: u32 = after[..end].trim().parse().ok()?;

    // 安全地按字节切分（标记本身是 ASCII，直接用字符索引）
    let marker_end_byte = start + PID_MARKER_PREFIX.len() + end + PID_MARKER_SUFFIX.len();
    let mut rest = buf.split_off(marker_end_byte);
    // 丢弃标记前可能存在的字节（正常应为空）
    buf.clear();
    // 去掉紧随其后的换行
    if rest.first() == Some(&b'\r') {
        rest.remove(0);
    }
    if rest.first() == Some(&b'\n') {
        rest.remove(0);
    }
    Some((pid, rest))
}

/// 通过独立的 exec channel 杀远程进程。
/// group_kill=true（pipe 模式，包装层用了 setsid）：按进程组原子 kill；
/// group_kill=false（pty 模式）：先杀子进程再杀主进程。
async fn kill_remote_tree(conn: &SshConnection, pid: u32, sig: &str, group_kill: bool) {
    let cmd = if group_kill {
        // 负 PID = 进程组；失败时退化为树 kill
        format!(
            "kill -{sig} -- -{pid} 2>/dev/null || {{ pkill -{sig} -P {pid} 2>/dev/null; kill -{sig} {pid} 2>/dev/null; }}; true"
        )
    } else {
        format!("pkill -{sig} -P {pid} 2>/dev/null; kill -{sig} {pid} 2>/dev/null; true")
    };
    tracing::info!("kill remote tree: {cmd}");
    let run = async {
        let mut channel = conn.handle.channel_open_session().await?;
        channel.exec(false, cmd.as_str()).await?;
        // 等待 channel 关闭（忽略内容）
        while channel.wait().await.is_some() {}
        Ok::<(), russh::Error>(())
    };
    if let Err(e) = tokio::time::timeout(Duration::from_secs(5), run).await {
        tracing::warn!("kill_remote_tree error: {e}");
    }
}

fn is_active(state: &str) -> bool {
    matches!(state, "preparing" | "syncing" | "running" | "stopping")
}

fn describe_request(req: &RunRequest) -> String {
    match req.kind {
        ScriptKind::Command => req
            .command
            .clone()
            .unwrap_or_else(|| "command".to_string()),
        _ => req.entry.clone().unwrap_or_else(|| "script".to_string()),
    }
}

/// shell 单引号包裹并转义
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 构造最终在设备上执行的命令行。
///
/// 形式：
///   echo <base64> | base64 -d | sh & __pid=$!; printf '__DEVRUNNER_PID_%s__\n' "$__pid"; wait $__pid
///
/// 脚本体的 base64 编码避免一切嵌套引号问题；包装层捕获远程 PID 用于可靠的 stop/timeout kill；
/// `wait` 将进程退出码原样传递为 channel 的 exit-status。
fn build_command(req: &RunRequest, remote_dir: &str) -> String {
    let env_prefix = req
        .env
        .iter()
        .map(|(k, v)| format!("{}={}", k, sh_quote(v)))
        .collect::<Vec<_>>()
        .join(" ");

    let body = match req.kind {
        ScriptKind::Python => {
            let entry = req.entry.as_deref().unwrap_or("main.py");
            let args = req
                .args
                .iter()
                .map(|a| sh_quote(a))
                .collect::<Vec<_>>()
                .join(" ");
            // exec 使 sh 直接替换为目标进程，PID 即 python 进程
            format!("{env_prefix} exec python3 -u {} {}", sh_quote(entry), args)
        }
        ScriptKind::Shell => {
            let entry = req.entry.as_deref().unwrap_or("main.sh");
            let args = req
                .args
                .iter()
                .map(|a| sh_quote(a))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{env_prefix} exec bash {} {}", sh_quote(entry), args)
        }
        ScriptKind::Command => req.command.clone().unwrap_or_default(),
    };

    let script = if req.workspace_dir.is_some() {
        format!("cd {} && {}", sh_quote(remote_dir), body)
    } else {
        body
    };

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(script.as_bytes());
    // pipe 模式用 setsid 让脚本独立成进程组（可整组原子 kill）；
    // pty 模式不用 setsid，避免脚本失去控制终端导致 input()/isatty() 失效。
    // 脚本先落临时文件再执行，保证脚本进程的 stdin 仍是 channel（管道喂 base64 会抢走 stdin）。
    // 注意：非交互 shell 的后台任务 stdin 默认被重定向到 /dev/null（POSIX），
    // 因此先用 fd 3 保存 channel stdin，再显式 <&3 喂给脚本进程。
    let setsid = match req.console_mode {
        ConsoleMode::Pipe => "setsid ",
        ConsoleMode::Pty => "",
    };
    format!(
        "__f=/tmp/.devrunner-wrap-$$.sh; echo {b64} | base64 -d > $__f; exec 3<&0; \
         {setsid}sh $__f <&3 & __pid=$!; \
         printf '{PID_MARKER_PREFIX}%s{PID_MARKER_SUFFIX}\\n' \"$__pid\"; wait $__pid; __rc=$?; rm -f $__f; exit $__rc"
    )
}
