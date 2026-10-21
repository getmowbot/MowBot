//! git, run directly (never through a shell): the commit a project is at, and `branch`, which turns
//! a bot's changes into a branch of the project's repository without touching its working tree or
//! its index (a temporary index is used instead).

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Value};

use super::files::cut;
use super::paths::normalized;
use super::{req_str, str_list};

const GIT_MISSING: &str = "git est introuvable sur cet ordinateur.";
const NOT_A_REPO: &str = "Ce projet n'est pas un dépôt git.";
/// git processes hashing files at the same time.
const HASH_WORKERS: usize = 4;
/// What is kept of git's own message in an error.
const GIT_MESSAGE_MAX: usize = 2_000;

/// `git -c core.quotepath=off` in `dir`: no window, no prompt, pathspecs taken literally, and none
/// of the git variables the app could have inherited (a hook's GIT_DIR…).
fn command(dir: &Path, index: Option<&Path>) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.quotepath=off"])
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1");
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_PREFIX",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ] {
        cmd.env_remove(name);
    }
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(super::exec::CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs git, `input` on its stdin. `Err` only when git cannot be started.
fn run(mut cmd: Command, input: Option<&[u8]>) -> Result<Output, String> {
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        ErrorKind::NotFound => GIT_MISSING.to_string(),
        _ => format!("Impossible de lancer git : {e}"),
    })?;
    let stdin = child.stdin.take();
    std::thread::scope(|scope| {
        if let (Some(mut stdin), Some(input)) = (stdin, input) {
            // Written aside while git's output is read; a git that stops early closes the pipe.
            scope.spawn(move || {
                let _ = stdin.write_all(input);
            });
        }
        child.wait_with_output()
    })
    .map_err(|e| format!("git n'a pas pu être suivi : {e}"))
}

/// What git printed, or a sentence saying what failed and why (git's own words).
fn checked(output: Output, what: &str) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(failure(what, &output))
    }
}

fn failure(what: &str, output: &Output) -> String {
    let said = String::from_utf8_lossy(&output.stderr);
    let said = said.trim();
    if said.is_empty() {
        format!("{what} : git a échoué ({}).", output.status)
    } else {
        format!("{what} : {}", cut(said, GIT_MESSAGE_MAX))
    }
}

/// The commit `HEAD` of the repository `dir` is in; `None` outside a repository, before the first
/// commit, or without git.
pub fn head(dir: &Path) -> Option<String> {
    let mut cmd = command(dir, None);
    cmd.args(["rev-parse", "--verify", "--quiet", "HEAD"]);
    let output = run(cmd, None).ok()?;
    if !output.status.success() {
        return None;
    }
    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!head.is_empty()).then_some(head)
}

