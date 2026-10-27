import { describe, expect, it } from "vitest";
import { minutesBar } from "./minutesBar";

describe("minutesBar", () => {
  it("이미 입력한 분과 줄마다의 몫을 이어 붙인다", () => {
    const b = minutesBar(480, 120, [120, 240]);
    expect(b.done).toBe(25);
    expect(b.parts).toEqual([
      { left: 25, width: 25 },
      { left: 50, width: 50 },
    ]);
    expect(b.over).toEqual({ left: 100, width: 0 });
  });

  it("기준을 넘치면 줄의 몫은 막대 끝에서 멈추고 넘친 몫을 따로 센다", () => {
    const b = minutesBar(480, 120, [300, 120]);
    expect(b.parts).toEqual([
      { left: 25, width: 62.5 },
      { left: 87.5, width: 12.5 },
    ]);
    // 120 + 420 = 540 → 60분 넘침 = 12.5%
    expect(b.over).toEqual({ left: 87.5, width: 12.5 });
  });

  it("넘친 몫은 overCap 에서 자른다", () => {
    const b = minutesBar(480, 480, [480]);
    expect(b.parts).toEqual([{ left: 100, width: 0 }]);
    expect(b.over).toEqual({ left: 70, width: 30 });
  });

  it("기준이 0 인 날은 채운 만큼을 막대 전체로 본다", () => {
    const b = minutesBar(0, 0, [60, 60]);
    expect(b.parts).toEqual([
      { left: 0, width: 50 },
      { left: 50, width: 50 },
    ]);
    expect(b.over.width).toBe(0);
  });

  it("음수 · 숫자가 아닌 값은 0 으로 센다", () => {
    const b = minutesBar(480, -10, [Number.NaN, 48]);
    expect(b.done).toBe(0);
    expect(b.parts).toEqual([
      { left: 0, width: 0 },
      { left: 0, width: 10 },
    ]);
  });
});
