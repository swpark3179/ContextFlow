import { describe, expect, it } from "vitest";
import { knownCategories } from "../category";
import fixture from "./categories.json";
import {
  categoryPageCounts,
  inCategory,
  narrowHits,
  pageCategoryKeys,
  pageChips,
  taskCategories,
  wikiCategoryView,
  type CatPage,
  type CatTask,
} from "./categories";

/** 그 경우의 모든 노드 키, 그리고 미분류 업무가 있으면 `""`. */
function keysOf(tasks: CatTask[]): string[] {
  const keys = knownCategories(tasks).map((n) => n.key);
  return tasks.some((t) => !t.category) ? [...keys, ""] : keys;
}

describe("위키 페이지의 카테고리 — Rust 허브와 같은 fixture", () => {
  // 허브 노트(src-tauri/src/hub.rs)가 같은 fixture 로 같은 답을 낸다. 어긋나면 위키 화면에서 고른
  // 카테고리의 페이지와 Obsidian 허브의 '위키' 절이 서로 다르게 보인다.
  it.each(fixture.map((c) => [c.note, c] as const))("%s", (_note, c) => {
    const idx = taskCategories(c.tasks);
    // 경우마다 키가 달라 JSON 의 추론 타입에는 없는 키가 `?: undefined` 로 붙는다.
    const want: Record<string, string[] | undefined> = c.expect;
    // 기대의 키 집합이 노드 전부(+ 미분류)라야 "어디에도 없음" 이 증명된다.
    expect(Object.keys(want).sort()).toEqual(keysOf(c.tasks).sort());
    for (const key of keysOf(c.tasks)) {
      const got = c.pages
        .filter((p) => inCategory(p, key, idx))
        .map((p) => p.path)
        .sort();
      expect([key, got]).toEqual([key, want[key]]);
    }
  });

  it.each(fixture.map((c) => [c.note, c] as const))("개수는 키마다 inCategory 로 센 것과 같다 — %s", (_note, c) => {
    const idx = taskCategories(c.tasks);
    const counts = categoryPageCounts(c.pages, idx);
    for (const key of new Set([...keysOf(c.tasks), ""])) {
      expect([key, counts.get(key) ?? 0]).toEqual([key, c.pages.filter((p) => inCategory(p, key, idx)).length]);
    }
    // 페이지가 없는 키는 싣지 않는다 — 실린 키는 모두 노드(또는 미분류)다.
    expect([...counts.keys()].every((k) => keysOf(c.tasks).includes(k))).toBe(true);
    expect([...counts.values()].every((n) => n > 0)).toBe(true);
  });
});

const task = (id: string, category: string | null): CatTask => ({ id, category });
const source = (path: string, taskId: string | null, sources: string[] = taskId ? [taskId] : []): CatPage => ({
  path,
  kind: "source",
  taskId,
  sources,
});
const topic = (path: string, ...sources: string[]): CatPage => ({ path, kind: "topic", taskId: null, sources });

describe("pageCategoryKeys · categoryPageCounts", () => {
  it("직접 든 키만 중복 없이 트리 순서로, 미분류는 맨 끝", () => {
    const idx = taskCategories([
      task("1", "a b/x"),
      task("2", null),
      task("3", "a/b"),
      task("4", "Kube"),
      task("5", "kube"),
      task("6", "a"),
    ]);
    // 키 문자열을 통째로 견주면 `a b/x` 가 `a/b` 앞에 온다 — `knownCategories` 와 같게 단계마다.
    const all = topic("t.md", "1", "2", "3", "4", "5", "6");
    expect(pageCategoryKeys(all, idx)).toEqual(["a", "a/b", "a b/x", "kube", ""]);
    expect(pageCategoryKeys(topic("t.md", "없음"), idx)).toEqual([]);
  });

  it("상위 노드는 하위의 합이 아니라 합집합이다", () => {
    const idx = taskCategories([task("x", "a/b"), task("y", "a/c")]);
    const counts = categoryPageCounts([topic("both.md", "x", "y"), source("sources/x.md", "x")], idx);
    expect(Object.fromEntries(counts)).toEqual({ a: 2, "a/b": 2, "a/c": 1 });
  });
});

