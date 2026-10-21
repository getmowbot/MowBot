//! `find` and `search`: walk a project like git sees it (`.gitignore` respected, `.git` skipped).

use std::fs;
use std::io::Read;
use std::path::Path;

use globset::{GlobBuilder, GlobMatcher};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde_json::{json, Value};

use super::files::{cut, is_binary, BINARY_SNIFF};
use super::paths::{components, relative, resolve, shown};
use super::{opt_str, req_str, u64_arg};

const FIND_DEFAULT_LIMIT: u64 = 500;
const FIND_MAX_LIMIT: u64 = 5_000;
const SEARCH_DEFAULT_LIMIT: u64 = 100;
const SEARCH_MAX_LIMIT: u64 = 1_000;
/// Entries visited at most by one walk (a huge tree without .gitignore).
const WALK_MAX_ENTRIES: usize = 300_000;
/// Files bigger than this are not searched.
const SEARCH_MAX_FILE: u64 = 8 * 1024 * 1024;
const MATCH_MAX_TEXT: usize = 400;

/// A glob on project-relative paths. Without `/` it matches the file name at any depth (like
/// `.gitignore` and ripgrep: `*.ts`); with one, the whole path (`src/**/*.ts`).
struct PathGlob {
    matcher: GlobMatcher,
    name_only: bool,
}

impl PathGlob {
    fn new(pattern: &str) -> Result<Self, String> {
        let pattern = pattern.trim().trim_start_matches("./");
        if pattern.is_empty() {
            return Err("Motif glob vide.".into());
        }
        let bytes = pattern.as_bytes();
        if pattern.starts_with('/')
            || pattern.starts_with('\\')
            || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        {
            return Err(format!(
                "Motif absolu refusé : {pattern} (les motifs sont relatifs à la racine du projet)"
            ));
        }
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .backslash_escape(true)
            .build()
            .map_err(|e| format!("Motif glob invalide : {pattern} ({e})"))?;
        Ok(Self {
            matcher: glob.compile_matcher(),
            name_only: !pattern.contains('/'),
        })
    }

    fn matches(&self, rel: &str) -> bool {
        if self.name_only {
            let name = rel.rsplit('/').next().unwrap_or(rel);
            self.matcher.is_match(name)
        } else {
            self.matcher.is_match(rel)
        }
    }
}

/// The literal directories a glob starts with (`src/app` for `src/app/**/*.ts`): where to walk.
fn literal_prefix(pattern: &str) -> String {
    let pattern = pattern.trim().trim_start_matches("./");
    let parts: Vec<&str> = pattern.split('/').collect();
    let mut prefix = Vec::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        if part.contains(['*', '?', '[', ']', '{', '}', '\\']) {
            break;
        }
        prefix.push(*part);
    }
    prefix.join("/")
}

/// The files under `start` (a directory inside `root`), in a stable order.
pub(super) fn walk_files(
    root: &Path,
    start: &Path,
    mut visit: impl FnMut(&Path, String) -> bool,
) -> bool {
    let walker = WalkBuilder::new(start)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .sort_by_file_name(|a, b| a.cmp(b))
        .build();
    for (visited, entry) in walker.enumerate() {
        if visited >= WALK_MAX_ENTRIES {
            return true;
        }
        let Ok(entry) = entry else { continue };
        // Links are not followed: a link could lead out of the project.
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let rel = relative(root, entry.path());
        if !visit(entry.path(), rel) {
            return true;
        }
    }
    false
}

fn limit(args: &Value, default: u64, max: u64) -> Result<usize, String> {
    Ok(u64_arg(args, "limit")?.unwrap_or(default).clamp(1, max) as usize)
}

pub fn find(root: &Path, args: &Value) -> Result<Value, String> {
    let pattern = req_str(args, "pattern")?;
    let limit = limit(args, FIND_DEFAULT_LIMIT, FIND_MAX_LIMIT)?;
    let glob = PathGlob::new(pattern)?;
    let prefix = literal_prefix(pattern);
    components(&prefix)?;
    let start = resolve(root, &prefix)?;
    if !start.is_dir() {
        return Ok(json!({ "paths": [], "truncated": false }));
    }
    let mut paths = Vec::new();
    let mut truncated = false;
    let stopped = walk_files(root, &start, |_, rel| {
        if glob.matches(&rel) {
            if paths.len() == limit {
                truncated = true;
                return false;
            }
            paths.push(rel);
        }
        true
    });
    Ok(json!({ "paths": paths, "truncated": truncated || stopped }))
}

