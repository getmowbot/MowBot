//! Updates of the app itself: the GitHub releases, signed with the project's key
//! (tauri-plugin-updater). Checked a little after startup and every few hours; the hub's page
//! offers to install, which restarts the app.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const FIRST_CHECK: Duration = Duration::from_secs(20);
const EVERY: Duration = Duration::from_secs(6 * 3600);

/// The update found by the last check, ready to install.
#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
}

/// A newer version, as the page shows it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
}

/// Download progress, for the page (bytes so far, total when known).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Asks the release feed for a newer version; tells the page when there is one.
pub async fn check(app: &AppHandle) -> Result<Option<Available>, String> {
    let update = app
        .updater()
        .map_err(|e| format!("Mises à jour indisponibles : {e}"))?
        .check()
        .await
        .map_err(|e| format!("Impossible de vérifier les mises à jour : {e}"))?;
    let available = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *app.state::<Updates>().pending.lock().await = update;
    if let Some(found) = &available {
        let _ = app.emit("update-available", found.clone());
    }
    Ok(available)
}

/// Downloads and installs the newer version, then restarts the app on it.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<Updates>().pending.lock().await.take();
    let update = match pending {
        Some(update) => update,
        None => app
            .updater()
            .map_err(|e| format!("Mises à jour indisponibles : {e}"))?
            .check()
            .await
            .map_err(|e| format!("Impossible de vérifier les mises à jour : {e}"))?
            .ok_or_else(|| "MowBot est déjà à jour.".to_string())?,
    };
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                // About every 512 KB: enough for a progress bar.
                if downloaded - reported >= 512 * 1024 || Some(downloaded) == total {
                    reported = downloaded;
                    let _ = progress.emit("update-progress", Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("La mise à jour a échoué : {e}"))?;
    app.restart();
}

/// Checks a little after startup, then every few hours, while the app runs.
pub fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(error) = check(&app).await {
                eprintln!("[mowbot] {error}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}
