//! FabriX 커넥터 — 원격 HTTP API + SSE.
//!
//! 인증은 커스텀 헤더 두 개(`x-fabrix-client` · `x-openapi-token`)다. 모델 목록은 정적
//! 폴백이 없고, 대신 마지막 성공 조회를 설정에 캐시해 오프라인에서도 즉시 보여 준다.
//!
//! **API 가 둘이다**(`FabrixConfig::api_style`).
//!
//! | | 네이티브 채팅 API (`chat`) | LLM 게이트웨이 (`openai`) |
//! | --- | --- | --- |
//! | 대화 | `POST {base}/openapi/chat/v1/messages` | `POST {base}/chat/completions` (`/v1` 없음) |
//! | 모델 | `GET {base}/openapi/chat/v1/all-models` | `GET {base}/v1/models` (`/v1` 있음) |
//! | 모델 고르기 | 본문 `modelIds` | 헤더 `x-llm-model-id` (본문 `model` 은 무시됨) |
//! | 토큰 | 받은 그대로 | `Bearer ` 접두사 필수 |
//! | 스트림 | FabriX 자체 프레임 | OpenAI `chat.completion.chunk` + `[DONE]` |
//!
//! 게이트웨이 쪽은 바탕화면 FabrixSample 의 규약을 따른다. 본문 조립과 SSE 파싱은 OpenAI
//! 호환 공용 모듈(`openai::openai_body` · `openai::parse_openai_sse`)을 쓰고, 다른 것은 헤더뿐이다.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::agents;
use crate::ai_settings::{self, FabrixConfig};
use crate::detect::{DetectedAgent, ModelOption};
use crate::run::{RunArgs, RunEvent};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const MODELS_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// `timeout` 은 **반드시** 준다. reqwest blocking 클라이언트는 비워 두면 기본 30초를 걸고,
/// 그 값은 헤더를 기다릴 때와 본문을 한 번 읽을 때마다 적용된다 — "전체 타임아웃 없음" 이
/// 아니다. 스트리밍 대화는 `sse::STREAM_IDLE`(조각 사이 공백 상한)을 넘긴다.
/// 프록시 환경변수는 무시한다(사내 엔드포인트는 직접 도달 가능).
fn build_client(
    allow_invalid_certs: bool,
    timeout: Duration,
) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .danger_accept_invalid_certs(allow_invalid_certs)
        .build()
        .map_err(|e| e.to_string())
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

/// 모델 목록 주소. 게이트웨이는 `/v1` 이 붙고 대화 주소는 안 붙는다 — 샘플 README 가 짚는
/// 가장 흔한 404 원인이다.
pub(crate) fn models_url(cfg: &FabrixConfig) -> String {
    if cfg.gateway() {
        format!("{}/v1/models", base(cfg))
    } else {
        format!("{}/openapi/chat/v1/all-models", base(cfg))
    }
}

pub(crate) fn chat_url(cfg: &FabrixConfig) -> String {
    if cfg.gateway() {
        format!("{}/chat/completions", base(cfg))
    } else {
        format!("{}/openapi/chat/v1/messages", base(cfg))
    }
}

/// 게이트웨이(WSO2)는 `x-openapi-token` 에 `Bearer ` 접두사를 요구한다. 빠지면 401/403 이고
/// 응답 본문만 보고는 원인을 알기 어렵다. 이미 붙어 있으면 그대로 둔다.
fn bearer(token: &str) -> String {
    let t = token.trim();
    if t.len() >= 7 && t.is_char_boundary(7) && t[..7].eq_ignore_ascii_case("bearer ") {
        t.to_string()
    } else {
        format!("Bearer {t}")
    }
}

/// 인증 · 부가 헤더. `model` 은 게이트웨이 대화에서만 의미가 있다 — 모델 목록 조회에는
/// `x-llm-model-id` 를 붙이지 않는다.
fn auth(
    mut req: reqwest::blocking::RequestBuilder,
    cfg: &FabrixConfig,
    model: Option<&str>,
) -> reqwest::blocking::RequestBuilder {
    if let Some(c) = cfg.client.as_deref() {
        req = req.header("x-fabrix-client", c);
    }
    if let Some(t) = cfg.openapi_token.as_deref() {
        req = req.header("x-openapi-token", if cfg.gateway() { bearer(t) } else { t.to_string() });
    }
    if let Some(e) = cfg.user_email.as_deref() {
        req = req.header("x-generative-ai-user-email", e);
    }
    if cfg.gateway() {
        if let Some(m) = model {
            req = req.header("x-llm-model-id", m);
        }
    }
    req
}

