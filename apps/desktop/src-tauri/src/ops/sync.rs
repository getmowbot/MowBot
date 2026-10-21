//! `manifest` and `read_files`: what the hub needs to copy a project on a bot's PC (docs/DESKTOP.md).

use std::fs;
use std::io::{ErrorKind, Read};
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::files::existing_file;
use super::git;
use super::paths::{io_error, resolve, shown};
use super::walk::walk_files;
use super::{opt_str, str_list};

/// Files bigger than this are left out of a manifest (`truncated`).
const MANIFEST_MAX_FILE: u64 = 20 * 1024 * 1024;
/// Files a manifest lists at most (`truncated` beyond).
const MANIFEST_MAX_FILES: usize = 50_000;
/// Paths one `read_files` asks for at most.
const READ_FILES_MAX_PATHS: usize = 200;
/// Bytes one `read_files` returns at most (before base64)… unless it asks for a single file, which
/// can be as big as a manifest lists.
const READ_FILES_MAX_BYTES: u64 = 8 * 1024 * 1024;

const MB: u64 = 1024 * 1024;

pub fn manifest(root: &Path, args: &Value) -> Result<Value, String> {
    manifest_within(root, args, MANIFEST_MAX_FILES, MANIFEST_MAX_FILE)
}

fn manifest_within(
    root: &Path,
    args: &Value,
    max_files: usize,
    max_file: u64,
) -> Result<Value, String> {
    let rel = opt_str(args, "path").unwrap_or("");
    let start = resolve(root, rel)?;
    let meta = fs::metadata(&start).map_err(|e| match e.kind() {
        ErrorKind::NotFound => format!("Dossier introuvable : {}", shown(rel)),
        _ => io_error(rel, &e),
    })?;
    if !meta.is_dir() {
        return Err(format!("Ce n'est pas un dossier : {}", shown(rel)));
    }

    let mut files: Vec<Value> = Vec::new();
    let mut truncated = false;
    let mut buffer = vec![0u8; 64 * 1024];
    let stopped = walk_files(root, &start, |path, rel| {
        if files.len() == max_files {
            truncated = true;
            return false;
        }
        match hash_file(path, max_file, &mut buffer) {
            Ok(Some((size, hash))) => {
                files.push(json!({ "path": rel, "size": size, "hash": hash }));
            }
            // Gone since the walk saw it: nothing to copy.
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            // Too big, or unreadable (locked by another program…): left out.
            _ => truncated = true,
        }
        true
    });
    Ok(json!({
        "files": files,
        "head": git::head(root),
        "truncated": truncated || stopped,
    }))
}

