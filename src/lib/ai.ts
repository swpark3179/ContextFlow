/**
 * AI 연결 계층의 타입과 표시 헬퍼 — Rust 쪽(`detect.rs` · `ai_settings.rs` · `run.rs`)과 1:1.
 *
 * 연결 방법은 네 가지이고 전부 채팅이다:
 *   * `claude` · `codex` — 로컬 CLI. 자식 프로세스를 띄워 stdout 스트림을 읽는다.
 *   * `aipro`  — 사내 OpenAI 호환 게이트웨이(Bearer 키 하나).
 *   * `fabrix` — 사내 전용 API(커스텀 헤더 두 개).
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
 * FabriX 는 `live` 와 `fallback` 만 쓴다(캐시도 `fallback` 로 묶는다).
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

/** 진단 코드 → 사용자 안내문. 카드 4장이 공유하므로 서비스 중립 문구로 쓴다. */
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

export interface AiProConfig {
  endpointUrl: string;
  apiKey?: string | null;
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
   *
   * 있으면 라이브 조회보다 우선한다. 게이트웨이가 `/models` 를 주지 않는 환경의 탈출구다.
   */
  customModels?: ModelOption[];
}

export interface FabrixConfig {
  endpointUrl: string;
  /** `x-fabrix-client` 헤더 */
  client?: string | null;
  /** `x-openapi-token` 헤더 */
  openapiToken?: string | null;
  allowInvalidCerts: boolean;
  maxOutputTokens?: number | null;
  models?: ModelOption[];
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

export interface AiSettings {
  agents: Record<string, AgentConfig>;
  prompts?: PromptConfig | null;
  aipro?: AiProConfig | null;
  fabrix?: FabrixConfig | null;
  active: ActiveChoice;
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
