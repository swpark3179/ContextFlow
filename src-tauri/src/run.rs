//! AI 실행 엔진.
//!
//! 상주 데몬이나 HTTP 서버는 없다. 실행 1건 = 워커 스레드 1개이며, 그 스레드가 자식
//! 프로세스(로컬 CLI)나 SSE 연결(원격)을 소유하고 정규화된 `RunEvent` 를 채널로 밀어
//! 넣는다. 네 서비스 모두 이 하나의 이벤트 어휘로 수렴한다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;

use crate::agents::{self, AgentKind, PromptFormat, RunCtx, StreamFormat};
use crate::ai_settings;
use crate::resolve::resolve_agent;

/// 실행 중 발생하는 사건. `rename_all_fields` 가 없으면 `sessionId`/`inputTokens` 가
/// snake_case 로 나가 프런트가 조용히 흘린다.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RunEvent {
    Status { label: String, model: Option<String>, session_id: Option<String> },
    TextDelta { delta: String },
    ThinkingDelta { delta: String },
    Usage { input_tokens: Option<u64>, output_tokens: Option<u64> },
    /// 모델이 출력 토큰 상한에 닿아 답변이 **중간에 끊겼다**.
    ///
    /// `Error` 가 아니다 — 스트림은 정상 종료하고 받은 데까지는 쓸 수 있다. 이것이 없으면
    /// 프런트는 잘림과 형식 위반을 구별하지 못해 "형식을 지키세요" 라는 엉뚱한 재질의를
    /// 보내고, 같은 상한에서 똑같이 잘린다.
    Truncated,
    Error { message: String },
    End { code: Option<i32>, status: String },
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    pub agent_id: String,
    pub prompt: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// 출력 토큰 상한. `None` 이면 원격 커넥터의 기본값(`DEFAULT_MAX_TOKENS`)을 쓴다.
    ///
    /// 상한에 닿아 잘리면 닫는 `}` 가 오지 않아 펜스 JSON 이 통째로 버려진다. 로컬 CLI 는
    /// 자체 상한을 쓰므로 이 값을 무시한다.
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

/// 원격 커넥터의 기본 출력 상한. 호출자가 `max_tokens` 를 주지 않았을 때의 값이다.
pub const DEFAULT_MAX_TOKENS: u32 = 8192;

impl RunArgs {
    /// 이 실행에 적용할 출력 토큰 상한.
    pub fn max_tokens_or_default(&self) -> u32 {
        self.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)
    }
}

/// 취소를 위해 살아 있는 실행을 들고 있는다.
#[derive(Default)]
pub struct RunRegistry {
    counter: AtomicU64,
    runs: Mutex<HashMap<String, RunHandle>>,
}

struct RunHandle {
    /// 원격 실행은 자식이 없어 `None` — 취소 플래그만으로 끊는다.
    child: Option<Arc<Mutex<Child>>>,
    canceled: Arc<AtomicBool>,
}

