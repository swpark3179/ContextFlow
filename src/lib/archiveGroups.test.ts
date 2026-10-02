import { describe, expect, it } from "vitest";
import { groupArchived } from "./archiveGroups";
import { knownCategories } from "./category";

const t = (
  folder: string,
  category: string | null,
  completedAt: string | null,
  archivedAt: string | null = null,
) => ({ folder, category, completedAt, archivedAt });

const shape = (groups: { key: string; label: string; count: number; items: { folder: string }[] }[]) =>
  groups.map((g) => [g.key, g.label, g.count, g.items.map((i) => i.folder)]);

describe("groupArchived — 분기", () => {
  it("이어지는 같은 분기끼리 묶는다(이전 보관함과 같은 결과)", () => {
    const sorted = [
      t("a", null, "2026-08-03"),
      t("b", "운영", "2026-07-01"),
      t("c", null, "2026-02-10"),
      t("d", "운영", "2025-12-31"),
    ];
    expect(shape(groupArchived(sorted, "quarter", knownCategories(sorted)))).toEqual([
      ["h:q:0:2026년 3분기", "2026년 3분기", 2, ["a", "b"]],
      ["h:q:1:2026년 1분기", "2026년 1분기", 1, ["c"]],
      ["h:q:2:2025년 4분기", "2025년 4분기", 1, ["d"]],
    ]);
  });

  it("완료일 없는 업무로 같은 라벨이 다시 나와도 따로 묶고 키는 겹치지 않는다", () => {
    // 완료일이 없으면 정렬은 맨 뒤지만 라벨은 보관일에서 온다.
    const sorted = [t("a", null, "2026-08-03"), t("b", null, "2026-02-10"), t("c", null, null, "2026-09-01")];
    const groups = groupArchived(sorted, "quarter", []);
    expect(shape(groups)).toEqual([
      ["h:q:0:2026년 3분기", "2026년 3분기", 1, ["a"]],
      ["h:q:1:2026년 1분기", "2026년 1분기", 1, ["b"]],
      ["h:q:2:2026년 3분기", "2026년 3분기", 1, ["c"]],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });
});

describe("groupArchived — 카테고리", () => {
  const archived = [
    t("1", "프로젝트/ContextFlow", "2026-09-01"),
    t("2", null, "2026-08-01"),
    t("3", "운영", "2026-07-01"),
    t("4", "프로젝트/contextflow", "2026-06-01"),
    t("5", "프로젝트/ContextFlow/UI", "2026-05-01"),
  ];
  const nodes = knownCategories(archived);

  it("전체 경로마다 평평하게, knownCategories 순서 · 미분류 맨 끝", () => {
    // `프로젝트` 는 직속 업무가 없어 묶음이 없다. 대소문자만 다른 4 는 1 과 한 묶음이고
    // 라벨은 nodes 의 철자다.
    expect(shape(groupArchived(archived, "category", nodes))).toEqual([
      ["h:c:운영", "운영", 1, ["3"]],
      ["h:c:프로젝트/contextflow", "프로젝트 › ContextFlow", 2, ["1", "4"]],
      ["h:c:프로젝트/contextflow/ui", "프로젝트 › ContextFlow › UI", 1, ["5"]],
      ["h:c:", "미분류", 1, ["2"]],
    ]);
  });

  it("묶음 안은 들어온 순서 그대로다", () => {
    const groups = groupArchived([...archived].reverse(), "category", nodes);
    expect(groups.find((g) => g.key === "h:c:프로젝트/contextflow")?.items.map((i) => i.folder)).toEqual([
      "4",
      "1",
    ]);
  });

  it("거른 뒤 남은 업무가 없는 카테고리는 묶음이 없다", () => {
    const sorted = archived.filter((x) => x.folder === "3" || x.folder === "5");
    expect(shape(groupArchived(sorted, "category", nodes))).toEqual([
      ["h:c:운영", "운영", 1, ["3"]],
      ["h:c:프로젝트/contextflow/ui", "프로젝트 › ContextFlow › UI", 1, ["5"]],
    ]);
  });
});