/// `[{languageCode, content}]` 배열에서 라벨을 고른다 — 한국어 → 영어 → 첫 비어 있지 않은 것.
fn pick_text(arr: Option<&Value>) -> Option<String> {
    let arr = arr?.as_array()?;
    let content = |v: &Value| {
        v.get("content")
            .and_then(|c| c.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let lang = |code: &str| {
        arr.iter()
            .find(|v| v.get("languageCode").and_then(|l| l.as_str()) == Some(code))
            .and_then(content)
    };
    lang("ko").or_else(|| lang("en")).or_else(|| arr.iter().find_map(content))
}

/// 문자열 또는 숫자 값을 id 문자열로. 게이트웨이의 `modelId` 는 숫자(16 · 70)이고 네이티브
/// 예시는 문자열이다 — 한쪽만 받으면 다른 쪽 목록이 통째로 비어 보인다.
fn id_of(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 모델 목록 응답 → 선택지.
///
/// 봉투가 셋이다 — 최상위 배열, `{"data":[…]}`, `{"models":[…]}`(`data` 가 비었으면 `models`).
/// id 는 `modelId` 를 쓰고, 없을 때만 `modelGuid` 로 내려간다(`modelServingId` 는 여러 모델이
/// 공유할 수 있어 id 로 못 쓴다). 라벨은 이름(한국어 → 영어) → `modelServingId` → id.
pub fn parse_models_json(body: &str) -> Result<Vec<ModelOption>, String> {
    let v: Value =
        serde_json::from_str(body).map_err(|e| format!("모델 목록 JSON 파싱 실패: {e}"))?;
    fn non_empty(x: Option<&Value>) -> Option<&Vec<Value>> {
        x.and_then(|a| a.as_array()).filter(|a| !a.is_empty())
    }
    let arr = match v.as_array() {
        Some(a) => a,
        None => non_empty(v.get("data"))
            .or_else(|| non_empty(v.get("models")))
            .ok_or("모델 목록 형식 오류: 배열 · data · models 어디에서도 목록을 찾지 못했습니다")?,
    };

    let mut out: Vec<ModelOption> = Vec::new();
    for item in arr {
        let Some(id) = id_of(item.get("modelId")).or_else(|| id_of(item.get("modelGuid"))) else {
            continue;
        };
        if out.iter().any(|m| m.id == id) {
            continue;
        }
        let mut label = pick_text(item.get("name"))
            .or_else(|| id_of(item.get("modelServingId")))
            .unwrap_or_else(|| id.clone());
        // 이름이 같은 모델이 둘이면 선택기에서 구별할 수 없다 — id 를 덧붙인다.
        if out.iter().any(|m| m.label == label) {
            label = format!("{label} · {id}");
        }
        out.push(ModelOption { id, label });
    }

    // 빈 목록을 성공으로 캐시하면 선택기가 텅 빈 채로 굳는다.
    if out.is_empty() {
        return Err("모델 목록이 비어 있습니다".to_string());
    }
    Ok(out)
}

fn fetch_models(cfg: &FabrixConfig) -> Result<Vec<ModelOption>, String> {
    let client = build_client(cfg.allow_invalid_certs, MODELS_TIMEOUT)?;
    let resp = auth(client.get(models_url(cfg)).header("Accept", "application/json"), cfg, None)
        .send()
        .map_err(|e| format!("FabriX 연결 실패: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("FabriX HTTP {status} — {}", with_hint(&body)));
    }
    parse_models_json(&body)
}

/// 화면 · 실행 · 연결 테스트가 모두 이 순서를 본다: 직접 지정 → 라이브 → 마지막 성공 캐시.
fn effective_models(
    cfg: &FabrixConfig,
    live: Option<Vec<ModelOption>>,
) -> (Vec<ModelOption>, &'static str) {
    if !cfg.custom_models.is_empty() {
        let known = live.as_deref().filter(|m| !m.is_empty()).unwrap_or(&cfg.models);
        return (resolve_custom(&cfg.custom_models, known), "custom");
    }
    if let Some(m) = live.filter(|m| !m.is_empty()) {
        return (m, "live");
    }
    (cfg.models.clone(), "cache")
}

/// 이름으로 적은 모델을 id 로 푼다.
///
/// 네이티브 채팅 API 의 모델 id 는 UUID(`019f23a1-…`)라, 사람이 직접 지정 칸에 적는 것은
/// 대개 화면에 보이는 **이름**("Glm 5.2")이다. 그 값을 그대로 `modelIds` 로 보내면 FabriX 가
/// "model_guid, Input should be a valid UUID" 로 거절한다(사내망에서 실제로 확인한 응답).
/// 아는 목록(라이브 조회 · 캐시)에 같은 이름이 있으면 그 id 로 바꾸고, 표시 이름은 적은 대로
/// 둔다. 이미 id 이거나 아무것도 맞지 않으면 손대지 않는다 — 목록에 없는 새 모델일 수 있다.
fn resolve_custom(custom: &[ModelOption], known: &[ModelOption]) -> Vec<ModelOption> {
    custom
        .iter()
        .map(|c| match resolve_id(&c.id, known) {
            Some(id) if id != c.id => ModelOption { id, label: c.label.clone() },
            _ => c.clone(),
        })
        .collect()
}

/// 이름 또는 id → 아는 목록의 id. 모르면 `None`.
fn resolve_id(name: &str, known: &[ModelOption]) -> Option<String> {
    let n = name.trim();
    known
        .iter()
        .find(|k| k.id == n)
        .or_else(|| known.iter().find(|k| k.label.trim().eq_ignore_ascii_case(n)))
        .map(|k| k.id.clone())
}

/// FabriX 오류 본문에 대응 방법을 덧붙인다. 원문은 그대로 두고 맨 뒤에 한 줄만 더한다.
fn with_hint(body: &str) -> String {
    let body = body.trim();
    if body.contains("model_guid") || body.contains("valid UUID") {
        format!("{body}\n→ 채팅 API 의 모델 id 는 UUID 입니다. 직접 지정 모델에 이름을 적었다면 모델 목록의 id 로 바꾸세요.")
    } else if body.contains("No matching resource") {
        format!("{body}\n→ 이 주소에 해당 경로가 없습니다. API 방식(채팅 API / LLM 게이트웨이)과 엔드포인트가 맞는지 확인하세요.")
    } else {
        body.to_string()
    }
}

/// 캐시 우선. `force` 일 때만 라이브 조회한다(앱 시작마다 네트워크를 때리지 않도록).
///
/// 직접 지정 모델이 있으면 조회하지 않고 사용 가능으로 본다 — 목록 조회가 막힌 환경을 위한
/// 탈출구이므로 "조회 실패 = 사용 불가" 규칙을 거기에 적용하면 탈출구가 닫힌다.
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
    agent.source = "remote".to_string();

    if !cfg.custom_models.is_empty() || (!force && !cfg.models.is_empty()) {
        let (models, source) = effective_models(&cfg, None);
        agent.available = true;
        agent.models = models;
        agent.models_source = source.to_string();
        return agent;
    }

    match fetch_models(&cfg) {
        Ok(models) => {
            agent.available = true;
            agent.models = models;
            agent.models_source = "live".to_string();
        }
        Err(_) => {
            agent.diagnostic = Some("unreachable".to_string());
            if !cfg.models.is_empty() {
                agent.models = cfg.models.clone();
                agent.models_source = "cache".to_string();
            }
        }
    }
    agent
}

/// 네이티브 채팅 API 의 요청 본문. 샘플링 값 중 온도만 호출자가 정하고, 나머지는 FabriX
/// 예시의 값을 그대로 쓴다.
fn chat_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    max_tokens: u32,
    temperature: f32,
) -> Value {
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
            "temperature": temperature,
            "repetition_penalty": 1.04
        },
        "isStream": true,
        "systemPrompt": system
    })
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

