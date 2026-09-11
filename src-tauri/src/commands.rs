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

/// Test the selected transport without starting a user workload.
#[tauri::command]
pub async fn test_device(
    state: tauri::State<'_, AppState>,
    device: DeviceProfile,
) -> Result<String> {
    device.validate()?;
    if device.transport == crate::device::TransportKind::Wsl {
        return crate::wsl::test_device(device.wsl.as_ref().unwrap()).await;
    }
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
pub async fn list_wsl_distributions() -> Result<Vec<String>> {
    crate::wsl::list_distributions().await
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
pub fn read_workspace_file(
    dir: String,
    name: String,
) -> std::result::Result<crate::workspace::Document, crate::workspace::FileError> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    crate::workspace::read(&dir, &name)
}

#[tauri::command]
pub fn write_workspace_file(
    state: tauri::State<'_, AppState>,
    request: crate::workspace::SaveRequest,
) -> std::result::Result<crate::workspace::Saved, crate::workspace::FileError> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
    // RunStatus does not expose workspace identity. Conservatively block saves
    // during preparation/sync of ANY desktop run, including a run being stopped.
    if state
        .run_manager
        .list_running()
        .iter()
        .any(|run| matches!(run.state.as_str(), "preparing" | "syncing" | "stopping"))
    {
        return Err(crate::workspace::FileError::new(
            "busy",
            "任务正在准备、同步或停止，请稍后保存",
        ));
    }
    crate::workspace::write(request)
}

// ---------- 运行控制 ----------

#[tauri::command]
pub fn run_script(
    state: tauri::State<'_, AppState>,
    request: crate::runner::RunRequest,
) -> Result<String> {
    let _guard = crate::workspace::FILE_OPERATIONS.lock();
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
