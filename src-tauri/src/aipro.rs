//! AI Pro 커넥터 — OpenAI 호환 HTTP + SSE.
//!
//! 인증은 `Authorization: Bearer <apiKey>` 하나. 모델 목록은 네 갈래로 정해진다
//! (`effective_models` 참고): 사용자 지정 → 라이브 `/models` → 캐시 → 정적 카탈로그.
//! 라이브 조회는 **명시적 재탐지와 연결 테스트에서만** 돈다 — 앱을 열 때마다 사내
//! 게이트웨이를 때리지 않기 위해서다.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::agents;
use crate::ai_settings::{self, AiProConfig};
use crate::detect::{fallback_from, DetectedAgent, ModelOption};
use crate::run::{RunArgs, RunEvent};

/// **필수.** 사내 게이트웨이가 이 UA 를 allowlist 하고 백엔드가 `ua.split("/")` 를 하므로,
/// UA 가 없으면 HTTP 500(`'NoneType' ... split`), 다른 UA 면 406 이다. reqwest 는 기본
/// UA 를 보내지 않는다.
const OPENCODE_UA: &str = "opencode/0.1.0";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const MODELS_TIMEOUT: Duration = Duration::from_secs(30);

/// `total: None` 이면 전체 요청 타임아웃이 없다 — 스트리밍 대화는 몇 분씩 정상적으로
/// 이어질 수 있다. 프록시 환경변수는 무시한다(사내 엔드포인트는 직접 도달 가능).
fn build_client(
    allow_invalid_certs: bool,
    total: Option<Duration>,
) -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .no_proxy()
        .user_agent(OPENCODE_UA)
        .connect_timeout(CONNECT_TIMEOUT)
        .danger_accept_invalid_certs(allow_invalid_certs);
    if let Some(t) = total {
        b = b.timeout(t);
    }
    b.build().map_err(|e| e.to_string())
}

fn load_config() -> Option<AiProConfig> {
    let root = crate::app_home().ok()?;
    ai_settings::load(&root)
        .aipro
        .filter(|c| !c.endpoint_url.trim().is_empty())
}

fn base(cfg: &AiProConfig) -> String {
    ai_settings::normalize_endpoint(&cfg.endpoint_url)
}

/// 정적 모델 카탈로그. 합성 `default` 는 넣지 않는다 — 채팅 API 가 실제 id 를 요구한다.
pub fn static_fallback_models() -> Vec<ModelOption> {
    fallback_from(agents::find("aipro").expect("aipro def"), false)
}

/// `/models` 응답 → 모델 목록.
///
/// 두 모양을 모두 받는다: OpenAI 표준 `{"data":[{"id":…}]}` 와 최상위 JSON 배열.
/// 게이트웨이가 어느 쪽을 주는지 확인할 길이 없어서(사내망) 관대하게 읽는다 —
/// 여기서 까다롭게 굴면 멀쩡한 응답을 "형식 오류" 로 되돌려보내게 된다.
pub fn parse_models_json(body: &str) -> Result<Vec<ModelOption>, String> {
    let v: Value =
        serde_json::from_str(body).map_err(|e| format!("모델 목록 JSON 파싱 실패: {e}"))?;
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.as_array())
        .ok_or("모델 목록 형식 오류: `data` 배열도 최상위 배열도 아닙니다")?;

    let pick = |item: &Value, key: &str| {
        item.get(key)
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    let mut out: Vec<ModelOption> = Vec::new();
    for item in arr {
        let id = match pick(item, "id").or_else(|| pick(item, "model")) {
            Some(s) => s,
            None => continue,
        };
        // 같은 id 를 두 번 주는 게이트웨이가 있다 — 선택기에 중복이 뜨면 사용자가
        // 무엇이 다른지 알 수 없다.
        if out.iter().any(|m| m.id == id) {
            continue;
        }
        let label = pick(item, "display_name")
            .or_else(|| pick(item, "name"))
            .unwrap_or_else(|| id.clone());
        out.push(ModelOption { id, label });
    }

    // 빈 목록을 성공으로 캐시하면 선택기가 텅 빈 채로 굳는다. 조회 실패로 본다.
    if out.is_empty() {
        return Err("모델 목록이 비어 있습니다".to_string());
    }
    Ok(out)
}

