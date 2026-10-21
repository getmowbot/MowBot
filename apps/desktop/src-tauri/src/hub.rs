//! The hub the main window shows: its address, the check that it answers, the right of its page to
//! call the app's commands, and where the window may navigate.

use std::time::Duration;

use tauri::ipc::CapabilityBuilder;
use tauri::utils::acl::RemoteUrlPattern;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

pub const MAIN: &str = "main";

/// Commands the hub's page may call (the same as the first-run page, see capabilities/).
const COMMAND_PERMISSIONS: [&str; 9] = [
    "allow-hub-url-get",
    "allow-hub-url-set",
    "allow-hub-change",
    "allow-connector-status",
    "allow-connector-link",
    "allow-connector-unlink",
    "allow-project-pick",
    "allow-project-add",
    "allow-project-remove",
];

/// The window has no frame: the page draws its buttons and moves it (see the web app's
/// `window-controls.tsx` and the first-run page).
pub const WINDOW_PERMISSIONS: [&str; 6] = [
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "core:window:allow-is-maximized",
];

/// A hub address as typed (`mowbot.example.com`, `http://localhost:5173/`…) made canonical:
/// `scheme://host[:port][/base]`, no trailing slash.
pub fn normalize(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Indique l'adresse du hub.".into());
    }
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        let host = input
            .split(['/', ':'])
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let local = host == "localhost"
            || host.ends_with(".local")
            || host.ends_with(".lan")
            || host.parse::<std::net::Ipv4Addr>().is_ok();
        format!("{}://{input}", if local { "http" } else { "https" })
    };
    let url = Url::parse(&with_scheme).map_err(|_| format!("Adresse invalide : {input}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Adresse invalide : {input} (http:// ou https://)"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("Adresse invalide : {input}"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("L'adresse du hub ne doit pas contenir d'identifiants.".into());
    }
    let origin = url.origin().ascii_serialization();
    let base = url.path().trim_end_matches('/');
    Ok(format!("{origin}{base}"))
}

/// `scheme://host[:port]` of a canonical hub address.
pub fn origin(hub: &str) -> Option<String> {
    Url::parse(hub)
        .ok()
        .map(|u| u.origin().ascii_serialization())
}

/// The connectors' WebSocket on this hub.
pub fn ws_url(hub: &str) -> Result<Url, String> {
    let mut url = Url::parse(hub).map_err(|_| format!("Adresse du hub invalide : {hub}"))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|_| format!("Adresse du hub invalide : {hub}"))?;
    let path = format!("{}/api/v1/connectors/ws", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

/// Checks that a MowBot hub answers at `hub` (`GET /api/v1/health`). Returns its address,
/// following a redirect to another origin (http → https).
pub async fn check(hub: &str) -> Result<String, String> {
    let health = format!("{hub}/api/v1/health");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("MowBot-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(&health)
        .send()
        .await
        .map_err(|e| format!("Le hub ne répond pas à {hub} : {}", root_cause(&e)))?;
    let status = response.status();
    let final_url = response.url().clone();
    if !status.is_success() {
        return Err(format!(
            "{health} répond {status} : est-ce bien l'adresse d'un hub MowBot ?"
        ));
    }
    let body: serde_json::Value = response
        .bytes()
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(|| format!("{hub} ne ressemble pas à un hub MowBot."))?;
    if body.get("status").and_then(|s| s.as_str()) != Some("ok") {
        return Err(format!("{hub} ne ressemble pas à un hub MowBot."));
    }
    let final_hub = final_url
        .as_str()
        .strip_suffix("/api/v1/health")
        .map(normalize)
        .transpose()?;
    Ok(final_hub.unwrap_or_else(|| hub.to_string()))
}

fn root_cause(error: &dyn std::error::Error) -> String {
    let mut cause = error;
    while let Some(source) = cause.source() {
        cause = source;
    }
    cause.to_string()
}

/// Lets the hub's page (its origin, in the main window) call the app's commands and hear its
/// events. Capabilities can only be added: an origin granted before stays so until restart.
pub fn grant(app: &AppHandle, hub: &str) -> Result<(), String> {
    let origin = origin(hub).ok_or_else(|| format!("Adresse du hub invalide : {hub}"))?;
    let state = app.state::<AppState>();
    let mut granted = state.granted.lock().unwrap();
    if granted.contains(&origin) {
        return Ok(());
    }
    let pattern = format!("{origin}/*");
    pattern
        .parse::<RemoteUrlPattern>()
        .map_err(|e| format!("Adresse du hub non prise en charge : {hub} ({e})"))?;
    let mut capability = CapabilityBuilder::new(format!("hub-{}", granted.len()))
        .remote(pattern)
        .local(false)
        .window(MAIN)
        .permission("core:event:allow-listen")
        .permission("core:event:allow-unlisten");
    for permission in COMMAND_PERMISSIONS.iter().chain(WINDOW_PERMISSIONS.iter()) {
        capability = capability.permission(*permission);
    }
    app.add_capability(capability)
        .map_err(|e| format!("Impossible d'autoriser le hub : {e}"))?;
    granted.insert(origin);
    Ok(())
}

/// The app's own first-run page.
pub fn setup_page(app: &AppHandle) -> Url {
    if tauri::is_dev() {
        if let Some(dev) = &app.config().build.dev_url {
            if let Ok(url) = dev.join("index.html") {
                return url;
            }
        }
    }
    let base = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    };
    Url::parse(base).expect("static URL")
}

/// Pages of the app itself (first-run page, dev server).
fn is_local(app: &AppHandle, url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (tauri::is_dev()
                    && app
                        .config()
                        .build
                        .dev_url
                        .as_ref()
                        .is_some_and(|dev| dev.origin() == url.origin()))
        }
        _ => false,
    }
}