/// 네이티브 SSE `data:` 한 조각 → 이벤트들. 종료 마커는 이벤트를 내지 않고, 최종 `end` 는
/// 워커가 스트림 종료 후 한 번만 보낸다.
///
/// 프레임에는 글자 말고도 쓸 것이 있다. 사내망에서 실제로 받은 스트림의 모양:
///
/// * `event_status` 가 `CHUNK`(답) · `THINK`(추론 모델의 생각 — `content` 에 실린다) ·
///   `REQUEST_ANALYSIS` · `FINAL_ANSWER`(단계 표시, 내용 없음) · `STATUS`(진행 문구).
/// * 생각만 하다 출력 상한에 닿으면 `CHUNK` 답이 하나도 없이 끝난다 — 그래서 `THINK` 를
///   글자와 섞지 않고 추론으로 따로 흘린다(테스트 대화가 "추론만 하고 끝났다" 를 알린다).
/// * `filter_block_reason.result_code` 는 통과일 때도 온다: `FR-200`("passed") · `FR-201`
///   ("allowed by the filter"). `FR-2xx` 가 아니고 문구도 통과가 아닐 때만 차단으로 본다.
/// * 마지막 프레임은 `finish_reason` · `response_code: R20000`. 모르는 필드는 무시한다.
pub fn parse_fabrix_sse_data(data: &str) -> Vec<RunEvent> {
    let data = data.trim();
    if data.is_empty() {
        return Vec::new();
    }
    let v: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    // 필터가 막았으면 그 사유가 곧 답이다. 빈 응답으로 끝나면 사용자는 형식 오류로 읽는다.
    if let Some(f) = v.get("filter_block_reason").filter(|f| f.is_object()) {
        let code = str_of(f, "result_code").unwrap_or("");
        let note = str_of(f, "message").unwrap_or("").to_ascii_lowercase();
        let passed = code.starts_with("FR-2") || note.contains("allowed") || note.contains("passed");
        if !code.is_empty() && !passed {
            let why = str_of(f, "ko").or_else(|| str_of(f, "message")).unwrap_or("사유 미상");
            return vec![RunEvent::Error {
                message: format!("FabriX 콘텐츠 필터가 응답을 막았습니다({code}): {why}"),
            }];
        }
    }

    let mut out = Vec::new();
    match v.get("event_status").and_then(|s| s.as_str()).unwrap_or("") {
        "CHUNK" => {
            if let Some(t) = v.get("reasoning_content").and_then(|c| c.as_str()) {
                if !t.is_empty() {
                    out.push(RunEvent::ThinkingDelta { delta: t.to_string() });
                }
            }
            if let Some(c) = v.get("content").and_then(|c| c.as_str()) {
                if !c.is_empty() {
                    out.push(RunEvent::TextDelta { delta: c.to_string() });
                }
            }
        }
        "THINK" => {
            if let Some(t) = v.get("content").and_then(|c| c.as_str()) {
                if !t.is_empty() {
                    out.push(RunEvent::ThinkingDelta { delta: t.to_string() });
                }
            }
        }
        "STATUS" => {
            // `event_data` 는 JSON 이 든 **문자열**이다: "{\"phase\": …, \"message\": …}".
            let label = str_of(&v, "event_data")
                .and_then(|d| serde_json::from_str::<Value>(d).ok())
                .and_then(|d| str_of(&d, "message").map(str::to_string))
                .or_else(|| str_of(&v, "content").map(str::to_string));
            if let Some(label) = label {
                out.push(RunEvent::Status { label, model: None, session_id: None });
            }
        }
        _ => {}
    }

    let length = str_of(&v, "finish_reason") == Some("length");
    if length || v.get("truncated").and_then(|t| t.as_bool()) == Some(true) {
        out.push(RunEvent::Truncated);
    }

    let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
    if status.contains("FAIL") || status.contains("ERROR") {
        let msg = str_of(&v, "message")
            .or_else(|| str_of(&v, "ko"))
            .or_else(|| str_of(&v, "content"))
            .unwrap_or("FabriX 오류")
            .to_string();
        out.push(RunEvent::Error { message: msg });
    }
    out
}

