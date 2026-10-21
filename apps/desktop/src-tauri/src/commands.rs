//! Commands the first-run page and the hub's page call (`invoke('connector_status')`…).
//! Results are camelCase JSON; errors are readable French sentences.

use tauri::{AppHandle, Manager, State, Url, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::config::{check_new_project, Project};
use crate::hub;
use crate::state::{emit_status, AppState, Status};

/// The hub the app shows, if any.
#[tauri::command]
pub fn hub_url_get(state: State<'_, AppState>) -> Option<String> {
    state.hub()
}

/// Checks that a MowBot hub answers at `url`, saves it, lets its page call the app and shows it.
/// Returns the saved address.
#[tauri::command]
pub async fn hub_url_set(app: AppHandle, url: String) -> Result<String, String> {
    let hub = hub::check(&hub::normalize(&url)?).await?;
    hub::grant(&app, &hub)?;
    let state = app.state::<AppState>();
    let changed = state.hub().as_deref() != Some(hub.as_str());
    state.set_hub(&hub)?;
    if changed {
        state.connection.lock().unwrap().last_error = None;
    }
    state.relink(false);
    emit_status(&app);
    let target = Url::parse(&hub).map_err(|_| format!("Adresse invalide : {hub}"))?;
    hub::navigate_main(&app, target);
    Ok(hub)
}

/// Shows the first-run page to type another hub's address (it can go back to the current one).
#[tauri::command]
pub fn hub_change(app: AppHandle) {
    hub::navigate_main(&app, hub::setup_page(&app));
}

#[tauri::command]
pub fn connector_status(state: State<'_, AppState>) -> Status {
    state.status()
}

/// Saves the connector's token (given once by the hub when the connector is created) for the
/// current hub, and connects.
#[tauri::command]
pub async fn connector_link(app: AppHandle, token: String) -> Result<Status, String> {
    let state = app.state::<AppState>();
    let hub = state
        .hub()
        .ok_or("Choisis d'abord l'adresse du hub.".to_string())?;
    let token = token.trim();
    if token.is_empty() {
        return Err("Jeton vide.".into());
    }
    if token.chars().any(|c| c.is_whitespace() || c.is_control()) || token.len() > 4096 {
        return Err("Jeton invalide.".into());
    }
    state.tokens.set(&hub, token)?;
    state.connection.lock().unwrap().last_error = None;
    state.relink(true);
    emit_status(&app);
    Ok(state.status())
}

/// Forgets the token of the current hub and disconnects.
#[tauri::command]
pub async fn connector_unlink(app: AppHandle) -> Result<Status, String> {
    let state = app.state::<AppState>();
    if let Some(hub) = state.hub() {
        state.tokens.delete(&hub);
    }
    state.connection.lock().unwrap().last_error = None;
    state.relink(false);
    emit_status(&app);
    Ok(state.status())
}

/// The native folder picker. `None` when cancelled.
#[tauri::command]
pub async fn project_pick(app: AppHandle, window: WebviewWindow) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Dossier à partager avec les bots")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let folder = rx
        .await
        .map_err(|_| "Choix du dossier interrompu.".to_string())?;
    Ok(folder
        .and_then(|f| f.into_path().ok())
        .map(|p| dunce::simplified(&p).display().to_string()))
}

/// Shares a folder with the hub's bots.
#[tauri::command]
pub async fn project_add(app: AppHandle, name: String, path: String) -> Result<Project, String> {
    let state = app.state::<AppState>();
    let home = app.path().home_dir().ok();
    let project = {
        let mut config = state.config.lock().unwrap();
        let (name, canonical) = check_new_project(&name, &path, &config.projects, home.as_deref())?;
        let project = Project {
            key: uuid::Uuid::new_v4().to_string(),
            name,
            path: canonical.display().to_string(),
        };
        config.projects.push(project.clone());
        if let Err(error) = config.save(&state.dir) {
            config.projects.pop();
            return Err(error);
        }
        project
    };
    state.send(state.projects_message());
    emit_status(&app);
    Ok(project)
}

/// Stops sharing a folder.
#[tauri::command]
pub async fn project_remove(app: AppHandle, key: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    {
        let mut config = state.config.lock().unwrap();
        let before = config.projects.clone();
        config.projects.retain(|p| p.key != key);
        if config.projects.len() == before.len() {
            return Err("Ce projet n'est pas partagé sur cet ordinateur.".into());
        }
        if let Err(error) = config.save(&state.dir) {
            config.projects = before;
            return Err(error);
        }
    }
    state.send(state.projects_message());
    emit_status(&app);
    Ok(())
}
