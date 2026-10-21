//! The connector: an outgoing WebSocket to the hub (`/api/v1/connectors/ws`) that announces the
//! shared folders and answers the hub's requests on them (docs/DESKTOP.md).

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, watch};
use tokio::time::{sleep, timeout, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::hub;
use crate::state::{emit_status, AppState, Link};

/// Close code of the hub when the token is revoked (the connector was deleted).
const REVOKED_CLOSE_CODE: u16 = 4401;
/// Shown when the hub refuses the token (HTTP 401 or close code 4401): it is forgotten.
const REFUSED_TOKEN: &str = "Le hub refuse ce jeton (connecteur supprimé ou jeton erroné) : \
     relie l'app à nouveau depuis la page Projets.";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// The hub pings every 25 s: past this silence the connection is dead.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(70);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
struct Request {
    id: String,
    op: String,
    project: String,
    #[serde(default)]
    args: Value,
}

/// How a connection ended.
enum End {
    /// The link changed (hub, token): connect again right away, or not at all.
    Relink,
    /// The token was revoked on the hub.
    Revoked,
    /// Lost; `bool`: it had been connected (the backoff starts over).
    Lost(String, bool),
}

/// Runs for the app's whole life.
pub async fn run(app: AppHandle) {
    let mut links = app.state::<AppState>().link.subscribe();
    loop {
        let link = links.borrow_and_update().clone();
        let Some(link) = link else {
            // Not linked: offline, the last error (a revoked token) stays shown.
            let error = app
                .state::<AppState>()
                .connection
                .lock()
                .unwrap()
                .last_error
                .clone();
            set_connection(&app, false, error);
            if links.changed().await.is_err() {
                return;
            }
            continue;
        };
        let mut backoff = BACKOFF_MIN;
        loop {
            match session(&app, &link, &mut links).await {
                End::Relink => break,
                End::Revoked => {
                    let state = app.state::<AppState>();
                    state.tokens.delete(&link.hub);
                    set_connection(&app, false, Some(REFUSED_TOKEN.into()));
                    state.relink(false);
                    break;
                }
                End::Lost(error, was_connected) => {
                    if was_connected {
                        backoff = BACKOFF_MIN;
                    }
                    set_connection(&app, false, Some(error));
                    tokio::select! {
                        _ = sleep(backoff) => {}
                        changed = links.changed() => {
                            if changed.is_err() {
                                return;
                            }
                            break;
                        }
                    }
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                }
            }
        }
    }
}

fn set_connection(app: &AppHandle, connected: bool, error: Option<String>) {
    {
        let state = app.state::<AppState>();
        let mut connection = state.connection.lock().unwrap();
        if connection.connected == connected && connection.last_error == error {
            return;
        }
        connection.connected = connected;
        connection.last_error = error;
        if !connected {
            connection.outbox = None;
        }
    }
    emit_status(app);
}

async fn session(app: &AppHandle, link: &Link, links: &mut watch::Receiver<Option<Link>>) -> End {
    let request = match request(link) {
        Ok(request) => request,
        Err(error) => return End::Lost(error, false),
    };
    let connecting = timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request));
    let socket = tokio::select! {
        result = connecting => match result {
            Err(_) => return End::Lost("Le hub ne répond pas (délai dépassé).".into(), false),
            Ok(Err(WsError::Http(response))) if response.status() == StatusCode::UNAUTHORIZED => {
                return End::Revoked;
            }
            Ok(Err(error)) => return End::Lost(connect_error(&error), false),
            Ok(Ok((socket, _))) => socket,
        },
        _ = links.changed() => return End::Relink,
    };
    let (mut sink, mut stream) = socket.split();
    let (outbox, mut outgoing) = mpsc::unbounded_channel::<String>();

    let state = app.state::<AppState>();
    let hello = json!({
        "t": "hello",
        "version": env!("CARGO_PKG_VERSION"),
        "hostname": crate::state::hostname(),
        "os": crate::state::os_name(),
        "shell": crate::ops::shell_name(),
        "projects": state.projects(),
    });
    if let Err(error) = sink.send(Message::text(hello.to_string())).await {
        return End::Lost(format!("Connexion au hub perdue : {error}"), false);
    }
    state.connection.lock().unwrap().outbox = Some(outbox.clone());
    set_connection(app, true, None);

    let mut deadline = Instant::now() + SILENCE_TIMEOUT;
    let end = loop {
        tokio::select! {
            incoming = stream.next() => {
                deadline = Instant::now() + SILENCE_TIMEOUT;
                match incoming {
                    Some(Ok(Message::Text(text))) => handle(app, text.as_str(), &outbox),
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code));
                        if code == Some(REVOKED_CLOSE_CODE) {
                            break End::Revoked;
                        }
                        let reason = frame
                            .map(|f| f.reason.to_string())
                            .filter(|r| !r.is_empty())
                            .unwrap_or_else(|| "connexion fermée".into());
                        break End::Lost(format!("Le hub a fermé la connexion ({reason})."), true);
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => break End::Lost(format!("Connexion au hub perdue : {error}"), true),
                    None => break End::Lost("Connexion au hub perdue.".into(), true),
                }
            }
            Some(message) = outgoing.recv() => {
                if let Err(error) = sink.send(Message::text(message)).await {
                    break End::Lost(format!("Connexion au hub perdue : {error}"), true);
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                break End::Lost("Le hub ne répond plus.".into(), true);
            }
            _ = links.changed() => {
                let _ = sink
                    .send(Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: CloseCode::Normal,
                        reason: "".into(),
                    })))
                    .await;
                break End::Relink;
            }
        }
    };
    state.connection.lock().unwrap().outbox = None;
    end
}

fn request(
    link: &Link,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    let url = hub::ws_url(&link.hub)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("Adresse du hub invalide : {e}"))?;
    let bearer = HeaderValue::from_str(&format!("Bearer {}", link.token))
        .map_err(|_| "Le jeton du connecteur contient des caractères invalides.".to_string())?;
    let headers = request.headers_mut();
    headers.insert(header::AUTHORIZATION, bearer);
    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static(concat!("MowBot-Desktop/", env!("CARGO_PKG_VERSION"))),
    );
    Ok(request)
}

fn connect_error(error: &WsError) -> String {
    match error {
        WsError::Http(response) => format!("Le hub a refusé la connexion ({}).", response.status()),
        WsError::Io(io) => format!("Hub injoignable : {io}"),
        WsError::Tls(tls) => format!("Connexion sécurisée impossible : {tls}"),
        other => format!("Connexion au hub impossible : {other}"),
    }
}

/// A message from the hub: requests are answered concurrently, each in its own task.
fn handle(app: &AppHandle, text: &str, outbox: &mpsc::UnboundedSender<String>) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if value.get("t").and_then(Value::as_str) != Some("req") {
        return;
    }
    let Ok(request) = serde_json::from_value::<Request>(value) else {
        return;
    };
    let app = app.clone();
    let outbox = outbox.clone();
    tauri::async_runtime::spawn(async move {
        let project = app
            .state::<AppState>()
            .projects()
            .into_iter()
            .find(|p| p.key == request.project);
        let result = match project {
            Some(project) => crate::ops::run(&request.op, &project.path, request.args).await,
            None => Err(format!(
                "Projet inconnu sur cet ordinateur : {} (le dossier n'est plus partagé ?)",
                request.project
            )),
        };
        let response = match result {
            Ok(data) => json!({ "t": "res", "id": request.id, "ok": true, "data": data }),
            Err(error) => json!({ "t": "res", "id": request.id, "ok": false, "error": error }),
        };
        let _ = outbox.send(response.to_string());
    });
}
