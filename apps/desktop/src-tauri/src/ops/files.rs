//! `list`, `read`, `write`, `edit`.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};

use super::paths::{io_error, normalized, relative, resolve, shown, stays_inside};
use super::{bool_arg, opt_str, req_str, u64_arg};

const LIST_MAX: usize = 5_000;
const READ_DEFAULT_LIMIT: u64 = 2_000;
const READ_MAX_LIMIT: u64 = 20_000;
/// The text `read` returns at most (the rest: `truncated`, read on with `offset`).
const READ_MAX_BYTES: usize = 512 * 1024;
/// Where a NUL byte means a binary file.
pub const BINARY_SNIFF: usize = 8 * 1024;

pub fn is_binary(head: &[u8]) -> bool {
    head[..head.len().min(BINARY_SNIFF)].contains(&0)
}

pub fn list(root: &Path, args: &Value) -> Result<Value, String> {
    let rel = opt_str(args, "path").unwrap_or("");
    let dir = resolve(root, rel)?;
    let meta = fs::metadata(&dir).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("Dossier introuvable : {}", shown(rel)),
        _ => io_error(rel, &e),
    })?;
    if !meta.is_dir() {
        return Err(format!(
            "Ce n'est pas un dossier : {} (utilise read)",
            shown(rel)
        ));
    }
    let base = relative(root, &dir);
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&dir).map_err(|e| io_error(rel, &e))? {
        let Ok(entry) = entry else { continue };
        if entries.len() >= LIST_MAX {
            truncated = true;
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        // A link is shown as what it points to, and only when that is inside the project.
        if kind.is_symlink() && !stays_inside(root, &path) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let size = if meta.is_dir() { 0 } else { meta.len() };
        entries.push((meta.is_dir(), name, size));
    }
    entries.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
            .then_with(|| a.1.cmp(&b.1))
    });
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|(is_dir, name, size)| {
            let path = if base.is_empty() {
                name.clone()
            } else {
                format!("{base}/{name}")
            };
            json!({
                "name": name,
                "path": path,
                "type": if is_dir { "directory" } else { "file" },
                "size": size,
            })
        })
        .collect();
    Ok(json!({ "entries": entries, "truncated": truncated }))
}

/// The file at `rel`, which must exist and be a file.
pub(super) fn existing_file(root: &Path, rel: &str) -> Result<std::path::PathBuf, String> {
    if normalized(rel)?.is_empty() {
        return Err("Chemin de fichier attendu (pas la racine du projet).".into());
    }
    let file = resolve(root, rel)?;
    let meta = fs::metadata(&file).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("Fichier introuvable : {rel}"),
        _ => io_error(rel, &e),
    })?;
    if meta.is_dir() {
        return Err(format!(
            "C'est un dossier, pas un fichier : {rel} (utilise list)"
        ));
    }
    Ok(file)
}

pub fn read(root: &Path, args: &Value) -> Result<Value, String> {
    let rel = req_str(args, "path")?;
    let file = existing_file(root, rel)?;
    let offset = u64_arg(args, "offset")?.unwrap_or(1).max(1);
    let limit = u64_arg(args, "limit")?
        .unwrap_or(READ_DEFAULT_LIMIT)
        .clamp(1, READ_MAX_LIMIT);

    let mut handle = fs::File::open(&file).map_err(|e| io_error(rel, &e))?;
    let mut head = Vec::with_capacity(BINARY_SNIFF);
    (&mut handle)
        .take(BINARY_SNIFF as u64)
        .read_to_end(&mut head)
        .map_err(|e| io_error(rel, &e))?;
    if is_binary(&head) {
        return Err(format!(
            "Fichier binaire, non lisible comme du texte : {rel}"
        ));
    }
    let mut reader = BufReader::with_capacity(64 * 1024, head.as_slice().chain(handle));

    let end = offset.saturating_add(limit);
    let mut text = String::new();
    let mut taken: u64 = 0;
    let mut full = false;
    let mut total: u64 = 0;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|e| io_error(rel, &e))?;
        if read == 0 {
            break;
        }
        total += 1;
        if total < offset || total >= end || full {
            continue;
        }
        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }
        let decoded = String::from_utf8_lossy(&line);
        let needed = decoded.len() + usize::from(taken > 0);
        if text.len() + needed > READ_MAX_BYTES {
            full = true;
            if taken == 0 {
                // A single huge line (minified file): its beginning.
                text.push_str(cut(&decoded, READ_MAX_BYTES));
                taken = 1;
            }
            continue;
        }
        if taken > 0 {
            text.push('\n');
        }
        text.push_str(&decoded);
        taken += 1;
    }
    let shown_until = offset - 1 + taken;
    Ok(json!({
        "text": text,
        "totalLines": total,
        "truncated": full || shown_until < total,
    }))
}

