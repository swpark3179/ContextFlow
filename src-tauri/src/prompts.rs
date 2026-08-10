//! 사용자 프롬프트 팩 — `~/.contextflow/prompts/*.md`.
//!
//! 소스를 고치지 않고 자기 지침을 프롬프트에 얹기 위한 통로다. 사용자가 폴더에 `.md`
//! 파일을 넣으면 앱이 목록으로 읽어 오고, 설정 화면에서 훅별로 켜고 끈다. 실제 배선은
//! `ai.json` 의 `prompts.hooks` 가 갖고 있다 — 파일은 저장소, 설정은 배선이다.
//!
//! **이 폴더는 읽기 전용으로만 다룬다.** 앱이 파일을 쓰지 않으므로 `ai_settings.rs` 와
//! 달리 `.corrupt` 백업이 없다. 대신 읽기에 실패한 파일도 목록에서 빼지 않고 `error` 를
//! 달아 돌려준다 — 조용히 사라지면 사용자가 원인을 알 수 없다.
//!
//! "스킬" 이 아니라 "프롬프트 팩" 인 이유: 이 앱의 Claude Code 실행은 도구를 전부 막고
//! (`agents.rs`) `--strict-mcp-config` 를 쓰며, 원격 서비스(AI Pro · FabriX)는 파일
//! 시스템이 아예 없다. 따라서 여기서 주입할 수 있는 것은 프롬프트 텍스트뿐이다.

use std::path::PathBuf;

use serde::Serialize;

/// 팩 1개 본문의 상한.
///
/// 팩 본문은 이미 후보 목록이 실린 프롬프트 위에 얹히므로, 약한 원격 모델의 컨텍스트를
/// 밀어내지 않게 넉넉하지 않게 잡는다.
pub const PACK_CAP: usize = 8_000;

/// 폴더에서 읽어 들일 파일 수 상한. 실수로 문서 폴더를 가리켜도 앱이 멈추지 않게 한다.
const MAX_PACKS: usize = 50;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptPack {
    /// 파일명 — 설정에 저장되는 키다. 표시 이름은 유일하지 않으므로 키로 쓰지 않는다.
    pub file: String,
    pub name: String,
    pub description: String,
    /// 프런트마터의 `stage`. UI 가 훅을 미리 골라 주기 위한 **힌트**일 뿐이고, 실제
    /// 적용은 설정이 정한다(한 파일을 여러 훅에 붙일 수 있다).
    pub stage: String,
    /// 프런트마터를 걷어낸 본문. `PACK_CAP` 에서 잘린다.
    pub body: String,
    pub chars: usize,
    pub truncated: bool,
    /// 읽기 실패 사유. `Some` 이면 주입 대상에서 제외된다.
    pub error: Option<String>,
}

fn prompts_dir() -> Result<PathBuf, String> {
    Ok(crate::app_home()?.join("prompts"))
}

/// 프런트마터를 떼어 (키/값 목록, 본문) 으로 나눈다.
///
/// `---` 로 감싼 `key: value` 줄만 읽는다. 필드가 셋뿐이라 YAML 의존성을 더하지 않는다.
/// 여는 `---` 가 없거나 닫는 `---` 를 못 찾으면 전체를 본문으로 본다 — 프런트마터는
/// 선택 사항이다.
fn split_front_matter(raw: &str) -> (Vec<(String, String)>, String) {
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let mut lines = text.lines();

    if lines.next().map(str::trim) != Some("---") {
        return (Vec::new(), text.to_string());
    }

    let mut fields = Vec::new();
    let mut closed = false;
    let mut body = String::new();

    for line in lines.by_ref() {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            fields.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    if !closed {
        return (Vec::new(), text.to_string());
    }

    for line in lines {
        body.push_str(line);
        body.push('\n');
    }
    (fields, body.trim().to_string())
}

fn field(fields: &[(String, String)], key: &str) -> String {
    fields
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// 문자 경계에서 자른다. 한국어는 UTF-8 다바이트라 바이트로 자르면 패닉이다.
fn clip(body: &str) -> (String, bool) {
    if body.chars().count() <= PACK_CAP {
        return (body.to_string(), false);
    }
    (body.chars().take(PACK_CAP).collect(), true)
}

fn read_pack(path: &PathBuf, file: String) -> PromptPack {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&file)
        .to_string();

    let raw = match std::fs::read(path) {
        Ok(r) => r,
        Err(e) => {
            return PromptPack {
                file,
                name: stem,
                description: String::new(),
                stage: String::new(),
                body: String::new(),
                chars: 0,
                truncated: false,
                error: Some(format!("파일을 읽을 수 없습니다: {e}")),
            }
        }
    };

    // BOM 을 떼고 깨진 바이트는 대체 문자로 흘려보낸다.
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&raw);
    let text = String::from_utf8_lossy(raw).into_owned();
    let (fields, body) = split_front_matter(&text);
    let (body, truncated) = clip(&body);

    let name = {
        let n = field(&fields, "name");
        if n.is_empty() { stem } else { n }
    };
    let error = if body.trim().is_empty() {
        Some("본문이 비어 있습니다 — 프런트마터 아래에 지침을 적어 주세요.".to_string())
    } else {
        None
    };

    PromptPack {
        chars: body.chars().count(),
        file,
        name,
        description: field(&fields, "description"),
        stage: field(&fields, "stage"),
        body,
        truncated,
        error,
    }
}

