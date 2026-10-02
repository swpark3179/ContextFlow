import { describe, expect, it } from "vitest";
import cases from "./category.cases.json";
import {
  categoryErrorMessage,
  categoryKey,
  knownCategories,
  label,
  normalizeCategory,
  SEG_MAX,
  snapToExisting,
  suggestCategory,
} from "./category";

interface Case {
  note: string;
  input: string;
  mode: "write" | "read";
  value?: string | null;
  error?: "depth" | "reserved";
}

describe("normalizeCategory — Rust 와 같은 fixture", () => {
  it.each((cases as Case[]).map((c) => [c.note, c] as const))("%s", (_note, c) => {
    const got = normalizeCategory(c.input, c.mode);
    if (c.error) expect(got).toEqual({ value: null, error: c.error });
    else expect(got).toEqual({ value: c.value, error: null });
  });

  it("모드를 생략하면 쓰기 규칙이다", () => {
    expect(normalizeCategory("a/b/c/d").error).toBe("depth");
  });

  it("U+0085 도 공백이다 — JS 의 trim 이 놓치는 글자", () => {
    expect(normalizeCategory("\u0085운영\u0085점검\u0085").value).toBe("운영 점검");
  });

  it("세그먼트마다 따로 자른다", () => {
    const long = "가".repeat(SEG_MAX + 5);
    expect(normalizeCategory(`${long}/${long}`).value).toBe(`${"가".repeat(SEG_MAX)}/${"가".repeat(SEG_MAX)}`);
  });

  it("오류 문구", () => {
    expect(categoryErrorMessage("depth")).toBe("카테고리는 3단계까지입니다");
    expect(categoryErrorMessage("reserved")).toBe("‘미분류’는 카테고리 이름으로 쓸 수 없습니다");
  });
});

describe("label · categoryKey", () => {
  it("화면에는 › 로 잇고, 없으면 미분류", () => {
    expect(label("프로젝트/ContextFlow/UI")).toBe("프로젝트 › ContextFlow › UI");
    expect(label("운영")).toBe("운영");
    expect(label(null)).toBe("미분류");
  });

  it("대소문자만 다른 것은 같은 키", () => {
    expect(categoryKey("Project/ContextFlow")).toBe(categoryKey("project/contextflow"));
  });
});

const cats = (...values: (string | null)[]) => values.map((category) => ({ category }));

describe("knownCategories", () => {
  it("하위 업무만 있어도 상위가 생기고, 개수는 하위까지 센다", () => {
    const nodes = knownCategories(cats("프로젝트/ContextFlow/UI", "프로젝트/ContextFlow", null, "운영"));
    expect(nodes.map((n) => [n.path, n.depth, n.count])).toEqual([
      ["운영", 1, 1],
      ["프로젝트", 1, 2],
      ["프로젝트/ContextFlow", 2, 2],
      ["프로젝트/ContextFlow/UI", 3, 1],
    ]);
  });

  it("대소문자 변형은 한 노드이고, 가장 많이 쓴 철자로 보인다", () => {
    const nodes = knownCategories(
      cats("Project/cf", "project/CF", "project/CF/ui", "project"),
    );
    expect(nodes.map((n) => n.path)).toEqual(["project", "project/CF", "project/CF/ui"]);
    expect(nodes[0]).toMatchObject({ key: "project", name: "project", count: 4 });
  });

  it("철자 수가 같으면 코드포인트 순으로 앞선 철자", () => {
    expect(knownCategories(cats("ops", "Ops"))[0].name).toBe("Ops");
  });

  it("형제는 세그먼트 키를 단계마다 코드포인트로 비교한다", () => {
    const nodes = knownCategories(
      cats("a b/x", "a/b", "a-b", "B", "\u{1F600}", "！", "가", "a"),
    );
    // 문자열 전체를 비교하면 `a b/x` 가 `a/b` 사이에 끼고, localeCompare 는 공백 ·
    // 구두점을 건너뛰며, UTF-16 비교는 이모지(서로게이트)를 U+FF01 앞에 둔다.
    expect(nodes.map((n) => n.path)).toEqual([
      "a",
      "a/b",
      "a b",
      "a b/x",
      "a-b",
      "B",
      "가",
      "！",
      "\u{1F600}",
    ]);
  });
});

describe("snapToExisting", () => {
  const nodes = knownCategories(cats("프로젝트/ContextFlow/UI", "Ops"));

  it("이미 있는 상위는 알려진 철자로 맞추고 새 부분은 그대로 둔다", () => {
    expect(snapToExisting("프로젝트/contextflow/새것", nodes)).toBe("프로젝트/ContextFlow/새것");
    expect(snapToExisting("ops", nodes)).toBe("Ops");
    expect(snapToExisting("새것/contextflow", nodes)).toBe("새것/contextflow");
  });
});

describe("suggestCategory", () => {
  const tasks = [
    { folder: "/a", category: "운영" },
    { folder: "/b", category: "프로젝트/CF" },
    { folder: "/c", category: "프로젝트/cf" },
    { folder: "/d", category: "운영" },
    { folder: "/e", category: null },
  ];

  it("상위 3건 중 가장 많은 카테고리", () => {
    expect(suggestCategory(["/a", "/b", "/c", "/d"], tasks)).toBe("프로젝트/CF");
  });

  it("같으면 더 위에 추천된 쪽", () => {
    expect(suggestCategory(["/e", "/c", "/a"], tasks)).toBe("프로젝트/cf");
  });

  it("카테고리가 없으면 null", () => {
    expect(suggestCategory(["/e"], tasks)).toBeNull();
    expect(suggestCategory([], tasks)).toBeNull();
  });
});