/// A path git printed (UTF-8 under Windows, bytes elsewhere).
fn git_path(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

/// The repository a project is in: its top folder and the project's place in it (`""` or
/// `apps/web/`, the prefix of the project's paths in git).
struct Repo {
    top: PathBuf,
    prefix: String,
}

impl Repo {
    fn open(root: &Path) -> Result<Self, String> {
        let mut cmd = command(root, None);
        cmd.args(["rev-parse", "--show-toplevel", "--show-prefix"]);
        let output = run(cmd, None)?;
        if !output.status.success() {
            if String::from_utf8_lossy(&output.stderr).contains("safe.directory") {
                return Err(
                    "git refuse ce dépôt : il appartient à un autre utilisateur de l'ordinateur (voir git config --global --add safe.directory)."
                        .into(),
                );
            }
            return Err(NOT_A_REPO.into());
        }
        let mut lines = output.stdout.split(|b| *b == b'\n');
        let top = lines.next().unwrap_or_default();
        let top = top.strip_suffix(b"\r").unwrap_or(top);
        if top.is_empty() {
            return Err(NOT_A_REPO.into());
        }
        let prefix = String::from_utf8_lossy(lines.next().unwrap_or_default())
            .trim_end_matches('\r')
            .to_string();
        Ok(Self {
            top: git_path(top),
            prefix,
        })
    }

    fn command(&self, index: Option<&Path>) -> Command {
        command(&self.top, index)
    }

    fn git(&self, index: Option<&Path>, args: &[&str]) -> Result<Output, String> {
        let mut cmd = self.command(index);
        cmd.args(args);
        run(cmd, None)
    }

    /// The path in the repository of a project path.
    fn full(&self, path: &str) -> String {
        format!("{}{path}", self.prefix)
    }

    fn branch_name(&self, name: &str) -> Result<String, String> {
        let invalid = || format!("Nom de branche invalide : {name}");
        if name.is_empty() || name.starts_with('-') || name.contains(['\0', '\n', '\r']) {
            return Err(invalid());
        }
        let output = self.git(None, &["check-ref-format", "--branch", name])?;
        if !output.status.success() {
            return Err(invalid());
        }
        // `@{-1}` and the like name another branch: refused.
        let checked = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if checked != name {
            return Err(invalid());
        }
        Ok(checked)
    }

    /// The full hash of the commit `base` names.
    fn commit_of(&self, base: &str) -> Result<String, String> {
        let missing = || format!("Commit de départ introuvable dans le dépôt : {base}");
        if base.trim().is_empty() || base.starts_with('-') || base.contains(['\0', '\n', '\r']) {
            return Err(missing());
        }
        let output = self.git(
            None,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{base}^{{commit}}"),
            ],
        )?;
        if !output.status.success() {
            return Err(missing());
        }
        let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if commit.is_empty() || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(missing());
        }
        Ok(commit)
    }

    fn has_branch(&self, name: &str) -> Result<bool, String> {
        let output = self.git(
            None,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
        )?;
        Ok(output.status.success())
    }

    /// The modes in `index` of the repository paths in `wanted`.
    fn modes(
        &self,
        index: &Path,
        wanted: &HashSet<String>,
    ) -> Result<HashMap<String, String>, String> {
        let mut cmd = self.command(Some(index));
        cmd.args(["ls-files", "--stage", "-z", "--full-name"]);
        if !self.prefix.is_empty() {
            cmd.arg("--").arg(&self.prefix);
        }
        let output = run(cmd, None)?;
        if !output.status.success() {
            return Err(failure("Lecture des fichiers du commit de départ", &output));
        }
        let mut modes = HashMap::new();
        // `<mode> <hash> <stage>\t<path>\0`
        for record in output.stdout.split(|b| *b == 0) {
            let Some(tab) = record.iter().position(|b| *b == b'\t') else {
                continue;
            };
            let path = String::from_utf8_lossy(&record[tab + 1..]);
            if !wanted.contains(path.as_ref()) {
                continue;
            }
            let mode = String::from_utf8_lossy(&record[..tab]);
            if let Some(mode) = mode.split(' ').next() {
                modes.insert(path.into_owned(), mode.to_string());
            }
        }
        Ok(modes)
    }

    /// Writes `data` in the repository's objects as `git add` would for `path` (its filters and
    /// line endings: `.gitattributes`, `core.autocrlf`…), and returns its hash.
    fn hash(&self, index: &Path, path: &str, data: &[u8]) -> Result<String, String> {
        let mut cmd = self.command(Some(index));
        cmd.args(["hash-object", "-w", "--stdin"])
            .arg(format!("--path={}", self.full(path)));
        let output = checked(run(cmd, Some(data))?, &format!("Enregistrement de {path}"))?;
        let hash = output.trim();
        if hash.is_empty() || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!(
                "Enregistrement de {path} : réponse inattendue de git."
            ));
        }
        Ok(hash.to_string())
    }

    /// `hash` for every file, a few at a time.
    fn hash_all(&self, index: &Path, files: &[(String, Vec<u8>)]) -> Result<Vec<String>, String> {
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let workers = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .clamp(1, HASH_WORKERS)
            .min(files.len());
        let chunk = files.len().div_ceil(workers);
        std::thread::scope(|scope| {
            let tasks: Vec<_> = files
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || {
                        part.iter()
                            .map(|(path, data)| self.hash(index, path, data))
                            .collect::<Result<Vec<_>, _>>()
                    })
                })
                .collect();
            let mut hashes = Vec::with_capacity(files.len());
            for task in tasks {
                let part = task
                    .join()
                    .map_err(|_| "Erreur interne du connecteur.".to_string())??;
                hashes.extend(part);
            }
            Ok(hashes)
        })
    }
}

