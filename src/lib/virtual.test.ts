import { describe, expect, it } from "vitest";
import { prefixOffsets, rangeFor } from "./virtual";

describe("prefixOffsets", () => {
  it("accumulates row heights and ends with the total", () => {
    const offsets = prefixOffsets(3, (i) => [10, 20, 30][i]);
    expect(offsets).toEqual([0, 10, 30, 60]);
  });

  it("has a single zero entry for an empty list", () => {
    expect(prefixOffsets(0, () => 10)).toEqual([0]);
  });

  it("treats a negative measurement as zero rather than moving rows backwards", () => {
    expect(prefixOffsets(2, () => -5)).toEqual([0, 0, 0]);
  });
});

describe("rangeFor", () => {
  // 100px 행 10개 = 1000px, 화면은 250px.
  const offsets = prefixOffsets(10, () => 100);

  it("renders nothing when there are no rows", () => {
    expect(rangeFor([0], 0, 250, 2)).toEqual([0, 0]);
  });

  it("starts at the top with no overscan", () => {
    expect(rangeFor(offsets, 0, 250, 0)).toEqual([0, 3]);
  });

  it("pads the range by the overscan on both sides", () => {
    expect(rangeFor(offsets, 400, 250, 2)).toEqual([2, 9]);
  });

  it("never runs past either end of the list", () => {
    expect(rangeFor(offsets, 0, 250, 6)).toEqual([0, 9]);
    expect(rangeFor(offsets, 900, 250, 6)).toEqual([3, 10]);
  });

  it("clamps a scroll position beyond the content to the last row", () => {
    const [start, end] = rangeFor(offsets, 99_999, 250, 0);
    expect(start).toBe(9);
    expect(end).toBe(10);
  });

  it("picks the row the top edge lands inside, not the one it just passed", () => {
    // 200 은 3번째 행(인덱스 2)의 시작점이다 — 2번째 행은 이미 완전히 지나갔다.
    expect(rangeFor(offsets, 200, 100, 0)).toEqual([2, 3]);
    // 199 는 아직 2번째 행(인덱스 1)이 한 픽셀 걸쳐 있다.
    expect(rangeFor(offsets, 199, 100, 0)).toEqual([1, 3]);
  });

  it("handles mixed measured and estimated heights", () => {
    const mixed = prefixOffsets(4, (i) => (i === 1 ? 300 : 50));
    expect(mixed).toEqual([0, 50, 350, 400, 450]);
    // 화면 위쪽이 60 이면 큰 행(인덱스 1) 안이다.
    expect(rangeFor(mixed, 60, 100, 0)).toEqual([1, 2]);
  });

  it("still returns a usable range before the viewport has been measured", () => {
    const [start, end] = rangeFor(offsets, 0, 0, 3);
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(0);
  });
});
