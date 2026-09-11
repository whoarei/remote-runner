pub mod commands;
pub mod device;
pub mod error;
pub mod process;
pub mod runner;
pub mod serial;
pub mod ssh;
pub mod workspace;
pub mod wsl;

use commands::AppState;
use device::DeviceStore;
use runner::{RunEvent, RunManager};
use tauri::Manager;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| dirs::config_dir().unwrap_or_default().join("remote-runner"));
            std::fs::create_dir_all(&config_dir).ok();
            tracing::info!("config dir: {}", config_dir.display());

            let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel::<RunEvent>();

            let state = AppState {
                run_manager: RunManager::new(&config_dir, event_tx),
                device_store: DeviceStore::new(&config_dir),
                config_dir,
            };
            app.manage(state);

            // RunEvent → Tauri event 转发
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                while let Some(ev) = event_rx.recv().await {
                    if let Err(e) = handle.emit("run-event", &ev) {
                        tracing::warn!("emit run-event failed: {e}");
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_devices,
            commands::save_device,
            commands::delete_device,
            commands::test_device,
            commands::list_serial_ports,
            commands::list_wsl_distributions,
            commands::list_workspace,
            commands::read_workspace_file,
            commands::write_workspace_file,
            commands::run_script,
            commands::stop_run,
            commands::send_run_input,
            commands::resize_run_console,
            commands::get_run_status,
            commands::list_running_runs,
            commands::get_run_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
