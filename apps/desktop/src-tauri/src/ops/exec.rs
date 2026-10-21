//! `exec`: a command in the announced shell, in the project, with a timeout that kills the whole
//! process tree.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::task::JoinHandle;

use super::paths::{resolve, shown};
use super::{opt_str, req_str, u64_arg};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
/// stdout and stderr are each kept to their last 200 KB.
const OUTPUT_MAX: usize = 200 * 1024;
/// Background processes may keep the pipes open after the command exits.
const DRAIN_AFTER_EXIT: Duration = Duration::from_secs(2);

#[cfg(windows)]
pub(super) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The shell `exec` runs, as announced to the hub: `powershell`, `bash`, `zsh`, `sh`…
pub fn shell_name() -> String {
    #[cfg(windows)]
    {
        "powershell".into()
    }
    #[cfg(not(windows))]
    {
        login_shell()
            .and_then(|shell| shell.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "sh".into())
    }
}

#[cfg(not(windows))]
fn login_shell() -> Option<std::path::PathBuf> {
    std::env::var_os("SHELL")
        .map(std::path::PathBuf::from)
        .filter(|shell| shell.is_absolute() && shell.exists())
}

/// UTF-8 output, no progress bars, and the exit code of a failing native command.
#[cfg(windows)]
fn powershell_script(command: &str) -> String {
    format!(
        "$ProgressPreference = 'SilentlyContinue'\n\
         [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
         $OutputEncoding = [System.Text.Encoding]::UTF8\n\
         {command}\n\
         if (-not $?) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }} else {{ exit 1 }} }}"
    )
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            // npm.ps1, pnpm.ps1…: the user approves the command, the policy would only break it.
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
        ])
        .arg(powershell_script(command))
        .creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = match login_shell() {
            Some(shell) => {
                let mut cmd = Command::new(shell);
                cmd.arg("-lc");
                cmd
            }
            None => {
                let mut cmd = Command::new("sh");
                cmd.arg("-c");
                cmd
            }
        };
        cmd.arg(command);
        // Its own process group, killed as a whole on timeout.
        cmd.process_group(0);
        cmd
    }
}

/// The last `OUTPUT_MAX` bytes of an output.
#[derive(Default)]
struct Tail {
    bytes: Vec<u8>,
    dropped: usize,
}

impl Tail {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > 2 * OUTPUT_MAX {
            let cut = self.bytes.len() - OUTPUT_MAX;
            self.bytes.drain(..cut);
            self.dropped += cut;
        }
    }

    fn text(&self) -> String {
        let start = self.bytes.len().saturating_sub(OUTPUT_MAX);
        let dropped = self.dropped + start;
        let tail = String::from_utf8_lossy(&self.bytes[start..]);
        if dropped == 0 {
            tail.into_owned()
        } else {
            format!("[… {dropped} premiers octets coupés …]\n{tail}")
        }
    }
}

fn collect<R: AsyncRead + Unpin + Send + 'static>(
    reader: Option<R>,
) -> (Arc<Mutex<Tail>>, JoinHandle<()>) {
    let tail = Arc::new(Mutex::new(Tail::default()));
    let sink = tail.clone();
    let task = tokio::spawn(async move {
        let Some(mut reader) = reader else { return };
        let mut buf = vec![0u8; 16 * 1024];
        while let Ok(n) = reader.read(&mut buf).await {
            if n == 0 {
                break;
            }
            sink.lock().unwrap().push(&buf[..n]);
        }
    });
    (tail, task)
}

async fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(not(windows))]
    {
        // The shell leads its own group: the group goes with it.
        if let Ok(pid) = i32::try_from(pid) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

pub async fn exec(root: &Path, args: &Value) -> Result<Value, String> {
    let command = req_str(args, "command")?;
    if command.trim().is_empty() {
        return Err("Commande vide.".into());
    }
    let cwd_rel = opt_str(args, "cwd").unwrap_or("");
    let cwd = resolve(root, cwd_rel)?;
    if !cwd.is_dir() {
        return Err(format!("Dossier introuvable : {}", shown(cwd_rel)));
    }
    let timeout_ms = u64_arg(args, "timeoutMs")?
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);

    let mut cmd = shell_command(command);
    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Impossible de lancer le shell ({}) : {e}", shell_name()))?;
    let pid = child.id();
    let (stdout, out_task) = collect(child.stdout.take());
    let (stderr, err_task) = collect(child.stderr.take());

    let waited = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await;
    let (exit_code, timed_out) = match waited {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(error)) => {
            kill_tree(pid).await;
            return Err(format!("La commande n'a pas pu être suivie : {error}"));
        }
        Err(_) => {
            kill_tree(pid).await;
            let _ = child.kill().await;
            (None, true)
        }
    };

    let aborts = [out_task.abort_handle(), err_task.abort_handle()];
    let drained = tokio::time::timeout(DRAIN_AFTER_EXIT, async {
        let _ = out_task.await;
        let _ = err_task.await;
    })
    .await;
    if drained.is_err() {
        for abort in aborts {
            abort.abort();
        }
    }
    let stdout = stdout.lock().unwrap().text();
    let stderr = stderr.lock().unwrap().text();
    Ok(json!({
        "exitCode": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "timedOut": timed_out,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Instant;

    fn project() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        (dir, root)
    }

    #[tokio::test]
    async fn runs_a_command_in_the_project() {
        let (_dir, root) = project();
        let data = exec(&root, &json!({ "command": "echo 'héllo \"monde\"'" }))
            .await
            .unwrap();
        assert_eq!(data["exitCode"], 0);
        assert_eq!(data["timedOut"], false);
        assert_eq!(data["stdout"].as_str().unwrap().trim(), "héllo \"monde\"");

        let data = exec(&root, &json!({ "command": "pwd", "cwd": "src" }))
            .await
            .unwrap();
        assert!(
            data["stdout"].as_str().unwrap().trim_end().ends_with("src"),
            "{data}"
        );

        let data = exec(&root, &json!({ "command": "exit 3" })).await.unwrap();
        assert_eq!(data["exitCode"], 3);
    }

    #[tokio::test]
    async fn refuses_bad_arguments() {
        let (_dir, root) = project();
        assert!(exec(&root, &json!({ "command": "" })).await.is_err());
        assert!(exec(&root, &json!({}))
            .await
            .unwrap_err()
            .starts_with("Paramètre manquant"));
        assert!(exec(&root, &json!({ "command": "echo", "cwd": "../" }))
            .await
            .unwrap_err()
            .starts_with("Chemin hors du projet"));
        assert!(exec(&root, &json!({ "command": "echo", "cwd": "nope" }))
            .await
            .unwrap_err()
            .starts_with("Dossier introuvable"));
    }

    #[tokio::test]
    async fn times_out_and_kills_the_tree() {
        let (_dir, root) = project();
        #[cfg(windows)]
        let command = "powershell.exe -NoProfile -Command 'Start-Sleep -Seconds 30'";
        #[cfg(not(windows))]
        let command = "sh -c 'sleep 30'; echo done";
        let started = Instant::now();
        let data = exec(&root, &json!({ "command": command, "timeoutMs": 1500 }))
            .await
            .unwrap();
        assert_eq!(data["timedOut"], true);
        assert!(data["exitCode"].is_null());
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn timeout_kills_grandchildren_too() {
        let (_dir, root) = project();
        // A child shell that would write a file after 4 s: killed with its parent, it never does.
        #[cfg(windows)]
        let command =
            "powershell.exe -NoProfile -Command 'Start-Sleep -Seconds 4; Set-Content after.txt x'";
        #[cfg(not(windows))]
        let command = "sh -c 'sleep 4; echo x > after.txt'";
        let data = exec(&root, &json!({ "command": command, "timeoutMs": 2500 }))
            .await
            .unwrap();
        assert_eq!(data["timedOut"], true);
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!root.join("after.txt").exists());
    }

    #[tokio::test]
    async fn keeps_the_end_of_long_outputs() {
        let (_dir, root) = project();
        #[cfg(windows)]
        let command = "[Console]::Error.Write('e'); Write-Output ('x' * 300000 + 'END')";
        #[cfg(not(windows))]
        let command = "printf e >&2; head -c 300000 /dev/zero | tr '\\0' x; echo END";
        let data = exec(&root, &json!({ "command": command })).await.unwrap();
        let stdout = data["stdout"].as_str().unwrap();
        assert!(stdout.starts_with("[… "), "{}", &stdout[..40]);
        assert!(stdout.trim_end().ends_with("END"));
        assert!(stdout.len() < OUTPUT_MAX + 100);
        assert_eq!(data["stderr"], "e");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_reports_native_exit_codes() {
        let (_dir, root) = project();
        let data = exec(&root, &json!({ "command": "cmd /c exit 5" }))
            .await
            .unwrap();
        assert_eq!(data["exitCode"], 5);
        let data = exec(&root, &json!({ "command": "Get-Item nope-missing" }))
            .await
            .unwrap();
        assert_eq!(data["exitCode"], 1);
        assert!(!data["stderr"].as_str().unwrap().is_empty());
        let data = exec(
            &root,
            &json!({ "command": "Write-Output a\nWrite-Output b" }),
        )
        .await
        .unwrap();
        assert_eq!(
            data["stdout"].as_str().unwrap().replace("\r\n", "\n"),
            "a\nb\n"
        );
    }
}
