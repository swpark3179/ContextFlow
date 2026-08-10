//! FabriX 커넥터 — 원격 HTTP API + SSE.
//!
//! 인증이 커스텀 헤더 두 개(`x-fabrix-client` · `x-openapi-token`)라는 점이 AI Pro 의
//! Bearer 하나와 다르다. 모델 목록은 라이브 조회 전용이라 정적 폴백이 없고, 대신
//! 마지막 성공 조회를 설정에 캐시해 오프라인에서도 즉시 보여 준다.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::agents;
use crate::ai_settings::{self, FabrixConfig};
use crate::detect::{DetectedAgent, ModelOption};
use crate::run::{RunArgs, RunEvent};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const MODELS_TIMEOUT: Duration = Duration::from_secs(30);

fn build_client(
    allow_invalid_certs: bool,
    total: Option<Duration>,
) -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .danger_accept_invalid_certs(allow_invalid_certs);
    if let Some(t) = total {
        b = b.timeout(t);
    }
    b.build().map_err(|e| e.to_string())
}

fn load_config() -> Option<FabrixConfig> {
    let root = crate::app_home().ok()?;
    ai_settings::load(&root)
        .fabrix
        .filter(|c| !c.endpoint_url.trim().is_empty())
}

fn base(cfg: &FabrixConfig) -> String {
    ai_settings::normalize_endpoint(&cfg.endpoint_url)
}

fn auth(
    mut req: reqwest::blocking::RequestBuilder,
    cfg: &FabrixConfig,
) -> reqwest::blocking::RequestBuilder {
    if let Some(c) = cfg.client.as_deref() {
        req = req.header("x-fabrix-client", c);
    }
    if let Some(t) = cfg.openapi_token.as_deref() {
        req = req.header("x-openapi-token", t);
    }
    req
}

