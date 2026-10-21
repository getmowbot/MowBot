//! "Sign in with ChatGPT" for the hub (docs/DESKTOP.md). OpenAI sends the browser back to a
//! loopback address (`http://127.0.0.1:<port>/auth/callback`), which only reaches the computer
//! running the browser: the OAuth runs here, and the hub's page hands the tokens to the hub, the
//! host that uses them (developers.openai.com/siwc, "Self-hosted VMs"). Nothing is kept here.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use url::Url;

use crate::hub::root_cause;

pub const AUTH_URL: &str = "https://auth.openai.com";
pub const CALLBACK_PATH: &str = "/auth/callback";
/// The port of OpenAI's examples; another free one when it is taken (only the port may vary).
pub const PREFERRED_PORT: u16 = 1455;
/// How long the browser has to come back.
pub const TIMEOUT: Duration = Duration::from_secs(300);
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// Without it the sign-in does not allow using the ChatGPT plan.
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const RESOURCE: &str = "https://api.openai.com/v1";
/// The client of a first sign-in; OpenAI issues the real one (`oaiapp_…`) in the callback.
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const MAX_REQUEST: usize = 16 * 1024;

/// What the hub's page asks for (`invoke('chatgpt_sign_in', { request })`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInRequest {
    /// The hub's `ext_agent_host_id` (the hub is the host that uses the tokens).
    pub host_id: String,
    /// `agent_name_hint` of a first sign-in.
    pub agent_name: String,
    /// The client OpenAI issued, to sign in again (none: a new registration).
    pub client_id: Option<String>,
    /// The account's email, to sign in again.
    pub login_hint: Option<String>,
    /// Language of the page the browser shows at the end (`fr`, `en`).
    pub lang: Option<String>,
}

/// What the page hands to the hub (`chatgpt` of `POST /providers`), once.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub client_id: String,
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub scope: String,
    pub nonce: String,
    pub earliest_refresh_at: Option<Value>,
}

/// A sign-in that did not end with tokens: `code` for the page to word it, OpenAI's `detail`
/// when there is one, and the client OpenAI issued, if any, to retry with it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignInError {
    pub code: &'static str,
    pub detail: Option<String>,
    pub client_id: Option<String>,
}

impl SignInError {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            detail: None,
            client_id: None,
        }
    }

    fn with(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::new(code)
        }
    }

    fn for_client(mut self, client_id: &str) -> Self {
        self.client_id = Some(client_id.to_string());
        self
    }
}

/// Where and how long to wait (tests use a fake OpenAI and any port).
pub struct Config {
    pub auth_url: String,
    pub port: u16,
    pub timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            auth_url: AUTH_URL.into(),
            port: PREFERRED_PORT,
            timeout: TIMEOUT,
        }
    }
}

/// The secrets of one attempt: `state` (the callback is ours), `nonce` (the ID token is for this
/// sign-in) and the PKCE verifier (only we can exchange the code).
pub struct Attempt {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
}

impl Attempt {
    pub fn new() -> Result<Self, SignInError> {
        Ok(Self {
            state: random_string()?,
            nonce: random_string()?,
            verifier: random_string()?,
        })
    }
}

