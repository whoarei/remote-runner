use crate::device::{DeviceProfile, TransportKind};
use crate::error::{Result, RunnerError};
use crate::process::{
    Capabilities, ConsoleMode, Outcome, OutputStream, RunState, SessionControl, SessionEvent,
};
use crate::ssh::client::SshConnection;
use crate::ssh::filesync;
use crate::ssh::session::{self, SpawnSpec};
use chrono::Local;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

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
    pub state: RunState,
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
            state: RunState::Preparing,
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
    Resync {
        statuses: Vec<RunStatus>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopKind {
    User,
    Timeout,
}

struct RunHandle {
    _serial_lease: Option<crate::serial::transport::PortLease>,
    capabilities: Capabilities,
    control: mpsc::UnboundedSender<SessionControl>,
    stop_tx: mpsc::UnboundedSender<StopKind>,
    status: RunStatus,
}

#[derive(Clone)]
pub struct RunManager {
    handles: Arc<Mutex<HashMap<String, RunHandle>>>,
    history: Arc<Mutex<VecDeque<RunStatus>>>,
    history_path: PathBuf,
    event_tx: broadcast::Sender<RunEvent>,
}

const HISTORY_LIMIT: usize = 200;
/// 输出流中携带远程 PID 的标记
const PID_MARKER_PREFIX: &str = "__DEVRUNNER_PID_";
const PID_MARKER_SUFFIX: &str = "__";

impl RunManager {
    pub fn new(config_dir: &std::path::Path, event_tx: broadcast::Sender<RunEvent>) -> Self {
        let history_path = config_dir.join("history.json");
        let mut history = std::fs::read_to_string(&history_path)
            .ok()
            .and_then(|s| serde_json::from_str::<VecDeque<RunStatus>>(&s).ok())
            .unwrap_or_default();
        history.truncate(HISTORY_LIMIT);
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(history)),
            history_path,
            event_tx,
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<RunEvent> {
        self.event_tx.subscribe()
    }

    pub fn snapshot(&self) -> Vec<RunStatus> {
        let handles = self.handles.lock();
        let history = self.history.lock();
        let mut statuses: Vec<_> = history.iter().cloned().collect();
        for handle in handles.values() {
            statuses.retain(|s| s.run_id != handle.status.run_id);
            statuses.push(handle.status.clone());
        }
        statuses
    }

    fn emit_output(&self, run_id: &str, stream: OutputStream, data: &[u8]) {
        use base64::Engine;
        for chunk in data.chunks(crate::events::OUTPUT_CHUNK) {
            let _ = self.event_tx.send(RunEvent::Output {
                run_id: run_id.into(),
                stream: match stream {
                    OutputStream::Stdout => "stdout",
                    OutputStream::Stderr => "stderr",
                }
                .into(),
                data: base64::engine::general_purpose::STANDARD.encode(chunk),
            });
        }
    }

    pub fn status(&self, run_id: &str) -> Option<RunStatus> {
        self.handles
            .lock()
            .get(run_id)
            .map(|h| h.status.clone())
            .or_else(|| {
                self.history
                    .lock()
                    .iter()
                    .find(|h| h.run_id == run_id)
                    .cloned()
            })
    }

    pub fn list_running(&self) -> Vec<RunStatus> {
        self.handles
            .lock()
            .values()
            .filter(|h| h.status.state.is_active())
            .map(|h| h.status.clone())
            .collect()
    }

    pub fn history(&self) -> Vec<RunStatus> {
        self.history.lock().iter().cloned().collect()
    }

    pub fn send_input(&self, run_id: &str, data: Vec<u8>) -> Result<()> {
        if data.len() > 64 * 1024 {
            return Err(RunnerError::InvalidInput(
                "input must not exceed 64 KiB per request".into(),
            ));
        }
        if data == [3] {
            return self.stop(run_id);
        }
        self.control(run_id)?
            .send(SessionControl::Input(data))
            .map_err(|_| RunnerError::RunNotFound(run_id.to_string()))
    }

    pub fn resize(&self, run_id: &str, cols: u32, rows: u32) -> Result<()> {
        if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 {
            return Err(RunnerError::InvalidInput(
                "console dimensions must be between 1 and 4096".into(),
            ));
        }
        if self
            .handles
            .lock()
            .get(run_id)
            .is_some_and(|h| !h.capabilities.resize)
        {
            return Err(RunnerError::InvalidInput(
                "serial shell cannot resize a running process; dimensions are set at launch".into(),
            ));
        }
        self.control(run_id)?
            .send(SessionControl::Resize { cols, rows })
            .map_err(|_| RunnerError::RunNotFound(run_id.to_string()))
    }

    /// 停止：置状态为 stopping 并通知执行循环做分级 kill（INT → TERM → KILL → 本地关闭）
    pub fn stop(&self, run_id: &str) -> Result<()> {
        let mut handles = self.handles.lock();
        let h = handles
            .get_mut(run_id)
            .ok_or_else(|| RunnerError::RunNotFound(run_id.to_string()))?;
        if h.status.state == RunState::Stopping {
            return Ok(());
        }
        h.stop_tx
            .send(StopKind::User)
            .map_err(|_| RunnerError::RunNotFound(run_id.to_string()))?;
        h.status.state = RunState::Stopping;
        let _ = self.event_tx.send(RunEvent::Status {
            status: h.status.clone(),
        });
        Ok(())
    }

    fn control(&self, run_id: &str) -> Result<mpsc::UnboundedSender<SessionControl>> {
        self.handles
            .lock()
            .get(run_id)
            .map(|h| h.control.clone())
            .ok_or_else(|| RunnerError::RunNotFound(run_id.to_string()))
    }

    fn set_state(&self, run_id: &str, state: RunState) {
        let mut map = self.handles.lock();
        if let Some(h) = map.get_mut(run_id) {
            if h.status.state == RunState::Stopping {
                return;
            }
            h.status.state = state;
            let _ = self.event_tx.send(RunEvent::Status {
                status: h.status.clone(),
            });
        }
    }

    fn finish(&self, run_id: &str, state: RunState, exit_code: Option<u32>, error: Option<String>) {
        let status = {
            let mut map = self.handles.lock();
            match map.get_mut(run_id) {
                Some(h) => {
                    h.status.state = state;
                    h.status.exit_code = exit_code;
                    h.status.error = error;
                    h.status.ended_at = Some(Local::now().to_rfc3339());
                    h.status.clone()
                }
                None => return,
            }
        };
        {
            let mut hist = self.history.lock();
            hist.push_front(status.clone());
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
        let _ = self.event_tx.send(RunEvent::Status { status });
    }

    pub fn start(
        &self,
        mut req: RunRequest,
        device: DeviceProfile,
        config_dir: PathBuf,
    ) -> Result<String> {
        device.validate()?;
        validate_request(&mut req)?;
        let capabilities = device.transport.capabilities();
        if req.console_mode == ConsoleMode::Pipe && !capabilities.pipe {
            return Err(RunnerError::InvalidInput(
                "serial shell has one combined console stream; pipe mode is not supported".into(),
            ));
        }
        let serial_lease = if device.transport == TransportKind::Serial {
            Some(crate::serial::transport::PortLease::acquire(
                &device.serial.as_ref().unwrap().port,
            )?)
        } else {
            None
        };
        let run_id = uuid::Uuid::new_v4().to_string();
        let label = describe_request(&req);
        let status = RunStatus::new(run_id.clone(), device.name.clone(), label);

        // 预占位：control 待 spawn 成功后替换；stop 通道立即生效
        let (placeholder, rx) = mpsc::unbounded_channel::<SessionControl>();
        drop(rx);
        let (stop_tx, stop_rx) = mpsc::unbounded_channel::<StopKind>();
        let mut handles = self.handles.lock();
        if handles.len() >= 32 {
            return Err(RunnerError::InvalidInput(
                "at most 32 runs may be active".into(),
            ));
        }
        handles.insert(
            run_id.clone(),
            RunHandle {
                _serial_lease: serial_lease,
                capabilities,
                control: placeholder,
                stop_tx,
                status: status.clone(),
            },
        );
        drop(handles);
        let _ = self.event_tx.send(RunEvent::Status {
            status: status.clone(),
        });

        let this = self.clone();
        let rid = run_id.clone();
        tauri::async_runtime::spawn(async move {
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
                RunOutcome::Exited { code } => self.finish(&run_id, RunState::Exited, code, None),
                RunOutcome::Canceled { code } => {
                    self.finish(&run_id, RunState::Canceled, code, None)
                }
                RunOutcome::TimedOut { secs } => self.finish(
                    &run_id,
                    RunState::Failed,
                    None,
                    Some(format!("timeout after {secs}s")),
                ),
            },
            Err(e) => {
                self.finish(&run_id, RunState::Failed, None, Some(e.to_string()));
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
        if device.transport == TransportKind::Wsl {
            return self.execute_wsl(run_id, req, device, stop_rx).await;
        }
        if device.transport == TransportKind::Serial {
            return self.execute_serial(run_id, req, device, stop_rx).await;
        }
        // 1. 建立 SSH 连接
        let conn = tokio::select! {
            biased;
            _ = stop_rx.recv() => return Ok(RunOutcome::Canceled { code: None }),
            conn = SshConnection::connect(device, config_dir) => conn?,
        };

        // 2. 同步 workspace（如有）
        let remote_dir = format!("{}/{}", device.workspace_root.trim_end_matches('/'), run_id);
        if let Some(local_dir) = &req.workspace_dir {
            self.set_state(run_id, RunState::Syncing);
            let sync = async {
                let sftp = filesync::open_sftp(&conn).await?;
                filesync::upload_dir(&sftp, std::path::Path::new(local_dir), &remote_dir).await
            };
            let n = tokio::select! {
                biased;
                _ = stop_rx.recv() => return Ok(RunOutcome::Canceled { code: None }),
                result = sync => result?,
            };
            tracing::info!("run {run_id}: uploaded {n} files to {remote_dir}");
        }
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }

        // 3. 构造启动命令（含远程 PID 捕获包装）
        let marker_prefix = format!("{PID_MARKER_PREFIX}{run_id}_");
        let command = build_command(req, &remote_dir, &marker_prefix);

        // pipe 模式下包装层使用 setsid，远程 PID 即独立进程组 ID，可整组 kill
        let group_kill = req.console_mode == ConsoleMode::Pipe;

        // 4. 启动进程
        self.set_state(run_id, RunState::Starting);
        let (session_tx, mut session_rx) = mpsc::channel::<SessionEvent>(64);
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
        self.set_state(run_id, RunState::Running);

        // 5. 事件循环：转发输出 / 捕获 PID / 处理停止与超时
        let timeout_secs = req.timeout_secs;
        let timeout_deadline = if timeout_secs > 0 {
            Some(tokio::time::Instant::now() + Duration::from_secs(timeout_secs))
        } else {
            None
        };

        let mut exit_code: Option<u32> = None;
        let mut remote_pid: Option<u32> = None;
        let mut pid_scanner = PidScanner::new(marker_prefix);
        let mut received_exit = false;
        let mut stop_kind: Option<StopKind> = None;
        // 停止升级阶段：1=已发 Ctrl+C/SIGINT，2=已发 kill TERM，3=已发 kill KILL，4=已本地关闭
        let mut stop_stage: u8 = 0;
        let mut interrupt_sent = false;
        let mut stop_deadline: Option<tokio::time::Instant> = None;

        loop {
            // Pipe runs live in their own session. Signal the actual PID marker's
            // group, not the SSH/setsid supervisor, including Stop before the marker.
            if stop_kind.is_some() && !interrupt_sent {
                if group_kill {
                    if let Some(pid) = remote_pid {
                        kill_remote_tree(&conn, pid, "INT", true).await;
                        interrupt_sent = true;
                    }
                } else {
                    let _ = proc.control.send(SessionControl::Interrupt);
                    interrupt_sent = true;
                }
            }
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
                                data = pid_scanner.push(&data);
                                remote_pid = pid_scanner.pid;
                            }
                            if data.is_empty() {
                                continue;
                            }
                            self.emit_output(run_id, stream, &data);
                        }
                        SessionEvent::Exit { code } => {
                            received_exit = true;
                            exit_code = code;
                        }
                        SessionEvent::Failed { error } => return Err(RunnerError::TaskFailed(error)),
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
                        self.set_state(run_id, RunState::Stopping);
                    }
                    // 第一步：Ctrl+C / SIGINT 尽力而为
                    stop_stage = 1;
                    stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                }
                _ = sleep_until_timeout, if stop_kind.is_none() => {
                    if stop_kind.is_none() {
                        stop_kind = Some(StopKind::Timeout);
                        self.set_state(run_id, RunState::Stopping);
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

        let remaining = std::mem::take(&mut pid_scanner.buffer);
        if !remaining.is_empty() {
            self.emit_output(run_id, OutputStream::Stdout, &remaining);
        }
        if stop_kind.is_none() && !received_exit {
            return Err(RunnerError::TaskFailed(
                "SSH channel closed without an exit status".into(),
            ));
        }

        Ok(match stop_kind {
            None => RunOutcome::Exited { code: exit_code },
            Some(StopKind::User) => RunOutcome::Canceled { code: exit_code },
            Some(StopKind::Timeout) => RunOutcome::TimedOut { secs: timeout_secs },
        })
    }

    async fn execute_wsl(
        &self,
        run_id: &str,
        req: &RunRequest,
        device: &DeviceProfile,
        mut stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) -> Result<RunOutcome> {
        use crate::wsl::{self, Event};
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        let files = if let Some(dir) = req.workspace_dir.clone() {
            tokio::task::spawn_blocking(move || wsl::filesync::collect(std::path::Path::new(&dir)))
                .await
                .map_err(|e| RunnerError::TaskFailed(e.to_string()))??
        } else {
            Vec::new()
        };
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        let (control, mut controls) = mpsc::unbounded_channel();
        if let Some(handle) = self.handles.lock().get_mut(run_id) {
            handle.control = control.clone();
        }
        let remote = format!("{}/{}", device.workspace_root.trim_end_matches('/'), run_id);
        let execution = wsl::execute(
            device.wsl.as_ref().unwrap(),
            req,
            &remote,
            files,
            &mut controls,
            |event| match event {
                Event::State(state) => self.set_state(run_id, state),
                Event::Output { stream, data } => {
                    self.emit_output(run_id, stream, &data);
                }
            },
        );
        await_transport(execution, control, stop_rx, req.timeout_secs).await
    }

    async fn execute_serial(
        &self,
        run_id: &str,
        req: &RunRequest,
        device: &DeviceProfile,
        mut stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) -> Result<RunOutcome> {
        use crate::serial::{self, Event};
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        let files = if let Some(dir) = req.workspace_dir.clone() {
            tokio::task::spawn_blocking(move || {
                serial::filesync::collect(std::path::Path::new(&dir))
            })
            .await
            .map_err(|e| RunnerError::TaskFailed(e.to_string()))??
        } else {
            Vec::new()
        };
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        let config = device.serial.as_ref().unwrap();
        let remote = format!("{}/{}", device.workspace_root.trim_end_matches('/'), run_id);
        serial::preflight(req, &remote, &files)?;
        let port = serial::transport::open(config)?;
        let (control, mut controls) = mpsc::unbounded_channel();
        if let Some(handle) = self.handles.lock().get_mut(run_id) {
            handle.control = control.clone();
        }
        let execution = serial::execute(
            port,
            config.baud_rate,
            req,
            &remote,
            files,
            &mut controls,
            |event| match event {
                Event::State(state) => self.set_state(run_id, state),
                Event::Output { stream, data } => {
                    self.emit_output(run_id, stream, &data);
                }
            },
        );
        await_transport(execution, control, stop_rx, req.timeout_secs).await
    }
}

async fn await_transport(
    execution: impl std::future::Future<Output = Result<Outcome>>,
    control: mpsc::UnboundedSender<SessionControl>,
    mut stops: mpsc::UnboundedReceiver<StopKind>,
    timeout_secs: u64,
) -> Result<RunOutcome> {
    tokio::pin!(execution);
    let mut stop_sent = false;
    let result = loop {
        tokio::select! {
            biased;
            _ = stops.recv(), if !stop_sent => { stop_sent = true; let _ = control.send(SessionControl::Interrupt); }
            result = &mut execution => break result?,
        }
    };
    Ok(match result.stopped {
        Some(crate::process::StopReason::User) => RunOutcome::Canceled { code: result.code },
        Some(crate::process::StopReason::Timeout) => RunOutcome::TimedOut { secs: timeout_secs },
        None => RunOutcome::Exited { code: result.code },
    })
}

enum RunOutcome {
    Exited { code: Option<u32> },
    Canceled { code: Option<u32> },
    TimedOut { secs: u64 },
}

/// 从输出缓冲中提取 `__DEVRUNNER_PID_<digits>__` 标记，返回 (pid, 剩余字节)
struct PidScanner {
    prefix: Vec<u8>,
    buffer: Vec<u8>,
    pid: Option<u32>,
}

impl PidScanner {
    fn new(prefix: String) -> Self {
        Self {
            prefix: prefix.into_bytes(),
            buffer: Vec::new(),
            pid: None,
        }
    }

    fn push(&mut self, data: &[u8]) -> Vec<u8> {
        self.buffer.extend_from_slice(data);
        let mut output = Vec::new();
        while !self.buffer.is_empty() {
            if self.pid.is_some() {
                output.append(&mut self.buffer);
                break;
            }
            if self.buffer.starts_with(&self.prefix) {
                if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                    let line = &self.buffer[self.prefix.len()..end];
                    let line = line.strip_suffix(b"\r").unwrap_or(line);
                    self.pid = line
                        .strip_suffix(PID_MARKER_SUFFIX.as_bytes())
                        .and_then(|digits| std::str::from_utf8(digits).ok())
                        .and_then(|digits| digits.parse::<u32>().ok())
                        .filter(|pid| *pid > 1);
                    if self.pid.is_some() {
                        self.buffer.drain(..=end);
                        continue;
                    }
                } else if self.buffer.len() <= self.prefix.len() + 14 {
                    break;
                }
            } else if self.prefix.starts_with(&self.buffer) {
                break;
            }
            // Forward whole spans instead of repeatedly shifting a large output packet.
            let next = (1..self.buffer.len())
                .find(|&i| self.buffer[i] == self.prefix[0])
                .unwrap_or(self.buffer.len());
            output.extend(self.buffer.drain(..next));
        }
        output
    }
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
    match tokio::time::timeout(Duration::from_secs(5), run).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!("kill_remote_tree SSH error: {e}"),
        Err(e) => tracing::warn!("kill_remote_tree timeout: {e}"),
    }
}