pub fn search(root: &Path, args: &Value) -> Result<Value, String> {
    let pattern = req_str(args, "pattern")?;
    let rel = opt_str(args, "path").unwrap_or("");
    let limit = limit(args, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT)?;
    let glob = opt_str(args, "glob")
        .filter(|g| !g.trim().is_empty())
        .map(PathGlob::new)
        .transpose()?;
    let regex = RegexBuilder::new(pattern)
        .size_limit(16 * 1024 * 1024)
        .build()
        .map_err(|e| format!("Expression régulière invalide : {e}"))?;

    let start = resolve(root, rel)?;
    let meta = fs::metadata(&start).map_err(|_| format!("Chemin introuvable : {}", shown(rel)))?;

    let mut matches: Vec<Value> = Vec::new();
    let mut truncated = false;
    let mut search_file = |path: &Path, rel: String| -> bool {
        let Some(text) = text_of(path) else {
            return true;
        };
        for (index, line) in text.lines().enumerate() {
            if !regex.is_match(line) {
                continue;
            }
            if matches.len() == limit {
                truncated = true;
                return false;
            }
            matches.push(json!({
                "path": rel,
                "line": index + 1,
                "text": cut(line.trim_end(), MATCH_MAX_TEXT),
            }));
        }
        true
    };

    let stopped = if meta.is_dir() {
        walk_files(root, &start, |path, rel| {
            if glob.as_ref().is_some_and(|g| !g.matches(&rel)) {
                return true;
            }
            search_file(path, rel)
        })
    } else {
        // One file, searched even if ignored.
        let rel = relative(root, &start);
        search_file(&start, rel);
        false
    };
    Ok(json!({ "matches": matches, "truncated": truncated || stopped }))
}

