//! AI 서비스 연결 설정의 영속화.
//!
//! **왜 기존 `settings.json` 과 파일을 나누는가**: `settings.json` 은 프런트가 통째로
//! 소유하고 `patchSettings` 가 키 입력마다 덮어쓴다. 이 파일은 반대로 **백엔드가 소유**
//! 한다 — 모델 캐시 이월, `.corrupt` 백업, 죽은 훅 prune 이 전부 여기서 일어난다. 같은
//! 파일을 공유하면 두 소유자의 쓰기가 서로를 지운다. 파일 하나에 소유자 하나.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::detect::ModelOption;

/// 로컬 CLI 에이전트 한 종의 설정. 지금은 사용자 지정 실행 파일 경로뿐이다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default)]
    pub custom_bin: Option<String>,
}

/// AI Pro 연결 설정 — OpenAI 호환 HTTP 서비스라 인증은 Bearer 키 하나다.
///
/// 키는 평문으로 저장된다. 로컬 단일 사용자 데스크탑 앱이라 감수하는 선택이며,
/// 설정 화면이 그 사실을 표시한다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiProConfig {
    /// 기준 엔드포인트. `/chat/completions` 는 `aipro.rs` 가 덧붙인다.
    #[serde(default)]
    pub endpoint_url: String,
    /// `Authorization: Bearer <apiKey>` 값.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 사내 TLS 검사 프록시의 CA 가 OS 저장소에 없을 때의 탈출구. 기본 false.
    #[serde(default)]
    pub allow_invalid_certs: bool,
    /// 출력 토큰 상한 **재정의**. 비어 있으면 호출자가 요청한 값을 쓴다. 게이트웨이가
    /// 큰 값을 거부하면 낮추고, 모델이 더 긴 출력을 허용하면 올린다 — 이 값이 있으면
    /// 모든 호출이 이 값을 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// 마지막으로 성공한 조회의 모델 목록 캐시. 프런트는 이 값을 보내지 않고
    /// 백엔드가 소유한다(연결 정보가 그대로면 이월, 바뀌면 무효화).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelOption>,
    /// 사용자가 직접 적은 모델 id. 있으면 라이브 조회·내장 카탈로그보다 우선한다 —
    /// 게이트웨이가 `/models` 를 주지 않는 환경의 탈출구다.
    ///
    /// 위의 `models` 캐시와 달리 **프런트가 소유한다**. 엔드포인트가 바뀌어도 지우지
    /// 않는다 — 사용자가 적은 값을 앱이 임의로 버리면 왜 사라졌는지 알 방법이 없다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_models: Vec<ModelOption>,
}

/// FabriX 연결 설정 — 인증이 커스텀 헤더 두 개다(AI Pro 의 Bearer 하나와 대비).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FabrixConfig {
    /// 기준 엔드포인트. `/openapi/chat/v1/...` 는 `fabrix.rs` 가 덧붙인다.
    #[serde(default)]
    pub endpoint_url: String,
    /// `x-fabrix-client` 헤더 값.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// `x-openapi-token` 헤더 값.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openapi_token: Option<String>,
    #[serde(default)]
    pub allow_invalid_certs: bool,
    /// 출력 토큰 상한 **재정의**. 비어 있으면 호출자가 요청한 값을 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelOption>,
}

/// 프롬프트 팩을 어느 훅에 붙일지의 배선.
///
/// 팩 본문은 `~/.contextflow/prompts/` 의 파일이 갖고 여기에는 파일명만 담는다 —
/// 사용자가 파일을 고쳐도 설정을 다시 저장할 필요가 없어야 한다. 명시적 opt-in 이므로
/// 비어 있으면 아무것도 주입되지 않는다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PromptConfig {
    /// 훅 이름 → 적용 순서대로의 팩 파일명.
    #[serde(default)]
    pub hooks: HashMap<String, Vec<String>>,
}

/// 추천에 쓸 연결. Multi-Aspect 는 1단계 위저드에서 골랐지만 ContextFlow 에는 위저드가
/// 없으므로 설정이 갖는다. `agent_id` 가 비어 있으면 AI 추천을 쓰지 않는다(로컬 유사도).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveChoice {
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub model: String,
}