/// The beginning of `text`, at most `max` bytes, cut on a character boundary.
pub fn cut(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub fn write(root: &Path, args: &Value) -> Result<Value, String> {
    let rel = req_str(args, "path")?;
    let content = req_str(args, "content")?;
    if normalized(rel)?.is_empty() {
        return Err("Chemin de fichier attendu (pas la racine du projet).".into());
    }
    let file = resolve(root, rel)?;
    if file.is_dir() {
        return Err(format!("C'est un dossier, pas un fichier : {rel}"));
    }
    // Binary files (pictures…) come in base64.
    let bytes = if bool_arg(args, "base64")?.unwrap_or(false) {
        BASE64
            .decode(content)
            .map_err(|_| format!("Contenu base64 invalide pour {rel}"))?
    } else {
        content.as_bytes().to_vec()
    };
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|e| io_error(rel, &e))?;
    }
    fs::write(&file, &bytes).map_err(|e| io_error(rel, &e))?;
    Ok(json!({ "size": bytes.len() }))
}

pub fn edit(root: &Path, args: &Value) -> Result<Value, String> {
    let rel = req_str(args, "path")?;
    let old = req_str(args, "old")?;
    let new = req_str(args, "new")?;
    let all = bool_arg(args, "all")?.unwrap_or(false);
    if old.is_empty() {
        return Err("`old` ne peut pas être vide.".into());
    }
    let file = existing_file(root, rel)?;
    let bytes = fs::read(&file).map_err(|e| io_error(rel, &e))?;
    if is_binary(&bytes) {
        return Err(format!(
            "Fichier binaire, non modifiable comme du texte : {rel}"
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("Le fichier n'est pas en UTF-8, il n'est pas modifié : {rel}"))?;

    // `read` gives lines joined with \n: a CRLF file matches once its line ends are restored.
    let crlf;
    let (old, new) = if !content.contains(old) && content.contains("\r\n") && old.contains('\n') {
        crlf = (to_crlf(old), to_crlf(new));
        (crlf.0.as_str(), crlf.1.as_str())
    } else {
        (old, new)
    };
    let count = content.matches(old).count();
    if count == 0 {
        return Err(format!(
            "Texte introuvable dans {rel} : `old` doit correspondre exactement (espaces et indentation compris)."
        ));
    }
    if count > 1 && !all {
        return Err(format!(
            "Le texte apparaît {count} fois dans {rel} : ajoute du contexte pour qu'il soit unique, ou passe all: true."
        ));
    }
    let (updated, replaced) = if all {
        (content.replace(old, new), count)
    } else {
        (content.replacen(old, new, 1), 1)
    };
    fs::write(&file, updated.as_bytes()).map_err(|e| io_error(rel, &e))?;
    Ok(json!({ "replaced": replaced }))
}

fn to_crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("src/b")).unwrap();
        fs::create_dir_all(root.join("A")).unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() {\n    println!(\"hi\");\n}\n",
        )
        .unwrap();
        fs::write(root.join("README.md"), "# Projet\n").unwrap();
        fs::write(root.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 0, 1]).unwrap();
        (dir, root)
    }

    #[test]
    fn list_puts_directories_first() {
        let (_dir, root) = project();
        let data = list(&root, &json!({ "path": "" })).unwrap();
        let entries = data["entries"].as_array().unwrap();
        let names: Vec<&str> = entries
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["A", "src", "logo.png", "README.md"]);
        assert_eq!(entries[1]["type"], "directory");
        assert_eq!(entries[1]["path"], "src");
        assert_eq!(entries[3]["type"], "file");
        assert_eq!(entries[3]["size"], 9);

        let data = list(&root, &json!({ "path": "src" })).unwrap();
        assert_eq!(data["entries"][0]["path"], "src/b");
        assert_eq!(data["entries"][1]["path"], "src/main.rs");

        assert!(list(&root, &json!({ "path": "nope" }))
            .unwrap_err()
            .starts_with("Dossier introuvable"));
        assert!(list(&root, &json!({ "path": "README.md" }))
            .unwrap_err()
            .starts_with("Ce n'est pas un dossier"));
        assert!(list(&root, &json!({ "path": "../" }))
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
    }

    #[test]
    fn read_returns_a_window_of_lines() {
        let (_dir, root) = project();
        let lines: Vec<String> = (1..=10).map(|i| format!("ligne {i}")).collect();
        fs::write(root.join("ten.txt"), lines.join("\r\n") + "\r\n").unwrap();

        let all = read(&root, &json!({ "path": "ten.txt" })).unwrap();
        assert_eq!(all["totalLines"], 10);
        assert_eq!(all["truncated"], false);
        assert_eq!(all["text"], lines.join("\n"));

        let window = read(
            &root,
            &json!({ "path": "ten.txt", "offset": 3, "limit": 2 }),
        )
        .unwrap();
        assert_eq!(window["text"], "ligne 3\nligne 4");
        assert_eq!(window["totalLines"], 10);
        assert_eq!(window["truncated"], true);

        let tail = read(
            &root,
            &json!({ "path": "ten.txt", "offset": 9, "limit": 5 }),
        )
        .unwrap();
        assert_eq!(tail["text"], "ligne 9\nligne 10");
        assert_eq!(tail["truncated"], false);

        let past = read(&root, &json!({ "path": "ten.txt", "offset": 50 })).unwrap();
        assert_eq!(past["text"], "");

        fs::write(root.join("empty.txt"), "").unwrap();
        let empty = read(&root, &json!({ "path": "empty.txt" })).unwrap();
        assert_eq!(empty["totalLines"], 0);
        assert_eq!(empty["text"], "");
    }

    #[test]
    fn read_refuses_binaries_directories_and_missing_files() {
        let (_dir, root) = project();
        assert!(read(&root, &json!({ "path": "logo.png" }))
            .unwrap_err()
            .starts_with("Fichier binaire"));
        assert!(read(&root, &json!({ "path": "src" }))
            .unwrap_err()
            .starts_with("C'est un dossier"));
        assert_eq!(
            read(&root, &json!({ "path": "src/x.ts" })).unwrap_err(),
            "Fichier introuvable : src/x.ts"
        );
        assert_eq!(
            read(&root, &json!({ "path": "../secret" })).unwrap_err(),
            "Chemin hors du projet : ../secret"
        );
        assert!(read(&root, &json!({}))
            .unwrap_err()
            .starts_with("Paramètre manquant"));
        assert!(read(&root, &json!({ "path": "README.md", "offset": "x" })).is_err());
    }

    #[test]
    fn read_caps_huge_lines() {
        let (_dir, root) = project();
        fs::write(root.join("min.js"), "é".repeat(READ_MAX_BYTES)).unwrap();
        let data = read(&root, &json!({ "path": "min.js" })).unwrap();
        assert_eq!(data["truncated"], true);
        assert!(data["text"].as_str().unwrap().len() <= READ_MAX_BYTES);
    }

    #[test]
    fn write_creates_missing_directories() {
        let (_dir, root) = project();
        let data = write(
            &root,
            &json!({ "path": "new/deep/file.txt", "content": "héllo" }),
        )
        .unwrap();
        assert_eq!(data["size"], 6);
        assert_eq!(
            fs::read_to_string(root.join("new/deep/file.txt")).unwrap(),
            "héllo"
        );
        write(&root, &json!({ "path": "README.md", "content": "" })).unwrap();
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "");
        let png = [0x89, b'P', b'N', b'G', 0, 1, 2];
        let data = write(
            &root,
            &json!({ "path": "public/logo.png", "content": BASE64.encode(png), "base64": true }),
        )
        .unwrap();
        assert_eq!(data["size"], 7);
        assert_eq!(fs::read(root.join("public/logo.png")).unwrap(), png);
        assert!(write(
            &root,
            &json!({ "path": "bad.png", "content": "%%%", "base64": true })
        )
        .is_err());
        assert!(write(&root, &json!({ "path": "src", "content": "x" })).is_err());
        assert!(write(&root, &json!({ "path": "", "content": "x" })).is_err());
        assert!(write(&root, &json!({ "path": "../x.txt", "content": "x" })).is_err());
        assert!(write(&root, &json!({ "path": "/tmp/x.txt", "content": "x" })).is_err());
        assert!(write(&root, &json!({ "path": "x.txt" }))
            .unwrap_err()
            .starts_with("Paramètre manquant"));
    }

    #[test]
    fn edit_replaces_a_unique_text() {
        let (_dir, root) = project();
        fs::write(root.join("a.txt"), "un deux trois deux\n").unwrap();
        let ambiguous = edit(
            &root,
            &json!({ "path": "a.txt", "old": "deux", "new": "2" }),
        );
        assert!(ambiguous.unwrap_err().contains("2 fois"));
        let data = edit(
            &root,
            &json!({ "path": "a.txt", "old": "un deux", "new": "1 2" }),
        )
        .unwrap();
        assert_eq!(data["replaced"], 1);
        let data = edit(
            &root,
            &json!({ "path": "a.txt", "old": "deux", "new": "2", "all": true }),
        )
        .unwrap();
        assert_eq!(data["replaced"], 1);
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "1 2 trois 2\n"
        );

        fs::write(root.join("b.txt"), "x x x").unwrap();
        let data = edit(
            &root,
            &json!({ "path": "b.txt", "old": "x", "new": "y", "all": true }),
        )
        .unwrap();
        assert_eq!(data["replaced"], 3);
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "y y y");

        assert!(
            edit(&root, &json!({ "path": "b.txt", "old": "zzz", "new": "y" }))
                .unwrap_err()
                .starts_with("Texte introuvable")
        );
        assert!(edit(&root, &json!({ "path": "b.txt", "old": "", "new": "y" })).is_err());
        assert!(edit(
            &root,
            &json!({ "path": "logo.png", "old": "P", "new": "Q" })
        )
        .is_err());
        assert!(edit(
            &root,
            &json!({ "path": "nope.txt", "old": "a", "new": "b" })
        )
        .unwrap_err()
        .starts_with("Fichier introuvable"));
    }

    #[test]
    fn edit_matches_crlf_files_with_lf_text() {
        let (_dir, root) = project();
        fs::write(root.join("w.txt"), "a\r\nb\r\nc\r\n").unwrap();
        let data = edit(
            &root,
            &json!({ "path": "w.txt", "old": "a\nb", "new": "A\nB" }),
        )
        .unwrap();
        assert_eq!(data["replaced"], 1);
        assert_eq!(
            fs::read_to_string(root.join("w.txt")).unwrap(),
            "A\r\nB\r\nc\r\n"
        );
    }
}
