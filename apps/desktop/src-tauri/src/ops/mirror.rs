//! `put` and `delete`: the hub brings the work done in a mirror (a copy of the project in a bot
//! workspace) back into the user's folder, file by file (docs/DESKTOP.md). Each file can carry
//! the hash the hub last saw (`expect`): when the file changed since, it is left alone and the
//! answer says so, so nothing the user wrote meanwhile is overwritten or deleted. `.git` is never
//! touched.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};

use super::paths::{components, io_error, resolve};
use super::sync::{hash_contents, MANIFEST_MAX_FILE};

/// Files one `put` or `delete` carries at most.
const BATCH_MAX: usize = 500;
/// How long a change the hub made is not reported back by the watcher.
const ECHO: Duration = Duration::from_secs(3);
/// Suffix of the temporary file a `put` writes before putting it in place.
pub const TEMP_SUFFIX: &str = ".mowbot-tmp";

/// What the hub just wrote or deleted, so the watcher does not send it back as a change.
static RECENT: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();

fn remember(path: &Path) {
    if let Ok(mut recent) = RECENT.get_or_init(Default::default).lock() {
        let now = Instant::now();
        recent.retain(|_, at| now.duration_since(*at) < ECHO);
        recent.insert(path.to_path_buf(), now);
        // Its folders change too (a new entry, a modification time).
        let mut parent = path.parent();
        while let Some(dir) = parent {
            recent.insert(dir.to_path_buf(), now);
            parent = dir.parent();
        }
    }
}

/// Whether this path was changed by the hub a moment ago.
pub fn written_by_hub(path: &Path) -> bool {
    RECENT
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|recent| recent.get(path).copied())
        .is_some_and(|at| at.elapsed() < ECHO)
}

/// A project-relative file path the hub may change: not the root, nothing in `.git`.
fn changeable(rel: &str) -> Result<String, String> {
    let parts = components(rel)?;
    if parts.is_empty() {
        return Err("Chemin de fichier attendu (pas la racine du projet).".into());
    }
    if parts.iter().any(|part| part.eq_ignore_ascii_case(".git")) {
        return Err(format!("Le dossier .git n'est jamais modifié : {rel}"));
    }
    if parts.last().is_some_and(|name| name.ends_with(TEMP_SUFFIX)) {
        return Err(format!("Nom de fichier réservé : {rel}"));
    }
    Ok(parts.join("/"))
}

/// The hash of the file now: `None` when there is none, `Some("")` when it cannot be hashed
/// (too big, unreadable).
fn current_hash(file: &Path) -> Result<Option<String>, std::io::Error> {
    match fs::symlink_metadata(file) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
        Ok(meta) if meta.is_dir() => return Ok(Some(String::new())),
        Ok(_) => {}
    }
    let mut buffer = vec![0u8; 64 * 1024];
    Ok(Some(
        hash_contents(file, MANIFEST_MAX_FILE, &mut buffer)?
            .map(|(_, hash)| hash)
            .unwrap_or_default(),
    ))
}

/// `expect` of an entry: absent (no check), `null` (the file must not exist), or a hash.
fn expected(entry: &Value) -> Option<Option<String>> {
    entry
        .get("expect")
        .map(|value| value.as_str().map(str::to_string))
}

fn entries<'a>(args: &'a Value, name: &str) -> Result<&'a Vec<Value>, String> {
    let list = args
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Paramètre manquant : files ({name})"))?;
    if list.len() > BATCH_MAX {
        return Err(format!(
            "Trop de fichiers en une fois : {} (au plus {BATCH_MAX}).",
            list.len()
        ));
    }
    Ok(list)
}

/// Writes `bytes` into `file` through a temporary file next to it, so an editor or a build never
/// reads half a file. The file keeps its permissions.
fn write_in_place(file: &Path, bytes: &[u8], executable: bool) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = file.with_file_name(format!(".{name}{TEMP_SUFFIX}"));
    let previous = fs::metadata(file).ok().map(|meta| meta.permissions());
    fs::write(&temp, bytes)?;
    if let Some(permissions) = previous {
        let _ = fs::set_permissions(&temp, permissions);
    } else if executable {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(0o755));
        }
    }
    if let Err(error) = fs::rename(&temp, file) {
        // A program holding the file open (Windows) can refuse the swap: written over instead.
        let _ = fs::remove_file(&temp);
        fs::write(file, bytes).map_err(|_| error)?;
    }
    Ok(())
}