/// `GET {base}/models`. 토큰을 태우지 않는 유일한 도달성 확인 수단이다.
fn fetch_models(cfg: &AiProConfig) -> Result<Vec<ModelOption>, String> {
    // `build_client` 를 반드시 거칠 것 — `OPENCODE_UA` 가 빠지면 이 게이트웨이는
    // `/models` 에도 406/500 을 준다.
    let client = build_client(cfg.allow_invalid_certs, Some(MODELS_TIMEOUT))?;
    let url = format!("{}/models", base(cfg));
    let mut req = client.get(&url).header("Accept", "application/json");
    if let Some(k) = cfg.api_key.as_deref() {
        req = req.header("Authorization", format!("Bearer {k}"));
    }
    let resp = req.send().map_err(|e| format!("연결 실패: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status} — {}", body.trim()));
    }
    parse_models_json(&body)
}

/// 화면·실행·연결 테스트가 **모두** 이 하나만 본다. 우선순위가 흩어지면 선택기에
/// 보이는 모델과 실제로 호출되는 모델이 달라진다.
///
/// 사용자 지정 → 라이브 조회 → 마지막 성공 캐시 → 정적 카탈로그.
fn effective_models(
    cfg: &AiProConfig,
    live: Option<Vec<ModelOption>>,
) -> (Vec<ModelOption>, &'static str) {
    if !cfg.custom_models.is_empty() {
        return (cfg.custom_models.clone(), "custom");
    }
    if let Some(m) = live.filter(|m| !m.is_empty()) {
        return (m, "live");
    }
    // 캐시는 반드시 지난번 라이브 조회에서 왔다 — 정적 카탈로그와 같은 `fallback` 로
    // 뭉뚱그리면 게이트웨이가 준 목록에 "내장 목록" 배지가 붙는다.
    if !cfg.models.is_empty() {
        return (cfg.models.clone(), "cache");
    }
    (static_fallback_models(), "fallback")
}

/// `force` 일 때만 라이브 조회한다(앱 시작마다 사내 게이트웨이를 때리지 않도록).
///
/// 조회에 실패해도 **`available` 은 내리지 않는다.** FabriX 는 목록이 곧 도달성이지만
/// AI Pro 는 카탈로그만으로도 대화가 된다 — 여기서 사용 불가로 만들면 추천 연결
/// 선택기에서 카드가 통째로 사라진다.
pub fn detect_aipro(cfg: Option<AiProConfig>, force: bool) -> DetectedAgent {
    let def = agents::find("aipro").expect("aipro def");
    let mut agent = DetectedAgent::empty(def);

    let cfg = match cfg {
        Some(c) if !c.endpoint_url.trim().is_empty() => c,
        _ => {
            agent.diagnostic = Some("not-configured".to_string());
            return agent;
        }
    };

    // 사용자가 직접 적었으면 조회할 이유가 없다 — 어차피 그 값이 이긴다.
    let live = if force && cfg.custom_models.is_empty() {
        fetch_models(&cfg).ok()
    } else {
        None
    };

    let (models, source) = effective_models(&cfg, live);
    agent.available = true;
    agent.source = "remote".to_string();
    agent.models = models;
    agent.models_source = source.to_string();
    agent
}

fn chat_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    stream: bool,
    max_tokens: u32,
) -> Value {
    let system = if system_prompt.trim().is_empty() {
        "사용자 질문에 정확하고 도움이 되게 답합니다.".to_string()
    } else {
        system_prompt.to_string()
    };
    serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": prompt },
        ],
        "stream": stream,
        "stream_options": { "include_usage": true },
        "temperature": 0.4,
        "max_tokens": max_tokens
    })
}

/// OpenAI `chat.completion.chunk` 한 조각 → 이벤트들.
pub fn parse_openai_sse_data(data: &str) -> Vec<RunEvent> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Vec::new();
    }
    let v: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();

    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("AI Pro 오류")
            .to_string();
        return vec![RunEvent::Error { message: msg }];
    }

    if let Some(delta) = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"))
    {
        // glm-5.2 은 추론 토큰을 별도 필드로 흘린다.
        for key in ["reasoning", "reasoning_content"] {
            if let Some(t) = delta.get(key).and_then(|x| x.as_str()) {
                if !t.is_empty() {
                    out.push(RunEvent::ThinkingDelta { delta: t.to_string() });
                }
            }
        }
        if let Some(t) = delta.get("content").and_then(|x| x.as_str()) {
            if !t.is_empty() {
                out.push(RunEvent::TextDelta { delta: t.to_string() });
            }
        }
    }

    // `length` 는 출력 상한에 닿아 답변이 끊겼다는 뜻이다. 스트림 자체는 정상 종료하므로
    // 이 신호가 없으면 프런트는 "형식 위반" 과 구별하지 못한다.
    if v.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("finish_reason"))
        .and_then(|x| x.as_str())
        == Some("length")
    {
        out.push(RunEvent::Truncated);
    }

    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
        out.push(RunEvent::Usage {
            input_tokens: u.get("prompt_tokens").and_then(|x| x.as_u64()),
            output_tokens: u.get("completion_tokens").and_then(|x| x.as_u64()),
        });
    }
    out
}