/// A file's text, or `None` when it is binary, too big or unreadable.
fn text_of(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > SEARCH_MAX_FILE {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    fs::File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    if is_binary(&bytes[..bytes.len().min(BINARY_SNIFF)]) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        for (path, content) in [
            (".gitignore", "dist/\n*.log\n"),
            (
                "src/main.ts",
                "export const answer = 42;\nconsole.log('MowBot');\n",
            ),
            ("src/app/view.ts", "// TODO: mowbot view\nexport {};\n"),
            ("src/app/view.css", ".mowbot { color: black; }\n"),
            ("dist/main.js", "console.log('MowBot');\n"),
            ("debug.log", "MowBot crashed\n"),
            (".git/config", "[core] MowBot\n"),
            (".github/ci.yml", "name: MowBot\n"),
            ("README.md", "# MowBot\n"),
        ] {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, content).unwrap();
        }
        fs::write(root.join("logo.png"), b"\x89PNG\0MowBot").unwrap();
        (dir, root)
    }

    fn paths(data: &Value) -> Vec<&str> {
        data["paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect()
    }

    #[test]
    fn find_matches_globs_and_respects_gitignore() {
        let (_dir, root) = project();
        let data = find(&root, &json!({ "pattern": "src/**/*.ts" })).unwrap();
        assert_eq!(paths(&data), ["src/app/view.ts", "src/main.ts"]);
        assert_eq!(data["truncated"], false);

        let data = find(&root, &json!({ "pattern": "*.ts" })).unwrap();
        assert_eq!(paths(&data), ["src/app/view.ts", "src/main.ts"]);

        let data = find(&root, &json!({ "pattern": "src/*.ts" })).unwrap();
        assert_eq!(paths(&data), ["src/main.ts"]);

        let data = find(&root, &json!({ "pattern": "**/*" })).unwrap();
        let all = paths(&data);
        assert!(all.contains(&".github/ci.yml"));
        assert!(all.contains(&".gitignore"));
        assert!(!all
            .iter()
            .any(|p| p.starts_with(".git/") || p.starts_with("dist/")));
        assert!(!all.contains(&"debug.log"));

        let data = find(&root, &json!({ "pattern": "**/*", "limit": 2 })).unwrap();
        assert_eq!(paths(&data).len(), 2);
        assert_eq!(data["truncated"], true);

        let data = find(&root, &json!({ "pattern": "nope/**/*.ts" })).unwrap();
        assert!(paths(&data).is_empty());

        assert!(find(&root, &json!({ "pattern": "../**/*" })).is_err());
        assert!(find(&root, &json!({ "pattern": "/etc/*" })).is_err());
        assert!(find(&root, &json!({ "pattern": "src/[" }))
            .unwrap_err()
            .starts_with("Motif glob invalide"));
    }

    #[test]
    fn search_finds_lines_and_skips_ignored_and_binary_files() {
        let (_dir, root) = project();
        let data = search(&root, &json!({ "pattern": "MowBot" })).unwrap();
        let found: Vec<(String, u64)> = data["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                (
                    m["path"].as_str().unwrap().to_string(),
                    m["line"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            found,
            [
                (".github/ci.yml".to_string(), 1),
                ("README.md".to_string(), 1),
                ("src/main.ts".to_string(), 2),
            ]
        );
        assert_eq!(data["matches"][2]["text"], "console.log('MowBot');");

        let data = search(&root, &json!({ "pattern": "(?i)mowbot", "glob": "*.ts" })).unwrap();
        assert_eq!(data["matches"].as_array().unwrap().len(), 2);

        let data = search(&root, &json!({ "pattern": "mowbot", "path": "src/app" })).unwrap();
        assert_eq!(data["matches"].as_array().unwrap().len(), 2);

        let data = search(
            &root,
            &json!({ "pattern": "MowBot", "path": "dist/main.js" }),
        )
        .unwrap();
        assert_eq!(data["matches"][0]["path"], "dist/main.js");

        let data = search(&root, &json!({ "pattern": "(?i)mowbot", "limit": 1 })).unwrap();
        assert_eq!(data["matches"].as_array().unwrap().len(), 1);
        assert_eq!(data["truncated"], true);

        assert!(search(&root, &json!({ "pattern": "(" }))
            .unwrap_err()
            .starts_with("Expression régulière invalide"));
        assert!(search(&root, &json!({ "pattern": "x", "path": "../" })).is_err());
        assert!(search(&root, &json!({ "pattern": "x", "path": "nope" }))
            .unwrap_err()
            .starts_with("Chemin introuvable"));
    }

    #[cfg(unix)]
    #[test]
    fn walks_do_not_follow_links_out_of_the_project() {
        let (_dir, root) = project();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.ts"), "MowBot secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        let data = find(&root, &json!({ "pattern": "**/*.ts" })).unwrap();
        assert!(!paths(&data).iter().any(|p| p.contains("secret")));
        let data = search(&root, &json!({ "pattern": "secret" })).unwrap();
        assert!(data["matches"].as_array().unwrap().is_empty());
        assert!(find(&root, &json!({ "pattern": "escape/*.ts" })).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn walks_do_not_follow_junctions_out_of_the_project() {
        use std::os::windows::process::CommandExt;
        let (_dir, root) = project();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.ts"), "MowBot secret").unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("escape"))
            .arg(dunce::canonicalize(outside.path()).unwrap())
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let data = find(&root, &json!({ "pattern": "**/*.ts" })).unwrap();
        assert!(!paths(&data).iter().any(|p| p.contains("secret")));
        let data = search(&root, &json!({ "pattern": "secret" })).unwrap();
        assert!(data["matches"].as_array().unwrap().is_empty());
        assert!(find(&root, &json!({ "pattern": "escape/*.ts" })).is_err());
    }

    #[test]
    fn literal_prefixes() {
        assert_eq!(literal_prefix("src/app/**/*.ts"), "src/app");
        assert_eq!(literal_prefix("./src/*.ts"), "src");
        assert_eq!(literal_prefix("*.ts"), "");
        assert_eq!(literal_prefix("**/x/*.ts"), "");
        assert_eq!(literal_prefix("src/main.rs"), "src");
    }
}
