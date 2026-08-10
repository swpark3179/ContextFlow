//! AI 서비스 정의와 레지스트리.
//!
//! 에이전트별 데이터(`AgentDef`)를 여기 모으고, `detect.rs`/`run.rs` 의 파이프라인은 그
//! 정의를 받아 동작한다. 새 서비스를 붙이려면 `AGENT_DEFS` 에 항목 하나를 더하면 된다.

use std::time::Duration;

/// `run.rs` 가 stdout 을 어느 파서로 읽을지.
#[derive(Clone, Copy)]
pub enum StreamFormat {
    /// Claude Code 의 `--output-format stream-json` (한 줄에 JSON 객체 하나).
    ClaudeStreamJson,
    /// Codex CLI 의 `exec --json` (thread/item 이벤트 JSONL).
    CodexJsonl,
}

/// 프롬프트를 stdin 으로 넘길 때의 프레이밍.
#[derive(Clone, Copy)]
pub enum PromptFormat {
    /// Claude `stream-json` 사용자 메시지 한 줄.
    ClaudeJson,
    /// 평문 그대로. Codex 는 프롬프트 인자가 `-` 면 stdin 을 그대로 읽는다.
    Plain,
}

/// 한 번의 실행에 필요한 문맥.
pub struct RunCtx<'a> {
    /// 선택한 모델 id. `None`/`"default"` 면 CLI 설정을 따른다.
    pub model: Option<&'a str>,
    /// 시스템 프롬프트.
    pub system_prompt: &'a str,
    /// 세션 id(claude 는 클라이언트가 민팅한 UUID).
    pub session_id: Option<&'a str>,
}

/// 에이전트를 어떻게 실행할지.
pub struct RunSpec {
    pub build_args: fn(&RunCtx) -> Vec<String>,
    pub prompt_format: PromptFormat,
    pub stream_format: StreamFormat,
    /// 자식에 추가로 넣을 환경변수. 사용자가 이미 설정한 키는 덮어쓰지 않는다.
    pub env: &'static [(&'static str, &'static str)],
}

/// 전송 계층. `Local` 은 파일시스템에서 해석해 자식 프로세스로 띄우고, `Remote` 는
/// HTTP API 라 resolve/spawn 을 건너뛰고 `aipro.rs`/`fabrix.rs` 로 간다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentKind {
    Local,
    Remote,
}

pub struct AgentDef {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: AgentKind,
    /// 찾아볼 바이너리 이름, 순서대로.
    pub bin_candidates: &'static [&'static str],
    /// 실행 파일 경로를 덮어쓰는 환경변수.
    pub env_var: Option<&'static str>,
    /// `%USERPROFILE%` 기준 추가 검색 하위경로.
    pub extra_search_subdirs: &'static [&'static str],
    pub version_timeout: Duration,
    /// 모델 나열 명령이 없을 때 쓰는 정적 카탈로그. `(id, label)`.
    /// **로컬만** 합성 `default` 를 앞에 붙인다(`detect::fallback_from`) — 원격 채팅 API 는
    /// 실제 모델 id 를 요구한다.
    pub fallback_models: &'static [(&'static str, &'static str)],
    pub run: Option<RunSpec>,
}

const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

/// Claude 실행 환경변수: 도구 명령 타임아웃 상향. 사용자가 이미 값을 잡아 두었으면
/// 앱이 덮어쓰지 않는다(`run.rs` 의 env 병합 참고).
const CLAUDE_ENV: &[(&str, &str)] = &[
    ("BASH_DEFAULT_TIMEOUT_MS", "300000"),
    ("BASH_MAX_TIMEOUT_MS", "1200000"),
];

/// 이 앱은 모델의 **텍스트 답변만** 필요하다. 도구를 전부 막으면 권한 프롬프트가
/// 뜰 일이 없어 `--permission-mode bypassPermissions` 같은 우회가 필요 없다.
const CLAUDE_DISALLOWED_TOOLS: &[&str] = &[
    "Bash",
    "Edit",
    "Write",
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "NotebookEdit",
    "Task",
];

/// 모델이 비어 있거나 `"default"` 가 아니면 `--model <m>` 을 붙인다.
fn push_model(a: &mut Vec<String>, model: Option<&str>) {
    if let Some(m) = model {
        if !m.is_empty() && m != "default" {
            a.push("--model".to_string());
            a.push(m.to_string());
        }
    }
}

