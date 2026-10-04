import { describe, expect, it } from "vitest";
import { candidatesFor, mappedCategory, patchDesignated, toggleDesignated } from "./categories";
import type { Designated, IwmsCategory, IwmsDay } from "./types";

function cat(ciKey: string, wbsid: string, priceType: string, blocked: string | null = null): IwmsCategory {
  return {
    ciKey,
    ciName: ciKey,
    wbsid,
    priceType,
    path: "대 > 중 > 소",
    task: wbsid,
    templates: [],
    rows: [],
    minutes: 0,
    blocked,
  };
}

function des(ciKey: string, wbsid: string, priceType: string, mapFrom: string[] = []): Designated {
  return { ciKey, ciName: ciKey, wbsid, path: "", task: wbsid, priceType, hint: "", mapFrom, samples: [] };
}

const day: IwmsDay = {
  workDate: "2026-10-02",
  userId: "u",
  standardMinutes: 480,
  maxMinutes: 480,
  totalMinutes: 0,
  approved: false,
  holiday: false,
  tabs: [],
  categories: [
    cat("A", "w1", "O"),
    cat("A", "w2", "O"),
    cat("A", "w3", "O", "마감일이 지났습니다"),
    cat("NON-OBJECT", "w1", "N"),
    cat("NON-OBJECT", "w9", "N"),
    cat("I", "w5", "I"),
  ],
};

describe("candidatesFor", () => {
  it("지정한 것 ∩ 그날 가능한 것 ∩ 대가 구분", () => {
    const r = candidatesFor(day, "O", [des("A", "w2", "O"), des("NON-OBJECT", "w1", "N")]);
    expect(r.list.map((c) => c.wbsid)).toEqual(["w2"]);
    expect(r.fallback).toBe(false);
    expect(r.missing).toEqual([]);
  });

  it("같은 wbsid 라도 탭이 다르면 다른 카테고리다", () => {
    const r = candidatesFor(day, "N", [des("A", "w1", "O"), des("NON-OBJECT", "w1", "N")]);
    expect(r.list.map((c) => `${c.ciKey}/${c.wbsid}`)).toEqual(["NON-OBJECT/w1"]);
  });

  it("그 대가 구분에 지정한 것이 없으면 그날 전체(막힌 것 빼고)로 대신한다", () => {
    const r = candidatesFor(day, "O", [des("NON-OBJECT", "w1", "N")]);
    expect(r.fallback).toBe(true);
    expect(r.list.map((c) => c.wbsid)).toEqual(["w1", "w2"]);
  });

  it("지정했지만 그날 없거나 막힌 것은 missing 으로 알린다", () => {
    const r = candidatesFor(day, "O", [des("A", "w1", "O"), des("A", "w3", "O"), des("B", "w7", "O")]);
    expect(r.list.map((c) => c.wbsid)).toEqual(["w1"]);
    expect(r.missing.map((d) => d.wbsid)).toEqual(["w3", "w7"]);
  });
});

describe("mappedCategory", () => {
  const list = [
    des("A", "w1", "O", ["프로젝트"]),
    des("A", "w2", "O", ["프로젝트/S-PCS-Plus"]),
    des("NON-OBJECT", "w9", "N", ["프로젝트/S-PCS-Plus"]),
  ];

  it("가장 깊은 매핑이 이긴다", () => {
    expect(mappedCategory("프로젝트/S-PCS-Plus/UI", list, "O")?.wbsid).toBe("w2");
    expect(mappedCategory("프로젝트/EPC", list, "O")?.wbsid).toBe("w1");
  });

  it("대가 구분이 다른 매핑은 보지 않는다", () => {
    expect(mappedCategory("프로젝트/S-PCS-Plus", list, "N")?.wbsid).toBe("w9");
    expect(mappedCategory("프로젝트/EPC", list, "N")).toBeNull();
  });

  it("대소문자는 가리지 않고, 앞부분만 같은 다른 단계는 하위가 아니다", () => {
    expect(mappedCategory("프로젝트/s-pcs-plus", list, "O")?.wbsid).toBe("w2");
    expect(mappedCategory("프로젝트2", list, "O")).toBeNull();
  });

  it("미분류 업무 · 자유 항목은 매핑이 없다", () => {
    expect(mappedCategory(null, list, "O")).toBeNull();
  });
});

describe("지정 목록 고치기", () => {
  it("켜고 끄고 고친다", () => {
    let l = toggleDesignated([], des("A", "w1", "O"), true);
    l = toggleDesignated(l, des("A", "w2", "O"), true);
    l = toggleDesignated(l, des("A", "w1", "O"), true);
    expect(l.map((d) => d.wbsid)).toEqual(["w2", "w1"]);
    l = patchDesignated(l, "A|w2", { hint: "배포" });
    expect(l[0].hint).toBe("배포");
    l = toggleDesignated(l, des("A", "w2", "O"), false);
    expect(l.map((d) => d.wbsid)).toEqual(["w1"]);
  });
});
