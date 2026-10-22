//! Watches the projects the hub mirrors in its bots' workspaces (`watch` from the hub) and tells
//! it what changed (`changed`), a moment after the last change, so the mirror follows within
//! seconds (docs/DESKTOP.md). What the hub itself just wrote is not sent back, nor `.git`, the
//! names the hub always leaves out (`node_modules`…), or the temporary files of `put`.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::{sleep_until, Instant};

use crate::ops::mirror::{written_by_hub, TEMP_SUFFIX};
use crate::ops::paths::relative;

/// Quiet time after the last change before telling the hub.
pub const QUIET: Duration = Duration::from_millis(700);
/// Longest a change waits while others keep coming (a build writing for minutes).
pub const MAX_WAIT: Duration = Duration::from_secs(3);
/// Past this many paths, the hub is told to look at everything.
const PATHS_MAX: usize = 200;

/// A change in a watched project: its key, and the project-relative path (`""`: anything).
pub type Change = (String, String);

/// The project-relative path of a change worth telling the hub, if it is one.
pub fn relevant(root: &Path, path: &Path, exclude: &[String]) -> Option<String> {
    if !path.starts_with(root) || written_by_hub(path) {
        return None;
    }
    let rel = relative(root, path);
    let skipped = rel.split('/').any(|part| {
        part.eq_ignore_ascii_case(".git")
            || part.ends_with(TEMP_SUFFIX)
            || exclude.iter().any(|name| name == part)
    });
    (!skipped).then_some(rel)
}

/// The watchers of one connection to the hub, by project key.
pub struct WatchSet {
    watched: HashMap<String, (PathBuf, RecommendedWatcher)>,
    changes: mpsc::UnboundedSender<Change>,
}

impl WatchSet {
    pub fn new(changes: mpsc::UnboundedSender<Change>) -> Self {
        Self {
            watched: HashMap::new(),
            changes,
        }
    }

    /// Watches exactly these projects (key, folder); the others stop. Returns what could not be
    /// watched.
    pub fn set(&mut self, wanted: Vec<(String, PathBuf)>, exclude: Vec<String>) -> Vec<String> {
        let keys: Vec<&String> = wanted.iter().map(|(key, _)| key).collect();
        self.watched.retain(|key, _| keys.contains(&key));
        let mut errors = Vec::new();
        for (key, root) in wanted {
            if self
                .watched
                .get(&key)
                .is_some_and(|(watched, _)| *watched == root)
            {
                continue;
            }
            match watch(&key, &root, exclude.clone(), self.changes.clone()) {
                Ok(watcher) => {
                    self.watched.insert(key, (root, watcher));
                }
                Err(error) => {
                    self.watched.remove(&key);
                    errors.push(format!("{}: {error}", root.display()));
                }
            }
        }
        errors
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.watched.len()
    }
}