/// Claude Code 헤드리스 호출.
///
/// `--system-prompt` 는 기본 시스템 프롬프트를 **교체**한다 — 코딩 에이전트 정체성이
/// 섞이지 않은 순수한 업무 맥락 분석을 얻는 것이 목적이다.
fn claude_build_args(ctx: &RunCtx) -> Vec<String> {
    let mut a = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--strict-mcp-config".to_string(),
        "--system-prompt".to_string(),
        ctx.system_prompt.to_string(),
        "--disallowedTools".to_string(),
    ];
    a.extend(CLAUDE_DISALLOWED_TOOLS.iter().map(|t| t.to_string()));
    push_model(&mut a, ctx.model);
    if let Some(sid) = ctx.session_id {
        if !sid.is_empty() {
            a.push("--session-id".to_string());
            a.push(sid.to_string());
        }
    }
    a
}

/// `-c key=value` 의 value 는 TOML 로 파싱된다. JSON 문자열 리터럴의 이스케이프 규칙
/// (`\n` · `\t` · `\"` · `\\` · `\uXXXX`)이 TOML 기본 문자열의 부분집합이라 그대로 쓴다 —
/// 프롬프트에는 줄바꿈과 따옴표가 반드시 들어간다.
fn toml_string(raw: &str) -> String {
    serde_json::to_string(raw).unwrap_or_else(|_| "\"\"".to_string())
}

/// Codex CLI 헤드리스 호출 (`codex exec`).
///
/// Claude 와 다른 점 셋:
/// - 시스템 프롬프트 플래그가 없다. 기본 지시를 **교체**하는 경로는 `-c base_instructions`
///   하나뿐이라(= claude 의 `--system-prompt`) 그쪽으로 넣는다. 프롬프트에 얹어 보내면
///   코딩 에이전트 정체성이 그대로 남는다.
/// - 도구를 개별로 끄는 플래그가 없다. 읽기 전용 샌드박스 + 승인 안 함으로 부작용을 막고
///   (승인 프롬프트가 뜨면 비대화형 실행이 그대로 멈춘다) 웹 검색만 명시적으로 끈다.
/// - 프롬프트는 `-` 를 주고 stdin 으로 넘긴다.
///
/// `--ephemeral` 은 세션 파일을 남기지 않는다. 추천 1건 = 새 실행이라 재개할 세션이 없고,
/// 매 추천마다 세션 파일이 쌓이는 것을 막는다.
fn codex_build_args(ctx: &RunCtx) -> Vec<String> {
    let mut a = vec![
        "exec".to_string(),
        "--json".to_string(),
        // 작업 폴더(`~/.contextflow/runs/current`)는 git 저장소가 아니다.
        "--skip-git-repo-check".to_string(),
        "--ephemeral".to_string(),
        "--color".to_string(),
        "never".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "-c".to_string(),
        "approval_policy=\"never\"".to_string(),
        "-c".to_string(),
        "tools.web_search=false".to_string(),
    ];
    if !ctx.system_prompt.trim().is_empty() {
        a.push("-c".to_string());
        a.push(format!("base_instructions={}", toml_string(ctx.system_prompt)));
    }
    push_model(&mut a, ctx.model);
    // 세션 id 는 받지 않는다 — codex 는 재개가 `exec resume <id>` 라는 별도 경로다.
    a.push("-".to_string());
    a
}