pub fn put(root: &Path, args: &Value) -> Result<Value, String> {
    let mut results = Vec::new();
    for entry in entries(args, "put")? {
        let rel = entry.get("path").and_then(Value::as_str).unwrap_or("");
        results.push(match put_one(root, rel, entry) {
            Ok(result) => result,
            Err(error) => json!({ "path": rel, "ok": false, "error": error }),
        });
    }
    Ok(json!({ "results": results }))
}

fn put_one(root: &Path, rel: &str, entry: &Value) -> Result<Value, String> {
    let rel = changeable(rel)?;
    let data = entry
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Contenu manquant pour {rel}"))?;
    let bytes = BASE64
        .decode(data)
        .map_err(|_| format!("Contenu base64 invalide pour {rel}"))?;
    let file = resolve(root, &rel)?;
    let current = current_hash(&file).map_err(|e| io_error(&rel, &e))?;
    if current.as_deref() == Some("") {
        return Err(format!(
            "Impossible de remplacer {rel} (dossier ou fichier illisible)."
        ));
    }
    if let Some(expect) = expected(entry) {
        if current != expect {
            return Ok(json!({ "path": rel, "ok": false, "changed": true, "current": current }));
        }
    }
    let executable = entry.get("exec").and_then(Value::as_bool).unwrap_or(false);
    remember(&file);
    write_in_place(&file, &bytes, executable).map_err(|e| io_error(&rel, &e))?;
    remember(&file);
    Ok(json!({ "path": rel, "ok": true, "size": bytes.len() }))
}

/// How a file is deleted: to the system's trash (the app), or for good (tests).
#[derive(Clone, Copy)]
pub enum Removal {
    Trash,
    #[cfg_attr(not(test), allow(dead_code))]
    Unlink,
}

pub fn delete(root: &Path, args: &Value) -> Result<Value, String> {
    delete_with(root, args, Removal::Trash)
}

pub fn delete_with(root: &Path, args: &Value, removal: Removal) -> Result<Value, String> {
    let mut results = Vec::new();
    for entry in entries(args, "delete")? {
        let rel = entry.get("path").and_then(Value::as_str).unwrap_or("");
        results.push(match delete_one(root, rel, entry, removal) {
            Ok(result) => result,
            Err(error) => json!({ "path": rel, "ok": false, "error": error }),
        });
    }
    Ok(json!({ "results": results }))
}

fn delete_one(root: &Path, rel: &str, entry: &Value, removal: Removal) -> Result<Value, String> {
    let rel = changeable(rel)?;
    let file = resolve(root, &rel)?;
    let current = current_hash(&file).map_err(|e| io_error(&rel, &e))?;
    let Some(current) = current else {
        // Already gone.
        return Ok(json!({ "path": rel, "ok": true, "gone": true }));
    };
    if current.is_empty() {
        return Err(format!(
            "Ce n'est pas un fichier que le hub peut supprimer : {rel}"
        ));
    }
    if let Some(expect) = expected(entry) {
        if Some(current.clone()) != expect {
            return Ok(json!({ "path": rel, "ok": false, "changed": true, "current": current }));
        }
    }
    remember(&file);
    let trashed = match removal {
        Removal::Trash => trash::delete(&file).is_ok(),
        Removal::Unlink => false,
    };
    if !trashed {
        if let Err(error) = fs::remove_file(&file) {
            if error.kind() != ErrorKind::NotFound {
                return Err(io_error(&rel, &error));
            }
        }
    }
    remove_empty_parents(root, &file);
    Ok(json!({ "path": rel, "ok": true, "trashed": trashed }))
}