fn watch(
    key: &str,
    root: &Path,
    exclude: Vec<String>,
    changes: mpsc::UnboundedSender<Change>,
) -> notify::Result<RecommendedWatcher> {
    let key = key.to_string();
    let base = root.to_path_buf();
    let mut watcher = RecommendedWatcher::new(
        move |event: notify::Result<Event>| {
            let Ok(event) = event else {
                // Events were lost (overflow): the hub looks at everything.
                let _ = changes.send((key.clone(), String::new()));
                return;
            };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            if event.need_rescan() {
                let _ = changes.send((key.clone(), String::new()));
                return;
            }
            for path in &event.paths {
                if let Some(rel) = relevant(&base, path, &exclude) {
                    let _ = changes.send((key.clone(), rel));
                }
            }
        },
        Config::default(),
    )?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// What one project changed: its paths, or `None` for everything.
fn paths_of(paths: &BTreeSet<String>) -> Option<Vec<String>> {
    if paths.len() > PATHS_MAX || paths.contains("") {
        return None;
    }
    Some(paths.iter().cloned().collect())
}

/// The `changed` message for a project.
pub fn changed_message(key: &str, paths: &BTreeSet<String>) -> String {
    json!({ "t": "changed", "project": key, "paths": paths_of(paths) }).to_string()
}

/// Gathers the changes of each project and sends one message per project once it has been quiet
/// for `quiet` (or after `max_wait`). Ends when every sender is gone.
pub async fn debounce(
    mut changes: mpsc::UnboundedReceiver<Change>,
    quiet: Duration,
    max_wait: Duration,
    send: impl Fn(String),
) {
    struct Pending {
        paths: BTreeSet<String>,
        first: Instant,
        last: Instant,
    }
    let mut pending: HashMap<String, Pending> = HashMap::new();
    loop {
        let due = pending
            .values()
            .map(|p| (p.last + quiet).min(p.first + max_wait))
            .min();
        tokio::select! {
            change = changes.recv() => {
                let Some((key, rel)) = change else { break };
                let now = Instant::now();
                let entry = pending.entry(key).or_insert_with(|| Pending {
                    paths: BTreeSet::new(),
                    first: now,
                    last: now,
                });
                entry.last = now;
                entry.paths.insert(rel);
            }
            _ = async { sleep_until(due.unwrap_or_else(Instant::now)).await }, if due.is_some() => {
                let now = Instant::now();
                let ready: Vec<String> = pending
                    .iter()
                    .filter(|(_, p)| (p.last + quiet).min(p.first + max_wait) <= now)
                    .map(|(key, _)| key.clone())
                    .collect();
                for key in ready {
                    if let Some(done) = pending.remove(&key) {
                        send(changed_message(&key, &done.paths));
                    }
                }
            }
        }
    }
    for (key, done) in pending {
        send(changed_message(&key, &done.paths));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::sync::{Arc, Mutex};

    fn exclude() -> Vec<String> {
        vec!["node_modules".into(), "target".into()]
    }

    #[test]
    fn keeps_project_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let at = |rel: &str| relevant(&root, &root.join(rel), &exclude());
        assert_eq!(at("src/main.ts"), Some("src/main.ts".into()));
        assert_eq!(at("src"), Some("src".into()));
        assert_eq!(relevant(&root, &root, &exclude()), Some(String::new()));
        assert_eq!(at(".git/index"), None);
        assert_eq!(at("app/node_modules/x/index.js"), None);
        assert_eq!(at("src/.main.ts.mowbot-tmp"), None);
        assert_eq!(relevant(&root, Path::new("/elsewhere/x"), &exclude()), None);
    }

    #[test]
    fn many_paths_mean_everything() {
        let few: BTreeSet<String> = ["a.ts".to_string(), "b.ts".to_string()].into();
        let message: Value = serde_json::from_str(&changed_message("k", &few)).unwrap();
        assert_eq!(message["t"], "changed");
        assert_eq!(message["project"], "k");
        assert_eq!(message["paths"], json!(["a.ts", "b.ts"]));
        let many: BTreeSet<String> = (0..=PATHS_MAX).map(|i| format!("f{i}")).collect();
        let message: Value = serde_json::from_str(&changed_message("k", &many)).unwrap();
        assert!(message["paths"].is_null());
        let root: BTreeSet<String> = ["".to_string(), "a.ts".to_string()].into();
        let message: Value = serde_json::from_str(&changed_message("k", &root)).unwrap();
        assert!(message["paths"].is_null());
    }

    #[tokio::test]
    async fn sends_once_quiet_then_again_for_later_changes() {
        let (tx, rx) = mpsc::unbounded_channel();
        let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
        let out = sent.clone();
        let task = tokio::spawn(debounce(
            rx,
            Duration::from_millis(80),
            Duration::from_millis(400),
            move |m| out.lock().unwrap().push(serde_json::from_str(&m).unwrap()),
        ));
        tx.send(("a".into(), "x.ts".into())).unwrap();
        tx.send(("a".into(), "y.ts".into())).unwrap();
        tx.send(("b".into(), "z.ts".into())).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(sent.lock().unwrap().is_empty());
        tokio::time::sleep(Duration::from_millis(200)).await;
        {
            let sent = sent.lock().unwrap();
            assert_eq!(sent.len(), 2);
            let a = sent.iter().find(|m| m["project"] == "a").unwrap();
            assert_eq!(a["paths"], json!(["x.ts", "y.ts"]));
        }
        tx.send(("a".into(), "w.ts".into())).unwrap();
        drop(tx);
        task.await.unwrap();
        assert_eq!(sent.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_busy_project_is_reported_before_it_settles() {
        let (tx, rx) = mpsc::unbounded_channel();
        let sent = Arc::new(Mutex::new(0usize));
        let out = sent.clone();
        let task = tokio::spawn(debounce(
            rx,
            Duration::from_millis(100),
            Duration::from_millis(250),
            move |_| *out.lock().unwrap() += 1,
        ));
        for i in 0..8 {
            tx.send(("a".into(), format!("f{i}"))).unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Changes kept coming every 50 ms: still told after at most 250 ms.
        assert!(*sent.lock().unwrap() >= 1);
        drop(tx);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn watches_a_folder_and_ignores_what_it_should() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut set = WatchSet::new(tx);
        assert!(set
            .set(vec![("k".into(), root.clone())], exclude())
            .is_empty());
        assert_eq!(set.len(), 1);
        tokio::time::sleep(Duration::from_millis(100)).await;
        fs::write(root.join("node_modules/dep.js"), "x").unwrap();
        fs::write(root.join("main.ts"), "hello").unwrap();
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !seen.contains(&"main.ts".to_string()) && Instant::now() < deadline {
            if let Ok(Some((key, rel))) =
                tokio::time::timeout(Duration::from_millis(200), rx.recv()).await
            {
                assert_eq!(key, "k");
                seen.push(rel);
            }
        }
        assert!(seen.contains(&"main.ts".to_string()), "{seen:?}");
        assert!(!seen.iter().any(|rel| rel.contains("node_modules")));
        // Stops watching what the hub no longer mirrors.
        assert!(set.set(vec![], exclude()).is_empty());
        assert_eq!(set.len(), 0);
        assert!(
            set.set(vec![("x".into(), root.join("missing"))], vec![])
                .len()
                == 1
        );
    }
}
