//! Path safety: every path the hub sends is relative to a project's root and must stay inside it,
//! symlinks (and Windows junctions) included.

use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The canonical root of a shared folder, checked again on every request (it may have moved).
pub fn project_root(path: &str) -> Result<PathBuf, String> {
    let root = dunce::canonicalize(path)
        .map_err(|_| format!("Le dossier du projet est introuvable sur l'ordinateur : {path}"))?;
    if !root.is_dir() {
        return Err(format!(
            "Le dossier du projet n'est plus un dossier : {path}"
        ));
    }
    Ok(root)
}

/// How a project-relative path is shown in messages.
pub fn shown(rel: &str) -> &str {
    if rel.trim().is_empty() {
        "(racine du projet)"
    } else {
        rel
    }
}

/// The normal components of a project-relative path (`/`-separated, `""` is the root).
/// Absolute paths, drive letters and `..` going above the root are refused.
pub fn components(rel: &str) -> Result<Vec<String>, String> {
    if rel.contains('\0') {
        return Err(format!("Chemin invalide : {}", rel.replace('\0', "")));
    }
    let normalized = if cfg!(windows) {
        rel.replace('\\', "/")
    } else {
        rel.to_string()
    };
    let bytes = normalized.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if normalized.starts_with('/') || drive {
        return Err(format!(
            "Chemin absolu refusé : {rel} (les chemins sont relatifs à la racine du projet, avec des /)"
        ));
    }
    let mut parts: Vec<String> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(format!("Chemin hors du projet : {rel}"));
                }
            }
            name => {
                // `name:stream` (NTFS alternate data streams) and device paths.
                if cfg!(windows) && name.contains(':') {
                    return Err(format!("Chemin invalide : {rel}"));
                }
                parts.push(name.to_string());
            }
        }
    }
    Ok(parts)
}

/// `components` joined back with `/` (`""` for the root).
pub fn normalized(rel: &str) -> Result<String, String> {
    Ok(components(rel)?.join("/"))
}

/// Resolves a project-relative path to an absolute path inside `root` (canonical).
///
/// An existing path is canonicalized (symlinks resolved); for a path that does not exist yet
/// (a file about to be written), its nearest existing ancestor is. Either must be inside `root`.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts = components(rel)?;
    let mut existing = root.to_path_buf();
    existing.extend(&parts);
    let mut missing: Vec<OsString> = Vec::new();
    loop {
        match std::fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if is_not_found(&error) => {
                let Some(name) = existing.file_name().map(|n| n.to_os_string()) else {
                    return Err(format!("Chemin introuvable : {}", shown(rel)));
                };
                missing.push(name);
                if !existing.pop() || !existing.starts_with(root) {
                    return Err(format!(
                        "Le dossier du projet est introuvable : {}",
                        root.display()
                    ));
                }
            }
            Err(error) => return Err(io_error(rel, &error)),
        }
    }
    let canonical = dunce::canonicalize(&existing).map_err(|error| {
        if is_not_found(&error) {
            format!("Lien symbolique cassé : {}", shown(rel))
        } else {
            io_error(rel, &error)
        }
    })?;
    if !canonical.starts_with(root) {
        return Err(format!("Chemin hors du projet : {}", shown(rel)));
    }
    let mut resolved = canonical;
    resolved.extend(missing.iter().rev());
    Ok(resolved)
}

/// Whether `path` (already inside the walk of `root`) really points inside `root` once its
/// symlinks are resolved.
pub fn stays_inside(root: &Path, path: &Path) -> bool {
    dunce::canonicalize(path).is_ok_and(|target| target.starts_with(root))
}

