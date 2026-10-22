//! MowBot desktop: the hub's interface in a window, and the connector that lets the hub's bots
//! work in the folders the user shares from this computer (docs/DESKTOP.md).

// No console window in release on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chatgpt;
mod commands;
mod config;
mod connector;
mod hub;
mod ops;
mod state;
mod update;
mod watch;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::state::AppState;

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Ouvrir MowBot", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "change-hub", "Changer de hub", true, None::<&str>)?;
    let updates = MenuItem::with_id(
        app,
        "check-updates",
        "Rechercher des mises à jour",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &change, &updates, &separator, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("MowBot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => hub::show_main(app),
            "change-hub" => hub::navigate_main(app, hub::setup_page(app)),
            "check-updates" => {
                // The page shows what is found (or says it is up to date).
                hub::show_main(app);
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = update::check(&app).await {
                        eprintln!("[mowbot] {error}");
                    }
                });
            }
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

/// `--hub <address>` (or `--hub=<address>`) on the command line: the hub to use from now on,
/// as if typed on the first-run page (an install command can set it this way).
fn hub_argument(args: &[String]) -> Option<String> {
    let value = args.iter().enumerate().find_map(|(i, arg)| {
        arg.strip_prefix("--hub=")
            .map(str::to_string)
            .or_else(|| (arg == "--hub").then(|| args.get(i + 1).cloned()).flatten())
    })?;
    match hub::normalize(&value) {
        Ok(hub) => Some(hub),
        Err(error) => {
            eprintln!("[mowbot] --hub ignoré : {error}");
            None
        }
    }
}

/// Saves the hub given on the command line, lets its page call the app and shows it.
fn use_hub_argument(app: &tauri::AppHandle, args: &[String]) {
    let Some(hub) = hub_argument(args) else {
        return;
    };
    let state = app.state::<AppState>();
    if let Err(error) = state.set_hub(&hub) {
        eprintln!("[mowbot] {error}");
        return;
    }
    state.relink(false);
    if let Err(error) = hub::grant(app, &hub) {
        eprintln!("[mowbot] {error}");
    }
    if let Ok(url) = tauri::Url::parse(&hub) {
        hub::navigate_main(app, url);
    }
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use_hub_argument(app, &argv);
            hub::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::hub_url_get,
            commands::hub_url_set,
            commands::hub_change,
            commands::update_check,
            commands::update_install,
            commands::connector_status,
            commands::connector_link,
            commands::connector_unlink,
            commands::project_pick,
            commands::project_add,
            commands::project_remove,
            commands::chatgpt_sign_in,
            commands::chatgpt_sign_in_cancel,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = app.path().app_config_dir()?;
            app.manage(AppState::new(dir, hub_override()));
            app.manage(update::Updates::default());
            app.manage(chatgpt::Pending::default());
            let args: Vec<String> = std::env::args().collect();
            if let Some(hub) = hub_argument(&args) {
                if let Err(error) = app.state::<AppState>().set_hub(&hub) {
                    eprintln!("[mowbot] {error}");
                }
            }
            if let Some(hub) = app.state::<AppState>().hub() {
                if let Err(error) = hub::grant(&handle, &hub) {
                    eprintln!("[mowbot] {error}");
                }
            }
            hub::create_main(&handle)?;
            create_tray(&handle)?;
            update::watch(handle.clone());
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

#[cfg(test)]
mod tests {
    use super::hub_argument;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_the_hub_from_the_command_line() {
        assert_eq!(
            hub_argument(&args(&["mowbot", "--hub", "mowbot.example.com/"])),
            Some("https://mowbot.example.com".to_string())
        );
        assert_eq!(
            hub_argument(&args(&["mowbot", "--hub=http://localhost:5173"])),
            Some("http://localhost:5173".to_string())
        );
        assert_eq!(hub_argument(&args(&["mowbot"])), None);
        assert_eq!(hub_argument(&args(&["mowbot", "--hub"])), None);
    }
}