/// 32 random bytes, base64url (43 characters: also a valid PKCE verifier).
fn random_string() -> Result<String, SignInError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| SignInError::with("failed", e.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// PKCE S256: base64url (no padding) of the SHA-256 of the verifier.
pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn printable(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

/// An opaque host id in one of the accepted forms.
fn valid_host_id(id: &str) -> bool {
    [
        "urn:uuid:",
        "urn:ietf:params:oauth:jwk-thumbprint:",
        "did:key:",
    ]
    .iter()
    .any(|prefix| id.starts_with(prefix))
        && id.len() <= 200
        && id.chars().all(|c| c.is_ascii_graphic())
}

fn valid_client_id(id: &str) -> bool {
    id != DYNAMIC_CLIENT
        && !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

fn check_request(request: &SignInRequest) -> Result<(), SignInError> {
    let invalid = |what: &str| SignInError::with("invalid_request", what);
    if !valid_host_id(&request.host_id) {
        return Err(invalid("hostId"));
    }
    if !printable(&request.agent_name, 60) {
        return Err(invalid("agentName"));
    }
    if request
        .client_id
        .as_deref()
        .is_some_and(|id| !valid_client_id(id))
    {
        return Err(invalid("clientId"));
    }
    if request
        .login_hint
        .as_deref()
        .is_some_and(|hint| !printable(hint, 320))
    {
        return Err(invalid("loginHint"));
    }
    Ok(())
}

/// The authorization URL: a new registration (`dynamic_agent_client` + `agent_name_hint`) or a
/// sign-in again with the issued client (and the account's email as `login_hint`).
pub fn authorize_url(
    auth_url: &str,
    request: &SignInRequest,
    attempt: &Attempt,
    redirect_uri: &str,
) -> Result<Url, SignInError> {
    let mut url = Url::parse(&format!(
        "{}/api/accounts/authorize",
        auth_url.trim_end_matches('/')
    ))
    .map_err(|e| SignInError::with("failed", e.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        match &request.client_id {
            Some(client_id) => {
                query.append_pair("client_id", client_id);
                if let Some(hint) = &request.login_hint {
                    query.append_pair("login_hint", hint);
                }
            }
            None => {
                query.append_pair("client_id", DYNAMIC_CLIENT);
                query.append_pair("agent_name_hint", &request.agent_name);
            }
        }
        query
            .append_pair("ext_agent_host_id", &request.host_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &attempt.state)
            .append_pair("nonce", &attempt.nonce)
            .append_pair("code_challenge", &code_challenge(&attempt.verifier))
            .append_pair("code_challenge_method", "S256");
    }
    Ok(url)
}

/// The query of OpenAI's redirect to the loopback address.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub client_id: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// The callback in an HTTP request head (`GET /auth/callback?… HTTP/1.1`); `None` for anything
/// else (a favicon…).
pub fn parse_callback(head: &str) -> Option<Callback> {
    let mut parts = head.lines().next()?.split(' ');
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    if !target.starts_with('/') {
        return None;
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != CALLBACK_PATH {
        return None;
    }
    let mut callback = Callback::default();
    for (key, value) in url.query_pairs() {
        let value = Some(value.into_owned());
        match key.as_ref() {
            "code" => callback.code = value,
            "state" => callback.state = value,
            "client_id" => callback.client_id = value,
            "scope" => callback.scope = value,
            "error" => callback.error = value,
            "error_description" => callback.error_description = value,
            _ => {}
        }
    }
    Some(callback)
}

/// A code to exchange, and the client to exchange it for.
#[derive(Debug, PartialEq, Eq)]
pub struct Grant {
    pub code: String,
    pub client_id: String,
    pub scope: Option<String>,
}

/// What a callback means for this attempt. `None`: not ours (another state), keep waiting.
pub fn check_callback(
    callback: &Callback,
    state: &str,
    expected_client: Option<&str>,
) -> Option<Result<Grant, SignInError>> {
    if callback.state.as_deref() != Some(state) {
        return None;
    }
    if let Some(error) = &callback.error {
        let code = if error == "access_denied" {
            "denied"
        } else {
            "failed"
        };
        let detail = callback
            .error_description
            .clone()
            .unwrap_or_else(|| error.clone());
        return Some(Err(SignInError::with(code, detail)));
    }
    let Some(code) = callback.code.clone().filter(|c| !c.is_empty()) else {
        return Some(Err(SignInError::new("incomplete")));
    };
    let client_id = match (expected_client, callback.client_id.as_deref()) {
        // Signing in again: the callback may leave the client out, never change it.
        (Some(expected), None) => expected.to_string(),
        (Some(expected), Some(got)) if got == expected => expected.to_string(),
        (Some(_), Some(_)) => return Some(Err(SignInError::new("other_client"))),
        // A new registration is complete only with the client OpenAI issued.
        (None, Some(got)) if valid_client_id(got) => got.to_string(),
        (None, _) => return Some(Err(SignInError::new("incomplete"))),
    };
    Some(Ok(Grant {
        code,
        client_id,
        scope: callback.scope.clone(),
    }))
}

/// The `nonce` claim of an ID token (the hub checks its signature; here only that it is ours).
pub fn id_token_nonce(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("nonce")?.as_str().map(str::to_string)
}

/// The credential in a token response, if it allows using the ChatGPT plan.
pub fn credential(token: &Value, grant: &Grant, nonce: &str) -> Result<Credential, SignInError> {
    let text = |key: &str| {
        token
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let (Some(access_token), Some(refresh_token), Some(id_token)) = (
        text("access_token"),
        text("refresh_token"),
        text("id_token"),
    ) else {
        return Err(
            SignInError::with("exchange", "incomplete token response").for_client(&grant.client_id)
        );
    };
    let scope = text("scope")
        .or_else(|| grant.scope.clone())
        .unwrap_or_default();
    if !scope.split_whitespace().any(|s| s == PLAN_SCOPE) {
        return Err(SignInError::new("plan_not_granted").for_client(&grant.client_id));
    }
    if id_token_nonce(&id_token).as_deref() != Some(nonce) {
        return Err(SignInError::new("nonce").for_client(&grant.client_id));
    }
    Ok(Credential {
        client_id: grant.client_id.clone(),
        id_token,
        access_token,
        refresh_token,
        expires_in: token
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(3600),
        scope,
        nonce: nonce.to_string(),
        earliest_refresh_at: token
            .get("earliest_refresh_at")
            .filter(|v| !v.is_null())
            .cloned(),
    })
}

/// OpenAI's error code in a refused answer (`{"error": "…"}` or `{"error": {"code": "…"}}`).
fn error_code(body: &Value) -> Option<String> {
    let error = body.get("error")?;
    error
        .as_str()
        .or_else(|| error.get("code").and_then(Value::as_str))
        .map(str::to_string)
}

/// The `authorization_code` grant (PKCE, no secret), with the same redirect URI and resource.
async fn exchange(
    client: &reqwest::Client,
    auth_url: &str,
    grant: &Grant,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Value, SignInError> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("client_id", &grant.client_id)
        .append_pair("code", &grant.code)
        .append_pair("code_verifier", verifier)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("resource", RESOURCE)
        .finish();
    let response = client
        .post(format!(
            "{}/api/accounts/oauth/token",
            auth_url.trim_end_matches('/')
        ))
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| {
            SignInError::with("unreachable", root_cause(&e)).for_client(&grant.client_id)
        })?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| {
        SignInError::with("unreachable", root_cause(&e)).for_client(&grant.client_id)
    })?;
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = error_code(&value).unwrap_or_else(|| format!("HTTP {status}"));
        return Err(SignInError::with("exchange", detail).for_client(&grant.client_id));
    }
    Ok(value)
}

/// 127.0.0.1 on the preferred port, or on any free one.
async fn listen(port: u16) -> Result<TcpListener, SignInError> {
    match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => Ok(listener),
        Err(_) if port != 0 => TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| SignInError::with("listen", e.to_string())),
        Err(error) => Err(SignInError::with("listen", error.to_string())),
    }
}

/// The request head (up to the blank line), or `None` if the browser says nothing.
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..read]);
        if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() > MAX_REQUEST {
            break;
        }
    }
    String::from_utf8(head).ok()
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         Referrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// The page the browser shows at the end, in the hub page's language.
struct Page {
    english: bool,
}