describe("wikiCategoryView", () => {
  const tasks = [
    task("1", "프로젝트/ContextFlow"),
    task("2", "프로젝트/Other"),
    task("3", "운영"),
    task("4", null),
    task("5", "프로젝트/contextflow/UI"),
  ];
  const pages = [source("sources/1.md", "1"), topic("topics/ui.md", "5", "4"), topic("answers/a.md")];

  it("선택지는 페이지가 있는 노드만 트리 순서로 — 업무만 있는 노드는 빠지고 미분류는 끝", () => {
    const v = wikiCategoryView(tasks, pages, null);
    expect(v.opts).toEqual([
      { key: "프로젝트", path: "프로젝트", name: "프로젝트", depth: 1, count: 2 },
      { key: "프로젝트/contextflow", path: "프로젝트/ContextFlow", name: "ContextFlow", depth: 2, count: 2 },
      { key: "프로젝트/contextflow/ui", path: "프로젝트/ContextFlow/UI", name: "UI", depth: 3, count: 1 },
      { key: "", path: "", name: "미분류", depth: 1, count: 1 },
    ]);
    // 노드 · 표시 철자는 전체 업무 기준이다 — 페이지가 없는 노드도 든다.
    expect(v.nodes.map((n) => n.key)).toEqual([
      "운영",
      "프로젝트",
      "프로젝트/contextflow",
      "프로젝트/contextflow/ui",
      "프로젝트/other",
    ]);
    expect(v.byKey.get("프로젝트/other")?.path).toBe("프로젝트/Other");
    expect(v.hasCats).toBe(true);
  });

  it("거르지 않으면 받은 배열 그대로, 고르면 하위까지 거른다", () => {
    expect(wikiCategoryView(tasks, pages, null)).toMatchObject({ effCat: null, shown: pages });
    expect(wikiCategoryView(tasks, pages, null).shown).toBe(pages);

    const v = wikiCategoryView(tasks, pages, "프로젝트");
    expect(v.effCat).toBe("프로젝트");
    expect(v.shown.map((p) => p.path)).toEqual(["sources/1.md", "topics/ui.md"]);
    expect(wikiCategoryView(tasks, pages, "").shown.map((p) => p.path)).toEqual(["topics/ui.md"]);
  });

  it("고른 키에 페이지가 없으면 전체로 돌아간다 — 없는 키 · 업무만 있는 노드 · 미분류 페이지가 없는 미분류", () => {
    for (const sel of ["없는/키", "운영", "프로젝트/other"]) {
      const v = wikiCategoryView(tasks, pages, sel);
      expect([sel, v.effCat]).toEqual([sel, null]);
      expect(v.shown).toBe(pages);
    }
    // 미분류 업무는 있지만 그 업무의 페이지가 없다.
    const only = [source("sources/1.md", "1")];
    expect(wikiCategoryView(tasks, only, "").effCat).toBeNull();
    expect(wikiCategoryView(tasks, only, null).opts.map((o) => o.key)).toEqual(["프로젝트", "프로젝트/contextflow"]);
  });

  it("카테고리 노드에 페이지가 없으면 hasCats 가 거짓 — 미분류만 있어도", () => {
    const v = wikiCategoryView([task("1", "a"), task("2", null)], [source("sources/2.md", "2")], "");
    expect(v.opts).toEqual([{ key: "", path: "", name: "미분류", depth: 1, count: 1 }]);
    expect(v.hasCats).toBe(false);
    // 미분류를 고른 채면 그 값은 살아 있다 — 화면은 이때 고르기를 남겨 [전체] 로 돌아갈 수 있게 한다.
    expect(v.effCat).toBe("");

    const plain = wikiCategoryView([task("1", null)], [source("sources/1.md", "1")], null);
    expect([plain.nodes, plain.hasCats]).toEqual([[], false]);
    expect(wikiCategoryView([], [topic("answers/a.md")], null)).toMatchObject({ opts: [], hasCats: false });
  });
});

describe("narrowHits", () => {
  // 관련도 순 — 경로 순서와 다르다.
  const hits = Array.from({ length: 50 }, (_, i) => ({ path: `p${49 - i}.md`, i }));
  const even = hits.filter((h) => h.i % 2 === 0).map((h) => h.path);

  it("거른 뒤에 자른다 — 순서는 그대로", () => {
    const got = narrowHits(hits, new Set(even));
    expect(got.map((h) => h.i)).toEqual(Array.from({ length: 25 }, (_, i) => i * 2));
    expect(narrowHits(hits, even, 10).map((h) => h.path)).toEqual(even.slice(0, 10));
  });

  it("경로가 null 이면 자르기만", () => {
    expect(narrowHits(hits, null)).toEqual(hits.slice(0, 30));
    expect(narrowHits(hits, null, 5)).toEqual(hits.slice(0, 5));
    expect(narrowHits(hits, [])).toEqual([]);
  });
});

describe("pageChips", () => {
  const tasks = [task("1", "Proj/CF"), task("2", "proj/cf"), task("3", "운영"), task("4", null), task("5", "Proj/CF")];
  const idx = taskCategories(tasks);
  const byKey = new Map(knownCategories(tasks).map((n) => [n.key, n]));

  it("앞의 둘과 나머지 — 철자는 노드의 것, 미분류는 미분류", () => {
    // 페이지의 업무는 `proj/cf` 로 썼지만 노드의 표시 철자(가장 많이 쓴 것)로 보인다.
    expect(pageChips(topic("t.md", "4", "3", "2"), idx, byKey)).toEqual({
      chips: [
        { key: "proj/cf", path: "Proj/CF" },
        { key: "운영", path: "운영" },
      ],
      rest: [{ key: "", path: "미분류" }],
    });
    expect(pageChips(topic("t.md", "4", "3", "2"), idx, byKey, 3).rest).toEqual([]);
  });

  it("소스 페이지는 자기 업무 것만, 이어지지 않은 페이지는 칩이 없다", () => {
    expect(pageChips(source("sources/4.md", "4", ["4", "3"]), idx, byKey)).toEqual({
      chips: [{ key: "", path: "미분류" }],
      rest: [],
    });
    expect(pageChips(topic("answers/a.md"), idx, byKey)).toEqual({ chips: [], rest: [] });
  });
});
