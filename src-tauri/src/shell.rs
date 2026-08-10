//! Windows shell integration: default app, "열기 방식" dialog, Explorer reveal,
//! and the Obsidian URI handoff.
//!
//! Everything goes through `std::process::Command` with `CREATE_NO_WINDOW` so no
//! console flashes on screen. That keeps us off version-sensitive Win32 bindings.

use crate::error::{AppError, Result};
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn spawn(mut cmd: Command) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| AppError::new("spawn", e.to_string()))
}

fn win_path(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\")
}

/// Opens with the OS-registered default application.
pub fn open_default(path: &Path) -> Result<()> {
    if !path.exists() {
        return Err(AppError::new("not_found", format!("파일이 없습니다: {}", path.display())));
    }
    #[cfg(windows)]
    {
        // `start` needs an empty title argument first, otherwise a quoted path
        // is consumed as the window title.
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", &win_path(path)]);
        return spawn(cmd);
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        spawn(cmd)
    }
}

/// The Windows "다른 앱으로 열기" chooser.
pub fn open_with_dialog(path: &Path) -> Result<()> {
    if !path.exists() {
        return Err(AppError::new("not_found", format!("파일이 없습니다: {}", path.display())));
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("rundll32.exe");
        cmd.arg("shell32.dll,OpenAs_RunDLL").arg(win_path(path));
        return spawn(cmd);
    }
    #[cfg(not(windows))]
    {
        open_default(path)
    }
}

/// Launches a specific executable against the file.
pub fn open_with_app(exe: &str, path: &Path) -> Result<()> {
    let mut cmd = Command::new(exe);
    cmd.arg(path);
    spawn(cmd)
}

/// Selects the item inside Explorer (or opens the folder when it is a dir).
pub fn reveal(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("explorer.exe");
        if path.is_dir() {
            cmd.arg(win_path(path));
        } else {
            // `/select,<path>` must be a single argument, comma included.
            cmd.arg(format!("/select,{}", win_path(path)));
        }
        // Explorer returns a non-zero exit code even on success, so we ignore it.
        let _ = spawn(cmd);
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
        open_default(dir)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutcome {
    /// `"obsidian"` when the URI handler took it, `"explorer"` on fallback.
    pub opened: String,
    pub detail: String,
}

/// True when an `obsidian:` URL protocol handler is registered.
pub fn obsidian_installed() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("reg");
        cmd.args(["query", "HKCR\\obsidian", "/v", "URL Protocol"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        return matches!(cmd.output(), Ok(o) if o.status.success());
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Opens a vault note in Obsidian. When the protocol is not registered we open
/// the containing folder in Explorer instead and say so, rather than firing a
/// URL into the void.
pub fn open_in_obsidian(vault_root: &Path, abs_path: &Path) -> Result<OpenOutcome> {
    if !abs_path.exists() {
        return Err(AppError::new("not_found", format!("노트가 없습니다: {}", abs_path.display())));
    }

    if obsidian_installed() {
        // `obsidian://open?path=<absolute>` works without knowing the vault name.
        let encoded = urlencoding::encode(&abs_path.to_string_lossy()).into_owned();
        let url = format!("obsidian://open?path={}", encoded);
        #[cfg(windows)]
        {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "start", "", &url]);
            spawn(cmd)?;
        }
        #[cfg(not(windows))]
        {
            let mut cmd = Command::new("xdg-open");
            cmd.arg(&url);
            spawn(cmd)?;
        }
        let rel = abs_path
            .strip_prefix(vault_root)
            .unwrap_or(abs_path)
            .to_string_lossy()
            .replace('\\', "/");
        return Ok(OpenOutcome { opened: "obsidian".into(), detail: rel });
    }

    reveal(abs_path)?;
    Ok(OpenOutcome {
        opened: "explorer".into(),
        detail: "Obsidian이 설치되어 있지 않아 탐색기에서 열었습니다".into(),
    })
}