/// The size and SHA-256 (hexadecimal) of a file, `None` when it is bigger than `max`.
fn hash_file(path: &Path, max: u64, buffer: &mut [u8]) -> std::io::Result<Option<(u64, String)>> {
    if fs::metadata(path)?.len() > max {
        return Ok(None);
    }
    let mut file = fs::File::open(path)?.take(max + 1);
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    loop {
        let read = file.read(buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    // Grown past the limit since its size was read.
    if size > max {
        return Ok(None);
    }
    Ok(Some((size, hex::encode(hasher.finalize()))))
}

pub fn read_files(root: &Path, args: &Value) -> Result<Value, String> {
    read_files_within(root, args, READ_FILES_MAX_BYTES, MANIFEST_MAX_FILE)
}

fn read_files_within(
    root: &Path,
    args: &Value,
    max_bytes: u64,
    max_single: u64,
) -> Result<Value, String> {
    let paths = str_list(args, "paths")?.ok_or("Paramètre manquant : paths")?;
    if paths.len() > READ_FILES_MAX_PATHS {
        return Err(format!(
            "Trop de fichiers demandés : {} (au plus {READ_FILES_MAX_PATHS} par requête).",
            paths.len()
        ));
    }
    let single = paths.len() == 1;
    let max = if single {
        max_bytes.max(max_single)
    } else {
        max_bytes
    };
    let too_big = |rel: &str| {
        if single {
            format!(
                "Fichier trop gros pour être copié : {rel} (plus de {} Mo).",
                max.div_ceil(MB)
            )
        } else {
            format!(
                "Trop de données demandées en une fois : plus de {} Mo (demande ces fichiers en plusieurs fois).",
                max.div_ceil(MB)
            )
        }
    };

    // Every path checked, and the total size, before anything is read.
    let mut targets = Vec::with_capacity(paths.len());
    let mut total: u64 = 0;
    for rel in paths {
        let file = existing_file(root, rel)?;
        let size = fs::metadata(&file).map_err(|e| io_error(rel, &e))?.len();
        total = total.saturating_add(size);
        if total > max {
            return Err(too_big(rel));
        }
        targets.push((rel, file));
    }

    let mut files = Vec::with_capacity(targets.len());
    let mut read: u64 = 0;
    for (rel, file) in targets {
        let mut bytes = Vec::new();
        fs::File::open(&file)
            .and_then(|handle| handle.take(max - read + 1).read_to_end(&mut bytes))
            .map_err(|e| io_error(rel, &e))?;
        read += bytes.len() as u64;
        // Grown since its size was read.
        if read > max {
            return Err(too_big(rel));
        }
        files.push(json!({ "path": rel, "data": BASE64.encode(&bytes) }));
    }
    Ok(json!({ "files": files }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for (path, content) in [
            (".gitignore", "dist/\n*.log\n"),
            ("src/main.ts", "hello"),
            ("src/app/view.ts", "export {};\n"),
            ("dist/main.js", "built\n"),
            ("debug.log", "crashed\n"),
            (".git/config", "[core]\n"),
            ("README.md", "# Projet\n"),
        ] {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, content).unwrap();
        }
        (dir, root)
    }

    fn listed(data: &Value) -> Vec<&str> {
        data["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap())
            .collect()
    }

    /// Whether `dir` is inside a git repository (a temp folder normally is not).
    fn in_a_repository(dir: &Path) -> bool {
        git::head(dir).is_some()
    }

    #[test]
    fn manifest_lists_files_with_their_hashes() {
        let (_dir, root) = project();
        let data = manifest(&root, &json!({})).unwrap();
        assert_eq!(
            listed(&data),
            [".gitignore", "README.md", "src/app/view.ts", "src/main.ts"]
        );
        let main = &data["files"][3];
        assert_eq!(main["size"], 5);
        assert_eq!(main["hash"], HELLO_SHA256);
        assert_eq!(data["truncated"], false);
        if !in_a_repository(&root) {
            assert!(data["head"].is_null());
        }

        let data = manifest(&root, &json!({ "path": "src/app" })).unwrap();
        assert_eq!(listed(&data), ["src/app/view.ts"]);

        assert!(manifest(&root, &json!({ "path": "../" }))
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(manifest(&root, &json!({ "path": "nope" }))
            .unwrap_err()
            .starts_with("Dossier introuvable"));
        assert!(manifest(&root, &json!({ "path": "README.md" }))
            .unwrap_err()
            .starts_with("Ce n'est pas un dossier"));
    }

    #[test]
    fn manifest_leaves_out_big_files_and_stops_at_its_limit() {
        let (_dir, root) = project();
        // Never read: its size alone leaves it out.
        let big = fs::File::create(root.join("big.bin")).unwrap();
        big.set_len(MANIFEST_MAX_FILE + 1).unwrap();
        drop(big);
        let data = manifest(&root, &json!({})).unwrap();
        assert!(!listed(&data).contains(&"big.bin"));
        assert_eq!(listed(&data).len(), 4);
        assert_eq!(data["truncated"], true);

        let data = manifest_within(&root, &json!({ "path": "src" }), 100, 5).unwrap();
        assert_eq!(listed(&data), ["src/main.ts"]);
        assert_eq!(data["truncated"], true);

        let data = manifest_within(&root, &json!({}), 2, MANIFEST_MAX_FILE).unwrap();
        assert_eq!(listed(&data), [".gitignore", "README.md"]);
        assert_eq!(data["truncated"], true);

        let data = manifest_within(&root, &json!({ "path": "src" }), 2, 100).unwrap();
        assert_eq!(listed(&data).len(), 2);
        assert_eq!(data["truncated"], false);
    }

    #[test]
    fn read_files_returns_base64_contents() {
        let (_dir, root) = project();
        let binary = [0u8, 1, 2, 255, b'\r', b'\n'];
        fs::write(root.join("logo.bin"), binary).unwrap();
        let data = read_files(&root, &json!({ "paths": ["logo.bin", "src/main.ts"] })).unwrap();
        let files = data["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["path"], "logo.bin");
        assert_eq!(
            BASE64.decode(files[0]["data"].as_str().unwrap()).unwrap(),
            binary
        );
        assert_eq!(files[1]["path"], "src/main.ts");
        assert_eq!(
            BASE64.decode(files[1]["data"].as_str().unwrap()).unwrap(),
            b"hello"
        );
        // Ignored files can still be asked for.
        assert!(read_files(&root, &json!({ "paths": ["debug.log"] })).is_ok());
        assert_eq!(
            read_files(&root, &json!({ "paths": [] })).unwrap()["files"],
            json!([])
        );
    }

    #[test]
    fn read_files_refuses_bad_paths_and_lists() {
        let (_dir, root) = project();
        assert_eq!(
            read_files(&root, &json!({ "paths": ["README.md", "../secret"] })).unwrap_err(),
            "Chemin hors du projet : ../secret"
        );
        assert!(read_files(&root, &json!({ "paths": ["/etc/passwd"] }))
            .unwrap_err()
            .starts_with("Chemin absolu refusé"));
        assert_eq!(
            read_files(&root, &json!({ "paths": ["nope.txt"] })).unwrap_err(),
            "Fichier introuvable : nope.txt"
        );
        assert!(read_files(&root, &json!({ "paths": ["src"] }))
            .unwrap_err()
            .starts_with("C'est un dossier"));
        let many: Vec<&str> = vec!["README.md"; READ_FILES_MAX_PATHS + 1];
        assert!(read_files(&root, &json!({ "paths": many }))
            .unwrap_err()
            .starts_with("Trop de fichiers demandés"));
        assert_eq!(
            read_files(&root, &json!({})).unwrap_err(),
            "Paramètre manquant : paths"
        );
        assert!(read_files(&root, &json!({ "paths": "README.md" }))
            .unwrap_err()
            .contains("liste"));
    }

    #[test]
    fn read_files_caps_the_answer() {
        let (_dir, root) = project();
        fs::write(root.join("a.txt"), "12345").unwrap();
        fs::write(root.join("b.txt"), "67890").unwrap();
        fs::write(root.join("c.txt"), "0123456789").unwrap();
        fs::write(root.join("d.txt"), "0123456789abc").unwrap();
        let both = json!({ "paths": ["a.txt", "b.txt"] });
        assert!(read_files_within(&root, &both, 8, 12)
            .unwrap_err()
            .starts_with("Trop de données demandées"));
        assert!(read_files_within(&root, &both, 10, 12).is_ok());
        // Alone, a file may be bigger than a batch.
        assert!(read_files_within(&root, &json!({ "paths": ["c.txt"] }), 8, 12).is_ok());
        assert!(
            read_files_within(&root, &json!({ "paths": ["d.txt"] }), 8, 12)
                .unwrap_err()
                .starts_with("Fichier trop gros")
        );
    }
}
