import { describe, expect, it } from "vitest";
import { problemsOf, rowsOf } from "./check";
import type { Draft } from "./parse";
import type { IwmsCategory, IwmsDay } from "./types";

const cat = (blocked: string | null = null): IwmsCategory => ({
  ciKey: "A",
  ciName: "공통",
  wbsid: "w1",
  priceType: "O",
  path: "대 > 중",
  task: "태스크",
  templates: [],
  rows: [],
  minutes: 0,
  blocked,
});

const draft = (extra: Partial<Draft> = {}): Draft => ({
  entryId: 1,
  title: "업무",
  price: "O",
  category: cat(),
  minutes: 60,
  note: " 상세 ",
  confidence: 80,
  alternatives: [],
  fixed: false,
  edited: {},
  issues: [],
  ...extra,
});

const day: IwmsDay = {
  workDate: "2026-10-02",
  userId: "u",
  standardMinutes: 480,
  maxMinutes: 480,
  totalMinutes: 360,
  approved: false,
  holiday: false,
  tabs: [],
  categories: [],
};

describe("미리보기 전 검사", () => {
  it("문제가 없으면 빈 목록", () => {
    expect(problemsOf([draft()], day)).toEqual([]);
  });

  it("줄마다 고칠 것을 짚는다", () => {
    const p = problemsOf(
      [draft({ category: null }), draft({ title: "b", minutes: 0, note: " " }), draft({ title: "c", category: cat("마감일이 지났습니다") })],
      day,
    );
    expect(p).toEqual([
      "‘업무’: 카테고리를 고르세요",
      "‘b’: 분을 넣으세요",
      "‘b’: 상세 내용이 비어 있습니다",
      "‘c’: 마감일이 지났습니다",
    ]);
  });

  it("하루 상한 · 결재 · 빈 목록", () => {
    expect(problemsOf([draft({ minutes: 1100 })], day)).toContain("하루 합계가 1460분이 되어 1440분을 넘습니다");
    expect(problemsOf([draft()], { ...day, approved: true })[0]).toContain("결재");
    expect(problemsOf([], day)).toEqual(["넣을 업무가 없습니다"]);
    expect(problemsOf([draft()], null)).toHaveLength(1);
  });

  it("초안을 덧붙일 행으로", () => {
    expect(rowsOf([draft(), draft({ entryId: 2, category: null })])).toEqual([
      { entryId: 1, title: "업무", ciKey: "A", wbsid: "w1", minutes: 60, note: "상세", reqDate: "", price: "O" },
    ]);
  });
});
