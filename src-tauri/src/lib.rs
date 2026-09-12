pub mod commands;
pub mod device;
pub mod error;
pub mod events;
pub mod process;
pub mod runner;
pub mod serial;
pub mod ssh;
pub mod terminal;
pub mod update;
pub mod workspace;
pub mod workspace_upload;
pub mod wsl;

use commands::AppState;
use device::DeviceStore;
use runner::RunManager;
use tauri::Manager;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::UpdateState::default())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| dirs::config_dir().unwrap_or_default().join("remote-runner"));
            std::fs::create_dir_all(&config_dir).ok();
            tracing::info!("config dir: {}", config_dir.display());

            let (event_tx, event_rx) = events::channel();

            let state = AppState {
                terminal_manager: terminal::TerminalManager::default(),
                run_manager: RunManager::new(&config_dir, event_tx),
                device_store: DeviceStore::new(&config_dir),
                config_dir,
                event_rx: parking_lot::Mutex::new(event_rx),
            };
            app.manage(state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_devices,
            commands::save_device,
            commands::delete_device,
            commands::test_device,
            commands::list_serial_ports,
            commands::list_wsl_distributions,
            commands::list_workspace_dir,
            commands::read_workspace_file,
            commands::write_workspace_file,
            commands::create_workspace_entry,
            commands::rename_workspace_entry,
            commands::delete_workspace_entry,
            commands::run_script,
            commands::stop_run,
            commands::send_run_input,
            commands::resize_run_console,
            commands::get_run_status,
            commands::list_running_runs,
            commands::get_run_history,
            commands::export_run_record,
            commands::export_run_output,
            commands::clear_run_history,
            commands::drain_run_events,
            commands::open_terminal,
            commands::read_terminal,
            commands::send_terminal_input,
            commands::resize_terminal,
            commands::close_terminal,
            commands::close_all_terminals,
            update::check_app_update,
            update::install_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
