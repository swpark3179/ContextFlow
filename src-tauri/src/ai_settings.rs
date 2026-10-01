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

/// FabriX 연결 설정 — 인증이 커스텀 헤더 두 개다.
///
/// FabriX 에는 **서로 다른 API 가 둘** 있다. 같은 헤더 이름을 쓰지만 기준 주소 · 경로 ·
/// 모델 id 형식이 모두 달라서, 플래그 하나로 갈라 두고 경로 조립은 `fabrix.rs` 가 한다.
///
/// * `chat`(기본) — 네이티브 채팅 API. `{base}/openapi/chat/v1/messages` · `/all-models`.
/// * `openai` — LLM 게이트웨이(OpenAI 호환, vLLM). `{base}/chat/completions` · `/v1/models`,
///   모델은 본문이 아니라 `x-llm-model-id` 헤더로 고른다. 바탕화면 FabrixSample 이 이쪽이다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FabrixConfig {
    /// 기준 엔드포인트. 경로는 `fabrix.rs` 가 방식에 맞춰 덧붙인다.
    #[serde(default)]
    pub endpoint_url: String,
    /// `"chat"` | `"openai"`. 비어 있으면 `chat` — 이 필드가 생기기 전의 ai.json 이 그대로
    /// 읽혀야 한다.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_style: String,
    /// `x-fabrix-client` 헤더 값.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// `x-openapi-token` 헤더 값. 게이트웨이 방식에서는 `Bearer ` 접두사가 필요한데,
    /// 빠져 있으면 보낼 때 붙인다(저장된 값은 사용자가 적은 그대로 둔다).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openapi_token: Option<String>,
    /// `x-generative-ai-user-email` 헤더 값(선택). 네이티브 모델 조회 예시가 보낸다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_email: Option<String>,
    #[serde(default)]
    pub allow_invalid_certs: bool,
    /// 출력 토큰 상한 **재정의**. 비어 있으면 호출자가 요청한 값을 쓴다. 게이트웨이가 큰 값을
    /// 거부하면 낮추고, 모델이 더 긴 출력을 허용하면 올린다 — 이 값이 있으면 모든 호출이
    /// 이 값을 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    /// 마지막으로 성공한 조회의 모델 목록 캐시. 프런트는 이 값을 보내지 않고 백엔드가
    /// 소유한다(연결 정보가 그대로면 이월, 바뀌면 무효화).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelOption>,
    /// 사용자가 직접 적은 모델 id. 모델 목록 조회가 막힌 환경의 탈출구이고, 있으면 조회
    /// 결과보다 우선한다.
    ///
    /// 위의 `models` 캐시와 달리 **프런트가 소유한다**. 엔드포인트가 바뀌어도 지우지
    /// 않는다 — 사용자가 적은 값을 앱이 임의로 버리면 왜 사라졌는지 알 방법이 없다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_models: Vec<ModelOption>,
}

