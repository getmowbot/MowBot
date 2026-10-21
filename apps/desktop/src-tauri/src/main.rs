//! MowBot desktop: the hub's interface in a window, and the connector that lets the hub's bots
//! work in the folders the user shares from this computer (docs/DESKTOP.md).

// No console window in release on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod connector;
mod hub;
mod ops;
mod state;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::state::AppState;

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Ouvrir MowBot", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "change-hub", "Changer de hub", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &change, &separator, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("MowBot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => hub::show_main(app),
            "change-hub" => hub::navigate_main(app, hub::setup_page(app)),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                hub::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// `MOWBOT_HUB_URL` shows that hub instead of the saved one (handy in development).
fn hub_override() -> Option<String> {
    let value = std::env::var("MOWBOT_HUB_URL").ok()?;
    if value.trim().is_empty() {
        return None;
    }
    match hub::normalize(&value) {
        Ok(hub) => Some(hub),
        Err(error) => {
            eprintln!("[mowbot] MOWBOT_HUB_URL ignoré : {error}");
            None
        }
    }
}

fn main() {
    tauri::Builder::default()
        // First: a second launch only brings the running app to the front.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            hub::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::hub_url_get,
            commands::hub_url_set,
            commands::connector_status,
            commands::connector_link,
            commands::connector_unlink,
            commands::project_pick,
            commands::project_add,
            commands::project_remove,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = app.path().app_config_dir()?;
            app.manage(AppState::new(dir, hub_override()));
            if let Some(hub) = app.state::<AppState>().hub() {
                if let Err(error) = hub::grant(&handle, &hub) {
                    eprintln!("[mowbot] {error}");
                }
            }
            hub::create_main(&handle)?;
            create_tray(&handle)?;
            tauri::async_runtime::spawn(connector::run(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to the tray: the connector keeps serving the bots.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == hub::MAIN {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start MowBot")
        .run(|app, event| match event {
            // Only "Quitter" (an explicit exit code) ends the app.
            RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => hub::show_main(app),
            _ => {
                let _ = app;
            }
        });
}
