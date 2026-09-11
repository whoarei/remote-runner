// Hide the Windows console in release builds; keep it for development logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    remote_runner::run();
}