/// Whether the main window may show `url`: the app's pages and the hub's. Other links open in
/// the user's browser.
fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
    if is_local(app, url) {
        return true;
    }
    let hub = app.state::<AppState>().hub();
    if hub.and_then(|h| origin(&h)).as_deref() == Some(&url.origin().ascii_serialization()) {
        return true;
    }
    if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

/// Creates the main window on the hub, or on the first-run page when there is no hub yet.
pub fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let target = match app
        .state::<AppState>()
        .hub()
        .and_then(|h| Url::parse(&h).ok())
    {
        Some(url) => WebviewUrl::External(url),
        None => WebviewUrl::App("index.html".into()),
    };
    let nav = app.clone();
    let popup = app.clone();
    WebviewWindowBuilder::new(app, MAIN, target)
        .title("MowBot")
        .inner_size(1280.0, 840.0)
        .min_inner_size(420.0, 560.0)
        // No system title bar: the interface has its own buttons (shadow and round corners kept).
        .decorations(false)
        .shadow(true)
        .background_color(tauri::window::Color(6, 7, 10, 255))
        .on_navigation(move |url| allow_navigation(&nav, url))
        .on_new_window(move |url, _features| {
            // Links (`target=_blank`) go to the browser; a blank page a script fills itself
            // (an OAuth sign-in tab) opens as a popup.
            if url.scheme() == "about" {
                return tauri::webview::NewWindowResponse::Allow;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
                let _ = popup.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
}

/// Shows the main window (recreated if it was closed) and brings it to the front.
pub fn show_main(app: &AppHandle) {
    let window = match app.get_webview_window(MAIN) {
        Some(window) => window,
        None => match create_main(app) {
            Ok(window) => window,
            Err(error) => {
                eprintln!("[mowbot] fenêtre : {error}");
                return;
            }
        },
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Sends the main window to `url` and shows it.
pub fn navigate_main(app: &AppHandle, url: Url) {
    match app.get_webview_window(MAIN) {
        Some(window) => {
            let _ = window.navigate(url);
        }
        None => {
            let _ = create_main(app);
        }
    }
    show_main(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_hub_addresses() {
        assert_eq!(
            normalize("mowbot.example.com").unwrap(),
            "https://mowbot.example.com"
        );
        assert_eq!(
            normalize(" https://mowbot.example.com/ ").unwrap(),
            "https://mowbot.example.com"
        );
        assert_eq!(
            normalize("localhost:5173").unwrap(),
            "http://localhost:5173"
        );
        assert_eq!(
            normalize("192.168.1.20:8787").unwrap(),
            "http://192.168.1.20:8787"
        );
        assert_eq!(
            normalize("http://localhost:5173/").unwrap(),
            "http://localhost:5173"
        );
        assert_eq!(
            normalize("https://example.com/mowbot/?x=1#y").unwrap(),
            "https://example.com/mowbot"
        );
        assert_eq!(
            normalize("HTTPS://Example.COM:443").unwrap(),
            "https://example.com"
        );
        assert!(normalize("").is_err());
        assert!(normalize("ftp://example.com").is_err());
        assert!(normalize("file:///C:/x").is_err());
        assert!(normalize("https://user:pass@example.com").is_err());
    }

    #[test]
    fn builds_the_connector_socket_url() {
        assert_eq!(
            ws_url("https://mowbot.example.com").unwrap().as_str(),
            "wss://mowbot.example.com/api/v1/connectors/ws"
        );
        assert_eq!(
            ws_url("http://localhost:5173").unwrap().as_str(),
            "ws://localhost:5173/api/v1/connectors/ws"
        );
        assert_eq!(
            ws_url("https://example.com/mowbot").unwrap().as_str(),
            "wss://example.com/mowbot/api/v1/connectors/ws"
        );
    }

    #[test]
    fn hub_origins_make_valid_remote_patterns() {
        for hub in [
            "https://mowbot.example.com",
            "http://localhost:5173",
            "http://192.168.1.20:8787",
        ] {
            let pattern = format!("{}/*", origin(hub).unwrap());
            let parsed: RemoteUrlPattern = pattern.parse().unwrap();
            assert!(parsed.test(&Url::parse(&format!("{hub}/teams/x?y=1")).unwrap()));
            assert!(!parsed.test(&Url::parse("https://evil.example.com/").unwrap()));
        }
    }
}
