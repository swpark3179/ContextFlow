import { describe, expect, it } from "vitest";
import type { AiSettings, PromptPack } from "./ai";
import { HOOK_CAP, composeHook, hooksOf, injectionFor } from "./promptPacks";

function pack(file: string, body: string, error: string | null = null): PromptPack {
  return {
    file,
    name: file.replace(/\.md$/, ""),
    description: "",
    stage: "recommend.rank",
    body,
    chars: body.length,
    truncated: false,
    error,
  };
}

function settings(hooks: Record<string, string[]>): AiSettings {
  return { agents: {}, prompts: { hooks }, active: { agentId: "", model: "" } };
}

describe("composeHook", () => {
  const packs = [pack("a.md", "지침 A"), pack("b.md", "지침 B")];

  it("is empty until a pack is explicitly wired", () => {
    expect(composeHook("recommend.rank", packs, {})).toEqual({ text: "", dropped: [] });
  });

  it("joins bodies in the configured order, not file order", () => {
    const got = composeHook("recommend.rank", packs, { "recommend.rank": ["b.md", "a.md"] });
    expect(got.text).toBe("지침 B\n\n지침 A");
    expect(got.dropped).toEqual([]);
  });

  it("skips packs that failed to read or are missing", () => {
    const withBad = [...packs, pack("bad.md", "", "읽을 수 없습니다")];
    const got = composeHook("recommend.rank", withBad, {
      "recommend.rank": ["bad.md", "없는파일.md", "a.md"],
    });
    expect(got.text).toBe("지침 A");
    expect(got.dropped).toEqual([]);
  });

  /**
   * 상한을 넘긴 팩은 조용히 빠지지 않고 보고돼야 한다 — 켜 둔 지침이 실제로는 나가지
   * 않는다는 사실을 사용자가 알 방법이 그것뿐이다.
   */
  it("reports packs dropped for exceeding the cap, and stops at the first one", () => {
    const big = pack("big.md", "가".repeat(HOOK_CAP));
    const got = composeHook("recommend.rank", [big, ...packs], {
      "recommend.rank": ["big.md", "a.md", "b.md"],
    });
    expect(got.text).toBe(big.body);
    // 순서가 사용자 우선순위다. 큰 것을 건너뛰고 뒤의 작은 것을 넣지 않는다.
    expect(got.dropped).toEqual(["a.md", "b.md"]);
  });
});

describe("injectionFor", () => {
  it("wraps the body and states that the output contract wins", () => {
    const got = injectionFor("recommend.rank", [pack("a.md", "지침 A")], settings({ "recommend.rank": ["a.md"] }));
    expect(got).toContain("# 추가 지침 (사용자 지정)");
    expect(got).toContain("출력 형식이 우선합니다");
    expect(got).toContain("지침 A");
  });

  it("is an empty string when nothing is wired", () => {
    expect(injectionFor("recommend.rank", [pack("a.md", "지침 A")], settings({}))).toBe("");
    expect(injectionFor("recommend.rank", [], null)).toBe("");
  });
});

describe("hooksOf", () => {
  it("defaults to no hooks for missing or null settings", () => {
    expect(hooksOf(null)).toEqual({});
    expect(hooksOf({ agents: {}, active: { agentId: "", model: "" } })).toEqual({});
  });
});
