import { describe, expect, it } from "vitest";
import { SAME, dice, duplicateOf } from "./duplicates";
import type { IwmsDay } from "./types";

const day: IwmsDay = {
  workDate: "2026-10-02",
  userId: "u",
  standardMinutes: 480,
  maxMinutes: 480,
  totalMinutes: 120,
  approved: false,
  holiday: false,
  tabs: [],
  categories: [
    {
      ciKey: "A",
      ciName: "공통",
      wbsid: "w1",
      priceType: "O",
      path: "",
      task: "애플리케이션 단순문의",
      templates: [],
      minutes: 120,
      blocked: null,
      rows: [
        { rowSeq: 1, minutes: 60, note: "SRM 인스턴스 문제건 조치", reqDate: "", exceptTime: false, exceptDay: false },
        { rowSeq: 2, minutes: 60, note: "설계협력사 임직원 등록현황 확인 건\n- 배치 실행", reqDate: "", exceptTime: false, exceptDay: false },
      ],
    },
  ],
};

describe("이미 넣은 일", () => {
  it("띄어쓰기 · 문장부호가 달라도 같은 일로 본다(2026-10-02 실데이터)", () => {
    const a = duplicateOf("SRM 인스턴스 문제건 조치", day);
    expect(a?.score).toBe(1);
    const b = duplicateOf("설계협력사 임직원 등록현황 확인건", day);
    expect(b?.row.rowSeq).toBe(2);
    expect(b!.score).toBeGreaterThanOrEqual(SAME);
  });

  it("다른 일은 걸리지 않는다", () => {
    expect(duplicateOf("S-PCS-Plus Knox 로그인 연동", day)).toBeNull();
    expect(duplicateOf("EPC Portal 품질서버 기동", day)).toBeNull();
  });

  it("Dice 계수", () => {
    expect(dice("서버 기동", "서버기동")).toBe(1);
    expect(dice("", "a")).toBe(0);
    expect(dice("서버 기동", "배포 스크립트")).toBe(0);
  });
});