/// `name` 배열에서 한국어 라벨을 고른다. 없으면 첫 번째 비어 있지 않은 content.
fn pick_ko_name(name: Option<&Value>) -> Option<String> {
    let arr = name?.as_array()?;
    let pick = |v: &Value| {
        v.get("content")
            .and_then(|c| c.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    arr.iter()
        .find(|v| v.get("languageCode").and_then(|l| l.as_str()) == Some("ko"))
        .and_then(pick)
        .or_else(|| arr.iter().find_map(pick))
}

/// `all-models` 응답(최상위 JSON 배열) → 모델 목록. 합성 `default` 는 없다.
pub fn parse_models_json(body: &str) -> Result<Vec<ModelOption>, String> {
    let v: Value =
        serde_json::from_str(body).map_err(|e| format!("모델 목록 JSON 파싱 실패: {e}"))?;
    let arr = v
        .as_array()
        .ok_or("모델 목록 형식 오류: 최상위가 JSON 배열이 아닙니다")?;
    let mut out = Vec::new();
    for item in arr {
        let model_id = match item.get("modelId").and_then(|x| x.as_str()) {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        let label = pick_ko_name(item.get("name")).unwrap_or_else(|| model_id.clone());
        out.push(ModelOption { id: model_id, label });
    }
    Ok(out)
}

fn fetch_models(cfg: &FabrixConfig) -> Result<Vec<ModelOption>, String> {
    let client = build_client(cfg.allow_invalid_certs, Some(MODELS_TIMEOUT))?;
    let url = format!("{}/openapi/chat/v1/all-models", base(cfg));
    let resp = auth(client.get(&url).header("Accept", "application/json"), cfg)
        .send()
        .map_err(|e| format!("FabriX 연결 실패: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("FabriX HTTP {status} — {}", body.trim()));
    }
    parse_models_json(&body)
}

/// 캐시 우선. `force` 일 때만 라이브 조회한다(앱 시작마다 네트워크를 때리지 않도록).
pub fn detect_fabrix(cfg: Option<FabrixConfig>, force: bool) -> DetectedAgent {
    let def = agents::find("fabrix").expect("fabrix def");
    let mut agent = DetectedAgent::empty(def);

    let cfg = match cfg {
        Some(c) if !c.endpoint_url.trim().is_empty() => c,
        _ => {
            agent.diagnostic = Some("not-configured".to_string());
            return agent;
        }
    };

    if !force && !cfg.models.is_empty() {
        agent.available = true;
        agent.source = "remote".to_string();
        agent.models = cfg.models.clone();
        agent.models_source = "fallback".to_string();
        return agent;
    }

    match fetch_models(&cfg) {
        Ok(models) => {
            agent.available = true;
            agent.source = "remote".to_string();
            agent.models = models;
            agent.models_source = "live".to_string();
        }
        Err(_) => {
            agent.source = "remote".to_string();
            agent.diagnostic = Some("unreachable".to_string());
            if !cfg.models.is_empty() {
                agent.models = cfg.models.clone();
                agent.models_source = "fallback".to_string();
            }
        }
    }
    agent
}

fn chat_body(model: &str, system_prompt: &str, prompt: &str, max_tokens: u32) -> Value {
    let system = if system_prompt.trim().is_empty() {
        "사용자 질문에 정확하고 도움이 되게 답합니다.".to_string()
    } else {
        system_prompt.to_string()
    };
    serde_json::json!({
        "modelIds": [model],
        "contents": [prompt],
        // 긴 답변이 중간에 잘리지 않도록 상한을 올린다.
        "llmConfig": {
            "max_new_tokens": max_tokens,
            "seed": Value::Null,
            "top_k": 14,
            "top_p": 0.94,
            "temperature": 0.4,
            "repetition_penalty": 1.04
        },
        "isStream": true,
        "systemPrompt": system
    })
}

/// SSE `data:` 페이로드 한 조각 → 이벤트들. 종료 마커는 이벤트를 내지 않고, 최종
/// `end` 는 워커가 스트림 종료 후 한 번만 보낸다.
pub fn parse_fabrix_sse_data(data: &str) -> Vec<RunEvent> {
    let data = data.trim();
    if data.is_empty() {
        return Vec::new();
    }
    let v: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let event_status = v.get("event_status").and_then(|s| s.as_str()).unwrap_or("");
    if event_status == "CHUNK" {
        if let Some(c) = v.get("content").and_then(|c| c.as_str()) {
            if !c.is_empty() {
                return vec![RunEvent::TextDelta { delta: c.to_string() }];
            }
        }
        return Vec::new();
    }

    let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
    if status.contains("SUCCESS") || status.contains("R20000") {
        return Vec::new();
    }
    if status.contains("FAIL") || status.contains("ERROR") {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("FabriX 오류")
            .to_string();
        return vec![RunEvent::Error { message: msg }];
    }
    Vec::new()
}

pub fn run_blocking(
    args: &RunArgs,
    canceled: &Arc<AtomicBool>,
    on_event: &mut dyn FnMut(RunEvent),
) -> Result<String, String> {
    let cfg =
        load_config().ok_or("FabriX 연결 정보가 없습니다. 설정 화면에서 저장하세요.")?;
    let model = match args.model.as_deref() {
        Some(m) if !m.trim().is_empty() && m != "default" => m.to_string(),
        _ => return Err("FabriX 모델을 선택해 주세요.".to_string()),
    };

    let client = build_client(cfg.allow_invalid_certs, None)?;
    let url = format!("{}/openapi/chat/v1/messages", base(&cfg));
    let resp = auth(
        client
            .post(&url)
            .header("Accept", "text/event-stream")
            .json(&chat_body(
                &model,
                &args.system_prompt,
                &args.prompt,
                // 설정의 재정의가 있으면 그 값이 이긴다 — 게이트웨이마다 허용 상한이 다르다.
                cfg.max_output_tokens.unwrap_or_else(|| args.max_tokens_or_default()),
            )),
        &cfg,
    )
    .send()
    .map_err(|e| format!("FabriX 요청 실패: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("FabriX HTTP {status} — {}", body.trim()));
    }

    on_event(RunEvent::Status {
        label: "streaming".to_string(),
        model: Some(model),
        session_id: None,
    });

    let mut reader = BufReader::new(resp);
    let mut buf = Vec::new();
    let mut had_error = false;
    loop {
        if canceled.load(Ordering::Relaxed) {
            break;
        }
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\r', '\n']);
                let data = match line.strip_prefix("data:") {
                    Some(rest) => rest.trim_start(),
                    None => continue,
                };
                for ev in parse_fabrix_sse_data(data) {
                    if matches!(ev, RunEvent::Error { .. }) {
                        had_error = true;
                    }
                    on_event(ev);
                }
            }
            Err(_) => {
                had_error = true;
                break;
            }
        }
    }
    drop(reader);

    Ok(if canceled.load(Ordering::Relaxed) {
        "canceled".to_string()
    } else if had_error {
        "failed".to_string()
    } else {
        "succeeded".to_string()
    })
}

/// 연결 테스트 — 모델 목록을 조회하고 그 결과를 캐시에 반영한다.
#[tauri::command]
pub async fn probe_fabrix() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::app_home()?;
        let cfg = load_config()
            .ok_or("FabriX 연결 정보가 없습니다. 엔드포인트를 먼저 저장하세요.")?;
        let models = fetch_models(&cfg)?;
        let mut s = ai_settings::load(&root);
        if let Some(f) = s.fabrix.as_mut() {
            f.models = models.clone();
            let _ = ai_settings::save(&root, &s);
        }
        Ok::<String, String>(format!("연결됨 ({}개 모델)", models.len()))
    })
    .await
    .map_err(|e| format!("연결 테스트가 중단되었습니다: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_prefer_korean_label() {
        let body = r#"[
          {"modelId":"m-1","name":[{"languageCode":"en","content":"Model One"},
                                   {"languageCode":"ko","content":"모델 1"}]},
          {"modelId":"m-2","name":[{"languageCode":"en","content":"Model Two"}]},
          {"modelId":"m-3"},
          {"modelId":"   "}
        ]"#;
        let m = parse_models_json(body).unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].label, "모델 1");
        assert_eq!(m[1].label, "Model Two");
        // 라벨이 없으면 id 로 대체.
        assert_eq!(m[2].label, "m-3");
    }

    #[test]
    fn non_array_body_is_an_error() {
        assert!(parse_models_json(r#"{"models":[]}"#).is_err());
        assert!(parse_models_json("nope").is_err());
    }

    #[test]
    fn chunk_events_become_text() {
        let evs = parse_fabrix_sse_data(r#"{"event_status":"CHUNK","content":"안녕"}"#);
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "안녕".into() }]);
    }

    #[test]
    fn terminal_markers_are_silent() {
        assert!(parse_fabrix_sse_data(r#"{"status":"SUCCESS"}"#).is_empty());
        assert!(parse_fabrix_sse_data(r#"{"status":"R20000"}"#).is_empty());
        assert!(parse_fabrix_sse_data(r#"{"event_status":"CHUNK","content":""}"#).is_empty());
        assert!(parse_fabrix_sse_data("nope").is_empty());
    }

    #[test]
    fn failure_status_becomes_error() {
        let evs = parse_fabrix_sse_data(r#"{"status":"FAIL","message":"터짐"}"#);
        assert_eq!(evs, vec![RunEvent::Error { message: "터짐".into() }]);
    }

    #[test]
    fn detect_uses_cache_without_network() {
        let cfg = FabrixConfig {
            endpoint_url: "https://unreachable.invalid".into(),
            models: vec![ModelOption { id: "m".into(), label: "M".into() }],
            ..Default::default()
        };
        let a = detect_fabrix(Some(cfg), false);
        assert!(a.available);
        assert_eq!(a.models_source, "fallback");
        assert_eq!(a.models.len(), 1);

        assert_eq!(
            detect_fabrix(None, false).diagnostic.as_deref(),
            Some("not-configured")
        );
    }

    #[test]
    fn chat_body_carries_the_given_system_prompt() {
        let b = chat_body("m-1", "당신은 업무 맥락 분석가입니다.", "질문", 8192);
        assert_eq!(b["systemPrompt"], "당신은 업무 맥락 분석가입니다.");
        assert_eq!(b["modelIds"][0], "m-1");
        assert_eq!(b["contents"][0], "질문");
        assert_eq!(b["isStream"], true);
    }
}
