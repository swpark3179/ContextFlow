//! OpenAI 호환 대화 API 의 요청 본문과 SSE 조각 파서.
//!
//! 지금 이것을 쓰는 곳은 FabriX 의 LLM 게이트웨이 방식(`fabrix.rs`, vLLM)뿐이다. 예전에는
//! AI Pro 커넥터가 같은 것을 갖고 있었고 게이트웨이가 빌려 썼는데, AI Pro 를 걷어 내면서
//! 공용 부분만 여기로 옮겼다 — 헤더 · 경로 · 모델 고르기는 커넥터마다 다르고 본문과
//! 스트림 모양만 같다.

use serde_json::Value;

use crate::run::RunEvent;

/// 호출자가 온도를 정하지 않았을 때의 값. 추천처럼 판단을 요구하는 호출에 맞춘 기본이다.
pub(crate) const DEFAULT_TEMPERATURE: f32 = 0.4;

/// 대화 요청 본문.
///
/// `include_usage` 는 끈다(FabriX 게이트웨이). vLLM 은 요청하지 않아도 마지막에 usage 조각을
/// 보내고, 오래된 vLLM 은 모르는 필드에 400 을 줄 수 있다.
pub(crate) fn openai_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    max_tokens: u32,
    temperature: f32,
    include_usage: bool,
) -> Value {
    let system = if system_prompt.trim().is_empty() {
        "사용자 질문에 정확하고 도움이 되게 답합니다.".to_string()
    } else {
        system_prompt.to_string()
    };
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": prompt },
        ],
        "stream": true,
        "temperature": temperature,
        "max_tokens": max_tokens
    });
    if include_usage {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    body
}

/// `chat.completion.chunk` 한 조각 → 이벤트들. `label` 은 오류 문구에 쓸 서비스 이름이다 —
/// 게이트웨이의 오류가 엉뚱한 서비스 이름으로 뜨면 사용자는 엉뚱한 설정을 고친다.
pub(crate) fn parse_openai_sse(data: &str, label: &str) -> Vec<RunEvent> {
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
            .map(str::to_string)
            .unwrap_or_else(|| format!("{label} 오류"));
        return vec![RunEvent::Error { message: msg }];
    }

    if let Some(delta) = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"))
    {
        // glm 계열은 추론 토큰을 별도 필드로 흘린다.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(data: &str) -> Vec<RunEvent> {
        parse_openai_sse(data, "FabriX")
    }

    #[test]
    fn content_delta_becomes_text() {
        let evs = parse(r#"{"choices":[{"delta":{"content":"안녕"}}]}"#);
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "안녕".into() }]);
    }

    #[test]
    fn reasoning_delta_becomes_thinking() {
        let evs = parse(r#"{"choices":[{"delta":{"reasoning":"흠"}}]}"#);
        assert_eq!(evs, vec![RunEvent::ThinkingDelta { delta: "흠".into() }]);
        let evs = parse(r#"{"choices":[{"delta":{"reasoning_content":"음"}}]}"#);
        assert_eq!(evs, vec![RunEvent::ThinkingDelta { delta: "음".into() }]);
    }

    #[test]
    fn done_and_role_only_chunks_are_silent() {
        assert!(parse("[DONE]").is_empty());
        assert!(parse(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#).is_empty());
        assert!(parse("").is_empty());
        assert!(parse("not json").is_empty());
    }

    #[test]
    fn usage_and_error_map_through() {
        let evs = parse(r#"{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}"#);
        assert_eq!(evs, vec![RunEvent::Usage { input_tokens: Some(5), output_tokens: Some(7) }]);
        let evs = parse(r#"{"error":{"message":"boom"}}"#);
        assert_eq!(evs, vec![RunEvent::Error { message: "boom".into() }]);
    }

    #[test]
    fn error_label_follows_the_service() {
        let evs = parse(r#"{"error":{}}"#);
        assert_eq!(evs, vec![RunEvent::Error { message: "FabriX 오류".into() }]);
    }

    /// 상한에 닿아 끊긴 응답은 오류가 아니라 `Truncated` 다.
    #[test]
    fn finish_reason_length_reports_truncation() {
        let evs = parse(r#"{"choices":[{"delta":{"content":"…"},"finish_reason":"length"}]}"#);
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "…".to_string() }, RunEvent::Truncated]);
    }

    /// 정상 종료는 잘림이 아니다 — 여기서 오판하면 멀쩡한 응답에도 축소 재질의가 붙는다.
    #[test]
    fn normal_stop_is_not_truncation() {
        let evs = parse(r#"{"choices":[{"delta":{"content":"끝"},"finish_reason":"stop"}]}"#);
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "끝".to_string() }]);
    }

    #[test]
    fn body_carries_system_prompt_ceiling_and_temperature() {
        let b = openai_body("16", "당신은 업무 맥락 분석가입니다.", "질문", 8192, 0.2, false);
        assert_eq!(b["messages"][0]["role"], "system");
        assert_eq!(b["messages"][0]["content"], "당신은 업무 맥락 분석가입니다.");
        assert_eq!(b["messages"][1]["content"], "질문");
        assert_eq!(b["max_tokens"], 8192);
        assert!((b["temperature"].as_f64().unwrap() - 0.2).abs() < 1e-6);
        // usage 요청은 켠 쪽에만 실린다 — 오래된 vLLM 은 모르는 필드를 400 으로 거절한다.
        assert!(b.get("stream_options").is_none());
        assert_eq!(openai_body("m", "", "q", 100, 0.4, true)["stream_options"]["include_usage"], true);
    }

    #[test]
    fn empty_system_prompt_gets_a_neutral_default() {
        let b = openai_body("m", "  ", "q", 100, 0.4, false);
        assert!(!b["messages"][0]["content"].as_str().unwrap().trim().is_empty());
    }
}