fn describe_request(req: &RunRequest) -> String {
    match req.kind {
        ScriptKind::Command => req.command.clone().unwrap_or_else(|| "command".to_string()),
        _ => req.entry.clone().unwrap_or_else(|| "script".to_string()),
    }
}

/// shell 单引号包裹并转义
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn validate_request(req: &mut RunRequest) -> Result<()> {
    let invalid = |message: &str| RunnerError::InvalidInput(message.into());
    if serde_json::to_vec(req)
        .map_err(|e| invalid(&e.to_string()))?
        .len()
        > 64 * 1024
    {
        return Err(invalid("run request must not exceed 64 KiB"));
    }
    if req.cols == 0 || req.rows == 0 || req.cols > 4096 || req.rows > 4096 {
        return Err(invalid("console dimensions must be between 1 and 4096"));
    }
    if req.timeout_secs > 31_536_000 {
        return Err(invalid("timeout must not exceed one year"));
    }
    for (key, value) in &req.env {
        let mut chars = key.chars();
        if !chars
            .next()
            .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
            || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
            || value.contains('\0')
        {
            return Err(invalid("invalid environment variable"));
        }
    }
    if req.args.iter().any(|a| a.contains('\0')) {
        return Err(invalid("arguments cannot contain NUL"));
    }
    let workspace = req
        .workspace_dir
        .as_ref()
        .map(std::fs::canonicalize)
        .transpose()?;
    if workspace.as_ref().is_some_and(|p| !p.is_dir()) {
        return Err(invalid("workspace must be a directory"));
    }
    match req.kind {
        ScriptKind::Command => {
            if !req
                .command
                .as_ref()
                .is_some_and(|c| !c.trim().is_empty() && !c.contains('\0'))
            {
                return Err(invalid("command must not be empty or contain NUL"));
            }
        }
        _ => {
            let root = workspace
                .as_ref()
                .ok_or_else(|| invalid("script requires a workspace"))?;
            let entry = req
                .entry
                .as_ref()
                .ok_or_else(|| invalid("script requires an entry"))?;
            let entry = entry.replace('\\', "/");
            if entry.is_empty()
                || entry.contains(['\0', ':'])
                || entry
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == "..")
            {
                return Err(invalid(
                    "entry must be a relative path inside the workspace",
                ));
            }
            let mut path = root.clone();
            for part in entry.split('/') {
                path.push(part);
                if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    return Err(invalid(
                        "symbolic links are not supported for script entries",
                    ));
                }
            }
            let resolved = std::fs::canonicalize(&path)?;
            if !resolved.starts_with(root) || !resolved.is_file() {
                return Err(invalid("entry must be a file inside the workspace"));
            }
            req.entry = Some(entry);
        }
    }
    if let Some(root) = workspace {
        req.workspace_dir = Some(root.to_string_lossy().into_owned());
    }
    Ok(())
}

