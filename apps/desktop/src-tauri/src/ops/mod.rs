//! What the hub asks the connector to do in a project (docs/DESKTOP.md): list, read, write, edit,
//! find, search, exec, and for a copy on a bot's PC manifest, read_files, branch. Every error is a
//! readable French sentence for the bot.

mod exec;
mod files;
mod git;
pub mod paths;
mod sync;
mod walk;

use serde_json::Value;

pub use exec::shell_name;

/// Runs `op` with `args` in the project whose folder is `project_path`.
pub async fn run(op: &str, project_path: &str, args: Value) -> Result<Value, String> {
    let root = paths::project_root(project_path)?;
    match op {
        "exec" => exec::exec(&root, &args).await,
        "list" | "read" | "write" | "edit" | "find" | "search" | "manifest" | "read_files"
        | "branch" => {
            let op = op.to_string();
            tokio::task::spawn_blocking(move || match op.as_str() {
                "list" => files::list(&root, &args),
                "read" => files::read(&root, &args),
                "write" => files::write(&root, &args),
                "edit" => files::edit(&root, &args),
                "find" => walk::find(&root, &args),
                "manifest" => sync::manifest(&root, &args),
                "read_files" => sync::read_files(&root, &args),
                "branch" => git::branch(&root, &args),
                _ => walk::search(&root, &args),
            })
            .await
            .map_err(|_| "Erreur interne du connecteur.".to_string())?
        }
        other => Err(format!("Opération inconnue : {other}")),
    }
}

fn arg<'a>(args: &'a Value, name: &str) -> Option<&'a Value> {
    args.get(name).filter(|v| !v.is_null())
}

pub(crate) fn opt_str<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    arg(args, name).and_then(Value::as_str)
}

pub(crate) fn req_str<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    match arg(args, name) {
        None => Err(format!("Paramètre manquant : {name}")),
        Some(value) => value
            .as_str()
            .ok_or_else(|| format!("Le paramètre {name} doit être un texte.")),
    }
}

/// A list of texts (`None` when absent).
pub(crate) fn str_list<'a>(args: &'a Value, name: &str) -> Result<Option<Vec<&'a str>>, String> {
    match arg(args, name) {
        None => Ok(None),
        Some(value) => value
            .as_array()
            .and_then(|items| items.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
            .map(Some)
            .ok_or_else(|| format!("Le paramètre {name} doit être une liste de textes.")),
    }
}

pub(crate) fn u64_arg(args: &Value, name: &str) -> Result<Option<u64>, String> {
    match arg(args, name) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .or_else(|| value.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
            .map(Some)
            .ok_or_else(|| format!("Le paramètre {name} doit être un nombre positif.")),
    }
}

pub(crate) fn bool_arg(args: &Value, name: &str) -> Result<Option<bool>, String> {
    match arg(args, name) {
        None => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| format!("Le paramètre {name} doit être true ou false.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn dispatches_ops_on_a_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let written = run("write", root, json!({ "path": "a/b.txt", "content": "x" })).await;
        assert_eq!(written.unwrap()["size"], 1);
        let read = run("read", root, json!({ "path": "a/b.txt" }))
            .await
            .unwrap();
        assert_eq!(read["text"], "x");
        let manifest = run("manifest", root, json!({})).await.unwrap();
        assert_eq!(manifest["files"][0]["path"], "a/b.txt");
        let copied = run("read_files", root, json!({ "paths": ["a/b.txt"] }))
            .await
            .unwrap();
        assert_eq!(copied["files"][0]["data"], "eA==");
        assert_eq!(
            run("branch", root, json!({})).await.unwrap_err(),
            "Paramètre manquant : name"
        );
        assert_eq!(
            run("delete", root, json!({})).await.unwrap_err(),
            "Opération inconnue : delete"
        );
        let missing = dir.path().join("missing");
        assert!(run("list", missing.to_str().unwrap(), json!({}))
            .await
            .unwrap_err()
            .starts_with("Le dossier du projet est introuvable"));
    }
}
