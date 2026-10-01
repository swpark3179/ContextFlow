import { Channel } from "@tauri-apps/api/core";
import type { RunArgs, RunEvent } from "./ai";
import * as api from "./api";

/**
 * AI 실행 1건을 프라미스로 감싼다 — 스트림 누적 · 정지 감시 · 전송 재시도.
 *
 * 네 연결이 하나의 이벤트 어휘(`RunEvent`)로 수렴하므로 이 래퍼도 하나면 된다.
 */

export interface RunResult {
  /** 지금까지 받은 텍스트. 실패해도 받은 데까지는 담겨 있다. */
  text: string;
  ok: boolean;
  error: string | null;
  /** 모델이 출력 상한에 닿아 끊겼다(원격이 알려 준 경우). */
  truncated: boolean;
  /** 서비스가 알려 준 토큰 사용량(마지막 값). 테스트 대화가 보여 준다. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 추론 토큰(보여 주지 않는 생각). 답이 비었을 때 "생각만 하다 끝났다" 를 가려내는 데 쓴다. */
  thinking?: string;
}

/** 사용자가 끊은 실행의 오류 문구. 재시도 대상이 아니다. */
export const CANCELED = "취소했습니다";

/** 최대 몇 번까지 실행할지(최초 실행 포함). */
export const RUN_ATTEMPTS = 3;

/** 아무 이벤트도 오지 않는 채로 이 시간이 지나면 죽은 실행으로 본다. */
export const RUN_STALL_MS = 5 * 60_000;

/** 2s → 4s → 8s → … 30s(상한). */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** (Math.max(1, attempt) - 1));
}

/**
 * 다시 실행해도 결과가 같은 실패의 표식 — Rust 쪽 오류 문구와 짝을 맞춘 목록이다.
 * 408 · 429 · 5xx 는 여기 없으므로 재시도한다.
 */
const PERMANENT_MARKS = [
  CANCELED,
  "찾지 못했습니다",
  "알 수 없는 AI 서비스",
  "알 수 없는 원격 서비스",
  "실행할 수 없는 서비스",
  "연결 정보가 없습니다",
  "모델을 선택해 주세요",
  "HTTP 400",
  "HTTP 401",
  "HTTP 403",
  "HTTP 404",
];

export function isRetryable(error: string | null): boolean {
  return error === null ? true : !PERMANENT_MARKS.some((m) => error.includes(m));
}

export interface RunOnceOptions {
  /** 부분 응답이 자랄 때마다. 진행 표시용. */
  onPartial?: (text: string) => void;
  /** 모든 이벤트(상태 · 추론 · 사용량 포함). 진행 단계 표시용. */
  onEvent?: (ev: RunEvent) => void;
  /**
   * 끊기. 신호가 오면 백엔드 실행을 취소하고 곧바로 `error: CANCELED` 로 끝난다 — 서버의
   * 생성이 실제로 멈출 때까지 기다리지 않는다(그건 백엔드가 알아서 정리한다).
   */
  signal?: AbortSignal;
}

/**
 * 한 번 실행한다.
 *
 * `end` 만 믿으면 안 된다 — 채널이 `end` 없이 끊기면 프라미스가 영원히 걸린다. 그래서
 * `finish` 는 멱등이고, 이벤트가 끊기면 정지 감시가 대신 매듭짓는다. 버리기 전에 반드시
 * `cancelRun` 을 부른다: 그러지 않으면 서버 쪽 생성이 계속 돌면서 우리는 그것을 끊을
 * id 마저 잃는다.
 */
export function runOnce(args: RunArgs, opts: RunOnceOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const channel = new Channel<RunEvent>();
    let text = "";
    let thinking = "";
    let usage: RunResult["usage"];
    let failure: string | null = null;
    let truncated = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let runId: string | null = null;

    const onAbort = () => {
      if (runId) void api.cancelRun(runId).catch(() => {});
      finish({ text, ok: false, error: CANCELED, truncated, usage, thinking });
    };
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    if (opts.signal?.aborted) {
      finish({ text: "", ok: false, error: CANCELED, truncated: false });
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (runId) void api.cancelRun(runId).catch(() => {});
        finish({
          text,
          ok: false,
          error: `AI 서비스가 ${RUN_STALL_MS / 60_000}분 넘게 응답하지 않았습니다.`,
          truncated,
          usage,
          thinking,
        });
      }, RUN_STALL_MS);
    };
    arm();

    channel.onmessage = (ev) => {
      if (done) return;
      arm();
      opts.onEvent?.(ev);
      if (ev.type === "textDelta") {
        text += ev.delta;
        opts.onPartial?.(text);
      } else if (ev.type === "thinkingDelta") thinking += ev.delta;
      else if (ev.type === "usage") usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
      else if (ev.type === "truncated") truncated = true;
      else if (ev.type === "error") failure = ev.message;
      else if (ev.type === "end") {
        const ok = ev.status === "succeeded";
        finish({
          text,
          ok,
          error: ok ? null : (failure ?? "실행이 완료되지 못했습니다."),
          truncated,
          usage,
          thinking,
        });
      }
      // `status` 는 감시 타이머를 다시 감는 것만으로 충분하다 — 생각 중인 모델을 죽은
      // 것으로 오판하지 않게 한다.
    };

    // cwd 는 비워 넘긴다 — 백엔드가 `~/.contextflow/runs/current` 로 해석한다.
    api
      .runAgent({ ...args, cwd: "" }, channel)
      .then((id) => {
        runId = id;
        // 감시 타이머가 먼저 터졌다면 이 실행은 이미 버려졌다 — 매달린 id 를 두는 대신
        // 바로 끊는다.
        if (done) void api.cancelRun(id).catch(() => {});
      })
      .catch((err) =>
        finish({ text: "", ok: false, error: api.errMessage(err), truncated: false }),
      );
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 일시적 실패면 백오프 후 다시 시도한다. 영구 실패(설정 오류 · 4xx)는 즉시 포기한다 —
 * 같은 결과를 세 번 기다리게 하는 것은 사용자를 붙잡아 두는 것 말고 하는 일이 없다.
 */
export async function runWithRetry(
  args: RunArgs,
  opts: RunOnceOptions = {},
): Promise<RunResult> {
  let result = await runOnce(args, opts);
  for (let attempt = 2; attempt <= RUN_ATTEMPTS; attempt++) {
    if (result.ok || !isRetryable(result.error) || opts.signal?.aborted) break;
    await sleep(backoffMs(attempt - 1));
    if (opts.signal?.aborted) break;
    result = await runOnce(args, opts);
  }
  return result;
}
