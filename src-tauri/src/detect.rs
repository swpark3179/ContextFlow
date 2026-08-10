//! AI 서비스 탐지 — 로컬은 resolve → `--version`, 원격은 설정 유무로 판정한다.

use serde::{Deserialize, Serialize};

use crate::agents::AgentDef;
use crate::exec::run_capture;
use crate::resolve::resolve_agent;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

/// 설정 화면 카드 한 장이 보여 주는 전부.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub id: String,
    pub name: String,
    /// 실제로 쓸 수 있는 상태인가(로컬=spawn 성공, 원격=연결 설정 있음).
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// `custom-path` / `path` / `not-found` / `remote`.
    pub source: String,
    pub models: Vec<ModelOption>,
    /// `live`(방금 조회) / `cache`(지난 조회) / `custom`(사용자 지정) / `fallback`(정적 카탈로그).
    ///
    /// FabriX 는 `live` 와 `fallback` 만 쓴다(캐시도 `fallback` 로 묶는다).
    pub models_source: String,
    /// `not-on-path` / `not-executable` / `missing-target` / `not-configured` / `unreachable`.
    pub diagnostic: Option<String>,
}

impl DetectedAgent {
    pub fn empty(def: &AgentDef) -> DetectedAgent {
        DetectedAgent {
            id: def.id.to_string(),
            name: def.name.to_string(),
            available: false,
            path: None,
            version: None,
            source: "not-found".to_string(),
            models: Vec::new(),
            models_source: "fallback".to_string(),
            diagnostic: None,
        }
    }
}

/// 설정 화면 목록용 최소 정보(탐지 없이 레지스트리만).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub env_var: Option<String>,
}

/// 정적 카탈로그 → 모델 목록. `with_default` 면 맨 앞에 합성 `default` 를 붙인다
/// (로컬 CLI 는 자체 설정 모델을 쓸 수 있지만, 원격 채팅 API 는 실제 id 를 요구한다).
pub fn fallback_from(def: &AgentDef, with_default: bool) -> Vec<ModelOption> {
    let mut out = Vec::new();
    if with_default {
        out.push(ModelOption {
            id: "default".to_string(),
            label: "기본값 (CLI 설정)".to_string(),
        });
    }
    out.extend(def.fallback_models.iter().map(|(id, label)| ModelOption {
        id: (*id).to_string(),
        label: (*label).to_string(),
    }));
    out
}

/// 로컬 CLI 에이전트 탐지. 블로킹이므로 커맨드에서 `spawn_blocking` 으로 감싸 호출한다.
pub fn detect_local(def: &AgentDef, custom: Option<&str>) -> DetectedAgent {
    let mut agent = DetectedAgent::empty(def);

    let resolved = match resolve_agent(def, custom) {
        Some(r) => r,
        None => {
            agent.diagnostic = Some("not-on-path".to_string());
            agent.models = fallback_from(def, true);
            return agent;
        }
    };
    agent.path = Some(resolved.path.clone());
    agent.source = resolved.source.to_string();

    let v = run_capture(&resolved.path, &["--version"], def.version_timeout);
    if let Some(err) = &v.spawn_error {
        agent.diagnostic = Some(
            match err.kind() {
                std::io::ErrorKind::PermissionDenied => "not-executable",
                _ => "missing-target",
            }
            .to_string(),
        );
        agent.models = fallback_from(def, true);
        return agent;
    }
    match v.status_code {
        // shim 이 사라진 런타임을 가리키면 127, 실행 권한이 없으면 126 이다.
        Some(127) => {
            agent.diagnostic = Some("missing-target".to_string());
            agent.models = fallback_from(def, true);
            return agent;
        }
        Some(126) => {
            agent.diagnostic = Some("not-executable".to_string());
            agent.models = fallback_from(def, true);
            return agent;
        }
        _ => {}
    }

    // spawn 이 됐으면 "있긴 하다" — 버전 파싱에 실패해도 사용 가능으로 본다.
    agent.available = true;
    if !v.timed_out && v.status_code == Some(0) {
        agent.version = v
            .stdout
            .lines()
            .next()
            .map(|l| l.trim().to_string())
            .filter(|s| !s.is_empty());
    }

    // 모델을 나열하는 명령이 없어 정적 카탈로그를 쓴다.
    agent.models = fallback_from(def, true);
    agent.models_source = "fallback".to_string();
    agent
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents;

    #[test]
    fn local_fallback_prepends_default_remote_does_not() {
        let claude = fallback_from(agents::find("claude").unwrap(), true);
        assert_eq!(claude[0].id, "default");
        assert_eq!(claude.len(), 7);

        let aipro = fallback_from(agents::find("aipro").unwrap(), false);
        assert!(!aipro.iter().any(|m| m.id == "default"));
        assert_eq!(aipro.len(), 3);
        assert_eq!(aipro[0].id, "glm-5.2");
    }

    #[test]
    fn unresolvable_binary_reports_not_on_path() {
        // 존재할 리 없는 후보로 정의를 흉내 낸다.
        static FAKE: agents::AgentDef = agents::AgentDef {
            id: "nope",
            name: "Nope",
            kind: agents::AgentKind::Local,
            bin_candidates: &["contextflow-nonexistent-bin"],
            env_var: None,
            extra_search_subdirs: &[],
            version_timeout: std::time::Duration::from_secs(1),
            fallback_models: &[("m", "M")],
            run: None,
        };
        let a = detect_local(&FAKE, None);
        assert!(!a.available);
        assert_eq!(a.diagnostic.as_deref(), Some("not-on-path"));
        assert_eq!(a.source, "not-found");
    }
}
