/**
 * AI 연결 계층의 타입과 표시 헬퍼 — Rust 쪽(`detect.rs` · `ai_settings.rs` · `run.rs`)과 1:1.
 *
 * 연결 방법은 세 가지이고 전부 채팅이다(표시 순서는 Rust 레지스트리 `agents.rs` 가 정한다):
 *   * `fabrix` — 사내 전용 API(커스텀 헤더 두 개). 채팅 API · LLM 게이트웨이 두 방식.
 *   * `claude` · `codex` — 로컬 CLI. 자식 프로세스를 띄워 stdout 스트림을 읽는다.
 */

export interface ModelOption {
  id: string;
  label: string;
}

export type AgentSource = "custom-path" | "path" | "not-found" | "remote";

/**
 * 목록의 출처. `live` = 방금 조회 · `cache` = 지난 조회 · `custom` = 사용자가 직접 적은 id ·
 * `fallback` = 내장 정적 카탈로그.
 *
 * FabriX 는 내장 카탈로그가 없어 `fallback` 을 쓰지 않는다(`custom` · `live` · `cache`).
 */
export type ModelsSource = "live" | "cache" | "custom" | "fallback";

export type Diagnostic =
  | "not-on-path"
  | "not-executable"
  | "missing-target"
  | "not-configured"
  | "unreachable";

/** Rust `DetectedAgent` 와 1:1. */
export interface DetectedAgent {
  id: string;
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
  source: AgentSource;
  models: ModelOption[];
  modelsSource: ModelsSource;
  diagnostic: Diagnostic | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  kind: "local" | "remote";
  envVar: string | null;
}

/** 진단 코드 → 사용자 안내문. 연결 탭 셋이 공유하므로 서비스 중립 문구로 쓴다. */
export const DIAGNOSTIC_HINT: Record<Diagnostic, string> = {
  "not-on-path":
    "PATH 와 알려진 설치 위치에서 실행 파일을 찾지 못했습니다. 아래에서 경로를 직접 지정하세요.",
  "not-executable": "찾은 파일에 실행 권한이 없습니다.",
  "missing-target": "실행 스크립트가 사라진 런타임을 가리키고 있습니다. 재설치가 필요합니다.",
  "not-configured": "연결 정보가 없습니다. 아래에서 엔드포인트와 인증 정보를 저장하세요.",
  unreachable: "엔드포인트에 연결하지 못했습니다. URL · 인증 정보 · 네트워크를 확인하세요.",
};

/* ── 설정 ──────────────────────────────────────────── */

export interface AgentConfig {
  customBin: string | null;
}

/**
 * FabriX 의 두 API. 같은 헤더 이름을 쓰지만 기준 주소 · 경로 · 모델 id 형식이 모두 다르다
 * (`src-tauri/src/fabrix.rs` 머리말 표). 빈 값은 `chat` 이다 — 이 필드가 생기기 전의 설정.
 */
export type FabrixApiStyle = "chat" | "openai";

export interface FabrixConfig {
  endpointUrl: string;
  apiStyle?: FabrixApiStyle | "";
  /** `x-fabrix-client` 헤더 */
  client?: string | null;
  /** `x-openapi-token` 헤더. 게이트웨이 방식이면 `Bearer ` 가 없을 때 백엔드가 붙인다. */
  openapiToken?: string | null;
  /** `x-generative-ai-user-email` 헤더(선택). */
  userEmail?: string | null;
  allowInvalidCerts: boolean;
  /**
   * 출력 토큰 상한 **재정의**. 비우면 호출자가 요청한 값을 쓴다.
   * 값이 있으면 이 서비스의 모든 호출이 이 값을 쓴다.
   */
  maxOutputTokens?: number | null;
  /** 백엔드 소유 캐시 — 프런트는 읽기만 하고 보내지 않는다. */
  models?: ModelOption[];
  /**
   * 사용자가 직접 적은 모델 id. 위의 `models` 캐시와 달리 **프런트가 소유하므로**
   * 저장할 때 반드시 실어 보내야 한다 — 빼면 백엔드가 비운 것으로 받는다.
   * 있으면 라이브 조회보다 우선한다. 모델 목록 조회가 막힌 환경의 탈출구다.
   */
  customModels?: ModelOption[];
}

/** 프롬프트 팩 배선 — 훅 이름 → 적용 순서대로의 팩 파일명. */
export interface PromptConfig {
  hooks: Record<string, string[]>;
}

/** 추천에 쓸 연결. `agentId` 가 비어 있으면 로컬 유사도만 쓴다. */
export interface ActiveChoice {
  agentId: string;
  model: string;
}

/**
 * 기능별 연결을 따로 고를 수 있는 기능 — Rust `ai_settings::ROUTES` 와 1:1.
 * 추천은 여기 없다: 추천이 쓰는 것이 곧 기본 연결(`active`)이다.
 */
export type AiFeature = "wiki.ingest" | "wiki.query" | "wiki.web";

