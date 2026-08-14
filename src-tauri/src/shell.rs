//! Windows shell integration: default app, "열기 방식" dialog, Explorer reveal,
//! and the Obsidian URI handoff.
//!
//! Everything goes through `std::process::Command` with `CREATE_NO_WINDOW` so no
//! console flashes on screen. That keeps us off version-sensitive Win32 bindings.

use crate::error::{AppError, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
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
    /// `"obsidian"` when the URI handler took it, `"explorer"` on fallback,
    /// `"unregistered"` when the note is outside every vault Obsidian knows.
    pub opened: String,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// Obsidian vault 목록
// ---------------------------------------------------------------------------
//
// `obsidian://open?path=<절대경로>` 는 그 경로가 **Obsidian 에 이미 등록된 vault 안에**
// 있을 때만 열린다. 밖이면 Obsidian 이 "Vault not found" 대화상자를 띄우는데, 그건 우리가
// 쏜 URL 이 죽었다는 뜻이지 사용자가 뭘 잘못한 게 아니다. 그래서 쏘기 전에 먼저 본다.
//
// 목록은 Obsidian 의 설정 폴더에 있는 `obsidian.json` 이다.
//   Windows  %APPDATA%\obsidian\obsidian.json
//   macOS    ~/Library/Application Support/obsidian/obsidian.json
//   Linux    ~/.config/obsidian/obsidian.json
// Tauri 의 `config_dir()` 이 세 곳에 그대로 대응하므로 경로를 손으로 짜지 않는다.
// **읽기만 한다** — 남의 앱 설정 파일이고, Obsidian 이 떠 있으면 종료할 때 자기 것으로
// 덮어쓰므로 우리가 쓴 내용은 어차피 살아남지 못한다.

#[derive(Debug, Clone)]
pub struct ObsidianVault {
    pub name: String,
    pub path: PathBuf,
}

/// 구분자를 `/` 로 맞추고 꼬리 구분자를 뗀다. `obsidian.json` 은 `\` 로, 우리 설정값은
/// `/` 로 경로를 들고 있어서 그대로는 비교가 안 된다.
fn slashed(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_string()
}

/// Windows 파일시스템은 대소문자를 가리지 않는다. 비교할 때만 접고, 돌려주는 경로는
/// 원본 대소문자를 유지한다.
fn fold(s: &str) -> String {
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// Obsidian 이 아는 vault 목록.
///
/// `None` 은 **목록을 읽지 못했다**는 뜻이다(미설치 · 포터블 설치 · 아직 한 번도 실행하지
/// 않음). 이때는 아무것도 단정하지 않고 예전처럼 `path=` 로 쏜다 — 목록이 없다는 것과
/// vault 가 등록되지 않았다는 것은 다르고, 둘을 섞으면 지금 잘 되던 사용자의 Obsidian
/// 열기를 우리가 망가뜨린다. 등록된 vault 가 정말 하나도 없으면 `Some(vec![])` 이다.
pub fn known_vaults(config_dir: &Path) -> Option<Vec<ObsidianVault>> {
    let text = std::fs::read_to_string(config_dir.join("obsidian").join("obsidian.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let vaults = json.get("vaults")?.as_object()?;
    Some(
        vaults
            .values()
            .filter_map(|v| {
                let path = PathBuf::from(v.get("path")?.as_str()?);
                // vault 이름은 폴더 이름이다 — Obsidian 도 그렇게 보여 준다.
                let name = path.file_name()?.to_string_lossy().to_string();
                Some(ObsidianVault { name, path })
            })
            .collect(),
    )
}

/// 대상을 품는 vault 와 vault 기준 상대 경로.
///
/// vault 가 중첩돼 있으면(예: `D:/Notes` 와 `D:/Notes/Work` 가 둘 다 등록) **가장 깊은**
/// 것을 고른다. Obsidian 이 그 파일을 실제로 여는 vault 가 그쪽이다.
pub fn resolve_vault<'a>(
    vaults: &'a [ObsidianVault],
    abs: &Path,
) -> Option<(&'a ObsidianVault, String)> {
    let target = slashed(abs);
    vaults
        .iter()
        .filter_map(|v| {
            let root = slashed(&v.path);
            // 루트만큼 잘라 대소문자를 접고 견준다. 나머지는 원본 그대로 쓴다.
            if fold(target.get(..root.len())?) != fold(&root) {
                return None;
            }
            // 경계는 반드시 구분자여야 한다 — `D:/Notes` 가 `D:/Notes2` 를 삼키면 안 된다.
            let rest = target.get(root.len()..)?.strip_prefix('/')?;
            (!rest.is_empty()).then(|| (v, root.len(), rest.to_string()))
        })
        // vault 가 중첩돼 있으면 더 깊은 쪽이 실제로 그 파일을 여는 vault 다.
        .max_by_key(|(_, depth, _)| *depth)
        .map(|(v, _, rest)| (v, rest))
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

fn launch_url(url: &str) -> Result<()> {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", url]);
        spawn(cmd)
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url);
        spawn(cmd)
    }
}

/// Opens a vault note in Obsidian.
///
/// 죽은 URL 을 쏘지 않는 것이 이 함수의 일이다. Obsidian 은 등록되지 않은 경로를 받으면
/// "Vault not found" 대화상자를 띄우는데, 사용자 눈에는 ContextFlow 가 고장 난 것으로
/// 보이고 무엇을 해야 하는지도 알 수 없다. 그래서 세 갈래로 나눈다.
///
/// * 목록을 읽을 수 있고 **등록된 vault 안** → `vault=`+`file=` 로 연다. 어느 vault 로 열지
///   우리가 지정하므로, Obsidian 이 쓰는 vault 루트와 ContextFlow 의 Vault 경로가 달라도
///   (예: `D:/ContextFlow` 는 등록 안 됐고 `D:/ContextFlow/Tasks` 만 vault) 충돌하지 않는다.
/// * 목록을 읽을 수 있고 **밖** → URL 을 쏘지 않고 탐색기로 열며 이유를 돌려준다.
/// * 목록을 못 읽음(`config_dir` 이 없거나 `obsidian.json` 이 없음) → 예전처럼 `path=` 로
///   쏜다. "목록이 없다" 와 "등록되지 않았다" 는 다르고, 둘을 섞으면 멀쩡히 쓰던 사용자의
///   Obsidian 열기를 우리가 막게 된다.
pub fn open_in_obsidian(
    config_dir: Option<&Path>,
    vault_root: &Path,
    abs_path: &Path,
) -> Result<OpenOutcome> {
    if !abs_path.exists() {
        return Err(AppError::new("not_found", format!("노트가 없습니다: {}", abs_path.display())));
    }

    if !obsidian_installed() {
        reveal(abs_path)?;
        return Ok(OpenOutcome {
            opened: "explorer".into(),
            detail: "Obsidian이 설치되어 있지 않아 탐색기에서 열었습니다".into(),
        });
    }

    let rel_to_root = abs_path
        .strip_prefix(vault_root)
        .unwrap_or(abs_path)
        .to_string_lossy()
        .replace('\\', "/");

    match config_dir.and_then(known_vaults) {
        Some(vaults) => match resolve_vault(&vaults, abs_path) {
            Some((vault, rel)) => {
                let url = format!(
                    "obsidian://open?vault={}&file={}",
                    urlencoding::encode(&vault.name),
                    urlencoding::encode(&rel),
                );
                launch_url(&url)?;
                Ok(OpenOutcome { opened: "obsidian".into(), detail: rel_to_root })
            }
            None => {
                reveal(abs_path)?;
                Ok(OpenOutcome {
                    opened: "unregistered".into(),
                    detail: slashed(vault_root),
                })
            }
        },
        None => {
            // 목록을 못 읽었다 — 예전 동작 그대로 절대 경로로 쏜다.
            let url =
                format!("obsidian://open?path={}", urlencoding::encode(&abs_path.to_string_lossy()));
            launch_url(&url)?;
            Ok(OpenOutcome { opened: "obsidian".into(), detail: rel_to_root })
        }
    }
}

/// 설정 화면이 보여 주는 등록 상태. `registry_found` 가 false 면 나머지는 판단하지 않은
/// 값이다 — "등록 안 됨" 이 아니라 "알 수 없음" 으로 표시해야 한다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub registry_found: bool,
    pub registered: bool,
    pub vault_name: Option<String>,
}

/// ContextFlow 의 Vault 루트가 Obsidian 에 등록돼 있는지. 루트 자체가 vault 인 경우와
/// 상위 vault 안에 들어 있는 경우를 모두 등록으로 본다 — 둘 다 노트가 실제로 열린다.
pub fn vault_status(config_dir: Option<&Path>, vault_root: &Path) -> VaultStatus {
    let Some(vaults) = config_dir.and_then(known_vaults) else {
        return VaultStatus { registry_found: false, registered: false, vault_name: None };
    };
    let root = slashed(vault_root);
    let hit = vaults.iter().find(|v| fold(&slashed(&v.path)) == fold(&root)).or_else(|| {
        // 루트 자체는 vault 가 아니어도 상위 vault 안에 있으면 노트는 열린다.
        resolve_vault(&vaults, vault_root).map(|(v, _)| v)
    });
    VaultStatus {
        registry_found: true,
        registered: hit.is_some(),
        vault_name: hit.map(|v| v.name.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "contextflow-obs-{}-{}",
                tag,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        /// `<config>/obsidian/obsidian.json` 을 그대로 만들어 둔다.
        fn write_registry(&self, json: &str) {
            let dir = self.0.join("obsidian");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("obsidian.json"), json).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn vault(path: &str) -> ObsidianVault {
        ObsidianVault {
            name: Path::new(path).file_name().unwrap().to_string_lossy().to_string(),
            path: PathBuf::from(path),
        }
    }

    #[test]
    fn a_missing_registry_is_unknown_not_empty() {
        let d = TempDir::new("noreg");
        // 목록을 못 읽은 것과 "등록된 vault 가 없다" 는 다르다. 섞으면 멀쩡한 사용자의
        // Obsidian 열기를 막게 되므로 None 이어야 한다.
        assert!(known_vaults(d.path()).is_none());

        let st = vault_status(Some(d.path()), Path::new("/home/me/Vault"));
        assert!(!st.registry_found);
        assert!(!st.registered);
    }

    #[test]
    fn reads_the_vault_list_and_names_them_by_folder() {
        let d = TempDir::new("reg");
        d.write_registry(
            r#"{"vaults":{"a1":{"path":"/home/me/Notes","ts":1},
                          "b2":{"path":"/home/me/Work Vault","ts":2}}}"#,
        );
        let mut names: Vec<String> =
            known_vaults(d.path()).unwrap().into_iter().map(|v| v.name).collect();
        names.sort();
        assert_eq!(names, vec!["Notes", "Work Vault"]);
    }

    #[test]
    fn an_empty_vault_list_is_known_and_empty() {
        let d = TempDir::new("emptyreg");
        d.write_registry(r#"{"vaults":{}}"#);
        assert_eq!(known_vaults(d.path()).unwrap().len(), 0);
    }

    #[test]
    fn resolve_picks_the_deepest_vault_containing_the_note() {
        let vaults = vec![vault("/home/me/Notes"), vault("/home/me/Notes/Work")];
        let (v, rel) =
            resolve_vault(&vaults, Path::new("/home/me/Notes/Work/Tasks/a/index.md")).unwrap();
        assert_eq!(v.name, "Work");
        assert_eq!(rel, "Tasks/a/index.md");
    }

    #[test]
    fn resolve_returns_none_outside_every_vault() {
        // 사용자가 부딪힌 상황 그대로 — Vault 루트가 Obsidian 에 등록돼 있지 않다.
        let vaults = vec![vault("/home/me/Notes")];
        assert!(resolve_vault(&vaults, Path::new("/data/ContextFlow/_index/Archive.md")).is_none());
    }

    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_a_match() {
        // `/home/me/Notes` 가 `/home/me/Notes2` 를 삼키면 안 된다 — 경계는 구분자여야 한다.
        let vaults = vec![vault("/home/me/Notes")];
        assert!(resolve_vault(&vaults, Path::new("/home/me/Notes2/index.md")).is_none());
    }

    #[test]
    fn the_vault_root_itself_is_not_a_note() {
        let vaults = vec![vault("/home/me/Notes")];
        assert!(resolve_vault(&vaults, Path::new("/home/me/Notes")).is_none());
    }

    #[test]
    fn backslash_paths_from_the_registry_match_slash_paths_from_settings() {
        // obsidian.json 은 Windows 경로를 `\` 로 들고 있고, 우리 설정값은 `/` 다.
        let vaults = vec![ObsidianVault {
            name: "ContextFlow".into(),
            path: PathBuf::from(r"D:\ContextFlow"),
        }];
        let (v, rel) = resolve_vault(&vaults, Path::new("D:/ContextFlow/_index/Archive.md")).unwrap();
        assert_eq!(v.name, "ContextFlow");
        assert_eq!(rel, "_index/Archive.md");
    }

    #[test]
    fn status_reports_registration_of_the_root_and_of_a_parent_vault() {
        let d = TempDir::new("status");
        d.write_registry(r#"{"vaults":{"a1":{"path":"/home/me/Notes","ts":1}}}"#);

        // 루트 자체가 vault 다.
        let exact = vault_status(Some(d.path()), Path::new("/home/me/Notes"));
        assert!(exact.registry_found && exact.registered);
        assert_eq!(exact.vault_name.as_deref(), Some("Notes"));

        // 루트가 상위 vault 안에 있어도 노트는 열린다 — 등록으로 본다.
        let nested = vault_status(Some(d.path()), Path::new("/home/me/Notes/ContextFlow"));
        assert!(nested.registered);
        assert_eq!(nested.vault_name.as_deref(), Some("Notes"));

        // 완전히 밖이면 등록 안 됨.
        let outside = vault_status(Some(d.path()), Path::new("/data/ContextFlow"));
        assert!(outside.registry_found);
        assert!(!outside.registered);
        assert_eq!(outside.vault_name, None);
    }
}