/// The project-relative form (`/`-separated) of an absolute path inside `root`.
pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_not_found(error: &std::io::Error) -> bool {
    matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

/// A readable sentence for an I/O error on a project path.
pub fn io_error(rel: &str, error: &std::io::Error) -> String {
    let rel = shown(rel);
    match error.kind() {
        ErrorKind::NotFound => format!("Introuvable : {rel}"),
        ErrorKind::PermissionDenied => format!("Accès refusé par le système : {rel}"),
        ErrorKind::AlreadyExists => format!("Existe déjà : {rel}"),
        ErrorKind::NotADirectory => format!("Un élément du chemin n'est pas un dossier : {rel}"),
        ErrorKind::IsADirectory => format!("C'est un dossier, pas un fichier : {rel}"),
        ErrorKind::DirectoryNotEmpty => format!("Le dossier n'est pas vide : {rel}"),
        ErrorKind::StorageFull => format!("Disque plein en écrivant : {rel}"),
        _ => format!("Erreur sur {rel} : {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}\n").unwrap();
        (dir, root)
    }

    #[test]
    fn components_normalize_and_refuse_escapes() {
        assert_eq!(components("").unwrap(), Vec::<String>::new());
        assert_eq!(components(".").unwrap(), Vec::<String>::new());
        assert_eq!(
            components("src//./main.rs").unwrap(),
            vec!["src", "main.rs"]
        );
        assert_eq!(
            components("src/deep/../main.rs").unwrap(),
            vec!["src", "main.rs"]
        );
        assert_eq!(components("src/").unwrap(), vec!["src"]);
        assert!(components("..")
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(components("../secret")
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(components("src/../../secret").is_err());
        assert!(components("a\0b").is_err());
    }

    #[test]
    fn absolute_paths_and_drive_letters_are_refused() {
        for path in [
            "/etc/passwd",
            "C:/Windows",
            "c:relative",
            "//server/share",
            "C:\\x",
        ] {
            let error = components(path).unwrap_err();
            assert!(error.starts_with("Chemin absolu refusé"), "{path}: {error}");
        }
        #[cfg(windows)]
        {
            assert!(components("\\\\server\\share").is_err());
            assert!(components("..\\secret").is_err());
            assert!(components("file.txt:stream").is_err());
            assert_eq!(components("src\\main.rs").unwrap(), vec!["src", "main.rs"]);
        }
    }

    #[test]
    fn resolves_existing_and_new_paths_inside_the_root() {
        let (_dir, root) = project();
        assert_eq!(resolve(&root, "").unwrap(), root);
        assert_eq!(
            resolve(&root, "src/main.rs").unwrap(),
            root.join("src").join("main.rs")
        );
        assert_eq!(
            resolve(&root, "src/new/dir/file.txt").unwrap(),
            root.join("src").join("new").join("dir").join("file.txt")
        );
        assert!(resolve(&root, "../outside.txt").is_err());
        assert!(resolve(&root, "src/../../outside.txt").is_err());
    }

    #[test]
    fn relative_paths_use_slashes() {
        let (_dir, root) = project();
        assert_eq!(
            relative(&root, &root.join("src").join("main.rs")),
            "src/main.rs"
        );
        assert_eq!(relative(&root, &root), "");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_escaping_the_root_are_refused() {
        let (_dir, root) = project();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("secret")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("nope.txt"), root.join("dangling")).unwrap();
        std::os::unix::fs::symlink(root.join("src"), root.join("inside")).unwrap();

        assert!(resolve(&root, "escape/secret.txt")
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(resolve(&root, "escape/new.txt")
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(resolve(&root, "secret")
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(resolve(&root, "dangling")
            .unwrap_err()
            .starts_with("Lien symbolique cassé"));
        assert_eq!(
            resolve(&root, "inside/main.rs").unwrap(),
            root.join("src/main.rs")
        );
        assert!(!stays_inside(&root, &root.join("escape")));
        assert!(stays_inside(&root, &root.join("inside")));
    }

    #[cfg(windows)]
    #[test]
    fn junctions_and_symlinks_escaping_the_root_are_refused() {
        use std::os::windows::process::CommandExt;
        let (_dir, root) = project();
        let outside = tempfile::tempdir().unwrap();
        let outside_root = dunce::canonicalize(outside.path()).unwrap();
        fs::write(outside_root.join("secret.txt"), "secret").unwrap();

        // Junctions need no privilege.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("escape"))
            .arg(&outside_root)
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(resolve(&root, "escape/secret.txt")
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(resolve(&root, "escape/new.txt")
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(!stays_inside(&root, &root.join("escape")));

        // Symlinks need developer mode or admin: checked when the OS allows creating one.
        let file_link = root.join("secret");
        if std::os::windows::fs::symlink_file(outside_root.join("secret.txt"), &file_link).is_ok() {
            assert!(resolve(&root, "secret")
                .unwrap_err()
                .starts_with("Chemin hors du projet"));
        }
        let dangling = root.join("dangling");
        if std::os::windows::fs::symlink_file(outside_root.join("nope.txt"), &dangling).is_ok() {
            assert!(resolve(&root, "dangling").is_err());
        }
    }

    #[test]
    fn project_root_must_exist() {
        let (_dir, root) = project();
        assert_eq!(project_root(root.to_str().unwrap()).unwrap(), root);
        assert!(project_root(root.join("missing").to_str().unwrap()).is_err());
        assert!(project_root(root.join("src/main.rs").to_str().unwrap()).is_err());
    }
}
