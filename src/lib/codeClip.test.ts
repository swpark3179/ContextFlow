import { describe, expect, it } from "vitest";
import { codeClip } from "./codeClip";

const BOX = { pad: 8, lh: 20, bar: 0 };

describe("코드 블록 높이", () => {
  it("잘리면 보이는 줄까지만 — 아래쪽 여백은 넣지 않는다", () => {
    const c = codeClip({ ...BOX, count: 18, limit: 8 });
    expect(c.clipped).toBe(true);
    expect(c.hidden).toBe(10);
    expect(c.maxHeight).toBe(8 + 8 * 20);
  });

  it("안 잘려도 상한은 숫자다 — 단계를 바꿀 때 높이가 흘러가야 한다", () => {
    const c = codeClip({ ...BOX, count: 5, limit: 8 });
    expect(c.clipped).toBe(false);
    expect(c.hidden).toBe(0);
    expect(c.maxHeight).toBeGreaterThanOrEqual(8 * 2 + 5 * 20);
  });

  it("가로 스크롤바가 먹는 높이를 더한다", () => {
    expect(codeClip({ ...BOX, bar: 11, count: 20, limit: 16 }).maxHeight).toBe(8 + 16 * 20 + 11);
  });

  it("딱 맞는 블록은 잘리지 않는다", () => {
    expect(codeClip({ ...BOX, count: 8, limit: 8 }).clipped).toBe(false);
  });
});