/// An index file of our own in the temp folder, removed afterwards.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("mowbot-index-{}", uuid::Uuid::new_v4().simple())))
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let mut lock = OsString::from(self.0.as_os_str());
        lock.push(".lock");
        let _ = fs::remove_file(lock);
    }
}

/// A project path a branch writes or deletes: inside the project, a file, not in `.git`.
fn change_path(rel: &str) -> Result<String, String> {
    let path = normalized(rel)?;
    if path.is_empty() {
        return Err("Chemin de fichier attendu (pas la racine du projet).".into());
    }
    let in_git_dir = path.split('/').any(|name| {
        name.trim_end_matches(['.', ' '])
            .eq_ignore_ascii_case(".git")
    });
    if in_git_dir {
        return Err(format!("Chemin refusé (dossier .git) : {rel}"));
    }
    Ok(path)
}

fn written_files(args: &Value) -> Result<Vec<(String, Vec<u8>)>, String> {
    let invalid = || "Le paramètre files doit être une liste de { path, data }.".to_string();
    let Some(list) = args.get("files").filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let list = list.as_array().ok_or_else(invalid)?;
    let mut files = Vec::with_capacity(list.len());
    for item in list {
        let rel = item
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let data = item
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let path = change_path(rel)?;
        let bytes = BASE64
            .decode(data)
            .map_err(|_| format!("Contenu base64 invalide pour {rel}"))?;
        files.push((path, bytes));
    }
    Ok(files)
}

fn author(args: &Value) -> Result<(String, String), String> {
    let author = args
        .get("author")
        .filter(|v| v.is_object())
        .ok_or("Paramètre manquant : author ({ name, email })")?;
    let field = |name: &str| -> Result<String, String> {
        let value = author
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("Paramètre manquant : author.{name}"))?;
        if value.contains(['<', '>', '\n', '\r', '\0']) {
            return Err(format!("Auteur invalide ({name}) : {value}"));
        }
        Ok(value.to_string())
    };
    Ok((field("name")?, field("email")?))
}

fn already_exists(name: &str) -> String {
    format!("La branche {name} existe déjà.")
}

