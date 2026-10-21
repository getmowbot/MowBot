//! What the app remembers: the hub's address and the shared folders (`config.json` in the app's
//! config dir), and the connector's token per hub (OS credential store, else a private file).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "config.json";
const TOKENS_FILE: &str = "connector-tokens.json";
const KEYRING_SERVICE: &str = "MowBot connector";
/// What the hub accepts: names of 80 characters, paths of 1024, 200 projects per computer.
const NAME_MAX: usize = 80;
const PATH_MAX: usize = 1024;
const PROJECTS_MAX: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub key: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub hub_url: Option<String>,
    #[serde(default)]
    pub projects: Vec<Project>,
}

impl Config {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(CONFIG_FILE);
        let Ok(text) = fs::read_to_string(&path) else {
            return Self::default();
        };
        match serde_json::from_str(&text) {
            Ok(config) => config,
            Err(error) => {
                eprintln!("[mowbot] config illisible ({error}), mise de côté");
                let _ = fs::rename(&path, dir.join(format!("{CONFIG_FILE}.bad")));
                Self::default()
            }
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        write_private(dir, CONFIG_FILE, &text)
            .map_err(|e| format!("Impossible d'enregistrer la configuration : {e}"))
    }
}

/// Writes `dir/name` atomically (temporary file, then rename), readable by the user only on Unix.
fn write_private(dir: &Path, name: &str, text: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        std::io::Write::write_all(&mut file, text.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp, dir.join(name))
}

/// Checks a folder the user wants to share: it exists, is not a drive root or the home folder
/// itself, and is not shared yet. Returns the trimmed name and the canonical path.
pub fn check_new_project(
    name: &str,
    path: &str,
    existing: &[Project],
    home: Option<&Path>,
) -> Result<(String, PathBuf), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Donne un nom au projet.".into());
    }
    if name.chars().count() > NAME_MAX {
        return Err(format!("Nom trop long ({NAME_MAX} caractères au plus)."));
    }
    let path = path.trim();
    if path.is_empty() {
        return Err("Choisis un dossier.".into());
    }
    if existing.len() >= PROJECTS_MAX {
        return Err(format!(
            "Tu partages déjà {PROJECTS_MAX} dossiers, le maximum."
        ));
    }
    let canonical =
        dunce::canonicalize(path).map_err(|_| format!("Dossier introuvable : {path}"))?;
    if !canonical.is_dir() {
        return Err(format!("Ce n'est pas un dossier : {path}"));
    }
    if canonical.as_os_str().len() > PATH_MAX {
        return Err("Chemin trop long pour être partagé.".into());
    }
    if canonical.parent().is_none() {
        return Err(format!(
            "Partager la racine d'un disque ({}) n'est pas permis : choisis un dossier de projet.",
            canonical.display()
        ));
    }
    if let Some(home) = home.and_then(|h| dunce::canonicalize(h).ok()) {
        if canonical == home {
            return Err(
                "Partager tout le dossier personnel n'est pas permis : choisis un dossier de projet."
                    .into(),
            );
        }
    }
    for project in existing {
        let same = dunce::canonicalize(&project.path)
            .map(|p| p == canonical)
            .unwrap_or(false)
            || Path::new(&project.path) == canonical;
        if same {
            return Err(format!(
                "Ce dossier est déjà partagé (« {} »).",
                project.name
            ));
        }
        if project.name.to_lowercase() == name.to_lowercase() {
            return Err(format!("Un projet s'appelle déjà « {} ».", project.name));
        }
    }
    Ok((name.to_string(), canonical))
}

/// The connector's token for a hub (keyed by its URL): in the OS credential store when there is
/// one, else in a file of the app's config dir (private to the user).
pub struct Tokens {
    dir: PathBuf,
}

