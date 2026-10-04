//! i-WMS 설정 — `~/.contextflow/iwms.json`. 백엔드가 원본을 소유한다(`ai.json` 과 같은 선례).
//!
//! 비밀값은 없다. SSO 세션 쿠키는 메모리에만 두고(`session.rs`) 여기에 쓰지 않는다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::Result;

pub const DEFAULT_BASE: &str = "http://i-wms.sds.samsung.net";

/// 정제의 공통 작성 규칙 기본값. 사용자가 설정의 템플릿 카드에서 고친다.
pub const DEFAULT_STYLE: &str = "- 1~3줄로 쓰고 명사형으로 끝낸다(예: …수행, …확인, …조치, …배포).
- 무엇을 했는지, 어느 시스템 · 화면 · 서버에 했는지, 결과가 어떤지를 담는다.
- 개인정보 · 계정 · 비밀번호 · 내부 IP 는 쓰지 않는다.
- 업무 기록의 말투(…했다, …함)를 그대로 옮기지 말고 보고 문체로 고친다.";

/// 분 단위로 고를 수 있는 값.
const STEPS: [i64; 5] = [1, 5, 10, 15, 30];

/// 사용하기로 지정한 카테고리 하나. 이름 · 경로는 지정할 때의 사본이라 i-WMS 에 연결하지 않아도
/// 설정 화면에 그릴 수 있다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Designated {
    pub ci_key: String,
    pub ci_name: String,
    pub wbsid: String,
    pub path: String,
    pub task: String,
    /// `O` 대가포함 · `N` 대가미포함.
    pub price_type: String,
    /// 이 카테고리에 넣는 일의 설명. AI 가 카테고리를 고를 때 읽는다.
    pub hint: String,
    /// 이 ContextFlow 카테고리(하위 포함)의 업무는 이 카테고리로 고정한다.
    pub map_from: Vec<String>,
    /// 상세내용 샘플 문구. AI 가 문체를 따른다.
    pub samples: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct IwmsSettings {
    pub base_url: String,
    /// 남은 시간(기준 − 이미 입력된 분)을 선택 업무에 모두 배분한다.
    pub fill_to_standard: bool,
    pub minute_step: i64,
    pub style_guide: String,
    pub categories: Vec<Designated>,
}

impl Default for IwmsSettings {
    fn default() -> Self {
        IwmsSettings {
            base_url: DEFAULT_BASE.to_string(),
            fill_to_standard: true,
            minute_step: 10,
            style_guide: DEFAULT_STYLE.to_string(),
            categories: Vec::new(),
        }
    }
}

fn file_path(root: &Path) -> PathBuf {
    root.join("iwms.json")
}

/// 읽는다. 없으면 기본값. 깨진 파일은 `iwms.json.corrupt` 로 먼저 남긴다 — 다음 저장이 지정한
/// 카테고리와 샘플을 지우지 않게(`ai_settings::load` 와 같은 규칙, 백업은 처음 것만).
pub fn load(root: &Path) -> IwmsSettings {
    let path = file_path(root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return IwmsSettings::default();
    };
    match serde_json::from_str::<IwmsSettings>(&raw) {
        Ok(s) => normalize(s),
        Err(err) => {
            let backup = root.join("iwms.json.corrupt");
            if !backup.exists() {
                let _ = std::fs::write(&backup, raw);
            }
            eprintln!("[contextflow] iwms.json 파싱 실패 ({err}) — 기본값으로 시작한다");
            IwmsSettings::default()
        }
    }
}

pub fn save(root: &Path, settings: &IwmsSettings) -> Result<IwmsSettings> {
    std::fs::create_dir_all(root)?;
    let s = normalize(settings.clone());
    crate::fsops::replace_text(&file_path(root), &serde_json::to_string_pretty(&s)?)?;
    Ok(s)
}

/// 쓰기 전 정리: 주소 끝 `/`, 분 단위, 같은 카테고리 두 번, 빈 매핑 · 샘플.
pub fn normalize(mut s: IwmsSettings) -> IwmsSettings {
    s.base_url = s.base_url.trim().trim_end_matches('/').to_string();
    if s.base_url.is_empty() {
        s.base_url = DEFAULT_BASE.to_string();
    }
    if !STEPS.contains(&s.minute_step) {
        s.minute_step = 10;
    }
    if s.style_guide.trim().is_empty() {
        s.style_guide = DEFAULT_STYLE.to_string();
    }
    let mut seen: Vec<(String, String)> = Vec::new();
    s.categories.retain_mut(|c| {
        c.ci_key = c.ci_key.trim().to_string();
        c.wbsid = c.wbsid.trim().to_string();
        let key = (c.ci_key.clone(), c.wbsid.clone());
        if c.ci_key.is_empty() || c.wbsid.is_empty() || seen.contains(&key) {
            return false;
        }
        seen.push(key);
        c.hint = c.hint.trim().to_string();
        c.map_from = c.map_from.iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect();
        c.map_from.dedup();
        c.samples = c.samples.iter().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()).collect();
        true
    });
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(ci: &str, wbs: &str) -> Designated {
        Designated { ci_key: ci.into(), wbsid: wbs.into(), price_type: "O".into(), ..Default::default() }
    }

    #[test]
    fn normalize_trims_dedupes_and_defaults() {
        let s = normalize(IwmsSettings {
            base_url: " http://x/ ".into(),
            minute_step: 7,
            style_guide: "  ".into(),
            categories: vec![
                Designated { map_from: vec![" a ".into(), "".into()], samples: vec!["".into(), " s ".into()], ..cat(" K ", "w1") },
                cat("K", "w1"),
                cat("", "w2"),
                cat("K", "w2"),
            ],
            ..Default::default()
        });
        assert_eq!(s.base_url, "http://x");
        assert_eq!(s.minute_step, 10);
        assert_eq!(s.style_guide, DEFAULT_STYLE);
        let keys: Vec<_> = s.categories.iter().map(|c| (c.ci_key.as_str(), c.wbsid.as_str())).collect();
        assert_eq!(keys, [("K", "w1"), ("K", "w2")]);
        assert_eq!(s.categories[0].map_from, ["a"]);
        assert_eq!(s.categories[0].samples, ["s"]);
    }

    #[test]
    fn a_missing_file_is_the_default_and_a_broken_one_is_kept_aside() {
        let dir = std::env::temp_dir().join(format!(
            "contextflow-iwms-settings-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load(&dir), IwmsSettings::default());

        let saved = save(&dir, &IwmsSettings { categories: vec![cat("K", "w")], ..Default::default() }).unwrap();
        assert_eq!(load(&dir), saved);

        std::fs::write(dir.join("iwms.json"), "{ broken").unwrap();
        assert_eq!(load(&dir), IwmsSettings::default());
        assert_eq!(std::fs::read_to_string(dir.join("iwms.json.corrupt")).unwrap(), "{ broken");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_and_missing_keys_fall_back_to_defaults() {
        let s: IwmsSettings = serde_json::from_str(r#"{"baseUrl":"http://y","extra":1}"#).unwrap();
        assert_eq!(s.base_url, "http://y");
        assert!(s.fill_to_standard);
        assert_eq!(s.minute_step, 10);
    }
}
