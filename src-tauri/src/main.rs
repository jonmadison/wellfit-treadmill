#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ble;

use std::sync::Mutex;

use ble::{BleState, ConnectInfo, DeviceInfo};
use tauri::menu::{CheckMenuItem, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

/// Holds the View > Light Mode item so the frontend can sync its checkmark to
/// the theme it restored from localStorage.
#[derive(Default)]
struct MenuState {
    light: Mutex<Option<CheckMenuItem<Wry>>>,
}

#[tauri::command]
async fn scan_devices(
    state: State<'_, BleState>,
    secs: Option<u64>,
) -> Result<Vec<DeviceInfo>, String> {
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

#[tauri::command]
fn set_light_checked(menu: State<'_, MenuState>, checked: bool) -> Result<(), String> {
    if let Some(item) = menu.light.lock().unwrap().as_ref() {
        item.set_checked(checked).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<CheckMenuItem<Wry>> {
    let light = CheckMenuItem::with_id(app, "toggle-light", "Light Mode", true, false, None::<&str>)?;

    // macOS needs an application submenu for Quit to exist at all.
    let app_menu = Submenu::with_items(
        app,
        "WELLFIT TM",
        true,
        &[
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // Edit menu so Cmd+C works for copying the command log.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(app, "View", true, &[&light])?;

    let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu])?;
    app.set_menu(menu)?;
    Ok(light)
}

fn main() {
    tauri::Builder::default()
        .manage(BleState::default())
        .manage(MenuState::default())
        .setup(|app| {
            let light = build_menu(app.handle())?;
            *app.state::<MenuState>().light.lock().unwrap() = Some(light);
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "toggle-light" {
                let _ = app.emit("ui:toggle-light", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_devices,
            connect,
            write_control,
            disconnect,
            is_connected,
            set_light_checked
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