/// The folders a deletion left empty go too, up to the project's root (git keeps no empty
/// folder either).
fn remove_empty_parents(root: &Path, file: &Path) {
    let mut dir = file.parent();
    while let Some(current) = dir {
        if current == root || !current.starts_with(root) {
            break;
        }
        let empty = fs::read_dir(current).is_ok_and(|mut entries| entries.next().is_none());
        if !empty || fs::remove_dir(current).is_err() {
            break;
        }
        remember(current);
        dir = current.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src/main.ts"), "hello").unwrap();
        fs::write(root.join("src/deep/only.ts"), "hello").unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        (dir, root)
    }

    fn b64(text: &[u8]) -> String {
        BASE64.encode(text)
    }

    #[test]
    fn put_writes_files_and_checks_what_was_there() {
        let (_dir, root) = project();
        let png = [0x89u8, b'P', b'N', b'G', 0, 1, 2];
        let data = put(
            &root,
            &json!({ "files": [
                { "path": "src/main.ts", "data": b64(b"bonjour"), "expect": HELLO_SHA256 },
                { "path": "public/logo.png", "data": b64(&png), "expect": null },
                { "path": "new.txt", "data": b64(b"x") },
            ] }),
        )
        .unwrap();
        let results = data["results"].as_array().unwrap();
        assert!(results.iter().all(|r| r["ok"] == true), "{results:?}");
        assert_eq!(
            fs::read_to_string(root.join("src/main.ts")).unwrap(),
            "bonjour"
        );
        assert_eq!(fs::read(root.join("public/logo.png")).unwrap(), png);
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "x");
        // No temporary file left behind.
        assert!(!root.join("src/.main.ts.mowbot-tmp").exists());
        assert!(written_by_hub(&root.join("src/main.ts")));
        assert!(written_by_hub(&root.join("src")));

        // Changed since the hub looked: left alone.
        let data = put(
            &root,
            &json!({ "files": [
                { "path": "src/main.ts", "data": b64(b"perdu"), "expect": HELLO_SHA256 },
                { "path": "new.txt", "data": b64(b"perdu"), "expect": null },
            ] }),
        )
        .unwrap();
        assert_eq!(data["results"][0]["ok"], false);
        assert_eq!(data["results"][0]["changed"], true);
        assert_eq!(data["results"][1]["changed"], true);
        assert_eq!(
            fs::read_to_string(root.join("src/main.ts")).unwrap(),
            "bonjour"
        );
        assert_eq!(fs::read_to_string(root.join("new.txt")).unwrap(), "x");
    }

    #[test]
    fn put_refuses_git_escapes_and_bad_content() {
        let (_dir, root) = project();
        let data = put(
            &root,
            &json!({ "files": [
                { "path": ".git/HEAD", "data": b64(b"x") },
                { "path": "sub/.GIT/config", "data": b64(b"x") },
                { "path": "../out.txt", "data": b64(b"x") },
                { "path": "", "data": b64(b"x") },
                { "path": "a.txt", "data": "%%%" },
                { "path": "src", "data": b64(b"x") },
                { "path": "b.txt" },
            ] }),
        )
        .unwrap();
        let errors: Vec<&str> = data["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                assert_eq!(r["ok"], false);
                r["error"].as_str().unwrap()
            })
            .collect();
        assert!(errors[0].starts_with("Le dossier .git"));
        assert!(errors[1].starts_with("Le dossier .git"));
        assert!(errors[2].starts_with("Chemin hors du projet"));
        assert!(errors[3].starts_with("Chemin de fichier attendu"));
        assert!(errors[4].starts_with("Contenu base64 invalide"));
        assert!(errors[5].starts_with("Impossible de remplacer"));
        assert!(errors[6].starts_with("Contenu manquant"));
        assert_eq!(
            fs::read_to_string(root.join(".git/HEAD")).unwrap(),
            "ref: refs/heads/main\n"
        );
        assert!(put(&root, &json!({})).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn put_keeps_permissions_and_marks_new_scripts_executable() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, root) = project();
        fs::write(root.join("run.sh"), "old").unwrap();
        fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o750)).unwrap();
        put(
            &root,
            &json!({ "files": [
                { "path": "run.sh", "data": b64(b"new") },
                { "path": "gradlew", "data": b64(b"#!/bin/sh"), "exec": true },
            ] }),
        )
        .unwrap();
        let mode = |p: &str| fs::metadata(root.join(p)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode("run.sh"), 0o750);
        assert_eq!(mode("gradlew") & 0o111, 0o111);
    }

    #[test]
    fn delete_removes_unchanged_files_and_their_empty_folders() {
        let (_dir, root) = project();
        let data = delete_with(
            &root,
            &json!({ "files": [
                { "path": "src/deep/only.ts", "expect": HELLO_SHA256 },
                { "path": "src/main.ts", "expect": "0000" },
                { "path": "gone.txt", "expect": HELLO_SHA256 },
                { "path": ".git/HEAD" },
                { "path": "src" },
            ] }),
            Removal::Unlink,
        )
        .unwrap();
        let results = data["results"].as_array().unwrap();
        assert_eq!(results[0]["ok"], true);
        assert!(!root.join("src/deep").exists());
        assert!(root.join("src").exists());
        assert_eq!(results[1]["ok"], false);
        assert_eq!(results[1]["changed"], true);
        assert_eq!(results[1]["current"], HELLO_SHA256);
        assert!(root.join("src/main.ts").exists());
        assert_eq!(results[2]["gone"], true);
        assert!(results[3]["error"]
            .as_str()
            .unwrap()
            .starts_with("Le dossier .git"));
        assert!(results[4]["error"]
            .as_str()
            .unwrap()
            .starts_with("Ce n'est pas un fichier"));
        assert!(root.join(".git/HEAD").exists());
    }
}
