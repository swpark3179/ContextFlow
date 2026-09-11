import { describe, expect, it } from "vitest";
import { keepTabs, tabKey } from "./tabs";

const TABS = [
  { path: "index.md", mode: "text" },
  { path: "회의록.md", mode: "md" },
  { path: "설계/도면.svg", mode: "text" },
];

describe("탭 닫기", () => {
  it("한 파일이 모드까지 합쳐 하나의 탭이 된다", () => {
    // 같은 파일을 뷰어와 편집기로 각각 여는 일은 없지만(`setTabMode` 가 자리를 갈아 끼운다),
    // 키가 경로뿐이면 그 규칙 자체를 표현할 수 없다.
    expect(tabKey({ path: "a.md", mode: "md" })).not.toBe(tabKey({ path: "a.md", mode: "text" }));
  });

  it("활성 탭이 살아 있으면 그 자리를 지킨다", () => {
    const out = keepTabs(TABS, "md|회의록.md", (t) => t.path !== "설계/도면.svg");
    expect(out.activeTab).toBe("md|회의록.md");
    expect(out.openTabs.map((t) => t.path)).toEqual(["index.md", "회의록.md"]);
  });

  it("활성 탭을 닫으면 남은 것 중 마지막이 활성이 된다", () => {
    const out = keepTabs(TABS, "text|index.md", (t) => t.path !== "index.md");
    expect(out.activeTab).toBe("text|설계/도면.svg");
  });

  it("전체를 닫으면 활성 탭도 비운다", () => {
    const out = keepTabs(TABS, "md|회의록.md", () => false);
    expect(out.openTabs).toEqual([]);
    // 빈 문자열이어야 편집기가 "열려 있는 파일이 없습니다" 를 그린다.
    expect(out.activeTab).toBe("");
  });

  it("이 탭만 남기면 그 탭이 활성이 된다", () => {
    const keep = "text|설계/도면.svg";
    const out = keepTabs(TABS, "text|index.md", (t) => tabKey(t) === keep);
    expect(out.openTabs).toHaveLength(1);
    expect(out.activeTab).toBe(keep);
  });

  it("옮겨 간 폴더 아래의 탭을 접두사로 걷어낸다", () => {
    // 업무 분할이 쓰는 길이다 — 폴더 하나를 옮기면 그 안의 탭이 전부 따라 닫힌다.
    const out = keepTabs(TABS, "text|설계/도면.svg", (t) => !t.path.startsWith("설계/"));
    expect(out.openTabs.map((t) => t.path)).toEqual(["index.md", "회의록.md"]);
    expect(out.activeTab).toBe("md|회의록.md");
  });
});
