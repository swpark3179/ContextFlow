import { describe, expect, it } from "vitest";
import { fitMinutes } from "./minutes";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("fitMinutes", () => {
  it("비율을 지키며 합을 남은 시간에 맞춘다", () => {
    const out = fitMinutes([60, 30, 30], [false, false, false], 120, 10);
    expect(sum(out)).toBe(120);
    expect(out).toEqual([60, 30, 30]);
    const grown = fitMinutes([60, 30, 30], [false, false, false], 240, 10);
    expect(grown).toEqual([120, 60, 60]);
  });

  it("단위로 내리고 버림이 큰 줄부터 채운다", () => {
    const out = fitMinutes([10, 10, 10], [false, false, false], 100, 10);
    expect(sum(out)).toBe(100);
    expect(out.every((v) => v % 10 === 0)).toBe(true);
    expect(out).toEqual([40, 30, 30]);
  });

  it("사람이 고친 값은 그대로 두고 나머지로 맞춘다", () => {
    const out = fitMinutes([90, 40, 40], [true, false, false], 120, 10);
    expect(out[0]).toBe(90);
    expect(sum(out)).toBe(120);
    expect(out).toEqual([90, 20, 10]);
  });

  it("모두 0 이면 똑같이 나눈다", () => {
    expect(fitMinutes([0, 0, 0, 0], [false, false, false, false], 120, 10)).toEqual([30, 30, 30, 30]);
  });

  it("줄마다 최소 한 단위", () => {
    const out = fitMinutes([300, 1, 1], [false, false, false], 120, 10);
    expect(out[1]).toBeGreaterThanOrEqual(10);
    expect(out[2]).toBeGreaterThanOrEqual(10);
    expect(sum(out)).toBe(120);
  });

  it("단위로 나누어떨어지지 않는 끝수는 가장 큰 줄로", () => {
    const out = fitMinutes([60, 30], [false, false], 95, 10);
    expect(sum(out)).toBe(95);
    expect(out).toEqual([65, 30]);
  });

  it("남은 시간이 없거나 다 잠겼으면 단위로만 맞춘다", () => {
    expect(fitMinutes([33, 47], [false, false], 0, 10)).toEqual([30, 50]);
    expect(fitMinutes([33, 47], [true, true], 120, 10)).toEqual([33, 47]);
    expect(fitMinutes([90, 30], [true, false], 60, 10)).toEqual([90, 30]);
  });
});