impl FabrixConfig {
    /// LLM 게이트웨이(OpenAI 호환) 방식인가. 그 밖의 값은 전부 네이티브 채팅 API 로 읽는다.
    pub fn gateway(&self) -> bool {
        self.api_style == "openai"
    }
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
/// 지점마다 그 요청의 **출력 계약 앞**에 붙는다. 시스템 프롬프트에는 주입하지 않는다 —
/// 판단의 정체성을 사용자 지침이 통과하면 결과가 왜 기울었는지 추적할 수 없다
/// (`src/lib/promptPacks.ts` 참조).
pub const HOOKS: [&str; 4] = ["recommend.rank", "wiki.ingest", "wiki.query", "wiki.lint"];

/// 훅 하나에 붙일 수 있는 팩 수. 프롬프트가 무한정 길어지는 것을 막는 1차 방어선이다.
pub const MAX_PACKS_PER_HOOK: usize = 5;

/// 기능별 연결을 고를 수 있는 기능. 추천은 여기 없다 — 추천은 `active`(기본 연결) 그 자체다.
///
/// 위키 질의와 점검은 한 연결을 같이 쓴다(둘 다 위키를 읽고 답하는 일이라 모델 성격이 같다).
pub const ROUTES: [&str; 2] = ["wiki.ingest", "wiki.query"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    /// 로컬 CLI 에이전트 설정, id 로 키잉("claude" · "codex").
    #[serde(default)]
    pub agents: HashMap<String, AgentConfig>,
    /// 프롬프트 팩 배선.
    #[serde(default)]
    pub prompts: PromptConfig,
    /// FabriX 연결. `None` 이면 미설정(탐지가 `not-configured`).
    ///
    /// 예전 파일의 `aipro` 키(걷어 낸 AI Pro 연결)는 모르는 키라 읽을 때 버려지고, 다음
    /// 저장에서 사라진다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fabrix: Option<FabrixConfig>,
    /// 기본 연결 — 추천이 쓰고, 기능별 연결을 고르지 않은 기능도 이것을 따른다.
    #[serde(default)]
    pub active: ActiveChoice,
    /// 기능별 연결(`ROUTES`). 키가 없으면 그 기능은 `active` 를 따른다.
    ///
    /// 위키 반영처럼 긴 입력을 오래 쓰는 일과 추천처럼 짧게 판단하는 일은 알맞은 모델이
    /// 다르다 — 값싼 모델을 반영에, 좋은 모델을 질의에 두는 식으로 나눠 쓸 수 있게 한다.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub routes: HashMap<String, ActiveChoice>,
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

    /// 기능별 연결을 지정(`Some`)하거나 해제(`None` · 빈 agent_id)한다.
    pub fn set_route(&mut self, feature: &str, choice: Option<ActiveChoice>) -> Result<(), String> {
        if !ROUTES.contains(&feature) {
            return Err(format!("알 수 없는 기능입니다: {feature}"));
        }
        match choice.filter(|c| !c.agent_id.trim().is_empty()) {
            Some(c) if !known_agent(&c.agent_id) => {
                Err(format!("알 수 없는 AI 서비스입니다: {}", c.agent_id.trim()))
            }
            Some(c) => {
                self.routes.insert(
                    feature.to_string(),
                    ActiveChoice {
                        agent_id: c.agent_id.trim().to_string(),
                        model: c.model.trim().to_string(),
                    },
                );
                Ok(())
            }
            None => {
                self.routes.remove(feature);
                Ok(())
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

/// 레지스트리(`agents.rs`)에 있는 서비스인가. 걷어 낸 서비스(AI Pro)를 가리키는 선택이
/// 파일에 남아 있으면 선택기에는 없는 값이 박혀 그 기능이 소리 없이 멈춘다.
fn known_agent(id: &str) -> bool {
    crate::agents::find(id.trim()).is_some()
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
            // 기능별 연결도 같은 이유로 모르는 키 · 빈 연결 · 없는 서비스를 걷어낸다.
            s.routes.retain(|k, v| ROUTES.contains(&k.as_str()) && known_agent(&v.agent_id));
            // 기본 연결이 없는 서비스를 가리키면 "사용하지 않음(로컬 유사도)" 으로 되돌린다.
            if !s.active.agent_id.trim().is_empty() && !known_agent(&s.active.agent_id) {
                s.active = ActiveChoice::default();
            }
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
        s.fabrix = Some(FabrixConfig {
            endpoint_url: "https://example.test".into(),
            client: Some("c".into()),
            openapi_token: Some("t".into()),
            max_output_tokens: Some(16_384),
            models: vec![ModelOption { id: "m-1".into(), label: "GLM-5.2".into() }],
            custom_models: vec![ModelOption { id: "mine".into(), label: "직접 지정".into() }],
            ..FabrixConfig::default()
        });
        s.active = ActiveChoice { agent_id: "fabrix".into(), model: "m-1".into() };
        save(&root, &s).unwrap();
        assert_eq!(load(&root), s);
    }

    /// 방식 필드가 생기기 전의 ai.json 은 네이티브 채팅 API 로 읽혀야 한다.
    #[test]
    fn fabrix_without_style_is_the_native_chat_api() {
        let root = tmp_root("fabrix-legacy");
        fs::write(
            file_path(&root),
            r#"{"fabrix":{"endpointUrl":"https://f.test","client":"c","openapiToken":"t"}}"#,
        )
        .unwrap();
        let f = load(&root).fabrix.unwrap();
        assert!(!f.gateway());
        assert!(f.custom_models.is_empty() && f.user_email.is_none());

        let mut g = f.clone();
        g.api_style = "openai".into();
        g.user_email = Some("me@corp.test".into());
        g.custom_models = vec![ModelOption { id: "16".into(), label: "gpt-oss".into() }];
        let mut s = AiSettings::default();
        s.fabrix = Some(g.clone());
        save(&root, &s).unwrap();
        assert_eq!(load(&root).fabrix, Some(g));
    }

    #[test]
    fn routes_validate_round_trip_and_prune() {
        let mut s = AiSettings::default();
        assert!(s.set_route("wiki.nope", None).is_err());
        let pick = |a: &str| Some(ActiveChoice { agent_id: a.into(), model: " m ".into() });
        s.set_route("wiki.ingest", pick("fabrix")).unwrap();
        assert_eq!(s.routes["wiki.ingest"].model, "m");
        // 빈 연결은 "기본 연결 따름" — 키 자체를 지운다.
        s.set_route("wiki.query", pick("claude")).unwrap();
        s.set_route("wiki.query", pick("  ")).unwrap();
        assert!(!s.routes.contains_key("wiki.query"));

        let root = tmp_root("routes");
        save(&root, &s).unwrap();
        assert_eq!(load(&root), s);

        fs::write(
            file_path(&root),
            r#"{"routes":{"wiki.ingest":{"agentId":"fabrix","model":"x"},"old.feature":{"agentId":"a","model":""},"wiki.query":{"agentId":"","model":""}}}"#,
        )
        .unwrap();
        let loaded = load(&root);
        assert_eq!(loaded.routes.len(), 1);
        assert_eq!(loaded.routes["wiki.ingest"].agent_id, "fabrix");
    }

    #[test]
    fn routes_reject_unknown_services() {
        let mut s = AiSettings::default();
        let pick = Some(ActiveChoice { agent_id: "aipro".into(), model: "glm-5.2".into() });
        assert!(s.set_route("wiki.ingest", pick).is_err());
        assert!(s.routes.is_empty());
    }

    /// AI Pro 를 쓰던 ai.json. 연결 설정은 버려지고, 그것을 가리키던 선택은 지워져 다른 연결은
    /// 그대로 남는다 — 선택기에 없는 값이 박힌 채로 기능이 멈추면 안 된다.
    #[test]
    fn retired_aipro_settings_are_dropped_on_load() {
        let root = tmp_root("retired-aipro");
        fs::write(
            file_path(&root),
            r#"{"aipro":{"endpointUrl":"https://aipro.test/v1","apiKey":"k"},
                "fabrix":{"endpointUrl":"https://f.test"},
                "active":{"agentId":"aipro","model":"glm-5.2"},
                "routes":{"wiki.ingest":{"agentId":"aipro","model":"glm-5.2"},
                          "wiki.query":{"agentId":"fabrix","model":"m"}}}"#,
        )
        .unwrap();
        let s = load(&root);
        assert_eq!(s.active, ActiveChoice::default());
        assert!(!s.routes.contains_key("wiki.ingest"));
        assert_eq!(s.routes["wiki.query"].agent_id, "fabrix");
        assert_eq!(s.fabrix.as_ref().unwrap().endpoint_url, "https://f.test");

        // 다음 저장에서 옛 키가 파일에서 사라진다.
        save(&root, &s).unwrap();
        assert!(!fs::read_to_string(file_path(&root)).unwrap().contains("aipro"));
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
    fn wiki_hooks_are_accepted() {
        let mut s = AiSettings::default();
        for h in ["wiki.ingest", "wiki.query", "wiki.lint"] {
            s.set_prompt_hook(h, vec!["a.md".into()]).unwrap();
        }
        assert_eq!(s.prompts.hooks.len(), 3);
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
}