pub fn run_blocking(
    args: &RunArgs,
    canceled: &Arc<AtomicBool>,
    on_event: &mut dyn FnMut(RunEvent),
) -> Result<String, String> {
    let cfg =
        load_config().ok_or("FabriX 연결 정보가 없습니다. 설정 화면에서 저장하세요.")?;
    let model = match args.model.as_deref() {
        // 예전에 이름으로 저장된 선택("Glm 5.2")도 아는 목록의 id 로 풀어 보낸다.
        Some(m) if !m.trim().is_empty() && m != "default" => {
            resolve_id(m, &cfg.models).unwrap_or_else(|| m.trim().to_string())
        }
        _ => return Err("FabriX 모델을 선택해 주세요.".to_string()),
    };
    // 설정의 재정의가 있으면 그 값이 이긴다 — 게이트웨이마다 허용 상한이 다르다.
    let max_tokens = cfg.max_output_tokens.unwrap_or_else(|| args.max_tokens_or_default());
    let temperature = args.temperature.unwrap_or(crate::openai::DEFAULT_TEMPERATURE);

    let client = build_client(cfg.allow_invalid_certs, crate::sse::STREAM_IDLE)?;
    let body = if cfg.gateway() {
        crate::openai::openai_body(
            &model,
            &args.system_prompt,
            &args.prompt,
            max_tokens,
            temperature,
            false,
        )
    } else {
        chat_body(&model, &args.system_prompt, &args.prompt, max_tokens, temperature)
    };
    let resp = auth(
        client.post(chat_url(&cfg)).header("Accept", "text/event-stream").json(&body),
        &cfg,
        Some(&model),
    )
    .send()
    .map_err(|e| format!("FabriX 요청 실패: {e}"))?;

    // 401/403 은 SSE 가 아니라 평문 본문으로 온다 — 스트림을 읽기 전에 상태부터 본다.
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("FabriX HTTP {status} — {}", with_hint(&body)));
    }

    on_event(RunEvent::Status {
        label: "streaming".to_string(),
        model: Some(model),
        session_id: None,
    });

    let gateway = cfg.gateway();
    Ok(crate::sse::pump(
        resp,
        canceled,
        crate::sse::STREAM_IDLE,
        &mut |d| {
            if gateway {
                crate::openai::parse_openai_sse(d, "FabriX")
            } else {
                parse_fabrix_sse_data(d)
            }
        },
        on_event,
    ))
}