/// 이 앱이 다루는 AI 서비스, 화면 표시 순서대로.
pub static AGENT_DEFS: [AgentDef; 4] = [
    AgentDef {
        id: "claude",
        name: "Claude Code",
        kind: AgentKind::Local,
        bin_candidates: &["claude"],
        env_var: Some("CLAUDE_BIN"),
        extra_search_subdirs: &[],
        version_timeout: VERSION_TIMEOUT,
        // 별칭을 먼저 둔다(CLI 가 최신 세대로 해석하므로 낡지 않는다). 뒤의 고정 id 는
        // 현행 세대이며 라인업이 바뀌면 갱신한다.
        fallback_models: &[
            ("opus", "Opus (최신)"),
            ("sonnet", "Sonnet (최신)"),
            ("haiku", "Haiku (최신)"),
            ("claude-opus-4-8", "Claude Opus 4.8"),
            ("claude-sonnet-5", "Claude Sonnet 5"),
            ("claude-haiku-4-5", "Claude Haiku 4.5"),
        ],
        run: Some(RunSpec {
            build_args: claude_build_args,
            prompt_format: PromptFormat::ClaudeJson,
            stream_format: StreamFormat::ClaudeStreamJson,
            env: CLAUDE_ENV,
        }),
    },
    AgentDef {
        // Codex CLI — claude 와 같은 로컬 CLI 경로(resolve → spawn → stdout 스트림)를 타고
        // 스트림 형식과 프롬프트 전달만 다르다(`codex_build_args` 참고).
        id: "codex",
        name: "Codex CLI",
        kind: AgentKind::Local,
        bin_candidates: &["codex"],
        env_var: Some("CODEX_BIN"),
        extra_search_subdirs: &[],
        version_timeout: VERSION_TIMEOUT,
        // claude 와 달리 최신 세대를 가리키는 별칭이 없다 — 그 자리를 합성 `default`
        // (= CLI 설정을 따른다, `detect::fallback_from`)가 대신한다. 아래는 라인업이
        // 바뀌면 갱신하는 현행 고정 id 다.
        fallback_models: &[
            ("gpt-5.5-codex", "GPT-5.5 Codex"),
            ("gpt-5.5", "GPT-5.5"),
            ("gpt-5.4-codex", "GPT-5.4 Codex"),
            ("gpt-5.4-mini", "GPT-5.4 Mini"),
            ("gpt-5.2-codex", "GPT-5.2 Codex"),
        ],
        run: Some(RunSpec {
            build_args: codex_build_args,
            prompt_format: PromptFormat::Plain,
            stream_format: StreamFormat::CodexJsonl,
            env: &[],
        }),
    },
    AgentDef {
        // 사내 AI Pro — OpenAI 호환 원격 HTTP 서비스. CLI 필드는 비어 있고 탐지·실행이
        // `aipro.rs` 로 간다. 모델은 항상 정적 카탈로그다(게이트웨이에 값싼 헬스
        // 엔드포인트가 없어, 탐지 때마다 조회하면 매번 토큰을 태우게 된다).
        id: "aipro",
        name: "AI Pro",
        kind: AgentKind::Remote,
        bin_candidates: &[],
        env_var: None,
        extra_search_subdirs: &[],
        version_timeout: VERSION_TIMEOUT,
        fallback_models: &[
            ("glm-5.2", "GLM-5.2"),
            ("qwen3.6-27b", "Qwen3.6-27b"),
            ("gpt-oss-120b", "Gpt-Oss-120b"),
        ],
        run: None,
    },
    AgentDef {
        // FabriX — 원격 HTTP API. 모델 목록은 라이브 조회 전용이라 정적 폴백이 없다.
        id: "fabrix",
        name: "FabriX",
        kind: AgentKind::Remote,
        bin_candidates: &[],
        env_var: None,
        extra_search_subdirs: &[],
        version_timeout: VERSION_TIMEOUT,
        fallback_models: &[],
        run: None,
    },
];

pub fn all() -> &'static [AgentDef] {
    &AGENT_DEFS
}