export const AI_FEATURES: { id: AiFeature; label: string; note: string }[] = [
  {
    id: "wiki.ingest",
    label: "위키 반영",
    note: "완료한 업무를 읽어 위키 페이지를 쓰는 일 — 입력이 길고 출력도 길다",
  },
  {
    id: "wiki.query",
    label: "위키 질의 · 점검",
    note: "위키 페이지를 읽고 답하거나 모순을 찾는 일",
  },
  {
    id: "wiki.web",
    label: "웹 검색",
    note: "위키 질의 중 브라우저로 가져온 웹 페이지를 읽고 필요한 사실만 추리는 일 — 입력이 길고 잡음이 많다",
  },
];

export interface AiSettings {
  agents: Record<string, AgentConfig>;
  prompts?: PromptConfig | null;
  fabrix?: FabrixConfig | null;
  /** 기본 연결 — 추천이 쓰고, 기능별 연결을 고르지 않은 기능도 이것을 따른다. */
  active: ActiveChoice;
  /** 기능별 연결. 키가 없으면 그 기능은 `active` 를 따른다. */
  routes?: Partial<Record<AiFeature, ActiveChoice>>;
}

/** `~/.contextflow/prompts/` 에서 읽어 온 프롬프트 팩 (Rust `prompts::PromptPack` 미러). */
export interface PromptPack {
  /** 파일명 — 설정에 저장되는 키. */
  file: string;
  name: string;
  description: string;
  /** 프런트마터 힌트. 실제 적용은 설정이 정한다. */
  stage: string;
  body: string;
  chars: number;
  truncated: boolean;
  /** 읽기 실패 사유. 있으면 주입 대상에서 제외된다. */
  error: string | null;
}

/* ── 실행 이벤트 ───────────────────────────────────── */

export type RunEvent =
  | { type: "status"; label: string; model?: string; sessionId?: string }
  | { type: "textDelta"; delta: string }
  | { type: "thinkingDelta"; delta: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  /**
   * 모델이 출력 토큰 상한에 닿아 답변이 중간에 끊겼다. `error` 가 아니다 — 스트림은
   * 정상 종료하고 받은 데까지는 쓸 수 있다. 이 신호가 있어야 "형식을 지키세요" 대신
   * "짧게 줄여서 다시" 라고 물을 수 있다.
   */
  | { type: "truncated" }
  | { type: "error"; message: string }
  | { type: "end"; code: number | null; status: string };

export interface RunArgs {
  agentId: string;
  prompt: string;
  /** 비우면 백엔드가 `~/.contextflow/runs/current` 로 해석한다. */
  cwd?: string;
  systemPrompt: string;
  model?: string | null;
  sessionId?: string | null;
  /** 출력 토큰 상한. 생략하면 원격 커넥터의 기본값(8,192)을 쓴다. */
  maxTokens?: number | null;
  /** 샘플링 온도. 생략하면 원격 커넥터의 기본값(0.4). 로컬 CLI 는 무시한다. */
  temperature?: number | null;
}

/* ── 표시용 헬퍼 ───────────────────────────────────── */

/** 상태 한 줄 — 카드 헤더와 추천 연결 선택기가 함께 쓴다. */
export function agentStatusText(agent: DetectedAgent | null, loading: boolean): string {
  if (loading) return "확인 중…";
  if (!agent) return "미확인";
  if (agent.available) return "연결됨";
  return agent.diagnostic ? DIAGNOSTIC_HINT[agent.diagnostic] : "연결되지 않음";
}

/** 실행 파일을 어디서 찾았는지. */
export function sourceLabel(source: AgentSource): string | null {
  if (source === "custom-path") return "지정 경로";
  if (source === "path") return "PATH";
  if (source === "remote") return "원격 API";
  return null;
}

/** 모델 목록 출처 배지. */
export const MODELS_SOURCE_LABEL: Record<ModelsSource, string> = {
  live: "실시간 조회",
  cache: "최근 조회",
  custom: "직접 지정",
  fallback: "내장 목록",
};

/** `출력 토큰 상한` 입력 → 값. 너무 작은 값은 답변을 통째로 잘라먹으므로 거른다. */
export function parseMaxTokens(text: string): number | null {
  const n = Number(text.trim().replace(/[,_\s]/g, ""));
  if (!Number.isFinite(n) || n < 256) return null;
  return Math.min(200_000, Math.round(n));
}

/** `모델 직접 지정` textarea → 목록. 한 줄에 `id` 또는 `id | label`. */
export function parseModelLines(text: string): ModelOption[] {
  const out: ModelOption[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [idPart, ...rest] = line.split("|");
    const id = (idPart ?? "").trim();
    if (!id || out.some((m) => m.id === id)) continue;
    const label = rest.join("|").trim();
    out.push({ id, label: label || id });
  }
  return out;
}

/** `parseModelLines` 의 역 — 저장된 목록을 textarea 로 되돌린다. */
export function modelLines(models: ModelOption[] | undefined): string {
  return (models ?? [])
    .map((m) => (m.label && m.label !== m.id ? `${m.id} | ${m.label}` : m.id))
    .join("\n");
}