impl Tokens {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    fn entry(hub: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, hub).ok()
    }

    fn file(&self) -> BTreeMap<String, String> {
        fs::read_to_string(self.dir.join(TOKENS_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save_file(&self, tokens: &BTreeMap<String, String>) -> Result<(), String> {
        if tokens.is_empty() {
            let _ = fs::remove_file(self.dir.join(TOKENS_FILE));
            return Ok(());
        }
        let text = serde_json::to_string_pretty(tokens).map_err(|e| e.to_string())?;
        write_private(&self.dir, TOKENS_FILE, &text)
            .map_err(|e| format!("Impossible d'enregistrer le jeton : {e}"))
    }

    pub fn get(&self, hub: &str) -> Option<String> {
        if let Some(Ok(token)) = Self::entry(hub).map(|e| e.get_password()) {
            return Some(token);
        }
        self.file().remove(hub)
    }

    pub fn set(&self, hub: &str, token: &str) -> Result<(), String> {
        let mut file = self.file();
        let stored = Self::entry(hub).is_some_and(|e| e.set_password(token).is_ok())
            // Read back: some stores accept silently and forget.
            && Self::entry(hub).and_then(|e| e.get_password().ok()).as_deref() == Some(token);
        if stored {
            if file.remove(hub).is_some() {
                self.save_file(&file)?;
            }
            return Ok(());
        }
        file.insert(hub.to_string(), token.to_string());
        self.save_file(&file)
    }

    pub fn delete(&self, hub: &str) {
        if let Some(entry) = Self::entry(hub) {
            let _ = entry.delete_credential();
        }
        let mut file = self.file();
        if file.remove(hub).is_some() {
            let _ = self.save_file(&file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, path: &Path) -> Project {
        Project {
            key: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            path: path.display().to_string(),
        }
    }

    #[test]
    fn config_round_trips_in_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            hub_url: Some("https://hub.example.com".into()),
            projects: vec![project("MowBot", dir.path())],
        };
        config.save(dir.path()).unwrap();
        let text = fs::read_to_string(dir.path().join(CONFIG_FILE)).unwrap();
        assert!(text.contains("\"hubUrl\""));
        let loaded = Config::load(dir.path());
        assert_eq!(loaded.hub_url, config.hub_url);
        assert_eq!(loaded.projects, config.projects);

        fs::write(dir.path().join(CONFIG_FILE), "{ broken").unwrap();
        assert!(Config::load(dir.path()).hub_url.is_none());
        assert!(dir.path().join("config.json.bad").exists());
    }

    #[test]
    fn new_projects_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let app = root.join("app");
        let api = root.join("api");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&api).unwrap();
        fs::write(root.join("file.txt"), "x").unwrap();

        let (name, path) = check_new_project("  App ", app.to_str().unwrap(), &[], None).unwrap();
        assert_eq!(name, "App");
        assert_eq!(path, app);

        let existing = [project("App", &app)];
        let again = check_new_project("Other", app.to_str().unwrap(), &existing, None);
        assert!(again
            .unwrap_err()
            .starts_with("Ce dossier est déjà partagé"));
        let same_name = check_new_project("app", api.to_str().unwrap(), &existing, None);
        assert!(same_name
            .unwrap_err()
            .starts_with("Un projet s'appelle déjà"));
        assert!(check_new_project("Api", api.to_str().unwrap(), &existing, None).is_ok());

        assert!(check_new_project("", api.to_str().unwrap(), &[], None).is_err());
        assert!(check_new_project(&"x".repeat(81), api.to_str().unwrap(), &[], None).is_err());
        let missing = root.join("missing");
        assert!(check_new_project("M", missing.to_str().unwrap(), &[], None)
            .unwrap_err()
            .starts_with("Dossier introuvable"));
        let file = root.join("file.txt");
        assert!(check_new_project("F", file.to_str().unwrap(), &[], None).is_err());
        let home = check_new_project("Home", root.to_str().unwrap(), &[], Some(&root));
        assert!(home.unwrap_err().contains("dossier personnel"));

        let drive_root = root.ancestors().last().unwrap().to_path_buf();
        let error = check_new_project("Disk", drive_root.to_str().unwrap(), &[], None).unwrap_err();
        assert!(error.starts_with("Partager la racine"), "{error}");
    }
}
