import { describe, expect, it } from "vitest";
import { edgeFades, fadeMask, revealLeft } from "./tabStrip";

describe("탭 띠 스크롤", () => {
  it("다 보이는 탭은 굴리지 않는다", () => {
    expect(revealLeft(100, 120, 0, 400)).toBeNull();
    expect(revealLeft(100, 120, 50, 400, 18)).toBeNull();
  });

  it("왼쪽으로 숨은 탭은 페이드 폭만큼 띄워 왼쪽 끝에 맞춘다", () => {
    expect(revealLeft(100, 120, 200, 400, 18)).toBe(82);
    // 맨 앞 탭이면 0 아래로 내려가지 않는다.
    expect(revealLeft(0, 120, 60, 400, 18)).toBe(0);
  });

  it("오른쪽으로 숨은 탭은 오른쪽 끝에 맞춘다", () => {
    expect(revealLeft(500, 120, 0, 400, 18)).toBe(238);
  });

  it("보이는 폭보다 넓은 탭은 이름의 시작을 맞춘다", () => {
    expect(revealLeft(500, 500, 0, 400, 18)).toBe(482);
  });

  it("넘친 쪽만 가장자리를 지운다", () => {
    expect(edgeFades(0, 400, 400)).toEqual({ left: false, right: false });
    expect(edgeFades(0, 900, 400)).toEqual({ left: false, right: true });
    expect(edgeFades(250, 900, 400)).toEqual({ left: true, right: true });
    expect(edgeFades(500, 900, 400)).toEqual({ left: true, right: false });
    // 소수 스크롤 위치의 반올림은 넘친 것으로 치지 않는다.
    expect(edgeFades(499.5, 900, 400)).toEqual({ left: true, right: false });
  });

  it("넘치지 않으면 가면을 씌우지 않는다", () => {
    expect(fadeMask({ left: false, right: false })).toBeUndefined();
    expect(fadeMask({ left: false, right: true }, 18)).toBe(
      "linear-gradient(to right, #000 0, #000 18px, #000 calc(100% - 18px), transparent 100%)",
    );
  });
});
