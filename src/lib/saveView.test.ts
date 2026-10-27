import { describe, expect, it } from "vitest";
import { savedAgain, savedAt, saveView, type SaveLike } from "./saveView";

const S = (state: SaveLike["state"], n = 1): SaveLike => ({ state, at: "14:52", n });

describe("저장 표시", () => {
  it("아직 한 번도 저장하지 않은 문서는 버퍼만 본다", () => {
    expect(saveView(false, undefined)).toBe("saved");
    expect(saveView(true, undefined)).toBe("dirty");
  });

  it("쓰는 중이 가장 앞선다 — 쓰는 사이에 친 글자가 있어도", () => {
    expect(saveView(true, S("saving"))).toBe("saving");
    expect(saveView(false, S("saving"))).toBe("saving");
  });

  it("실패는 아직 미저장일 때만 실패다", () => {
    expect(saveView(true, S("failed"))).toBe("failed");
    // 다시 읽어 디스크와 같아졌으면 붙잡을 것이 없다.
    expect(saveView(false, S("failed"))).toBe("saved");
  });

  it("저장한 뒤 다시 친 글은 미저장이다", () => {
    expect(saveView(true, S("saved"))).toBe("dirty");
    expect(saveView(false, S("saved"))).toBe("saved");
  });

  it("저장 시각은 문서의 것이 먼저, 없으면 스냅샷 시각", () => {
    expect(savedAt(S("saved"), "09:00")).toBe("14:52");
    expect(savedAt(undefined, "09:00")).toBe("09:00");
    expect(savedAt({ state: "failed", at: "", n: 0 }, "09:00")).toBe("09:00");
  });

  it("체크는 저장 횟수가 늘 때만 튄다 — 업무를 바꿔 0 으로 돌아간 것은 저장이 아니다", () => {
    expect(savedAgain(2, 3)).toBe(true);
    expect(savedAgain(3, 3)).toBe(false);
    expect(savedAgain(5, 0)).toBe(false);
    expect(savedAgain(0, 1)).toBe(true);
  });
});