impl RunRegistry {
    pub fn next_id(&self) -> String {
        format!("run-{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }

    pub fn register(&self, id: &str) -> Arc<AtomicBool> {
        let canceled = Arc::new(AtomicBool::new(false));
        self.lock()
            .insert(id.to_string(), RunHandle { child: None, canceled: canceled.clone() });
        canceled
    }

    pub fn attach_child(&self, id: &str, child: Arc<Mutex<Child>>) {
        if let Some(h) = self.lock().get_mut(id) {
            h.child = Some(child);
        }
    }

    pub fn unregister(&self, id: &str) {
        self.lock().remove(id);
    }

    /// 뮤텍스 중독을 흡수한다 — 한 번 poisoned 되면 취소 경로가 영구히 죽는다.
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunHandle>> {
        self.runs.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// 자식 프로세스 트리를 종료한다.
///
/// Windows 에서는 `.cmd` shim 이 node 를 손자로 띄우므로 직접 자식(cmd.exe)만 죽이면
/// 에이전트가 살아남는다.
pub fn kill_tree(child: &Arc<Mutex<Child>>) {
    let mut c = child.lock().unwrap_or_else(PoisonError::into_inner);
    #[cfg(windows)]
    {
        let pid = c.id().to_string();
        let _ = crate::exec::command_for("taskkill", &["/PID", pid.as_str(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = c.kill();
}

/// 자식의 종료를 기다리되 **폴링 사이에 락을 놓는다**.
///
/// `wait()` 를 락을 쥔 채 부르면, 그 사이에 도착한 취소가 `kill_tree` 의 락 획득에서
/// 막힌다 — stdout 을 닫고도 끝나지 않는 자식을 만나면 서로 영원히 기다리게 된다.
fn wait_released(child: &Arc<Mutex<Child>>) -> Option<std::process::ExitStatus> {
    loop {
        {
            let mut c = child.lock().unwrap_or_else(PoisonError::into_inner);
            match c.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// 줄 단위로 읽되 디코딩은 lossy 로 한다.
///
/// `BufRead::lines` 는 UTF-8 이 아닌 바이트 하나에 `Err` 를 내고, 그러면 나머지 응답이
/// 통째로 사라지면서도 실행은 "성공"으로 끝난다.
pub fn stream_lines<R: BufRead>(mut reader: R, mut on_line: impl FnMut(&str)) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                on_line(line.trim_end_matches(['\r', '\n']));
            }
            Err(_) => break,
        }
    }
}

/// Claude `stream-json` 한 줄 → 이벤트들. 알 수 없는 타입·비JSON·빈 줄은 무시한다.
pub fn parse_claude_stream_line(line: &str) -> Vec<RunEvent> {
    let line = line.trim();
    if line.is_empty() {
        return Vec::new();
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") => {
            if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                out.push(RunEvent::Status {
                    label: "init".to_string(),
                    model: v.get("model").and_then(|m| m.as_str()).map(str::to_string),
                    session_id: v
                        .get("session_id")
                        .and_then(|s| s.as_str())
                        .map(str::to_string),
                });
            }
        }
        Some("assistant") => {
            let content = v.get("message").and_then(|m| m.get("content"));
            match content {
                // 방어: content 가 bare string 으로 오는 구현도 받아 준다.
                Some(Value::String(s)) if !s.is_empty() => {
                    out.push(RunEvent::TextDelta { delta: s.clone() })
                }
                Some(Value::Array(blocks)) => {
                    for b in blocks {
                        match b.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                    if !t.is_empty() {
                                        out.push(RunEvent::TextDelta { delta: t.to_string() });
                                    }
                                }
                            }
                            Some("thinking") => {
                                if let Some(t) = b.get("thinking").and_then(|t| t.as_str()) {
                                    if !t.is_empty() {
                                        out.push(RunEvent::ThinkingDelta {
                                            delta: t.to_string(),
                                        });
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        Some("result") => {
            if let Some(u) = v.get("usage") {
                out.push(RunEvent::Usage {
                    input_tokens: u.get("input_tokens").and_then(|x| x.as_u64()),
                    output_tokens: u.get("output_tokens").and_then(|x| x.as_u64()),
                });
            }
        }
        _ => {}
    }
    out
}

/// Codex `exec --json` 스트림 파서.
///
/// **상태를 갖는 이유**: codex 는 델타가 아니라 아이템의 **누적 전문**을 `item.started` →
/// `item.updated` → `item.completed` 로 반복해 보낸다. 그대로 흘리면 같은 문장이 몇 번씩
/// 쌓이므로, 아이템별로 이미 내보낸 길이를 기억해 늘어난 꼬리만 델타로 잘라낸다.
#[derive(Default)]
pub struct CodexStream {
    /// 아이템 id → 이미 내보낸 바이트 수.
    sent: HashMap<String, usize>,
}

impl CodexStream {
    /// 이 아이템에서 아직 안 내보낸 부분. 없으면 `None`.
    fn tail(&mut self, id: &str, full: &str) -> Option<String> {
        let seen = self.sent.entry(id.to_string()).or_insert(0);
        // `get` 이라 문자 경계가 아니어도 패닉하지 않는다. 아이템이 통째로 다시 쓰인
        // 경우(길이가 줄거나 경계가 어긋남)에는 전문을 다시 내보낸다 — 중복이 유실보다 낫다.
        let out = match full.len().cmp(seen) {
            std::cmp::Ordering::Greater => full.get(*seen..).unwrap_or(full).to_string(),
            _ => return None,
        };
        *seen = full.len();
        Some(out).filter(|s| !s.is_empty())
    }

    /// JSONL 한 줄 → 이벤트들. 알 수 없는 타입·비JSON·빈 줄은 무시한다.
    pub fn parse_line(&mut self, line: &str) -> Vec<RunEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let mut out = Vec::new();
        match v.get("type").and_then(|t| t.as_str()) {
            Some("thread.started") => out.push(RunEvent::Status {
                label: "init".to_string(),
                model: None,
                session_id: v.get("thread_id").and_then(|s| s.as_str()).map(str::to_string),
            }),
            Some("item.started" | "item.updated" | "item.completed") => {
                let item = match v.get("item") {
                    Some(i) => i,
                    None => return out,
                };
                let id = item.get("id").and_then(|x| x.as_str()).unwrap_or("item");
                let text = item.get("text").and_then(|x| x.as_str()).unwrap_or_default();
                match item.get("type").and_then(|t| t.as_str()) {
                    Some("agent_message") => {
                        if let Some(delta) = self.tail(id, text) {
                            out.push(RunEvent::TextDelta { delta });
                        }
                    }
                    Some("reasoning") => {
                        if let Some(delta) = self.tail(id, text) {
                            out.push(RunEvent::ThinkingDelta { delta });
                        }
                    }
                    // 명령 실행 · 파일 변경 같은 도구 아이템은 답변 본문이 아니다.
                    // 오류 아이템도 여기서는 흘리지 않는다 — 아래 주석 참고.
                    _ => {}
                }
            }
            Some("turn.completed") => {
                if let Some(u) = v.get("usage") {
                    out.push(RunEvent::Usage {
                        input_tokens: u.get("input_tokens").and_then(|x| x.as_u64()),
                        output_tokens: u.get("output_tokens").and_then(|x| x.as_u64()),
                    });
                }
            }
            Some("turn.failed") => {
                let message = v
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Codex 실행이 실패했습니다.")
                    .to_string();
                out.push(RunEvent::Error { message });
            }
            // 최상위 `error` 와 `error` 아이템은 **재시도 중 알림**이다("Reconnecting… 2/5",
            // 전송 방식 폴백 등). codex 는 그러고도 성공으로 끝나는 경우가 많으므로 오류로
            // 올리지 않는다 — 최종 실패는 `turn.failed` 와 종료 코드가 말한다.
            _ => {}
        }
        out
    }
}

/// 실행 한 건을 **호출 스레드에서 끝까지** 수행한다. 종료 상태
/// (`succeeded`/`failed`/`canceled`)를 돌려준다.
///
/// `on_child` 는 로컬 실행에서 자식이 뜬 직후 한 번 호출된다 — 호출부가 취소를 위해
/// 핸들을 붙잡을 수 있도록. 원격 실행에서는 호출되지 않는다(취소 플래그로 끊는다).
pub fn execute_blocking(
    args: &RunArgs,
    canceled: &Arc<AtomicBool>,
    on_child: &mut dyn FnMut(Arc<Mutex<Child>>),
    on_event: &mut dyn FnMut(RunEvent),
) -> String {
    let def = match agents::find(&args.agent_id) {
        Some(d) => d,
        None => {
            on_event(RunEvent::Error {
                message: format!("알 수 없는 AI 서비스입니다: {}", args.agent_id),
            });
            return "failed".to_string();
        }
    };

    if def.kind == AgentKind::Remote {
        let result = match def.id {
            "aipro" => crate::aipro::run_blocking(args, canceled, on_event),
            "fabrix" => crate::fabrix::run_blocking(args, canceled, on_event),
            other => Err(format!("알 수 없는 원격 서비스입니다: {other}")),
        };
        return match result {
            Ok(status) => status,
            Err(message) => {
                on_event(RunEvent::Error { message });
                "failed".to_string()
            }
        };
    }

    let run = match def.run.as_ref() {
        Some(r) => r,
        None => {
            on_event(RunEvent::Error {
                message: format!("실행할 수 없는 서비스입니다: {}", def.id),
            });
            return "failed".to_string();
        }
    };

    let config_dir = match crate::app_home() {
        Ok(d) => d,
        Err(e) => {
            on_event(RunEvent::Error { message: e });
            return "failed".to_string();
        }
    };
    let custom = ai_settings::load(&config_dir).agent_custom_bin(&args.agent_id);
    let resolved = match resolve_agent(def, custom.as_deref()) {
        Some(r) => r,
        None => {
            on_event(RunEvent::Error {
                message: format!(
                    "{} 실행 파일을 찾지 못했습니다. 설정에서 경로를 지정하세요.",
                    def.name
                ),
            });
            return "failed".to_string();
        }
    };

    let built = (run.build_args)(&RunCtx {
        model: args.model.as_deref(),
        system_prompt: &args.system_prompt,
        session_id: args.session_id.as_deref(),
    });

    let mut cmd = crate::exec::command_for(&resolved.path, &built);
    cmd.current_dir(&args.cwd);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // 사용자가 이미 잡아 둔 값은 앱이 덮어쓰지 않는다.
    for (k, v) in run.env {
        if std::env::var_os(k).is_none() {
            cmd.env(k, v);
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            on_event(RunEvent::Error {
                message: format!("{} 실행에 실패했습니다: {e}", def.name),
            });
            return "failed".to_string();
        }
    };

    // 자식 락을 잡지 않고 읽기 위해 파이프를 미리 떼어 낸다.
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let child = Arc::new(Mutex::new(child));
    on_child(child.clone());

    if let Some(mut si) = stdin {
        match run.prompt_format {
            PromptFormat::ClaudeJson => {
                let msg = serde_json::json!({
                    "type": "user",
                    "message": { "role": "user", "content": args.prompt }
                });
                let _ = writeln!(si, "{}", serde_json::to_string(&msg).unwrap_or_default());
            }
            PromptFormat::Plain => {
                let _ = writeln!(si, "{}", args.prompt);
            }
        }
        // si 가 여기서 drop 되며 stdin 이 닫힌다 = 턴의 끝.
    }

    // stderr 는 별도 스레드로 흘려보낸다. 안 읽으면 파이프가 차서 자식이 멈춘다.
    let err_handle = std::thread::spawn(move || {
        let mut collected = String::new();
        if let Some(se) = stderr {
            stream_lines(BufReader::new(se), |l| {
                if collected.len() < 4096 {
                    collected.push_str(l);
                    collected.push('\n');
                }
            });
        }
        collected
    });

    if let Some(so) = stdout {
        let reader = BufReader::new(so);
        match run.stream_format {
            StreamFormat::ClaudeStreamJson => stream_lines(reader, |line| {
                for ev in parse_claude_stream_line(line) {
                    on_event(ev);
                }
            }),
            StreamFormat::CodexJsonl => {
                let mut stream = CodexStream::default();
                stream_lines(reader, |line| {
                    for ev in stream.parse_line(line) {
                        on_event(ev);
                    }
                });
            }
        }
    }

    let status = wait_released(&child);
    let stderr_text = err_handle.join().unwrap_or_default();

    if canceled.load(Ordering::Relaxed) {
        return "canceled".to_string();
    }
    let code = status.and_then(|s| s.code());
    if code == Some(0) {
        "succeeded".to_string()
    } else {
        let detail = stderr_text.trim();
        on_event(RunEvent::Error {
            message: if detail.is_empty() {
                format!("{} 실행이 코드 {:?} 로 끝났습니다.", def.name, code)
            } else {
                detail.to_string()
            },
        });
        "failed".to_string()
    }
}

/// 단건 실행. `runId` 를 즉시 반환하고 워커 스레드에서 스트리밍한다.
#[tauri::command]
pub fn run_agent(
    app: tauri::AppHandle,
    args: RunArgs,
    on_event: Channel<RunEvent>,
) -> Result<String, String> {
    use tauri::Manager;

    // 빈 값은 전용 작업 폴더로 해석한다.
    let mut args = args;
    args.cwd = crate::resolve_cwd(&args.cwd)?;

    let registry = app.state::<RunRegistry>();
    let run_id = registry.next_id();
    let canceled = registry.register(&run_id);

    let app_handle = app.clone();
    let id = run_id.clone();
    std::thread::spawn(move || {
        let registry = app_handle.state::<RunRegistry>();
        let mut attach = |c: Arc<Mutex<Child>>| registry.attach_child(&id, c);
        let mut emit = |ev: RunEvent| {
            let _ = on_event.send(ev);
        };
        let status = execute_blocking(&args, &canceled, &mut attach, &mut emit);
        registry.unregister(&id);
        let _ = on_event.send(RunEvent::End { code: None, status });
    });

    Ok(run_id)
}

#[tauri::command]
pub fn cancel_run(registry: tauri::State<RunRegistry>, run_id: String) -> Result<(), String> {
    let runs = registry.lock();
    if let Some(h) = runs.get(&run_id) {
        h.canceled.store(true, Ordering::Relaxed);
        if let Some(child) = &h.child {
            kill_tree(child);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_line_yields_model_and_session() {
        let evs = parse_claude_stream_line(
            r#"{"type":"system","subtype":"init","model":"claude-sonnet-5","session_id":"abc"}"#,
        );
        assert_eq!(
            evs,
            vec![RunEvent::Status {
                label: "init".into(),
                model: Some("claude-sonnet-5".into()),
                session_id: Some("abc".into()),
            }]
        );
    }

    #[test]
    fn assistant_blocks_split_into_text_and_thinking() {
        let evs = parse_claude_stream_line(
            r#"{"type":"assistant","message":{"content":[
                 {"type":"thinking","thinking":"음..."},
                 {"type":"text","text":"같은 패턴입니다"},
                 {"type":"tool_use","name":"Bash"}]}}"#,
        );
        assert_eq!(
            evs,
            vec![
                RunEvent::ThinkingDelta { delta: "음...".into() },
                RunEvent::TextDelta { delta: "같은 패턴입니다".into() },
            ]
        );
    }

    #[test]
    fn bare_string_content_is_accepted() {
        let evs =
            parse_claude_stream_line(r#"{"type":"assistant","message":{"content":"안녕"}}"#);
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "안녕".into() }]);
    }

    #[test]
    fn result_line_yields_usage() {
        let evs = parse_claude_stream_line(
            r#"{"type":"result","usage":{"input_tokens":10,"output_tokens":20}}"#,
        );
        assert_eq!(
            evs,
            vec![RunEvent::Usage { input_tokens: Some(10), output_tokens: Some(20) }]
        );
    }

    #[test]
    fn junk_lines_are_ignored() {
        assert!(parse_claude_stream_line("").is_empty());
        assert!(parse_claude_stream_line("not json").is_empty());
        assert!(parse_claude_stream_line(r#"{"type":"unknown"}"#).is_empty());
    }

    /// codex 는 아이템의 누적 전문을 반복해 보낸다 — 늘어난 꼬리만 나가야 한다.
    #[test]
    fn codex_item_updates_emit_only_the_new_tail() {
        let mut s = CodexStream::default();
        assert_eq!(
            s.parse_line(
                r#"{"type":"item.started","item":{"id":"i0","type":"agent_message","text":"같은"}}"#
            ),
            vec![RunEvent::TextDelta { delta: "같은".into() }]
        );
        assert_eq!(
            s.parse_line(
                r#"{"type":"item.updated","item":{"id":"i0","type":"agent_message","text":"같은 패턴"}}"#
            ),
            vec![RunEvent::TextDelta { delta: " 패턴".into() }]
        );
        // 같은 전문이 다시 와도 두 번 쌓이지 않는다.
        assert!(s
            .parse_line(
                r#"{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"같은 패턴"}}"#
            )
            .is_empty());
    }

    #[test]
    fn codex_separates_reasoning_from_answer_and_tracks_items_apart() {
        let mut s = CodexStream::default();
        assert_eq!(
            s.parse_line(
                r#"{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"음..."}}"#
            ),
            vec![RunEvent::ThinkingDelta { delta: "음...".into() }]
        );
        // 아이템 id 가 다르면 진행도도 따로 센다.
        assert_eq!(
            s.parse_line(
                r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"음..."}}"#
            ),
            vec![RunEvent::TextDelta { delta: "음...".into() }]
        );
        // 도구 아이템은 답변 본문이 아니다.
        assert!(s
            .parse_line(
                r#"{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"ls"}}"#
            )
            .is_empty());
    }

    #[test]
    fn codex_thread_and_usage_and_failure_map_through() {
        let mut s = CodexStream::default();
        assert_eq!(
            s.parse_line(r#"{"type":"thread.started","thread_id":"t-1"}"#),
            vec![RunEvent::Status {
                label: "init".into(),
                model: None,
                session_id: Some("t-1".into()),
            }]
        );
        assert_eq!(
            s.parse_line(
                r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":20}}"#
            ),
            vec![RunEvent::Usage { input_tokens: Some(10), output_tokens: Some(20) }]
        );
        assert_eq!(
            s.parse_line(r#"{"type":"turn.failed","error":{"message":"stream disconnected"}}"#),
            vec![RunEvent::Error { message: "stream disconnected".into() }]
        );
    }

    /// 재연결 알림은 오류가 아니다 — 그러고도 성공으로 끝나는 실행에서 이것을 오류로
    /// 올리면 멀쩡한 추천에 실패 메시지가 붙는다.
    #[test]
    fn codex_transient_notices_are_not_errors() {
        let mut s = CodexStream::default();
        assert!(s.parse_line(r#"{"type":"error","message":"Reconnecting... 2/5"}"#).is_empty());
        assert!(s
            .parse_line(
                r#"{"type":"item.completed","item":{"id":"i0","type":"error","message":"Falling back to HTTPS"}}"#
            )
            .is_empty());
        assert!(s.parse_line(r#"{"type":"turn.started"}"#).is_empty());
        assert!(s.parse_line("").is_empty());
        assert!(s.parse_line("not json").is_empty());
    }

    #[test]
    fn stream_lines_survives_invalid_utf8() {
        // 잘못된 바이트가 낀 줄 다음 줄이 살아 있어야 한다.
        let data: Vec<u8> = b"first\n\xff\xfe bad\nlast\n".to_vec();
        let mut seen = Vec::new();
        stream_lines(BufReader::new(&data[..]), |l| seen.push(l.to_string()));
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0], "first");
        assert_eq!(seen[2], "last");
    }

    /// 상한을 주지 않으면 원격 커넥터 기본값을 쓴다.
    #[test]
    fn max_tokens_falls_back_to_the_default() {
        let mut a = RunArgs {
            agent_id: "aipro".into(),
            prompt: "q".into(),
            cwd: String::new(),
            system_prompt: String::new(),
            model: None,
            session_id: None,
            max_tokens: None,
        };
        assert_eq!(a.max_tokens_or_default(), DEFAULT_MAX_TOKENS);
        a.max_tokens = Some(16_384);
        assert_eq!(a.max_tokens_or_default(), 16_384);
    }
}