/// 주입 지점. 여기 없는 이름은 `set_prompt_hook` 이 거부하고 `load` 가 걷어낸다 — 오타로
/// 만들어진 죽은 키가 설정 파일에 쌓이면 왜 안 먹히는지 알 방법이 없다.
///
/// 추천 순위 요청 하나뿐이다. 시스템 프롬프트에는 주입하지 않는다 — 판단의 정체성을
/// 사용자 지침이 통과하면 결과가 왜 기울었는지 추적할 수 없다(`src/lib/promptPacks.ts` 참조).
pub const HOOKS: [&str; 1] = ["recommend.rank"];

/// 훅 하나에 붙일 수 있는 팩 수. 프롬프트가 무한정 길어지는 것을 막는 1차 방어선이다.
pub const MAX_PACKS_PER_HOOK: usize = 5;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    /// 로컬 CLI 에이전트 설정, id 로 키잉("claude" · "codex").
    #[serde(default)]
    pub agents: HashMap<String, AgentConfig>,
    /// 프롬프트 팩 배선.
    #[serde(default)]
    pub prompts: PromptConfig,
    /// AI Pro 연결. `None` 이면 미설정(탐지가 `not-configured`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aipro: Option<AiProConfig>,
    /// FabriX 연결. `None` 이면 미설정.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fabrix: Option<FabrixConfig>,
    /// 추천에 쓸 연결.
    #[serde(default)]
    pub active: ActiveChoice,
}

impl AiSettings {
    pub fn agent_custom_bin(&self, id: &str) -> Option<String> {
        self.agents.get(id).and_then(|c| c.custom_bin.clone())
    }

    /// 한 에이전트의 사용자 지정 경로를 설정(`Some`)하거나 해제(`None`)한다.
    pub fn set_agent_bin(&mut self, id: &str, path: Option<String>) {
        match path {
            Some(p) => {
                self.agents.insert(id.to_string(), AgentConfig { custom_bin: Some(p) });
            }
            None => {
                self.agents.remove(id);
            }
        }
    }

    /// 한 훅의 팩 목록을 통째로 교체한다.
    ///
    /// 파일이 실제로 있는지는 확인하지 않는다 — 사용자가 파일을 잠깐 빼 두었다 되돌릴
    /// 수 있고, 없는 파일은 프롬프트를 조립할 때 건너뛰면 그만이다.
    pub fn set_prompt_hook(&mut self, stage: &str, files: Vec<String>) -> Result<(), String> {
        if !HOOKS.contains(&stage) {
            return Err(format!("알 수 없는 주입 지점입니다: {stage}"));
        }
        let mut seen: Vec<String> = Vec::new();
        for f in files {
            let f = f.trim().to_string();
            if f.is_empty() || seen.contains(&f) {
                continue;
            }
            seen.push(f);
            if seen.len() >= MAX_PACKS_PER_HOOK {
                break;
            }
        }
        if seen.is_empty() {
            self.prompts.hooks.remove(stage);
        } else {
            self.prompts.hooks.insert(stage.to_string(), seen);
        }
        Ok(())
    }
}

fn file_path(root: &Path) -> PathBuf {
    root.join("ai.json")
}

/// 설정 파일을 읽는다. 파일이 없으면 기본값.
///
/// **파싱 실패 시 원본을 `ai.json.corrupt` 로 먼저 보존한다.** `load` 는 거의 모든
/// 커맨드가 호출하고 그 뒤 `save` 가 따라오므로, 그냥 기본값으로 넘어가면 다음 저장이
/// 사용자의 경로·엔드포인트·토큰을 전부 지운다. 백업은 keep-first — 이미 백업이 있으면
/// 덮어쓰지 않는다(2차 파손이 원본을 밀어내지 않도록).
pub fn load(root: &Path) -> AiSettings {
    let path = file_path(root);
    let raw = match fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return AiSettings::default(),
    };
    match serde_json::from_str::<AiSettings>(&raw) {
        Ok(mut s) => {
            // 은퇴한 훅에 배선이 남아 있으면 여기서 걷어낸다. 남겨 두면 설정 화면에
            // 뜨지도, 지울 수도 없는 죽은 배선이 되고 다음 저장이 그것을 다시 써 넣는다.
            s.prompts.hooks.retain(|k, _| HOOKS.contains(&k.as_str()));
            s
        }
        Err(err) => {
            let backup = root.join("ai.json.corrupt");
            if !backup.exists() {
                let _ = fs::write(&backup, raw);
            }
            eprintln!("[contextflow] ai.json 파싱 실패 ({err}) — 기본값으로 시작한다");
            AiSettings::default()
        }
    }
}