pub fn find(id: &str) -> Option<&'static AgentDef> {
    AGENT_DEFS.iter().find(|d| d.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(model: Option<&'a str>, sid: Option<&'a str>) -> RunCtx<'a> {
        RunCtx { model, system_prompt: "당신은 업무 맥락 분석가입니다.", session_id: sid }
    }

    #[test]
    fn registry_ids_are_unique_and_findable() {
        let ids: Vec<&str> = AGENT_DEFS.iter().map(|d| d.id).collect();
        assert_eq!(ids, vec!["claude", "codex", "aipro", "fabrix"]);
        for id in &ids {
            assert!(find(id).is_some());
        }
        assert!(find("gemini").is_none());
    }

    #[test]
    fn local_agents_are_runnable_and_remote_ones_are_not() {
        for id in ["claude", "codex"] {
            let d = find(id).unwrap();
            assert_eq!(d.kind, AgentKind::Local);
            assert!(d.run.is_some());
            assert!(!d.bin_candidates.is_empty());
        }
        for id in ["aipro", "fabrix"] {
            let d = find(id).unwrap();
            assert_eq!(d.kind, AgentKind::Remote);
            assert!(d.run.is_none());
            assert!(d.bin_candidates.is_empty());
        }
    }

    #[test]
    fn claude_args_carry_system_prompt_and_block_tools() {
        let a = claude_build_args(&ctx(None, None));
        let sys = a.iter().position(|s| s == "--system-prompt").unwrap();
        assert_eq!(a[sys + 1], "당신은 업무 맥락 분석가입니다.");
        assert!(a.contains(&"--disallowedTools".to_string()));
        assert!(a.contains(&"Bash".to_string()));
        // 권한 우회는 쓰지 않는다.
        assert!(!a.iter().any(|s| s == "--permission-mode"));
        // 모델·세션 미지정이면 해당 플래그가 아예 없다.
        assert!(!a.iter().any(|s| s == "--model" || s == "--session-id"));
    }

    #[test]
    fn claude_args_include_model_and_session_when_given() {
        let a = claude_build_args(&ctx(Some("sonnet"), Some("uuid-1")));
        let m = a.iter().position(|s| s == "--model").unwrap();
        assert_eq!(a[m + 1], "sonnet");
        let s = a.iter().position(|s| s == "--session-id").unwrap();
        assert_eq!(a[s + 1], "uuid-1");

        // "default" 는 CLI 설정을 따르라는 뜻이라 플래그를 붙이지 않는다.
        assert!(!claude_build_args(&ctx(Some("default"), None)).iter().any(|s| s == "--model"));
    }

    /// 시스템 프롬프트는 `-c base_instructions` 로만 들어간다. 이것이 빠지면 코딩 에이전트
    /// 정체성이 그대로 남아 답변이 업무 맥락 분석이 아니게 된다.
    #[test]
    fn codex_args_replace_base_instructions_and_read_stdin() {
        let a = codex_build_args(&ctx(None, None));
        assert_eq!(a[0], "exec");
        assert!(a.contains(&"--json".to_string()));
        // 프롬프트는 stdin 이므로 `-` 가 **마지막** 인자여야 한다.
        assert_eq!(a.last().unwrap(), "-");
        assert!(a.contains(&"base_instructions=\"당신은 업무 맥락 분석가입니다.\"".to_string()));
        // 부작용 차단: 읽기 전용 샌드박스 + 승인 프롬프트 없음(비대화형이라 멈춘다).
        assert!(a.contains(&"read-only".to_string()));
        assert!(a.contains(&"approval_policy=\"never\"".to_string()));
        // 모델 미지정이면 플래그가 아예 없다.
        assert!(!a.iter().any(|s| s == "--model"));
    }

    #[test]
    fn codex_args_include_model_but_never_a_session_id() {
        let a = codex_build_args(&ctx(Some("gpt-5.5-codex"), Some("uuid-1")));
        let m = a.iter().position(|s| s == "--model").unwrap();
        assert_eq!(a[m + 1], "gpt-5.5-codex");
        // 재개는 `exec resume` 라는 별도 경로다 — 세션 id 를 흘려 넣으면 안 된다.
        assert!(!a.iter().any(|s| s == "uuid-1"));
        assert!(!codex_build_args(&ctx(Some("default"), None)).iter().any(|s| s == "--model"));
    }

    /// 줄바꿈·따옴표가 든 프롬프트가 TOML 값으로 깨지지 않아야 한다 — 깨지면 codex 가
    /// 설정 파싱에서 죽거나 지시가 통째로 리터럴로 들어간다.
    #[test]
    fn base_instructions_value_is_a_valid_toml_string() {
        let raw = "첫 줄\n\"인용\"\t끝\\";
        assert_eq!(toml_string(raw), "\"첫 줄\\n\\\"인용\\\"\\t끝\\\\\"");

        let a = codex_build_args(&RunCtx {
            model: None,
            system_prompt: raw,
            session_id: None,
        });
        let c = a.iter().position(|s| s.starts_with("base_instructions=")).unwrap();
        assert_eq!(a[c - 1], "-c");
    }

    /// 시스템 프롬프트가 없으면 기본 지시를 빈 문자열로 **덮어쓰지 않는다**.
    #[test]
    fn empty_system_prompt_leaves_base_instructions_alone() {
        let a = codex_build_args(&RunCtx { model: None, system_prompt: "  ", session_id: None });
        assert!(!a.iter().any(|s| s.starts_with("base_instructions=")));
    }
}
