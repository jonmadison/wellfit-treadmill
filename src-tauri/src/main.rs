#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ble;

use ble::{BleState, ConnectInfo, DeviceInfo};
use tauri::{AppHandle, State};

#[tauri::command]
async fn scan_devices(state: State<'_, BleState>, secs: Option<u64>) -> Result<Vec<DeviceInfo>, String> {
    state.scan_devices(secs.unwrap_or(6)).await
}

#[tauri::command]
async fn connect(
    app: AppHandle,
    state: State<'_, BleState>,
    id: String,
) -> Result<ConnectInfo, String> {
    state.connect(app, id).await
}

#[tauri::command]
async fn write_control(state: State<'_, BleState>, data: Vec<u8>) -> Result<(), String> {
    state.write_control(data).await
}

#[tauri::command]
async fn disconnect(state: State<'_, BleState>) -> Result<(), String> {
    state.disconnect().await
}

#[tauri::command]
async fn is_connected(state: State<'_, BleState>) -> Result<bool, String> {
    Ok(state.is_connected().await)
}

fn main() {
    tauri::Builder::default()
        .manage(BleState::default())
        .invoke_handler(tauri::generate_handler![
            scan_devices,
            connect,
            write_control,
            disconnect,
            is_connected
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