/// 构造最终在设备上执行的命令行。
///
/// 形式：
///   mktemp → decode script → background process with channel stdin → PID → wait
///
/// 脚本体的 base64 编码避免一切嵌套引号问题；包装层捕获远程 PID 用于可靠的 stop/timeout kill；
/// `wait` 将进程退出码原样传递为 channel 的 exit-status。
pub(crate) fn build_script(req: &RunRequest, remote_dir: &str) -> String {
    let env_prefix = req
        .env
        .iter()
        .map(|(k, v)| format!("export {}={};", k, sh_quote(v)))
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
            format!(
                "exec python3 -u {} {}",
                sh_quote(&format!("./{entry}")),
                args
            )
        }
        ScriptKind::Shell => {
            let entry = req.entry.as_deref().unwrap_or("main.sh");
            let args = req
                .args
                .iter()
                .map(|a| sh_quote(a))
                .collect::<Vec<_>>()
                .join(" ");
            format!("exec bash {} {}", sh_quote(&format!("./{entry}")), args)
        }
        ScriptKind::Command => req.command.clone().unwrap_or_default(),
    };

    if req.workspace_dir.is_some() {
        format!(
            "cd {} || exit $?; {env_prefix} {body}",
            sh_quote(remote_dir)
        )
    } else {
        format!("{env_prefix} {body}")
    }
}