/// 최소 대화 1회로 도달성을 확인한다. 토큰을 태우므로 모델 목록 조회가 실패한 뒤에만 부른다.
/// 응답 본문은 읽지 않는다 — 상태 코드가 곧 답이고, 스트림이면 연결을 끊는 것으로 충분하다.
fn probe_chat(cfg: &FabrixConfig, model: &str) -> Result<(), String> {
    let client = build_client(cfg.allow_invalid_certs, PROBE_TIMEOUT)?;
    let body = if cfg.gateway() {
        serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 8,
            "stream": false
        })
    } else {
        chat_body(model, "", "ping", 8, 0.0)
    };
    let resp = auth(client.post(chat_url(cfg)).json(&body), cfg, Some(model))
        .send()
        .map_err(|e| format!("연결 실패: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {status} — {}", with_hint(&resp.text().unwrap_or_default())))
    }
}

/// 연결 테스트 — 2단계.
///
/// ① 모델 목록 조회. 성공하면 캐시에 반영하고 끝 — 토큰을 태우지 않는다.
/// ② 실패하면 첫 유효 모델(직접 지정 → 캐시)로 최소 대화 1회.
///
/// 둘 다 실패하면 **두 사유를 함께** 돌려준다. 목록 조회만 막힌 게이트웨이에서 "연결 실패"
/// 하나로 끝내면, 실제로는 대화가 되는 연결을 사용자가 버리게 된다.
#[tauri::command]
pub async fn probe_fabrix() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::app_home()?;
        let cfg = load_config()
            .ok_or("FabriX 연결 정보가 없습니다. 엔드포인트를 먼저 저장하세요.")?;

        let models_err = match fetch_models(&cfg) {
            Ok(models) => {
                let n = models.len();
                let mut s = ai_settings::load(&root);
                if let Some(f) = s.fabrix.as_mut() {
                    f.models = models;
                    let _ = ai_settings::save(&root, &s);
                }
                return Ok(format!("연결됨 — 모델 {n}개를 조회했습니다."));
            }
            Err(e) => e,
        };

        let (models, _) = effective_models(&cfg, None);
        let Some(model) = models.first().map(|m| m.id.clone()) else {
            return Err(format!(
                "연결 실패 — 모델 목록: {models_err}\n대화로 확인할 모델이 없습니다. 모델 id 를 직접 지정하면 대화로 확인합니다."
            ));
        };
        match probe_chat(&cfg, &model) {
            Ok(()) => Ok(format!(
                "연결됨 — 모델 목록은 받지 못했지만 대화로 확인했습니다 (모델: {model})."
            )),
            Err(chat_err) => Err(format!(
                "연결 실패 — 모델 목록: {models_err}\n대화 확인({model}): {chat_err}"
            )),
        }
    })
    .await
    .map_err(|e| format!("연결 테스트가 중단되었습니다: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opt(id: &str, label: &str) -> ModelOption {
        ModelOption { id: id.into(), label: label.into() }
    }

    fn gw() -> FabrixConfig {
        FabrixConfig {
            endpoint_url: "https://gw.test/openapi/llm/".into(),
            api_style: "openai".into(),
            client: Some("client-jwt".into()),
            openapi_token: Some("wso2-jwt".into()),
            ..Default::default()
        }
    }

    #[test]
    fn models_prefer_korean_then_english_label() {
        let body = r#"[
          {"modelId":"m-1","name":[{"languageCode":"en","content":"Model One"},
                                   {"languageCode":"ko","content":"모델 1"}]},
          {"modelId":"m-2","name":[{"languageCode":"ja","content":"モデル"},
                                   {"languageCode":"en","content":"Model Two"}]},
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

    /// 게이트웨이의 `/v1/models` 는 숫자 id 를 `data` 봉투에 담아 준다.
    #[test]
    fn gateway_models_have_numeric_ids_in_an_envelope() {
        let body = r#"{"data":[
          {"modelId":16,"modelGuid":"0196f1fc-2858-70a9-a232-74dbddb971d0","modelServingId":"gpt-oss-120b",
           "name":[{"languageCode":"ko","content":"GPT OSS"}]},
          {"modelId":70,"modelServingId":"gpt-oss-120b"},
          {"modelId":16}
        ]}"#;
        let m = parse_models_json(body).unwrap();
        assert_eq!(m, vec![opt("16", "GPT OSS"), opt("70", "gpt-oss-120b")]);

        let models = parse_models_json(r#"{"data":[],"models":[{"modelId":"a"}]}"#).unwrap();
        assert_eq!(models, vec![opt("a", "a")]);
    }

    #[test]
    fn guid_is_the_fallback_id_and_duplicate_labels_get_the_id() {
        let m = parse_models_json(
            r#"[{"modelGuid":"g-1","modelServingId":"x"},{"modelId":"b","modelServingId":"x"}]"#,
        )
        .unwrap();
        assert_eq!(m, vec![opt("g-1", "x"), opt("b", "x · b")]);
    }

    #[test]
    fn junk_and_empty_lists_are_errors() {
        assert!(parse_models_json("nope").is_err());
        assert!(parse_models_json(r#"{"models":[]}"#).is_err());
        assert!(parse_models_json(r#"[{"name":"이름만"}]"#).is_err());
        assert!(parse_models_json("[]").is_err());
    }

    #[test]
    fn urls_follow_the_api_style() {
        let native = FabrixConfig { endpoint_url: "https://f.test/".into(), ..Default::default() };
        assert_eq!(models_url(&native), "https://f.test/openapi/chat/v1/all-models");
        assert_eq!(chat_url(&native), "https://f.test/openapi/chat/v1/messages");
        assert_eq!(models_url(&gw()), "https://gw.test/openapi/llm/v1/models");
        assert_eq!(chat_url(&gw()), "https://gw.test/openapi/llm/chat/completions");
    }

    fn header(req: &reqwest::blocking::Request, name: &str) -> Option<String> {
        req.headers().get(name).map(|v| v.to_str().unwrap().to_string())
    }

    /// 게이트웨이: 토큰에 Bearer 를 붙이고, 모델은 헤더로 고르며, 목록 조회에는 모델 헤더가 없다.
    #[test]
    fn gateway_headers() {
        let client = reqwest::blocking::Client::new();
        let mut cfg = gw();
        cfg.user_email = Some("me@corp.test".into());

        let chat = auth(client.post(chat_url(&cfg)), &cfg, Some("16")).build().unwrap();
        assert_eq!(header(&chat, "x-openapi-token").as_deref(), Some("Bearer wso2-jwt"));
        assert_eq!(header(&chat, "x-fabrix-client").as_deref(), Some("client-jwt"));
        assert_eq!(header(&chat, "x-llm-model-id").as_deref(), Some("16"));
        assert_eq!(header(&chat, "x-generative-ai-user-email").as_deref(), Some("me@corp.test"));

        let list = auth(client.get(models_url(&cfg)), &cfg, None).build().unwrap();
        assert_eq!(header(&list, "x-llm-model-id"), None);

        // 이미 붙어 있으면 두 번 붙이지 않는다.
        cfg.openapi_token = Some("bearer abc".into());
        let again = auth(client.get(models_url(&cfg)), &cfg, None).build().unwrap();
        assert_eq!(header(&again, "x-openapi-token").as_deref(), Some("bearer abc"));
    }

    /// 네이티브: 토큰은 받은 그대로, 모델 헤더는 없다(모델은 본문 `modelIds`).
    #[test]
    fn native_headers_are_untouched() {
        let client = reqwest::blocking::Client::new();
        let cfg = FabrixConfig {
            endpoint_url: "https://f.test".into(),
            openapi_token: Some("raw-token".into()),
            ..Default::default()
        };
        let req = auth(client.post(chat_url(&cfg)), &cfg, Some("m-1")).build().unwrap();
        assert_eq!(header(&req, "x-openapi-token").as_deref(), Some("raw-token"));
        assert_eq!(header(&req, "x-llm-model-id"), None);
        assert_eq!(header(&req, "x-generative-ai-user-email"), None);
    }

    #[test]
    fn chunk_events_become_text_and_thinking() {
        let evs = parse_fabrix_sse_data(r#"{"event_status":"CHUNK","content":"안녕"}"#);
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "안녕".into() }]);
        let evs = parse_fabrix_sse_data(
            r#"{"event_status":"CHUNK","reasoning_content":"흠","content":""}"#,
        );
        assert_eq!(evs, vec![RunEvent::ThinkingDelta { delta: "흠".into() }]);
    }

    #[test]
    fn status_frames_carry_their_message() {
        let evs = parse_fabrix_sse_data(
            r#"{"event_status":"STATUS","status":"SUCCESS","content":"x","event_data":"{\"phase\": \"planning\", \"message\": \"최종 응답을 생성합니다.\"}"}"#,
        );
        assert_eq!(
            evs,
            vec![RunEvent::Status {
                label: "최종 응답을 생성합니다.".into(),
                model: None,
                session_id: None
            }]
        );
    }

    #[test]
    fn terminal_markers_are_silent() {
        assert!(parse_fabrix_sse_data(r#"{"status":"SUCCESS","response_code":"R20000"}"#)
            .is_empty());
        assert!(parse_fabrix_sse_data(
            r#"{"event_status":"CHUNK","content":"","filter_block_reason":{"result_code":"FR-200"}}"#
        )
        .is_empty());
        assert!(parse_fabrix_sse_data("nope").is_empty());
    }

    #[test]
    fn length_and_truncated_flags_report_truncation() {
        let evs = parse_fabrix_sse_data(
            r#"{"event_status":"CHUNK","content":"끝","finish_reason":"length"}"#,
        );
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "끝".into() }, RunEvent::Truncated]);
        assert_eq!(parse_fabrix_sse_data(r#"{"truncated":true}"#), vec![RunEvent::Truncated]);
        assert!(parse_fabrix_sse_data(r#"{"truncated":null,"finish_reason":null}"#).is_empty());
    }

    /// 사내망에서 받은 실제 프레임들. FR-201 은 차단이 아니라 "allowed by the filter" 다.
    #[test]
    fn real_stream_frames_from_the_native_api() {
        let allowed = r#"{"ko":"Default","en":"Default","policy_id":"49","message":"The content was allowed by the filter","result_code":"FR-201","filter_log_id":"1"}"#;
        let think = format!(r#"{{"event_status":"THINK","status":"SUCCESS","content":"생각","filter_block_reason":{allowed}}}"#);
        assert_eq!(parse_fabrix_sse_data(&think), vec![RunEvent::ThinkingDelta { delta: "생각".into() }]);
        let chunk = format!(r#"{{"event_status":"CHUNK","status":"SUCCESS","content":"답","filter_block_reason":{allowed}}}"#);
        assert_eq!(parse_fabrix_sse_data(&chunk), vec![RunEvent::TextDelta { delta: "답".into() }]);
        let marker = r#"{"event_status":"FINAL_ANSWER","status":"SUCCESS","content":"","event_data":"{}","filter_block_reason":{"result_code":"FR-201","message":"allowed"}}"#;
        assert!(parse_fabrix_sse_data(marker).is_empty());
        let end = r#"{"event_status":"CHUNK","status":"SUCCESS","content":"","finish_reason":"stop","response_code":"R20000","truncated":false}"#;
        assert!(parse_fabrix_sse_data(end).is_empty());
    }

    #[test]
    fn filter_block_becomes_an_error() {
        let evs = parse_fabrix_sse_data(
            r#"{"event_status":"CHUNK","content":"","filter_block_reason":{"result_code":"FR-403","ko":"정책 위반"}}"#,
        );
        assert!(matches!(&evs[..], [RunEvent::Error { message }]
            if message.contains("FR-403") && message.contains("정책 위반")));
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
            models: vec![opt("m", "M")],
            ..Default::default()
        };
        let a = detect_fabrix(Some(cfg), false);
        assert!(a.available);
        assert_eq!(a.models_source, "cache");
        assert_eq!(a.models.len(), 1);

        assert_eq!(detect_fabrix(None, false).diagnostic.as_deref(), Some("not-configured"));
    }

    /// 직접 지정 모델은 조회 없이 이긴다 — 목록 조회가 막힌 환경의 탈출구.
    #[test]
    fn custom_models_skip_the_lookup_and_win() {
        let cfg = FabrixConfig {
            endpoint_url: "http://127.0.0.1:1".into(),
            models: vec![opt("cached", "c")],
            custom_models: vec![opt("16", "mine")],
            ..Default::default()
        };
        let a = detect_fabrix(Some(cfg), true);
        assert!(a.available);
        assert_eq!(a.models, vec![opt("16", "mine")]);
        assert_eq!(a.models_source, "custom");
    }

    #[test]
    fn failed_lookup_is_unreachable_but_keeps_the_cache_visible() {
        let cfg = FabrixConfig {
            endpoint_url: "http://127.0.0.1:1".into(),
            models: vec![opt("cached", "c")],
            ..Default::default()
        };
        let a = detect_fabrix(Some(cfg), true);
        assert!(!a.available);
        assert_eq!(a.diagnostic.as_deref(), Some("unreachable"));
        assert_eq!(a.models_source, "cache");
    }

    /// 사내망에서 확인한 실패: 직접 지정 칸에 이름("Glm 5.2")을 적으면 UUID 가 아니라 거절된다.
    /// 아는 목록에 같은 이름이 있으면 id 로 푼다.
    #[test]
    fn custom_model_names_resolve_to_known_ids() {
        let uuid = "019f23a1-46aa-7fa5-a6ab-391127fea7e6";
        let known = vec![opt(uuid, "Glm 5.2"), opt("16", "x")];
        let got = resolve_custom(
            &[opt("Glm 5.2", "Glm 5.2"), opt("glm 5.2", "내 이름"), opt("16", "x"), opt("new", "n")],
            &known,
        );
        assert_eq!(got[0], opt(uuid, "Glm 5.2"));
        assert_eq!(got[1], opt(uuid, "내 이름"));
        assert_eq!(got[2], opt("16", "x"));
        assert_eq!(got[3], opt("new", "n"));

        let cfg = FabrixConfig {
            endpoint_url: "https://f.test".into(),
            models: known.clone(),
            custom_models: vec![opt("Glm 5.2", "Glm 5.2")],
            ..Default::default()
        };
        let (m, src) = effective_models(&cfg, None);
        assert_eq!(src, "custom");
        assert_eq!(m[0].id, uuid);
        assert_eq!(resolve_id("GLM 5.2", &known).as_deref(), Some(uuid));
        assert_eq!(resolve_id("모름", &known), None);
    }

    #[test]
    fn error_bodies_get_a_hint() {
        assert!(with_hint("model_guid, Input should be a valid UUID").contains("UUID 입니다"));
        assert!(with_hint("No matching resource found").contains("API 방식"));
        assert_eq!(with_hint(" 그 밖 "), "그 밖");
    }

    #[test]
    fn chat_body_carries_the_given_system_prompt_and_temperature() {
        let b = chat_body("m-1", "당신은 업무 맥락 분석가입니다.", "질문", 8192, 0.2);
        assert_eq!(b["systemPrompt"], "당신은 업무 맥락 분석가입니다.");
        assert_eq!(b["modelIds"][0], "m-1");
        assert_eq!(b["contents"][0], "질문");
        assert_eq!(b["isStream"], true);
        assert!((b["llmConfig"]["temperature"].as_f64().unwrap() - 0.2).abs() < 1e-6);
    }
}