/// `~/.contextflow/prompts/*.md` 를 전부 읽는다. 폴더가 없으면 만들고 빈 목록.
#[tauri::command]
pub async fn list_prompt_packs() -> Result<Vec<PromptPack>, String> {
    tauri::async_runtime::spawn_blocking(list_sync)
        .await
        .map_err(|e| format!("프롬프트 팩 읽기가 중단되었다: {e}"))?
}

fn list_sync() -> Result<Vec<PromptPack>, String> {
    let dir = prompts_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("프롬프트 폴더를 만들 수 없다: {e}"))?;

    let entries =
        std::fs::read_dir(&dir).map_err(|e| format!("프롬프트 폴더를 읽을 수 없다: {e}"))?;

    let mut paths: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if ext != "md" && ext != "markdown" {
            continue;
        }
        let Some(file) = path.file_name().and_then(|f| f.to_str()) else {
            continue;
        };
        paths.push((file.to_string(), path));
    }

    paths.sort_by(|(a, _), (b, _)| a.cmp(b));
    paths.truncate(MAX_PACKS);

    Ok(paths
        .into_iter()
        .map(|(file, path)| read_pack(&path, file))
        .collect())
}

/// 팩 폴더의 절대경로. 설정 화면이 표시하고, 사용자가 여기에 파일을 넣는다.
#[tauri::command]
pub fn prompt_dir_path() -> Result<String, String> {
    let dir = prompts_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("프롬프트 폴더를 만들 수 없다: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 팩 폴더를 OS 파일 탐색기로 연다. 실패해도 경로는 화면에 떠 있으므로 치명적이지 않다.
#[tauri::command]
pub fn open_prompt_dir() -> Result<(), String> {
    let dir = prompt_dir_path()?;

    #[cfg(windows)]
    let (bin, args) = ("explorer.exe", vec![dir.clone()]);
    #[cfg(target_os = "macos")]
    let (bin, args) = ("open", vec![dir.clone()]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (bin, args) = ("xdg-open", vec![dir.clone()]);

    // `command_for` 는 인자를 항상 1개 이상 요구한다 — 여기서는 경로가 그 한 개다.
    crate::exec::command_for(bin, &args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("폴더를 열 수 없습니다: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn front_matter_is_split_off() {
        let (fields, body) = split_front_matter(
            "---\nname: 재발 업무 우선\ndescription: 반복 패턴 가중\nstage: recommend.rank\n---\n\n- 지침 한 줄\n",
        );
        assert_eq!(field(&fields, "name"), "재발 업무 우선");
        assert_eq!(field(&fields, "description"), "반복 패턴 가중");
        assert_eq!(field(&fields, "stage"), "recommend.rank");
        assert_eq!(body, "- 지침 한 줄");
    }

    #[test]
    fn front_matter_is_optional() {
        let (fields, body) = split_front_matter("# 그냥 본문\n내용");
        assert!(fields.is_empty());
        assert_eq!(body, "# 그냥 본문\n내용");
    }

    #[test]
    fn unclosed_front_matter_is_treated_as_body() {
        // 닫는 --- 이 없으면 본문을 프런트마터로 오해해 통째로 삼키면 안 된다.
        let (fields, body) = split_front_matter("---\nname: x\n본문이 이어짐");
        assert!(fields.is_empty());
        assert!(body.contains("본문이 이어짐"));
    }

    #[test]
    fn body_is_clipped_on_char_boundary() {
        let long = "가".repeat(PACK_CAP + 100);
        let (body, truncated) = clip(&long);
        assert!(truncated);
        assert_eq!(body.chars().count(), PACK_CAP);
    }

    #[test]
    fn short_body_is_not_marked_truncated() {
        let (body, truncated) = clip("짧다");
        assert!(!truncated);
        assert_eq!(body, "짧다");
    }

    #[test]
    fn unreadable_file_stays_in_the_list_with_a_reason() {
        // 목록에서 조용히 사라지면 사용자가 왜 안 먹히는지 알 수 없다.
        let missing = std::env::temp_dir().join("contextflow-no-such-pack.md");
        let _ = std::fs::remove_file(&missing);
        let pack = read_pack(&missing, "contextflow-no-such-pack.md".into());
        assert!(pack.error.is_some());
        assert!(pack.body.is_empty());
        assert_eq!(pack.name, "contextflow-no-such-pack");
    }

    #[test]
    fn empty_body_is_flagged() {
        let dir = std::env::temp_dir().join("contextflow-prompts-empty");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.md");
        std::fs::write(&path, "---\nname: 빈 팩\n---\n\n   \n").unwrap();
        let pack = read_pack(&path, "empty.md".into());
        assert_eq!(pack.name, "빈 팩");
        assert!(pack.error.is_some());
    }
}
