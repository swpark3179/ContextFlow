/**
 * 기능별 연결의 해석 규칙.
 *
 * 지정한 연결이 쓸 수 없을 때 기본 연결로 **몰래** 바꾸지 않는다는 것이 핵심이다 — 바꾸면
 * 사용자가 모르는 사이에 다른 서비스로 업무 내용이 나간다.
 */
import { describe, expect, it, vi } from "vitest";
import type { AiSettings, DetectedAgent } from "../lib/ai";

vi.mock("@tauri-apps/api/core", () => ({ Channel: class {}, invoke: async () => null }));

const { routeRun, routeInfo, activeRun, useAi } = await import("./aiStore");

function agent(id: string, available: boolean, remote = true): DetectedAgent {
  return {
    id,
    name: id.toUpperCase(),
    available,
    path: null,
    version: null,
    source: remote ? "remote" : "path",
    models: [{ id: "m1", label: "M1" }],
    modelsSource: "live",
    diagnostic: null,
  };
}

function state(settings: Partial<AiSettings>, detected: Record<string, DetectedAgent>) {
  return {
    ...useAi.getState(),
    settings: { agents: {}, active: { agentId: "", model: "" }, ...settings },
    detected,
  };
}

describe("routeRun", () => {
  const detected = {
    fabrix: agent("fabrix", true),
    aipro: agent("aipro", false),
    claude: agent("claude", true, false),
  };

  it("falls back to the default connection when no route is set", () => {
    const s = state({ active: { agentId: "fabrix", model: "m1" } }, detected);
    expect(routeRun(s, "wiki.ingest")).toEqual({ agentId: "fabrix", model: "m1" });
    expect(routeInfo(s, "wiki.ingest")).toMatchObject({ via: "default", name: "FABRIX" });
  });

  it("uses the route when it is set and available", () => {
    const s = state(
      {
        active: { agentId: "fabrix", model: "m1" },
        routes: { "wiki.query": { agentId: "claude", model: "" } },
      },
      detected,
    );
    // 로컬 CLI 는 모델이 비어 있으면 자체 설정을 따른다.
    expect(routeRun(s, "wiki.query")).toEqual({ agentId: "claude", model: "default" });
  });

  it("never silently swaps an unavailable route for the default", () => {
    const s = state(
      {
        active: { agentId: "fabrix", model: "m1" },
        routes: { "wiki.ingest": { agentId: "aipro", model: "x" } },
      },
      detected,
    );
    expect(routeRun(s, "wiki.ingest")).toBeNull();
    expect(routeInfo(s, "wiki.ingest")).toMatchObject({ via: "route", run: null, name: "AIPRO" });
    // 기본 연결 자체는 멀쩡하다.
    expect(activeRun(s)).toEqual({ agentId: "fabrix", model: "m1" });
  });

  it("reports none when there is neither a route nor a default", () => {
    const s = state({}, detected);
    expect(routeInfo(s, "wiki.query")).toEqual({ run: null, via: "none", name: null });
  });

  it("a remote connection without a model id cannot run", () => {
    const s = state({ active: { agentId: "fabrix", model: "" } }, detected);
    expect(routeRun(s, "wiki.ingest")).toBeNull();
  });
});
