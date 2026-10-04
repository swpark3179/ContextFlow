/**
 * `runOnce` 의 취소 · 사용량 계약.
 *
 * 위키 반영 큐는 [취소] 를 누르면 곧바로 다음 업무로 넘어가야 하고, 테스트 대화는 토큰
 * 사용량을 보여 줘야 한다. 둘 다 채널 이벤트와 커맨드 호출의 순서로 정해지므로, 그 두 가지를
 * 흉내 내 확인한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "./ai";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
let channel: { onmessage: ((ev: RunEvent) => void) | null } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((ev: RunEvent) => void) | null = null;
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd === "run_agent") {
      channel = args.onEvent as typeof channel;
      return "run-7";
    }
    return null;
  },
}));

const { runOnce, runWithRetry, isRetryable, thinkingTail, CANCELED } = await import("./runOnce");

const ARGS = { agentId: "claude", prompt: "q", systemPrompt: "" };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  channel = null;
});

describe("runOnce", () => {
  it("collects text, thinking and the last usage", async () => {
    const p = runOnce(ARGS);
    await tick();
    channel!.onmessage!({ type: "thinkingDelta", delta: "흠" });
    channel!.onmessage!({ type: "textDelta", delta: "안녕" });
    channel!.onmessage!({ type: "usage", inputTokens: 10, outputTokens: 3 });
    channel!.onmessage!({ type: "end", code: null, status: "succeeded" });
    const r = await p;
    expect(r).toMatchObject({ ok: true, text: "안녕", thinking: "흠" });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  /** 생각 토큰은 쌓아 두기만 하면 화면이 멈춘 것처럼 보인다 — 자랄 때마다 길이와 끝줄을 알린다. */
  it("reports thinking length and its last line as it grows", async () => {
    const seen: [number, string][] = [];
    const p = runOnce(ARGS, { onThinking: (n, tail) => seen.push([n, tail]) });
    await tick();
    channel!.onmessage!({ type: "thinkingDelta", delta: "첫 줄\n" });
    channel!.onmessage!({ type: "thinkingDelta", delta: "둘째" });
    channel!.onmessage!({ type: "end", code: null, status: "succeeded" });
    await p;
    expect(seen).toEqual([
      [4, "첫 줄"],
      [6, "둘째"],
    ]);
  });

  it("abort cancels the backend run and resolves at once", async () => {
    const ctl = new AbortController();
    const p = runOnce(ARGS, { signal: ctl.signal });
    await tick();
    channel!.onmessage!({ type: "textDelta", delta: "부분" });
    ctl.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: false, error: CANCELED, text: "부분" });
    expect(calls.map((c) => c.cmd)).toEqual(["run_agent", "cancel_run"]);
    expect(calls[1]!.args).toEqual({ runId: "run-7" });
    // 끝난 뒤 늦게 오는 이벤트는 무시된다.
    channel!.onmessage!({ type: "end", code: null, status: "succeeded" });
  });

  it("an already-aborted signal never starts a run", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await runOnce(ARGS, { signal: ctl.signal });
    expect(r.error).toBe(CANCELED);
    expect(calls).toEqual([]);
  });

  it("cancellation is permanent — runWithRetry does not try again", async () => {
    expect(isRetryable(CANCELED)).toBe(false);
    const ctl = new AbortController();
    const p = runWithRetry(ARGS, { signal: ctl.signal });
    await tick();
    ctl.abort();
    const r = await p;
    expect(r.error).toBe(CANCELED);
    expect(calls.filter((c) => c.cmd === "run_agent")).toHaveLength(1);
  });
});

describe("thinkingTail", () => {
  it("keeps the last non-empty line, clipped to its last 80 chars", () => {
    expect(thinkingTail("a\nb\n\n")).toBe("b");
    expect(thinkingTail("")).toBe("");
    expect(thinkingTail("x".repeat(100) + "끝")).toBe("x".repeat(79) + "끝");
  });
});