pub fn save(root: &Path, settings: &AiSettings) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("설정 폴더를 만들 수 없다: {e}"))?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(file_path(root), json).map_err(|e| format!("설정을 저장할 수 없다: {e}"))
}

/// 엔드포인트 정규화 — 앞뒤 공백과 끝 슬래시를 떼어 경로 조립이 `//` 가 되지 않게 한다.
pub fn normalize_endpoint(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// 빈 문자열은 "값 없음"으로 접는다(시크릿 필드 공용).
pub fn normalize_secret(raw: Option<String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// 임베딩 시절의 flat 필드(`api` · `apiKey` · `model`)를 AI Pro 연결로 1회 옮긴다.
///
/// `ai.json` 이 이미 있으면 아무것도 하지 않는다 — 마이그레이션은 한 번이고, 사용자가
/// 그 뒤 지운 연결을 되살리면 안 된다. 옛 `model` 은 임베딩 모델명이라 옮기지 않는다
/// (채팅 모델 id 가 아니어서 그대로 쓰면 첫 호출이 400 으로 실패한다).
pub fn migrate_from_legacy(root: &Path, legacy: &serde_json::Value) -> AiSettings {
    let path = file_path(root);
    if path.exists() {
        return load(root);
    }

    let endpoint = legacy
        .get("api")
        .and_then(|v| v.as_str())
        .map(normalize_endpoint)
        .unwrap_or_default();
    if endpoint.is_empty() {
        return AiSettings::default();
    }

    let mut s = AiSettings::default();
    s.aipro = Some(AiProConfig {
        endpoint_url: endpoint,
        api_key: normalize_secret(
            legacy.get("apiKey").and_then(|v| v.as_str()).map(str::to_string),
        ),
        ..AiProConfig::default()
    });
    // 저장에 실패해도 이번 세션은 마이그레이션된 값으로 동작한다. 다음 저장이 다시 쓴다.
    let _ = save(root, &s);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("contextflow-ai-settings-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_is_default() {
        let root = tmp_root("missing");
        assert_eq!(load(&root), AiSettings::default());
    }

    #[test]
    fn round_trips() {
        let root = tmp_root("roundtrip");
        let mut s = AiSettings::default();
        s.set_agent_bin("claude", Some("C:\\bin\\claude.cmd".into()));
        s.aipro = Some(AiProConfig {
            endpoint_url: "https://example.test/v1".into(),
            api_key: Some("k".into()),
            allow_invalid_certs: false,
            max_output_tokens: Some(16_384),
            models: vec![ModelOption { id: "glm-5.2".into(), label: "GLM-5.2".into() }],
            custom_models: vec![ModelOption { id: "mine".into(), label: "직접 지정".into() }],
        });
        s.active = ActiveChoice { agent_id: "aipro".into(), model: "glm-5.2".into() };
        save(&root, &s).unwrap();
        assert_eq!(load(&root), s);
    }

    #[test]
    fn clearing_agent_bin_removes_entry() {
        let mut s = AiSettings::default();
        s.set_agent_bin("claude", Some("x".into()));
        s.set_agent_bin("claude", None);
        assert!(s.agents.is_empty());
    }

    #[test]
    fn corrupt_file_is_backed_up_and_kept() {
        let root = tmp_root("corrupt");
        fs::write(file_path(&root), "{ not json").unwrap();
        assert_eq!(load(&root), AiSettings::default());
        let backup = root.join("ai.json.corrupt");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{ not json");

        // 2차 파손이 1차 백업을 밀어내지 않는다.
        fs::write(file_path(&root), "also broken").unwrap();
        let _ = load(&root);
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{ not json");
    }

    #[test]
    fn unknown_keys_do_not_wipe_known_ones() {
        let root = tmp_root("unknown");
        fs::write(
            file_path(&root),
            r#"{"agents":{"claude":{"customBin":"C:\\c.exe"}},"somethingNew":42}"#,
        )
        .unwrap();
        assert_eq!(load(&root).agent_custom_bin("claude").as_deref(), Some("C:\\c.exe"));
    }

    #[test]
    fn prompt_hook_rejects_unknown_stage() {
        let mut s = AiSettings::default();
        assert!(s.set_prompt_hook("recommend.nope", vec!["a.md".into()]).is_err());
        assert!(s.prompts.hooks.is_empty());
    }

    #[test]
    fn prompt_hook_dedupes_and_caps() {
        let mut s = AiSettings::default();
        let many: Vec<String> = (0..10).map(|i| format!("p{i}.md")).collect();
        s.set_prompt_hook("recommend.rank", many).unwrap();
        assert_eq!(s.prompts.hooks["recommend.rank"].len(), MAX_PACKS_PER_HOOK);

        s.set_prompt_hook("recommend.rank", vec!["a.md".into(), " a.md ".into(), "b.md".into()])
            .unwrap();
        assert_eq!(s.prompts.hooks["recommend.rank"], vec!["a.md", "b.md"]);
    }

    /// 시스템 프롬프트 주입은 없다 — 설정에 남아 있어도 배선으로 되살아나지 않는다.
    #[test]
    fn retired_hooks_are_rejected_and_pruned() {
        let mut s = AiSettings::default();
        assert!(s.set_prompt_hook("recommend.system", vec!["a.md".into()]).is_err());

        let root = tmp_root("retired");
        fs::write(
            file_path(&root),
            r#"{"prompts":{"hooks":{"recommend.system":["a.md"],"recommend.rank":["b.md"]}}}"#,
        )
        .unwrap();
        let loaded = load(&root);
        assert_eq!(loaded.prompts.hooks.len(), 1);
        assert_eq!(loaded.prompts.hooks["recommend.rank"], vec!["b.md"]);
    }

    #[test]
    fn empty_prompt_hook_removes_the_key() {
        let mut s = AiSettings::default();
        s.set_prompt_hook("recommend.rank", vec!["a.md".into()]).unwrap();
        s.set_prompt_hook("recommend.rank", vec![]).unwrap();
        assert!(s.prompts.hooks.is_empty());
    }

    #[test]
    fn endpoint_and_secret_normalization() {
        assert_eq!(normalize_endpoint("  https://a.test/v1/  "), "https://a.test/v1");
        assert_eq!(normalize_secret(Some("  ".into())), None);
        assert_eq!(normalize_secret(Some(" k ".into())), Some("k".into()));
    }

    #[test]
    fn legacy_endpoint_becomes_an_aipro_connection() {
        let root = tmp_root("migrate");
        let legacy = serde_json::json!({
            "api": "https://llm.internal.corp/v1/",
            "apiKey": " secret ",
            "model": "in-house-embed-v2"
        });
        let s = migrate_from_legacy(&root, &legacy);
        let aipro = s.aipro.as_ref().unwrap();
        assert_eq!(aipro.endpoint_url, "https://llm.internal.corp/v1");
        assert_eq!(aipro.api_key.as_deref(), Some("secret"));
        // 임베딩 모델명은 채팅 모델 id 가 아니므로 옮기지 않는다.
        assert!(aipro.models.is_empty() && aipro.custom_models.is_empty());
        // 파일로 남아 다음 실행에서 다시 마이그레이션되지 않는다.
        assert_eq!(load(&root), s);
    }

    #[test]
    fn migration_never_overwrites_an_existing_file() {
        let root = tmp_root("migrate-existing");
        let mut existing = AiSettings::default();
        existing.set_agent_bin("codex", Some("/usr/bin/codex".into()));
        save(&root, &existing).unwrap();

        let s = migrate_from_legacy(&root, &serde_json::json!({ "api": "https://other.test" }));
        assert_eq!(s, existing);
        assert!(s.aipro.is_none());
    }

    #[test]
    fn empty_legacy_endpoint_migrates_nothing() {
        let root = tmp_root("migrate-empty");
        let s = migrate_from_legacy(&root, &serde_json::json!({ "api": "  " }));
        assert_eq!(s, AiSettings::default());
        // 옮길 것이 없으면 파일도 만들지 않는다.
        assert!(!file_path(&root).exists());
    }
}
