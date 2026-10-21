//! The app's shared state: config, the hub shown, the connector's link and connection.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};

use crate::config::{Config, Project, Tokens};

/// Event the pages hear when the connector's status changes (payload: [`Status`]).
pub const STATUS_EVENT: &str = "connector-status";

/// Where the connector connects, with what: it reconnects whenever this changes.
#[derive(Clone, PartialEq, Eq)]
pub struct Link {
    pub hub: String,
    pub token: String,
}

#[derive(Default)]
pub struct Connection {
    pub connected: bool,
    pub last_error: Option<String>,
    /// Messages to the hub, while connected.
    pub outbox: Option<mpsc::UnboundedSender<String>>,
}

pub struct AppState {
    pub dir: PathBuf,
    pub config: Mutex<Config>,
    pub tokens: Tokens,
    /// The hub shown (`MOWBOT_HUB_URL` wins over the config at startup).
    hub: Mutex<Option<String>>,
    pub link: watch::Sender<Option<Link>>,
    pub connection: Mutex<Connection>,
    /// Origins whose page may call the app's commands.
    pub granted: Mutex<HashSet<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub linked: bool,
    pub connected: bool,
    pub hub_url: Option<String>,
    pub hostname: String,
    pub os: &'static str,
    pub shell: String,
    pub version: &'static str,
    pub projects: Vec<Project>,
    pub last_error: Option<String>,
}

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub fn hostname() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "ordinateur".into())
}

impl AppState {
    pub fn new(dir: PathBuf, hub_override: Option<String>) -> Self {
        let config = Config::load(&dir);
        let hub = hub_override.or_else(|| config.hub_url.clone());
        let tokens = Tokens::new(&dir);
        let link = hub.as_ref().and_then(|hub| {
            tokens.get(hub).map(|token| Link {
                hub: hub.clone(),
                token,
            })
        });
        Self {
            config: Mutex::new(config),
            tokens,
            hub: Mutex::new(hub),
            link: watch::Sender::new(link),
            connection: Mutex::new(Connection::default()),
            granted: Mutex::new(HashSet::new()),
            dir,
        }
    }

    pub fn hub(&self) -> Option<String> {
        self.hub.lock().unwrap().clone()
    }

    pub fn set_hub(&self, hub: &str) -> Result<(), String> {
        *self.hub.lock().unwrap() = Some(hub.to_string());
        let mut config = self.config.lock().unwrap();
        config.hub_url = Some(hub.to_string());
        config.save(&self.dir)
    }

    pub fn projects(&self) -> Vec<Project> {
        self.config.lock().unwrap().projects.clone()
    }

    /// Points the connector at the current hub with its token. `force` reconnects even when
    /// nothing changed (a token pasted again).
    pub fn relink(&self, force: bool) {
        let link = self
            .hub()
            .and_then(|hub| self.tokens.get(&hub).map(|token| Link { hub, token }));
        if force {
            self.link.send_replace(link);
        } else {
            self.link.send_if_modified(|current| {
                if *current == link {
                    return false;
                }
                *current = link;
                true
            });
        }
    }

    pub fn status(&self) -> Status {
        let connection = self.connection.lock().unwrap();
        Status {
            linked: self.link.borrow().is_some(),
            connected: connection.connected,
            hub_url: self.hub(),
            hostname: hostname(),
            os: os_name(),
            shell: crate::ops::shell_name(),
            version: env!("CARGO_PKG_VERSION"),
            projects: self.projects(),
            last_error: connection.last_error.clone(),
        }
    }

    /// Sends a message to the hub if connected.
    pub fn send(&self, message: String) {
        if let Some(outbox) = &self.connection.lock().unwrap().outbox {
            let _ = outbox.send(message);
        }
    }

    /// The shared folders, as the hub hears them.
    pub fn projects_message(&self) -> String {
        serde_json::json!({ "t": "projects", "projects": self.projects() }).to_string()
    }
}

/// Tells the pages the connector's status changed.
pub fn emit_status(app: &AppHandle) {
    let status = app.state::<AppState>().status();
    let _ = app.emit(STATUS_EVENT, status);
}