/// 호출 스레드에서 SSE 를 끝까지 읽는다. 종료 상태를 돌려준다.
pub fn run_blocking(
    args: &RunArgs,
    canceled: &Arc<AtomicBool>,
    on_event: &mut dyn FnMut(RunEvent),
) -> Result<String, String> {
    let cfg =
        load_config().ok_or("AI Pro 연결 정보가 없습니다. 설정 화면에서 저장하세요.")?;
    let model = match args.model.as_deref() {
        Some(m) if !m.trim().is_empty() && m != "default" => m.to_string(),
        _ => return Err("AI Pro 모델을 선택해 주세요.".to_string()),
    };

    let client = build_client(cfg.allow_invalid_certs, None)?;
    let url = format!("{}/chat/completions", base(&cfg));
    let mut req = client
        .post(&url)
        .header("Accept", "text/event-stream")
        .json(&chat_body(
            &model,
            &args.system_prompt,
            &args.prompt,
            true,
            // 설정의 재정의가 있으면 그 값이 이긴다 — 게이트웨이마다 허용 상한이 다르다.
            cfg.max_output_tokens.unwrap_or_else(|| args.max_tokens_or_default()),
        ));
    if let Some(k) = cfg.api_key.as_deref() {
        req = req.header("Authorization", format!("Bearer {k}"));
    }

    let resp = req.send().map_err(|e| format!("AI Pro 요청 실패: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("AI Pro HTTP {status} — {}", body.trim()));
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
                for ev in parse_openai_sse_data(data) {
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
    // 취소는 연결을 끊어 서버 쪽 생성도 멈추게 한다.
    drop(reader);

    Ok(if canceled.load(Ordering::Relaxed) {
        "canceled".to_string()
    } else if had_error {
        "failed".to_string()
    } else {
        "succeeded".to_string()
    })
}

/// 최소 비스트림 채팅 1회로 도달성을 확인한다. 토큰을 태우므로 `/models` 가 실패한
/// 뒤에만 부른다.
fn probe_chat(cfg: &AiProConfig, model: &str) -> Result<(), String> {
    let client = build_client(cfg.allow_invalid_certs, Some(PROBE_TIMEOUT))?;
    let url = format!("{}/chat/completions", base(cfg));
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
        "stream": false
    });
    let mut req = client.post(&url).header("Accept", "application/json").json(&body);
    if let Some(k) = cfg.api_key.as_deref() {
        req = req.header("Authorization", format!("Bearer {k}"));
    }
    let resp = req.send().map_err(|e| format!("연결 실패: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {status} — {}", resp.text().unwrap_or_default().trim()))
    }
}

/// 연결 테스트 — 2단계.
///
/// ① `GET /models`. 성공하면 목록을 캐시에 반영하고 끝 — 토큰을 태우지 않는다.
/// ② 실패하면 최소 채팅 1회. 모델은 하드코딩이 아니라 `effective_models` 의 첫 항목이다.
///
/// 둘 다 실패하면 **두 사유를 함께** 돌려준다. 정적 카탈로그의 첫 항목을 박아 두고
/// 채팅만 때리면, 게이트웨이가 그 id 를 서빙하지 않을 때 모델 문제가 연결 실패로
/// 위장된다.
#[tauri::command]
pub async fn probe_aipro() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config()
            .ok_or("AI Pro 연결 정보가 없습니다. 엔드포인트를 먼저 저장하세요.")?;

        let models_err = match fetch_models(&cfg) {
            Ok(models) => {
                let n = models.len();
                cache_models(models);
                return Ok(format!("연결됨 — 모델 {n}개를 조회했습니다."));
            }
            Err(e) => e,
        };

        let (models, _) = effective_models(&cfg, None);
        let model = models
            .first()
            .map(|m| m.id.clone())
            .ok_or("AI Pro 모델 카탈로그가 비어 있습니다.")?;

        match probe_chat(&cfg, &model) {
            Ok(()) => Ok(format!(
                "연결됨 — 모델 목록 조회는 지원하지 않아 대화로 확인했습니다 (모델: {model})."
            )),
            Err(chat_err) => Err(format!(
                "연결 실패 — 모델 목록: {models_err} / 대화 확인({model}): {chat_err}"
            )),
        }
    })
    .await
    .map_err(|e| format!("연결 테스트가 중단되었습니다: {e}"))?
}