fn build_command(req: &RunRequest, remote_dir: &str, marker_prefix: &str) -> String {
    // Emit the PID from the workload's foreground shell. Non-interactive shell
    // background jobs inherit SIGINT/SIGQUIT ignored, which `trap -` cannot undo.
    // Removing the already-open script before exec also avoids orphan temp files.
    let script = format!(
        "rm -f -- \"$0\"; printf '{marker_prefix}%s{PID_MARKER_SUFFIX}\\n' \"$$\"; {}",
        build_script(req, remote_dir)
    );
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(script.as_bytes());
    // -w preserves the exit status even when setsid must fork a session leader.
    // PTY workloads stay in the SSH foreground group and retain their terminal.
    let setsid = match req.console_mode {
        ConsoleMode::Pipe => "setsid -w ",
        ConsoleMode::Pty => "",
    };
    format!(
        "umask 077; __f=$(mktemp /tmp/.devrunner-wrap-XXXXXXXXXX) || exit 1; trap 'rm -f -- \"$__f\"' EXIT; echo {b64} | base64 -d > \"$__f\" || exit 1; exec {setsid}sh \"$__f\""
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn local_wrapper(
        command: &str,
        input: &[u8],
        mode: ConsoleMode,
    ) -> Option<(i32, Vec<u8>, u32)> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        #[cfg(windows)]
        let shell = std::path::Path::new("C:/Program Files/Git/bin/bash.exe");
        #[cfg(not(windows))]
        let shell = std::path::Path::new("/bin/sh");
        if !shell.exists() {
            eprintln!("SKIP: local POSIX shell unavailable");
            return None;
        }
        let mut req = request();
        req.command = Some(command.into());
        req.console_mode = mode;
        let wrapper = build_command(&req, "/tmp/unused", "__REVIEW_PID_");
        // Let a POSIX parent translate signaled termination to 128+signal;
        // MSYS native Windows process status is otherwise not a POSIX exit code.
        let supervised = format!(
            "sh -c {}; __test_rc=$?; exit \"$__test_rc\"",
            sh_quote(&wrapper)
        );
        let mut child = Command::new(shell)
            .arg("-c")
            .arg(supervised)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let result = child.wait_with_output().unwrap();
        let mut scanner = PidScanner::new("__REVIEW_PID_".into());
        let mut output = scanner.push(&result.stdout);
        output.extend_from_slice(&scanner.buffer);
        let code = result.status.code().unwrap_or(130);
        Some((
            code,
            output,
            scanner.pid.expect("actual workload PID marker"),
        ))
    }

    #[test]
    fn foreground_wrapper_preserves_sigint_and_user_cleanup() {
        if let Some((code, output, _)) =
            local_wrapper("kill -INT $$; echo SHOULD_NOT_PRINT", b"", ConsoleMode::Pty)
        {
            assert_eq!(code, 130);
            assert!(output.is_empty());
        }
        if let Some((code, output, _)) = local_wrapper(
            "trap 'printf cleanup; exit 23' INT; kill -INT $$; echo SHOULD_NOT_PRINT",
            b"",
            ConsoleMode::Pty,
        ) {
            assert_eq!(code, 23);
            assert_eq!(output, b"cleanup");
        }
    }

    #[test]
    fn foreground_wrapper_preserves_stdin_pid_exit_code_and_removes_temp_script() {
        let command = "test ! -e \"$0\" || exit 99; printf '%s:' \"$$\"; read value; printf '%s' \"$value\"; exit 7";
        if let Some((code, output, pid)) =
            local_wrapper(command, b"literal input\n", ConsoleMode::Pty)
        {
            assert_eq!(code, 7);
            assert_eq!(output, format!("{pid}:literal input").as_bytes());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pipe_wrapper_waits_for_session_and_reports_its_actual_group_pid() {
        let (code, output, pid) = local_wrapper(
            "ps -o pgid= -p $$; read value; printf '%s' \"$value\"; exit 7",
            b"INPUT\n",
            ConsoleMode::Pipe,
        )
        .unwrap();
        assert_eq!(code, 7);
        assert_eq!(
            String::from_utf8(output).unwrap().trim(),
            format!("{pid}\nINPUT")
        );
    }

    #[test]
    fn output_overload_is_bounded_and_recovers_a_lost_terminal_status() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, mut rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        let (control, _) = mpsc::unbounded_channel();
        let (stop_tx, _) = mpsc::unbounded_channel();
        manager.handles.lock().insert(
            "run".into(),
            RunHandle {
                _serial_lease: None,
                capabilities: TransportKind::Ssh.capabilities(),
                control,
                stop_tx,
                status: RunStatus::new("run".into(), "test".into(), "bounded".into()),
            },
        );
        manager.finish("run", RunState::Exited, Some(7), None);
        // Force the terminal event out of the bounded retention window.
        for _ in 0..crate::events::EVENT_CAPACITY * 2 {
            manager.emit_output(
                "run",
                OutputStream::Stdout,
                &[0xff; crate::events::OUTPUT_CHUNK],
            );
        }
        let events = crate::events::drain(&mut rx, &manager);
        let RunEvent::Resync { statuses } = &events[0] else {
            panic!("expected explicit lag recovery")
        };
        assert_eq!(statuses[0].state, RunState::Exited);
        assert_eq!(statuses[0].exit_code, Some(7));
        assert!(events.len() <= crate::events::BATCH_SIZE);
        let mut retained = events.len() - 1;
        for _ in 0..5 {
            retained += crate::events::drain(&mut rx, &manager).len();
        }
        assert_eq!(retained, crate::events::EVENT_CAPACITY);
        assert!(crate::events::drain(&mut rx, &manager).is_empty());
        manager.emit_output("next", OutputStream::Stderr, &[0xff, 0, 0xfe]);
        let events = crate::events::drain(&mut rx, &manager);
        let RunEvent::Output { data, stream, .. } = &events[0] else {
            panic!("expected raw output")
        };
        assert_eq!(stream, "stderr");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap(),
            [0xff, 0, 0xfe]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn request() -> RunRequest {
        serde_json::from_value(serde_json::json!({
            "device_id": "test", "kind": "command", "command": "true"
        }))
        .unwrap()
    }

    #[test]
    fn pid_marker_preserves_binary_output_at_every_packet_boundary() {
        let prefix = "__DEVRUNNER_PID_test_";
        let input = b"\xffbefore\n__DEVRUNNER_PID_test_123__\r\nafter\xe4\xb8\xad";
        for split in 0..=input.len() {
            let mut scanner = PidScanner::new(prefix.into());
            let mut output = scanner.push(&input[..split]);
            output.extend(scanner.push(&input[split..]));
            output.extend_from_slice(&scanner.buffer);
            assert_eq!(scanner.pid, Some(123), "split {split}");
            assert_eq!(output, b"\xffbefore\nafter\xe4\xb8\xad", "split {split}");
        }
    }

    #[test]
    fn pid_scanner_does_not_swallow_short_or_invalid_output() {
        for input in [
            b"hello".as_slice(),
            b"__DEVRUNNER_PID_test_0__\n",
            b"__DEVRUNNER_PID_test_12",
        ] {
            let mut scanner = PidScanner::new("__DEVRUNNER_PID_test_".into());
            let mut output = Vec::new();
            for byte in input {
                output.extend(scanner.push(&[*byte]));
            }
            output.extend_from_slice(&scanner.buffer);
            assert_eq!(output, input);
            assert_eq!(scanner.pid, None);
        }
    }

    #[test]
    fn validates_commands_and_environment_before_start() {
        let mut req = request();
        req.command = Some(" ".into());
        assert!(validate_request(&mut req).is_err());
        req.command = Some("true".into());
        req.env.insert("X; touch /tmp/injected".into(), "1".into());
        assert!(validate_request(&mut req).is_err());
        req.env.clear();
        req.env.insert("VALID_1".into(), "quotes ' and $()".into());
        assert!(validate_request(&mut req).is_ok());
    }

    #[test]
    fn validates_script_entry_and_normalizes_windows_paths() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/test.py"), "print(1)").unwrap();
        let mut req = request();
        req.kind = ScriptKind::Python;
        req.workspace_dir = Some(root.to_string_lossy().into_owned());
        for entry in ["../test.py", "/test.py", "C:/test.py", "sub", "missing.py"] {
            req.entry = Some(entry.into());
            assert!(validate_request(&mut req).is_err(), "{entry}");
        }
        req.entry = Some("sub\\test.py".into());
        validate_request(&mut req).unwrap();
        assert_eq!(req.entry.as_deref(), Some("sub/test.py"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn command_environment_is_exported_and_script_names_are_not_options() {
        let mut req = request();
        req.env.insert("VALUE".into(), "a'b".into());
        req.command = Some("printf '%s' \"$VALUE\"; true".into());
        let decode = |req: &RunRequest| {
            let command = build_command(req, "/tmp/ws", "marker_");
            let encoded = command
                .split("echo ")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap();
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap(),
            )
            .unwrap()
        };
        let script = decode(&req);
        assert!(script.contains("export VALUE='a'\\''b';"));
        assert!(script.contains("printf '%s' \"$VALUE\"; true"));
        req.kind = ScriptKind::Python;
        req.entry = Some("-test.py".into());
        assert!(decode(&req).contains("python3 -u './-test.py'"));
    }

    #[test]
    fn terminal_event_is_published_after_history_and_remains_queryable() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (events, mut rx) = crate::events::channel();
        let manager = RunManager::new(&root, events);
        let (control, _) = mpsc::unbounded_channel();
        let (stop_tx, _stop_rx) = mpsc::unbounded_channel();
        manager.handles.lock().insert(
            "run".into(),
            RunHandle {
                _serial_lease: None,
                capabilities: TransportKind::Ssh.capabilities(),
                control,
                stop_tx,
                status: RunStatus::new("run".into(), "device".into(), "test".into()),
            },
        );
        manager.stop("run").unwrap();
        manager.set_state("run", RunState::Running);
        assert_eq!(manager.status("run").unwrap().state, RunState::Stopping);
        manager.finish("run", RunState::Canceled, Some(143), None);
        while let Ok(event) = rx.try_recv() {
            if let RunEvent::Status { status } = event {
                if status.state == RunState::Canceled {
                    assert_eq!(manager.history()[0].run_id, "run");
                    assert_eq!(manager.status("run").unwrap().exit_code, Some(143));
                    assert!(manager.list_running().is_empty());
                }
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