pub fn branch(root: &Path, args: &Value) -> Result<Value, String> {
    let name = req_str(args, "name")?;
    let message = req_str(args, "message")?;
    let base = req_str(args, "base")?;
    let (author_name, author_email) = author(args)?;
    if message.trim().is_empty() {
        return Err("Message de commit vide.".into());
    }
    let files = written_files(args)?;
    let deletes = str_list(args, "deletes")?
        .unwrap_or_default()
        .into_iter()
        .map(change_path)
        .collect::<Result<Vec<_>, _>>()?;
    if files.is_empty() && deletes.is_empty() {
        return Err("Aucun fichier à écrire ni à supprimer : pas de branche à créer.".into());
    }
    let mut seen = HashSet::new();
    for path in files.iter().map(|(path, _)| path).chain(&deletes) {
        if !seen.insert(path.as_str()) {
            return Err(format!("Chemin donné deux fois : {path}"));
        }
    }

    let repo = Repo::open(root)?;
    let name = repo.branch_name(name)?;
    let base = repo.commit_of(base)?;
    if repo.has_branch(&name)? {
        return Err(already_exists(&name));
    }

    let temp = TempIndex::new();
    let index = temp.0.as_path();
    checked(
        repo.git(Some(index), &["read-tree", &base])?,
        "Lecture du commit de départ",
    )?;
    let wanted: HashSet<String> = files.iter().map(|(path, _)| repo.full(path)).collect();
    let modes = repo.modes(index, &wanted)?;
    let hashes = repo.hash_all(index, &files)?;

    // `<mode> <hash>\t<path>\0` for each change; mode 0 removes the path. Deletions go first, so
    // that a file can take the place of a deleted folder (and conflicting entries are replaced).
    let mut info: Vec<u8> = Vec::new();
    let zero = "0".repeat(base.len());
    for path in &deletes {
        info.extend_from_slice(format!("0 {zero}\t{}\0", repo.full(path)).as_bytes());
    }
    for ((path, _), hash) in files.iter().zip(&hashes) {
        let full = repo.full(path);
        let mode = match modes.get(&full).map(String::as_str) {
            Some(mode @ ("100755" | "120000")) => mode,
            Some("160000") => {
                return Err(format!(
                    "{path} est un sous-module git : il ne peut pas être remplacé par un fichier."
                ))
            }
            _ => "100644",
        };
        info.extend_from_slice(format!("{mode} {hash}\t{full}\0").as_bytes());
    }
    let mut cmd = repo.command(Some(index));
    cmd.args(["update-index", "--add", "--replace", "-z", "--index-info"]);
    let output = run(cmd, Some(&info))?;
    if !output.status.success() {
        return Err(failure("Préparation du commit", &output));
    }
    // A path git refuses (`verify_path`) is skipped with this message, not an error.
    let said = String::from_utf8_lossy(&output.stderr);
    if let Some(path) = said
        .lines()
        .find_map(|line| line.strip_prefix("Ignoring path "))
    {
        let path = path.strip_prefix(repo.prefix.as_str()).unwrap_or(path);
        return Err(format!("Chemin refusé par git : {path}"));
    }

    let tree = checked(
        repo.git(Some(index), &["write-tree"])?,
        "Préparation du commit",
    )?;
    let tree = tree.trim();

    let mut text = message.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let mut cmd = repo.command(Some(index));
    cmd.args(["commit-tree", tree, "-p", &base, "-F", "-"])
        .env("GIT_AUTHOR_NAME", &author_name)
        .env("GIT_AUTHOR_EMAIL", &author_email)
        .env("GIT_COMMITTER_NAME", &author_name)
        .env("GIT_COMMITTER_EMAIL", &author_email);
    let commit = checked(run(cmd, Some(text.as_bytes()))?, "Création du commit")?;
    let commit = commit.trim().to_string();

    // `""`: the branch must not exist yet; it is never overwritten.
    let reference = format!("refs/heads/{name}");
    let output = repo.git(
        None,
        &["update-ref", "-m", "MowBot", &reference, &commit, ""],
    )?;
    if !output.status.success() {
        if repo.has_branch(&name)? {
            return Err(already_exists(&name));
        }
        return Err(failure(&format!("Création de la branche {name}"), &output));
    }
    Ok(json!({ "branch": name, "commit": commit }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        let available = command(&std::env::temp_dir(), None)
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success());
        if !available {
            eprintln!("git est introuvable : test sauté");
        }
        available
    }

    /// `git <args>` in `dir`, which must succeed; its output.
    fn git_in(dir: &Path, args: &[&str]) -> String {
        let output = command(dir, None).args(args).output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?} : {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn write(root: &Path, files: &[(&str, &str)]) {
        for (path, content) in files {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, content).unwrap();
        }
    }

    /// A repository with `files` committed, set up so that the user's git config does not matter.
    fn repository(files: &[(&str, &str)]) -> Option<(tempfile::TempDir, PathBuf, String)> {
        if !git_available() {
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let top = dunce::canonicalize(dir.path()).unwrap();
        git_in(&top, &["init", "-q"]);
        for (key, value) in [
            ("user.name", "Joris"),
            ("user.email", "joris@example.com"),
            ("core.autocrlf", "false"),
            ("commit.gpgsign", "false"),
        ] {
            git_in(&top, &["config", key, value]);
        }
        write(&top, files);
        git_in(&top, &["add", "-A"]);
        git_in(&top, &["commit", "-q", "--no-verify", "-m", "Départ"]);
        let head = git_in(&top, &["rev-parse", "HEAD"]).trim().to_string();
        Some((dir, top, head))
    }

    fn b64(text: &str) -> String {
        BASE64.encode(text)
    }

    #[test]
    fn branch_commits_changes_without_touching_the_working_tree() {
        let Some((_dir, top, head)) = repository(&[
            ("keep.txt", "keep\n"),
            ("edit.txt", "before\n"),
            ("gone.txt", "gone\n"),
            ("run.sh", "#!/bin/sh\necho 1\n"),
        ]) else {
            return;
        };
        git_in(&top, &["update-index", "--chmod=+x", "run.sh"]);
        git_in(&top, &["commit", "-q", "--no-verify", "-m", "Exécutable"]);
        let head_after_chmod = git_in(&top, &["rev-parse", "HEAD"]).trim().to_string();
        assert_ne!(head, head_after_chmod);
        let head = head_after_chmod;
        // The user's work in progress: a staged change and an untracked file.
        write(&top, &[("keep.txt", "staged\n")]);
        git_in(&top, &["add", "keep.txt"]);
        write(&top, &[("draft.txt", "draft\n")]);
        let status = git_in(&top, &["status", "--porcelain"]);
        let index = fs::read(top.join(".git/index")).unwrap();
        let current = git_in(&top, &["symbolic-ref", "HEAD"]);

        let args = json!({
            "name": "mowbot/bot-1",
            "message": "Changements du bot",
            "author": { "name": "Bot", "email": "bot@mowbot.local" },
            "base": head,
            "files": [
                { "path": "edit.txt", "data": b64("after\n") },
                { "path": "new/dir/file.txt", "data": b64("new\n") },
                { "path": "run.sh", "data": b64("#!/bin/sh\necho 2\n") },
            ],
            "deletes": ["gone.txt"],
        });
        let data = branch(&top, &args).unwrap();
        assert_eq!(data["branch"], "mowbot/bot-1");
        let commit = data["commit"].as_str().unwrap();
        assert_eq!(git_in(&top, &["rev-parse", "mowbot/bot-1"]).trim(), commit);

        let show = |path: &str| git_in(&top, &["cat-file", "-p", &format!("mowbot/bot-1:{path}")]);
        let entry = |path: &str| git_in(&top, &["ls-tree", "mowbot/bot-1", "--", path]);
        assert_eq!(show("edit.txt"), "after\n");
        assert_eq!(show("new/dir/file.txt"), "new\n");
        assert_eq!(show("run.sh"), "#!/bin/sh\necho 2\n");
        assert_eq!(show("keep.txt"), "keep\n");
        assert!(entry("gone.txt").is_empty());
        assert!(entry("run.sh").starts_with("100755 "));
        assert!(entry("edit.txt").starts_with("100644 "));
        assert!(entry("new/dir/file.txt").starts_with("100644 "));
        assert_eq!(
            git_in(
                &top,
                &[
                    "log",
                    "-1",
                    "--format=%P|%an <%ae>|%cn <%ce>|%s",
                    "mowbot/bot-1"
                ]
            )
            .trim(),
            format!("{head}|Bot <bot@mowbot.local>|Bot <bot@mowbot.local>|Changements du bot")
        );

        // Nothing moved on the user's side.
        assert_eq!(fs::read(top.join(".git/index")).unwrap(), index);
        assert_eq!(git_in(&top, &["status", "--porcelain"]), status);
        assert_eq!(git_in(&top, &["rev-parse", "HEAD"]).trim(), head);
        assert_eq!(git_in(&top, &["symbolic-ref", "HEAD"]), current);
        assert_eq!(
            fs::read_to_string(top.join("edit.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(
            fs::read_to_string(top.join("keep.txt")).unwrap(),
            "staged\n"
        );
        assert!(top.join("gone.txt").exists());
        assert!(!top.join("new").exists());

        // A branch is never overwritten.
        assert_eq!(
            branch(&top, &args).unwrap_err(),
            "La branche mowbot/bot-1 existe déjà."
        );
        assert_eq!(git_in(&top, &["rev-parse", "mowbot/bot-1"]).trim(), commit);
    }

    #[test]
    fn branch_in_a_project_inside_a_repository() {
        let Some((_dir, top, _)) = repository(&[
            ("root.txt", "root\n"),
            ("app/src/a.txt", "a\n"),
            ("app/old.txt", "old\n"),
            ("app/tool.sh", "#!/bin/sh\n"),
        ]) else {
            return;
        };
        git_in(&top, &["update-index", "--chmod=+x", "app/tool.sh"]);
        git_in(&top, &["commit", "-q", "--no-verify", "-m", "Exécutable"]);
        let head = git_in(&top, &["rev-parse", "HEAD"]).trim().to_string();
        let project = top.join("app");
        let data = branch(
            &project,
            &json!({
                "name": "mowbot/sub",
                "message": "Dans app",
                "author": { "name": "Bot", "email": "bot@mowbot.local" },
                "base": head,
                "files": [
                    { "path": "src/a.txt", "data": b64("A\n") },
                    { "path": "b.txt", "data": b64("b\n") },
                    { "path": "tool.sh", "data": b64("#!/bin/sh\necho\n") },
                ],
                "deletes": ["old.txt"],
            }),
        )
        .unwrap();
        assert_eq!(data["branch"], "mowbot/sub");
        let show = |path: &str| git_in(&top, &["cat-file", "-p", &format!("mowbot/sub:{path}")]);
        let entry = |path: &str| git_in(&top, &["ls-tree", "mowbot/sub", "--", path]);
        assert_eq!(show("app/src/a.txt"), "A\n");
        assert_eq!(show("app/b.txt"), "b\n");
        assert_eq!(show("root.txt"), "root\n");
        assert!(entry("app/old.txt").is_empty());
        assert!(entry("app/tool.sh").starts_with("100755 "));
        assert!(entry("app/b.txt").starts_with("100644 "));
        assert!(entry("b.txt").is_empty());
        assert!(entry("src").is_empty());
        assert!(top.join("app/old.txt").exists());

        assert_eq!(head_of(&project), Some(head));
    }

    /// `head`, which the tests' own `head` variables hide.
    fn head_of(dir: &Path) -> Option<String> {
        super::head(dir)
    }

    #[test]
    fn branch_stores_files_like_git_add() {
        let Some((_dir, top, head)) = repository(&[("text.txt", "a\nb\n")]) else {
            return;
        };
        git_in(&top, &["config", "core.autocrlf", "true"]);
        let binary = [0u8, b'\r', b'\n', 1];
        branch(
            &top,
            &json!({
                "name": "mowbot/crlf",
                "message": "Fins de ligne",
                "author": { "name": "Bot", "email": "bot@mowbot.local" },
                "base": head,
                "files": [
                    { "path": "text.txt", "data": b64("a\r\nc\r\n") },
                    { "path": "data.bin", "data": BASE64.encode(binary) },
                ],
            }),
        )
        .unwrap();
        // Text normalized as the repository wants it, binaries untouched.
        assert_eq!(
            git_in(&top, &["cat-file", "-p", "mowbot/crlf:text.txt"]),
            "a\nc\n"
        );
        let output = command(&top, None)
            .args(["cat-file", "blob", "mowbot/crlf:data.bin"])
            .output()
            .unwrap();
        assert_eq!(output.stdout, binary);
    }

    #[test]
    fn branch_refuses_bad_requests() {
        let Some((_dir, top, head)) = repository(&[("a.txt", "a\n")]) else {
            return;
        };
        let request = |changes: Value| {
            let mut args = json!({
                "name": "mowbot/x",
                "message": "x",
                "author": { "name": "Bot", "email": "bot@mowbot.local" },
                "base": head,
                "files": [{ "path": "a.txt", "data": b64("b\n") }],
            });
            for (key, value) in changes.as_object().unwrap() {
                args[key] = value.clone();
            }
            branch(&top, &args).unwrap_err()
        };
        assert_eq!(
            request(json!({ "name": "bad..name" })),
            "Nom de branche invalide : bad..name"
        );
        assert_eq!(
            request(json!({ "name": "-x" })),
            "Nom de branche invalide : -x"
        );
        assert!(request(json!({ "base": "nope" })).starts_with("Commit de départ introuvable"));
        assert!(request(json!({ "base": "--all" })).starts_with("Commit de départ introuvable"));
        assert_eq!(
            request(json!({ "files": [{ "path": "../x.txt", "data": "" }] })),
            "Chemin hors du projet : ../x.txt"
        );
        assert!(
            request(json!({ "files": [{ "path": "/etc/x", "data": "" }] }))
                .starts_with("Chemin absolu refusé")
        );
        assert!(
            request(json!({ "files": [{ "path": ".git/config", "data": "" }] }))
                .starts_with("Chemin refusé")
        );
        // `.git` under its NTFS short name: refused by git itself (core.protectNTFS).
        assert_eq!(
            request(json!({ "files": [{ "path": "GIT~1/hooks/x", "data": "" }] })),
            "Chemin refusé par git : GIT~1/hooks/x"
        );
        assert!(request(json!({ "deletes": ["../a.txt"] })).starts_with("Chemin hors du projet"));
        assert_eq!(
            request(json!({ "deletes": ["a.txt"] })),
            "Chemin donné deux fois : a.txt"
        );
        assert!(
            request(json!({ "files": [{ "path": "b.txt", "data": "%%%" }] }))
                .starts_with("Contenu base64 invalide")
        );
        assert!(request(json!({ "files": [] })).starts_with("Aucun fichier"));
        assert!(request(json!({ "author": { "name": "Bot" } })).contains("author.email"));
        assert!(request(json!({ "message": "  " })).starts_with("Message de commit vide"));
        // Nothing was created by the refused requests.
        assert!(!Repo::open(&top).unwrap().has_branch("mowbot/x").unwrap());
        // `a.txt` exists in the base: a folder can't be written under it without replacing it.
        let data = branch(
            &top,
            &json!({
                "name": "mowbot/folder",
                "message": "Dossier",
                "author": { "name": "Bot", "email": "bot@mowbot.local" },
                "base": head,
                "files": [{ "path": "a.txt/inside.txt", "data": b64("x\n") }],
                "deletes": ["a.txt"],
            }),
        );
        assert!(data.is_ok(), "{data:?}");
        assert_eq!(
            git_in(&top, &["cat-file", "-p", "mowbot/folder:a.txt/inside.txt"]),
            "x\n"
        );
    }

    #[test]
    fn branch_needs_a_repository() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        if head_of(&root).is_some() || Repo::open(&root).is_ok() {
            // The temp folder is itself inside a repository: nothing to check here.
            return;
        }
        let error = branch(
            &root,
            &json!({
                "name": "mowbot/x",
                "message": "x",
                "author": { "name": "Bot", "email": "bot@mowbot.local" },
                "base": "HEAD",
                "files": [{ "path": "a.txt", "data": b64("a\n") }],
            }),
        )
        .unwrap_err();
        assert_eq!(error, NOT_A_REPO);
    }
}