impl Page {
    fn new(lang: Option<&str>) -> Self {
        Self {
            english: lang.is_some_and(|l| l.starts_with("en")),
        }
    }

    fn html(&self, title: &str, text: &str) -> String {
        let lang = if self.english { "en" } else { "fr" };
        format!(
            "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
             <title>{title} · MowBot</title><style>\
             body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#06070a;\
             color:#f2f3f5;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}}\
             main{{max-width:26rem;margin:1rem;padding:2rem;border:1px solid #23262d;\
             border-radius:1rem;background:#0d0f13}}h1{{margin:0 0 .5rem;font-size:1.25rem}}\
             p{{margin:0;color:#a1a6b0}}</style></head><body><main><h1>{title}</h1>\
             <p>{text}</p></main></body></html>",
            title = escape(title),
            text = escape(text),
        )
    }

    fn done(&self) -> String {
        if self.english {
            self.html(
                "Signed in with ChatGPT",
                "You can close this page and go back to MowBot.",
            )
        } else {
            self.html(
                "Connecté avec ChatGPT",
                "Tu peux fermer cette page et revenir dans MowBot.",
            )
        }
    }

    fn denied(&self) -> String {
        if self.english {
            self.html(
                "Sign-in cancelled",
                "Nothing was shared with MowBot. You can close this page.",
            )
        } else {
            self.html(
                "Connexion annulée",
                "Rien n'a été partagé avec MowBot. Tu peux fermer cette page.",
            )
        }
    }

    fn failed(&self, error: &SignInError) -> String {
        let detail = error.detail.as_deref().unwrap_or(error.code);
        if self.english {
            self.html(
                "Couldn't sign in",
                &format!("{detail}. Go back to MowBot to try again."),
            )
        } else {
            self.html(
                "Connexion impossible",
                &format!("{detail}. Reviens dans MowBot pour réessayer."),
            )
        }
    }

    fn stale(&self) -> String {
        if self.english {
            self.html(
                "Expired link",
                "This page doesn't match the sign-in MowBot is waiting for.",
            )
        } else {
            self.html(
                "Lien expiré",
                "Cette page ne correspond pas à la connexion qu'attend MowBot.",
            )
        }
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The whole sign-in: loopback listener first, then the browser on OpenAI's page, then the
/// callback (state checked), the code exchange and the checks of what came back. Ends after
/// `config.timeout`, or when `cancel` fires (or is dropped).
pub async fn sign_in<F>(
    config: &Config,
    request: SignInRequest,
    open: F,
    cancel: oneshot::Receiver<()>,
) -> Result<Credential, SignInError>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    check_request(&request)?;
    let attempt = Attempt::new()?;
    let listener = listen(config.port).await?;
    let port = listener
        .local_addr()
        .map_err(|e| SignInError::with("listen", e.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let url = authorize_url(&config.auth_url, &request, &attempt, &redirect_uri)?;
    let mut client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("MowBot-Desktop/", env!("CARGO_PKG_VERSION")));
    if Url::parse(&config.auth_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h == "127.0.0.1" || h == "localhost"))
        .unwrap_or(false)
    {
        client = client.no_proxy();
    }
    let client = client
        .build()
        .map_err(|e| SignInError::with("failed", e.to_string()))?;
    open(url.as_str()).map_err(|e| SignInError::with("browser", e))?;

    let page = Page::new(request.lang.as_deref());
    let wait = async {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            let Some(head) = read_head(&mut stream).await else {
                continue;
            };
            let Some(callback) = parse_callback(&head) else {
                respond(&mut stream, "404 Not Found", "").await;
                continue;
            };
            let Some(checked) =
                check_callback(&callback, &attempt.state, request.client_id.as_deref())
            else {
                respond(&mut stream, "400 Bad Request", &page.stale()).await;
                continue;
            };
            let result = match checked {
                Ok(grant) => exchange(
                    &client,
                    &config.auth_url,
                    &grant,
                    &attempt.verifier,
                    &redirect_uri,
                )
                .await
                .and_then(|token| credential(&token, &grant, &attempt.nonce)),
                Err(error) => Err(error),
            };
            let body = match &result {
                Ok(_) => page.done(),
                Err(error) if error.code == "denied" => page.denied(),
                Err(error) => page.failed(error),
            };
            respond(&mut stream, "200 OK", &body).await;
            return result;
        }
    };
    tokio::select! {
        result = wait => result,
        _ = tokio::time::sleep(config.timeout) => Err(SignInError::new("timeout")),
        _ = cancel => Err(SignInError::new("cancelled")),
    }
}

/// One sign-in at a time: a new one (or the page's cancel button) ends the one waiting.
#[derive(Default)]
pub struct Pending {
    current: Mutex<Option<(u64, oneshot::Sender<()>)>>,
    next: AtomicU64,
}

impl Pending {
    /// Cancels the sign-in waiting, if any, and registers a new one.
    pub fn start(&self) -> (u64, oneshot::Receiver<()>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        if let Some((_, previous)) = self.current.lock().unwrap().replace((id, tx)) {
            let _ = previous.send(());
        }
        (id, rx)
    }

    /// The sign-in `id` ended.
    pub fn finish(&self, id: u64) {
        let mut current = self.current.lock().unwrap();
        if current.as_ref().is_some_and(|(current, _)| *current == id) {
            *current = None;
        }
    }

    pub fn cancel(&self) {
        if let Some((_, sender)) = self.current.lock().unwrap().take() {
            let _ = sender.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn request(client_id: Option<&str>) -> SignInRequest {
        SignInRequest {
            host_id: "urn:uuid:6f1c2b8e-0d7a-4c55-9a3e-1b2c3d4e5f60".into(),
            agent_name: "MowBot".into(),
            client_id: client_id.map(str::to_string),
            login_hint: client_id.map(|_| "joris@example.com".to_string()),
            lang: Some("en".into()),
        }
    }

    fn attempt() -> Attempt {
        Attempt {
            state: "the-state".into(),
            nonce: "the-nonce".into(),
            verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into(),
        }
    }

    fn query(url: &Url) -> std::collections::HashMap<String, String> {
        url.query_pairs().into_owned().collect()
    }

    fn id_token(nonce: &str) -> String {
        let part = |value: Value| URL_SAFE_NO_PAD.encode(value.to_string());
        format!(
            "{}.{}.sig",
            part(serde_json::json!({ "alg": "RS256" })),
            part(serde_json::json!({ "sub": "user-1", "nonce": nonce }))
        )
    }

    #[test]
    fn pkce_follows_rfc_7636() {
        // RFC 7636, appendix B.
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let a = Attempt::new().unwrap();
        let b = Attempt::new().unwrap();
        assert_eq!(a.verifier.len(), 43);
        assert!(a
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(a.state, b.state);
        assert_ne!(a.state, a.nonce);
        assert_ne!(a.verifier, b.verifier);
    }

    #[test]
    fn builds_the_authorization_url_of_a_new_registration() {
        let url = authorize_url(
            "https://auth.openai.com",
            &request(None),
            &attempt(),
            "http://127.0.0.1:1455/auth/callback",
        )
        .unwrap();
        assert_eq!(
            format!("{}{}", url.origin().ascii_serialization(), url.path()),
            "https://auth.openai.com/api/accounts/authorize"
        );
        let q = query(&url);
        assert_eq!(q["client_id"], "dynamic_agent_client");
        assert_eq!(q["agent_name_hint"], "MowBot");
        assert_eq!(
            q["ext_agent_host_id"],
            "urn:uuid:6f1c2b8e-0d7a-4c55-9a3e-1b2c3d4e5f60"
        );
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:1455/auth/callback");
        assert_eq!(
            q["scope"],
            "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
        );
        assert_eq!(q["resource"], "https://api.openai.com/v1");
        assert_eq!(q["state"], "the-state");
        assert_eq!(q["nonce"], "the-nonce");
        assert_eq!(
            q["code_challenge"],
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(!q.contains_key("login_hint"));
    }

    #[test]
    fn signs_in_again_with_the_issued_client() {
        let url = authorize_url(
            "https://auth.openai.com/",
            &request(Some("oaiapp_123")),
            &attempt(),
            "http://127.0.0.1:54321/auth/callback",
        )
        .unwrap();
        let q = query(&url);
        assert_eq!(q["client_id"], "oaiapp_123");
        assert_eq!(q["login_hint"], "joris@example.com");
        assert!(!q.contains_key("agent_name_hint"));
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:54321/auth/callback");
    }

    #[test]
    fn refuses_odd_requests() {
        let mut bad = request(None);
        bad.host_id = "laptop-of-joris".into();
        assert_eq!(check_request(&bad).unwrap_err().code, "invalid_request");
        let mut bad = request(Some("dynamic_agent_client"));
        assert!(check_request(&bad).is_err());
        bad.client_id = Some("oaiapp_1&x=y".into());
        assert!(check_request(&bad).is_err());
        assert!(check_request(&request(Some("oaiapp_123"))).is_ok());
        assert!(check_request(&request(None)).is_ok());
    }

    #[test]
    fn parses_the_callback() {
        let head = "GET /auth/callback?code=c%2F1&state=the-state&client_id=oaiapp_9&scope=openid+chatgpt.tokens.use.direct HTTP/1.1\r\nHost: 127.0.0.1:1455\r\n\r\n";
        assert_eq!(
            parse_callback(head),
            Some(Callback {
                code: Some("c/1".into()),
                state: Some("the-state".into()),
                client_id: Some("oaiapp_9".into()),
                scope: Some("openid chatgpt.tokens.use.direct".into()),
                ..Callback::default()
            })
        );
        let denied =
            parse_callback("GET /auth/callback?error=access_denied&state=s HTTP/1.1\r\n\r\n")
                .unwrap();
        assert_eq!(denied.error.as_deref(), Some("access_denied"));
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1\r\n\r\n"), None);
        assert_eq!(
            parse_callback("GET /callback?code=x HTTP/1.1\r\n\r\n"),
            None
        );
        assert_eq!(
            parse_callback("POST /auth/callback?code=x HTTP/1.1\r\n\r\n"),
            None
        );
        assert_eq!(parse_callback(""), None);
    }

    #[test]
    fn checks_the_callback_against_the_attempt() {
        let callback = |state: &str, client: Option<&str>| Callback {
            code: Some("code-1".into()),
            state: Some(state.into()),
            client_id: client.map(str::to_string),
            scope: None,
            ..Callback::default()
        };
        // Another attempt's: not ours.
        assert_eq!(
            check_callback(&callback("old", Some("oaiapp_1")), "s", None),
            None
        );
        assert_eq!(
            check_callback(&callback("s", Some("oaiapp_1")), "s", None),
            Some(Ok(Grant {
                code: "code-1".into(),
                client_id: "oaiapp_1".into(),
                scope: None
            }))
        );
        // A new registration needs the issued client.
        for client in [None, Some("dynamic_agent_client")] {
            assert_eq!(
                check_callback(&callback("s", client), "s", None)
                    .unwrap()
                    .unwrap_err()
                    .code,
                "incomplete"
            );
        }
        // Signing in again: may leave it out, may not change it.
        assert_eq!(
            check_callback(&callback("s", None), "s", Some("oaiapp_1"))
                .unwrap()
                .unwrap()
                .client_id,
            "oaiapp_1"
        );
        assert_eq!(
            check_callback(&callback("s", Some("oaiapp_2")), "s", Some("oaiapp_1"))
                .unwrap()
                .unwrap_err()
                .code,
            "other_client"
        );
        let denied = Callback {
            state: Some("s".into()),
            error: Some("access_denied".into()),
            ..Callback::default()
        };
        assert_eq!(
            check_callback(&denied, "s", None)
                .unwrap()
                .unwrap_err()
                .code,
            "denied"
        );
    }

    #[test]
    fn keeps_only_credentials_that_allow_the_plan() {
        let grant = Grant {
            code: "c".into(),
            client_id: "oaiapp_1".into(),
            scope: None,
        };
        let token = |scope: &str, nonce: &str| {
            serde_json::json!({
                "access_token": "at", "refresh_token": "rt", "id_token": id_token(nonce),
                "expires_in": 3600, "scope": scope, "earliest_refresh_at": 1_800_000_000,
            })
        };
        let full = "openid offline_access chatgpt.tokens.use.direct";
        let ok = credential(&token(full, "n"), &grant, "n").unwrap();
        assert_eq!(ok.client_id, "oaiapp_1");
        assert_eq!(ok.expires_in, 3600);
        assert_eq!(
            ok.earliest_refresh_at,
            Some(serde_json::json!(1_800_000_000))
        );
        let no_plan = credential(&token("openid offline_access", "n"), &grant, "n").unwrap_err();
        assert_eq!(no_plan.code, "plan_not_granted");
        assert_eq!(no_plan.client_id.as_deref(), Some("oaiapp_1"));
        assert_eq!(
            credential(&token(full, "other"), &grant, "n")
                .unwrap_err()
                .code,
            "nonce"
        );
        assert_eq!(
            credential(&serde_json::json!({ "access_token": "at" }), &grant, "n")
                .unwrap_err()
                .code,
            "exchange"
        );
    }

    #[test]
    fn one_sign_in_at_a_time() {
        let pending = Pending::default();
        let (first, mut first_cancel) = pending.start();
        let (second, mut second_cancel) = pending.start();
        assert!(first_cancel.try_recv().is_ok());
        pending.finish(first);
        assert!(second_cancel.try_recv().is_err());
        pending.cancel();
        assert!(second_cancel.try_recv().is_ok());
        pending.finish(second);
    }

    /// Answers one request of the token endpoint, after checking it, with tokens for `nonce`.
    async fn fake_token_endpoint(
        listener: TcpListener,
        nonce: Arc<Mutex<String>>,
        challenge: Arc<Mutex<String>>,
    ) -> String {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = stream.read(&mut chunk).await.unwrap();
            request.extend_from_slice(&chunk[..read]);
            let text = String::from_utf8_lossy(&request).to_string();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if body.len() >= length {
                    break;
                }
            }
        }
        let text = String::from_utf8(request).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /api/accounts/oauth/token "));
        let form: std::collections::HashMap<String, String> =
            url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .collect();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["client_id"], "oaiapp_new");
        assert_eq!(form["code"], "the-code");
        assert_eq!(form["resource"], "https://api.openai.com/v1");
        assert_eq!(
            code_challenge(&form["code_verifier"]),
            *challenge.lock().unwrap()
        );
        let answer = serde_json::json!({
            "access_token": "at-1", "refresh_token": "rt-1",
            "id_token": id_token(&nonce.lock().unwrap()), "token_type": "Bearer",
            "expires_in": 3600,
            "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
            answer.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        form["redirect_uri"].clone()
    }

    #[tokio::test]
    async fn signs_in_through_the_browser_and_the_token_endpoint() {
        let token_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let auth_url = format!("http://{}", token_listener.local_addr().unwrap());
        let nonce = Arc::new(Mutex::new(String::new()));
        let challenge = Arc::new(Mutex::new(String::new()));
        let endpoint = tokio::spawn(fake_token_endpoint(
            token_listener,
            nonce.clone(),
            challenge.clone(),
        ));
        let config = Config {
            auth_url,
            port: 0,
            timeout: Duration::from_secs(20),
        };
        let page = Arc::new(Mutex::new(None::<tokio::task::JoinHandle<String>>));
        let browser = page.clone();
        let (_cancel, cancelled) = oneshot::channel();
        // The "browser": reads the authorization URL, then comes back to the loopback address
        // as OpenAI would, first with a stale state, then with the right one.
        let open = move |url: &str| {
            let url = Url::parse(url).unwrap();
            let q = query(&url);
            *nonce.lock().unwrap() = q["nonce"].clone();
            *challenge.lock().unwrap() = q["code_challenge"].clone();
            let redirect = q["redirect_uri"].clone();
            let state = q["state"].clone();
            *browser.lock().unwrap() = Some(tokio::spawn(async move {
                let http = reqwest::Client::builder().no_proxy().build().unwrap();
                let stale = http
                    .get(format!("{redirect}?code=x&state=old"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(stale.status(), 400);
                http.get(format!(
                    "{redirect}?code=the-code&state={state}&client_id=oaiapp_new&scope=openid"
                ))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap()
            }));
            Ok(())
        };
        let credential = sign_in(&config, request(None), open, cancelled)
            .await
            .unwrap();
        assert_eq!(credential.client_id, "oaiapp_new");
        assert_eq!(credential.access_token, "at-1");
        assert_eq!(credential.refresh_token, "rt-1");
        let redirect_uri = endpoint.await.unwrap();
        assert!(redirect_uri.starts_with("http://127.0.0.1:"));
        assert!(redirect_uri.ends_with("/auth/callback"));
        let handle = page.lock().unwrap().take().unwrap();
        let shown = handle.await.unwrap();
        assert!(shown.contains("Signed in with ChatGPT"));
    }

    #[tokio::test]
    async fn stops_when_cancelled_or_late() {
        let config = Config {
            auth_url: "http://127.0.0.1:9".into(),
            port: 0,
            timeout: Duration::from_millis(200),
        };
        let (cancel, cancelled) = oneshot::channel();
        cancel.send(()).unwrap();
        let error = sign_in(&config, request(None), |_| Ok(()), cancelled)
            .await
            .unwrap_err();
        assert_eq!(error.code, "cancelled");
        let (_keep, waiting) = oneshot::channel();
        let error = sign_in(&config, request(None), |_| Ok(()), waiting)
            .await
            .unwrap_err();
        assert_eq!(error.code, "timeout");
        let (_keep, waiting) = oneshot::channel();
        let error = sign_in(
            &config,
            request(None),
            |_| Err("no browser".into()),
            waiting,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "browser");
    }
}
