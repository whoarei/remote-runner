use crate::device::{DeviceProfile, DeviceStore};
use crate::error::Result;
use crate::runner::{RunManager, RunStatus};
use serde::Serialize;
use std::path::PathBuf;

pub struct AppState {
    pub run_manager: RunManager,
    pub device_store: DeviceStore,
    pub config_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceEntry {
    pub name: String,
    pub is_dir: bool,
}

// ---------- 设备管理 ----------

#[tauri::command]
pub fn list_devices(state: tauri::State<'_, AppState>) -> Result<Vec<DeviceProfile>> {
    state.device_store.list()
}

#[tauri::command]
pub fn save_device(
    state: tauri::State<'_, AppState>,
    device: DeviceProfile,
) -> Result<DeviceProfile> {
    state.device_store.save(device)
}

#[tauri::command]
pub fn delete_device(state: tauri::State<'_, AppState>, id: String) -> Result<()> {
    state.device_store.delete(&id)
}

/// 连接测试：建立 SSH 连接并执行 uname
#[tauri::command]
pub async fn test_device(
    state: tauri::State<'_, AppState>,
    device: DeviceProfile,
) -> Result<String> {
    device.validate()?;
    if device.transport == crate::device::TransportKind::Serial {
        return crate::serial::test_device(&device).await;
    }
    let conn = crate::ssh::client::SshConnection::connect(&device, &state.config_dir).await?;
    let channel = conn.handle.channel_open_session().await?;
    channel
        .exec(true, "uname -a && python3 --version 2>&1; echo EXIT:$?")
        .await?;
    let mut out = String::new();
    let mut ch = channel;
    while let Some(msg) = ch.wait().await {
        match msg {
            russh::ChannelMsg::Data { data } => {
                out.push_str(&String::from_utf8_lossy(&data));
            }
            russh::ChannelMsg::ExtendedData { data, .. } => {
                out.push_str(&String::from_utf8_lossy(&data));
            }
            russh::ChannelMsg::Eof => {
                let _ = ch.close().await;
            }
            russh::ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(out)
}

// ---------- 工作区 ----------

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<String>> {
    crate::serial::transport::available_ports()
}

#[tauri::command]
pub fn list_workspace(dir: String) -> Result<Vec<WorkspaceEntry>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        entries.push(WorkspaceEntry {
            name,
            is_dir: entry.metadata()?.is_dir(),
        });
    }
    entries.sort_by(|a, b| (b.is_dir, a.name.clone()).cmp(&(a.is_dir, b.name.clone())));
    Ok(entries)
}

#[tauri::command]
pub fn read_workspace_file(dir: String, name: String) -> Result<String> {
    let path = std::path::Path::new(&dir).join(&name);
    // 防止路径逃逸
    let canonical_dir = std::fs::canonicalize(&dir)?;
    let canonical_path = std::fs::canonicalize(&path)?;
    if !canonical_path.starts_with(&canonical_dir) {
        return Err(crate::error::RunnerError::InvalidInput(
            "path escapes workspace".into(),
        ));
    }
    Ok(std::fs::read_to_string(&canonical_path)?)
}

// ---------- 运行控制 ----------

#[tauri::command]
pub fn run_script(
    state: tauri::State<'_, AppState>,
    request: crate::runner::RunRequest,
) -> Result<String> {
    let device = state.device_store.get(&request.device_id)?;
    state
        .run_manager
        .start(request, device, state.config_dir.clone())
}

#[tauri::command]
pub fn stop_run(state: tauri::State<'_, AppState>, run_id: String) -> Result<()> {
    state.run_manager.stop(&run_id)
}

#[tauri::command]
pub fn send_run_input(
    state: tauri::State<'_, AppState>,
    run_id: String,
    data: String,
) -> Result<()> {
    state.run_manager.send_input(&run_id, data.into_bytes())
}

#[tauri::command]
pub fn resize_run_console(
    state: tauri::State<'_, AppState>,
    run_id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    state.run_manager.resize(&run_id, cols, rows)
}

#[tauri::command]
pub fn get_run_status(
    state: tauri::State<'_, AppState>,
    run_id: String,
) -> Result<Option<RunStatus>> {
    Ok(state.run_manager.status(&run_id))
}

#[tauri::command]
pub fn list_running_runs(state: tauri::State<'_, AppState>) -> Result<Vec<RunStatus>> {
    Ok(state.run_manager.list_running())
}

#[tauri::command]
pub fn get_run_history(state: tauri::State<'_, AppState>) -> Result<Vec<RunStatus>> {
    Ok(state.run_manager.history())
}