/// 라이브로 받은 목록을 설정에 반영한다. 캐시는 최선 노력이다 — 저장에 실패해도
/// 연결 테스트 결과 자체는 유효하므로 조용히 넘어간다.
fn cache_models(models: Vec<ModelOption>) {
    let Ok(root) = crate::app_home() else { return };
    let mut s = ai_settings::load(&root);
    if let Some(c) = s.aipro.as_mut() {
        c.models = models;
        let _ = ai_settings::save(&root, &s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_catalog_has_no_synthetic_default() {
        let m = static_fallback_models();
        assert_eq!(m.len(), 3);
        assert!(!m.iter().any(|x| x.id == "default"));
        assert_eq!(m[0].id, "glm-5.2");
    }

    #[test]
    fn content_delta_becomes_text() {
        let evs = parse_openai_sse_data(r#"{"choices":[{"delta":{"content":"안녕"}}]}"#);
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "안녕".into() }]);
    }

    #[test]
    fn reasoning_delta_becomes_thinking() {
        let evs = parse_openai_sse_data(r#"{"choices":[{"delta":{"reasoning":"흠"}}]}"#);
        assert_eq!(evs, vec![RunEvent::ThinkingDelta { delta: "흠".into() }]);
    }

    #[test]
    fn done_and_role_only_chunks_are_silent() {
        assert!(parse_openai_sse_data("[DONE]").is_empty());
        assert!(
            parse_openai_sse_data(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#).is_empty()
        );
        assert!(parse_openai_sse_data("").is_empty());
        assert!(parse_openai_sse_data("not json").is_empty());
    }

    #[test]
    fn usage_and_error_map_through() {
        let evs = parse_openai_sse_data(
            r#"{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}"#,
        );
        assert_eq!(
            evs,
            vec![RunEvent::Usage { input_tokens: Some(5), output_tokens: Some(7) }]
        );
        let evs = parse_openai_sse_data(r#"{"error":{"message":"boom"}}"#);
        assert_eq!(evs, vec![RunEvent::Error { message: "boom".into() }]);
    }

    #[test]
    fn detect_without_config_is_not_configured() {
        let a = detect_aipro(None, false);
        assert!(!a.available);
        assert_eq!(a.diagnostic.as_deref(), Some("not-configured"));

        let a = detect_aipro(
            Some(AiProConfig {
                endpoint_url: "https://x.test/v1".into(),
                ..Default::default()
            }),
            false,
        );
        assert!(a.available);
        assert_eq!(a.source, "remote");
        assert_eq!(a.models.len(), 3);
    }

    fn cfg() -> AiProConfig {
        AiProConfig { endpoint_url: "https://x.test/v1".into(), ..Default::default() }
    }

    fn opt(id: &str) -> ModelOption {
        ModelOption { id: id.to_string(), label: id.to_string() }
    }

    /// OpenAI 표준과 최상위 배열을 모두 받아야 한다 — 게이트웨이가 어느 쪽을 주는지
    /// 확인할 길이 없어서(사내망) 한쪽만 읽으면 멀쩡한 응답을 형식 오류로 되돌린다.
    #[test]
    fn parses_both_openai_data_and_bare_array() {
        let wrapped = parse_models_json(r#"{"data":[{"id":"a"},{"id":"b"}]}"#).unwrap();
        assert_eq!(wrapped, vec![opt("a"), opt("b")]);

        let bare = parse_models_json(r#"[{"id":"a"},{"id":"b"}]"#).unwrap();
        assert_eq!(bare, wrapped);
    }

    #[test]
    fn label_prefers_display_name_then_name_then_id() {
        let m = parse_models_json(
            r#"{"data":[
                {"id":"a","display_name":"에이","name":"A"},
                {"id":"b","name":"비"},
                {"id":"c"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(m[0].label, "에이");
        assert_eq!(m[1].label, "비");
        assert_eq!(m[2].label, "c");
    }

    /// id 가 없는 항목은 건너뛰고, 중복 id 는 한 번만 남는다. 빈 결과는 성공이 아니다 —
    /// 빈 목록을 캐시하면 선택기가 텅 빈 채로 굳는다.
    #[test]
    fn skips_junk_dedupes_and_rejects_empty() {
        let m = parse_models_json(
            r#"{"data":[{"id":"a"},{"name":"이름만"},{"id":"  "},{"id":"a"},{"model":"b"}]}"#,
        )
        .unwrap();
        assert_eq!(m, vec![opt("a"), opt("b")]);

        assert!(parse_models_json(r#"{"data":[]}"#).is_err());
        assert!(parse_models_json(r#"{"data":[{"name":"이름만"}]}"#).is_err());
        assert!(parse_models_json("not json").is_err());
        assert!(parse_models_json(r#"{"models":[{"id":"a"}]}"#).is_err());
    }

    /// 우선순위가 흩어지면 선택기에 보이는 모델과 실제로 호출되는 모델이 달라진다.
    #[test]
    fn custom_models_win_over_live_and_cache() {
        let mut c = cfg();
        c.models = vec![opt("cached")];
        c.custom_models = vec![opt("mine")];
        let (m, src) = effective_models(&c, Some(vec![opt("live")]));
        assert_eq!(m, vec![opt("mine")]);
        assert_eq!(src, "custom");
    }

    #[test]
    fn live_wins_over_cache_and_cache_over_static() {
        let mut c = cfg();
        c.models = vec![opt("cached")];

        let (m, src) = effective_models(&c, Some(vec![opt("live")]));
        assert_eq!(m, vec![opt("live")]);
        assert_eq!(src, "live");

        let (m, src) = effective_models(&c, None);
        assert_eq!(m, vec![opt("cached")]);
        assert_eq!(src, "cache");

        // 빈 라이브 응답은 없는 것으로 본다 — 캐시를 밀어내면 안 된다.
        let (m, _) = effective_models(&c, Some(Vec::new()));
        assert_eq!(m, vec![opt("cached")]);

        let (m, src) = effective_models(&cfg(), None);
        assert_eq!(m, static_fallback_models());
        assert_eq!(src, "fallback");
    }

    /// 회귀 방지 — 조회에 실패해도 사용 가능이어야 한다. `available` 이 내려가면
    /// `availableAgents()` 에서 빠져 추천 연결 선택기에서 AI Pro 가 통째로 사라진다.
    #[test]
    fn stays_available_when_live_lookup_fails() {
        // 닿을 수 없는 주소라 `force` 조회는 반드시 실패한다.
        let c = AiProConfig {
            endpoint_url: "http://127.0.0.1:1/v1".into(),
            ..Default::default()
        };
        let a = detect_aipro(Some(c), true);
        assert!(a.available);
        assert_eq!(a.models_source, "fallback");
        assert_eq!(a.models, static_fallback_models());
        assert!(a.diagnostic.is_none());
    }

    /// 사용자가 직접 적었으면 네트워크를 타지 않는다 — 어차피 그 값이 이긴다.
    #[test]
    fn custom_models_short_circuit_the_lookup() {
        let c = AiProConfig {
            endpoint_url: "http://127.0.0.1:1/v1".into(),
            custom_models: vec![opt("mine")],
            ..Default::default()
        };
        let a = detect_aipro(Some(c), true);
        assert_eq!(a.models, vec![opt("mine")]);
        assert_eq!(a.models_source, "custom");
    }

    #[test]
    fn chat_body_uses_the_given_system_prompt() {
        let b = chat_body("glm-5.2", "당신은 업무 맥락 분석가입니다.", "질문", true, 8192);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][0]["content"], "당신은 업무 맥락 분석가입니다.");
        assert_eq!(b["messages"][1]["content"], "질문");
    }

    #[test]
    fn chat_body_carries_the_requested_output_ceiling() {
        assert_eq!(chat_body("m", "", "q", true, 8192)["max_tokens"], 8192);
        assert_eq!(chat_body("m", "", "q", true, 16_384)["max_tokens"], 16_384);
    }

    /// 상한에 닿아 끊긴 응답은 오류가 아니라 `Truncated` 다. 이 신호가 있어야 프런트가
    /// "형식을 지키세요" 대신 "분량을 줄여 다시" 라고 물을 수 있다.
    #[test]
    fn finish_reason_length_reports_truncation() {
        let evs = parse_openai_sse_data(
            r#"{"choices":[{"delta":{"content":"…"},"finish_reason":"length"}]}"#,
        );
        assert_eq!(
            evs,
            vec![RunEvent::TextDelta { delta: "…".to_string() }, RunEvent::Truncated,]
        );
    }

    /// 정상 종료는 잘림이 아니다 — 여기서 오판하면 멀쩡한 응답에도 축소 재질의가 붙는다.
    #[test]
    fn normal_stop_is_not_truncation() {
        let evs = parse_openai_sse_data(
            r#"{"choices":[{"delta":{"content":"끝"},"finish_reason":"stop"}]}"#,
        );
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "끝".to_string() }]);
        // 스트리밍 도중의 조각에는 finish_reason 이 아예 없다.
        let mid = parse_openai_sse_data(r#"{"choices":[{"delta":{"content":"중"}}]}"#);
        assert_eq!(mid, vec![RunEvent::TextDelta { delta: "중".to_string() }]);
    }
}
