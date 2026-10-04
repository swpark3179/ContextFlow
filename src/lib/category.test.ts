import { describe, expect, it } from "vitest";
import cases from "./category.cases.json";
import moves from "./category.move.json";
import tree from "./category.tree.json";
import {
  categoryErrorMessage,
  categoryKey,
  dropKind,
  flattenSideRows,
  HEAD_DWELL_MS,
  isWithin,
  keyOf,
  knownCategories,
  label,
  movePlan,
  normalizeCategory,
  openFor,
  parentOf,
  retarget,
  revealKeys,
  SEG_MAX,
  snapToExisting,
  suggestCategory,
  tabTarget,
  type SideRow,
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
  it("출력 전체 — 하위 경로는 상위의 표시 철자를 잇는다", () => {
    // 트리 · 보관함 묶기가 이 출력을 그대로 쓴다. 필드 하나라도 바뀌면 여기서 먼저 안다.
    const nodes = knownCategories(
      cats("Project/cf", "project/CF", "project/CF/ui", "project", "운영", null),
    );
    expect(nodes).toEqual([
      { key: "project", path: "project", name: "project", depth: 1, count: 4 },
      { key: "project/cf", path: "project/CF", name: "CF", depth: 2, count: 3 },
      { key: "project/cf/ui", path: "project/CF/ui", name: "ui", depth: 3, count: 1 },
      { key: "운영", path: "운영", name: "운영", depth: 1, count: 1 },
    ]);
  });

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

interface TreeCase {
  note: string;
  cats: (string | null)[];
  nodes: { key: string; path: string; depth: number; count: number }[];
}

describe("knownCategories — Rust 와 같은 fixture", () => {
  // 허브 노트(src-tauri/src/hub.rs)가 같은 트리를 Rust 로 다시 만든다. 순서 · 철자가 어긋나면
  // 사이드바와 Obsidian 의 카테고리가 서로 다르게 보인다.
  it.each((tree as TreeCase[]).map((c) => [c.note, c] as const))("%s", (_note, c) => {
    const nodes = knownCategories(cats(...c.cats));
    expect(nodes.map(({ key, path, depth, count }) => ({ key, path, depth, count }))).toEqual(c.nodes);
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

describe("tabTarget", () => {
  it("강조한 경로에 / 를 붙여 한 단계 내려간다", () => {
    expect(tabTarget("프로젝트", "")).toBe("프로젝트/");
    expect(tabTarget("프로젝트/ContextFlow", "프로젝트/")).toBe("프로젝트/ContextFlow/");
  });

  it("미분류 · 3단계는 내려갈 곳이 없어 가로채지 않는다", () => {
    expect(tabTarget(null, "운영")).toBeNull();
    expect(tabTarget("a/b/c", "a/b/")).toBeNull();
  });

  it("채워도 지금 값 그대로면 가로채지 않는다", () => {
    expect(tabTarget("프로젝트", "프로젝트/")).toBeNull();
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

  it("상위 3건 중 2건 이상이 같은 카테고리 — 철자는 더 위에 추천된 쪽", () => {
    expect(suggestCategory(["/a", "/b", "/c", "/d"], tasks)).toBe("프로젝트/CF");
    expect(suggestCategory(["/c", "/e", "/b"], tasks)).toBe("프로젝트/cf");
  });

  it("상위 3건 밖은 세지 않는다", () => {
    expect(suggestCategory(["/a", "/b", "/e", "/d"], tasks)).toBeNull();
  });

  it("제각각이면 제안하지 않는다", () => {
    expect(suggestCategory(["/e", "/c", "/a"], tasks)).toBeNull();
    expect(suggestCategory(["/a", "/b"], tasks)).toBeNull();
  });

  it("추천이 한 건뿐이면 그 업무의 카테고리", () => {
    expect(suggestCategory(["/b"], tasks)).toBe("프로젝트/CF");
  });

  it("카테고리가 없으면 null", () => {
    expect(suggestCategory(["/e"], tasks)).toBeNull();
    expect(suggestCategory([], tasks)).toBeNull();
  });
});

describe("keyOf · isWithin", () => {
  it("미분류의 키는 빈 문자열, 나머지는 소문자 전체 경로", () => {
    expect(keyOf(null)).toBe("");
    expect(keyOf("Project/CF")).toBe("project/cf");
  });

  it("하위까지 포함하고, 대소문자는 가리지 않는다", () => {
    expect(isWithin("Project/CF/UI", "project")).toBe(true);
    expect(isWithin("project/cf", "project/cf")).toBe(true);
    expect(isWithin("project", "project/cf")).toBe(false);
  });

  it("앞부분만 같은 형제는 하위가 아니다", () => {
    expect(isWithin("a/bc", "a/b")).toBe(false);
    expect(isWithin("ab", "a")).toBe(false);
  });

  it("빈 키는 미분류만이다", () => {
    expect(isWithin(null, "")).toBe(true);
    expect(isWithin("운영", "")).toBe(false);
    expect(isWithin(null, "운영")).toBe(false);
  });
});

describe("revealKeys · openFor", () => {
  it("조상 전부(자기 포함)의 키, 미분류는 빈 키 하나", () => {
    expect(revealKeys("프로젝트/ContextFlow/UI")).toEqual([
      "프로젝트",
      "프로젝트/contextflow",
      "프로젝트/contextflow/ui",
    ]);
    expect(revealKeys(null)).toEqual([""]);
  });

  it("닫힌 조상만 빼고, 다른 묶음의 접힘은 그대로 둔다", () => {
    const closed = ["운영", "프로젝트", "프로젝트/contextflow", ""];
    expect(openFor(closed, "프로젝트/ContextFlow")).toEqual(["운영", ""]);
    expect(openFor(closed, null)).toEqual(["운영", "프로젝트", "프로젝트/contextflow"]);
    // 새 배열이다 — 설정을 그 자리에서 고치지 않는다.
    expect(closed).toEqual(["운영", "프로젝트", "프로젝트/contextflow", ""]);
  });

  it("이미 다 열려 있으면 null — 설정을 다시 쓰지 않는다", () => {
    expect(openFor(["운영", "프로젝트/contextflow/ui"], "프로젝트/ContextFlow")).toBeNull();
    expect(openFor([], null)).toBeNull();
  });
});

describe("flattenSideRows", () => {
  const T = (id: string, category: string | null) => ({ id, category });
  // 전역 순서(수동 순서 · 최근 수정순)대로 섞여 있다.
  const live = [
    T("u1", null),
    T("p1", "프로젝트/ContextFlow"),
    T("o1", "운영"),
    T("p2", "프로젝트/ContextFlow/UI"),
    T("p3", "프로젝트/ContextFlow"),
    T("u2", null),
  ];
  const nodes = knownCategories(live);
  const flat = (
    visible: { id: string; category: string | null }[],
    closed: string[] = [],
    forceOpen = false,
  ) => flattenSideRows(visible, { nodes, closed, forceOpen });
  /** 한 줄씩 읽기 좋게 — 머리 행은 `▼ 경로 (개수)`, 업무 행은 `· id`. */
  const show = (rows: SideRow<{ id: string }>[]) =>
    rows.map((r) =>
      r.kind === "cat"
        ? `${r.open ? "▼" : "▶"} ${r.path || r.name} (${r.count})`
        : `· ${r.task.id}`,
    );

  it("머리 행 뒤에 직속 업무, 그다음 하위 — 미분류는 맨 끝", () => {
    expect(show(flat(live))).toEqual([
      "▼ 운영 (1)",
      "· o1",
      // 직속 업무가 없는 부모는 머리 행만 있다.
      "▼ 프로젝트 (3)",
      "▼ 프로젝트/ContextFlow (3)",
      "· p1",
      "· p3",
      "▼ 프로젝트/ContextFlow/UI (1)",
      "· p2",
      "▼ 미분류 (2)",
      "· u1",
      "· u2",
    ]);
  });

  it("깊이 — 업무 행은 든 묶음의 깊이, 미분류는 1", () => {
    const rows = flat(live);
    expect(rows.map((r) => (r.kind === "cat" ? r.depth : `${r.task.id}:${r.depth}`))).toEqual([
      1, "o1:1", 1, 2, "p1:2", "p3:2", 3, "p2:3", 1, "u1:1", "u2:1",
    ]);
    expect(rows.find((r) => r.kind === "cat" && r.key === "")).toEqual({
      kind: "cat",
      key: "",
      path: "",
      name: "미분류",
      depth: 1,
      count: 2,
      open: true,
    });
  });

  it("보이는 업무가 없는 노드는 그리지 않고, 개수는 보이는 것만 센다", () => {
    const visible = live.filter((t) => t.id !== "o1" && t.id !== "p2");
    expect(show(flat(visible))).toEqual([
      "▼ 프로젝트 (2)",
      "▼ 프로젝트/ContextFlow (2)",
      "· p1",
      "· p3",
      "▼ 미분류 (2)",
      "· u1",
      "· u2",
    ]);
  });

  it("미분류만 보여도 머리 행은 남는다 — 접어 둔 미분류를 다시 열 곳", () => {
    const visible = live.filter((t) => t.id === "u1");
    expect(show(flat(visible))).toEqual(["▼ 미분류 (1)", "· u1"]);
    expect(show(flat(visible, [""]))).toEqual(["▶ 미분류 (1)"]);
  });

  it("닫힌 노드는 하위 머리 행 · 업무 행을 감추고 개수는 그대로다", () => {
    expect(show(flat(live, ["프로젝트"]))).toEqual([
      "▼ 운영 (1)",
      "· o1",
      "▶ 프로젝트 (3)",
      "▼ 미분류 (2)",
      "· u1",
      "· u2",
    ]);
    expect(show(flat(live, ["프로젝트/contextflow"]))).toEqual([
      "▼ 운영 (1)",
      "· o1",
      "▼ 프로젝트 (3)",
      "▶ 프로젝트/ContextFlow (3)",
      "▼ 미분류 (2)",
      "· u1",
      "· u2",
    ]);
  });

  it("forceOpen 이면 접힘을 무시한다 — 검색 중", () => {
    expect(flat(live, ["프로젝트", "운영", ""], true)).toEqual(flat(live));
  });

  it("철자와 순서는 nodes 에서 온다 — 보이는 업무의 철자가 아니라", () => {
    const all = [T("a", "Project/CF"), T("b", "Project/CF"), T("c", "project/cf")];
    const nodes = knownCategories(all);
    const rows = flattenSideRows([all[2]], { nodes, closed: [], forceOpen: false });
    expect(show(rows)).toEqual(["▼ Project (1)", "▼ Project/CF (1)", "· c"]);
    expect(rows[1]).toMatchObject({ name: "CF", key: "project/cf" });
  });

  it("묶음마다 업무 행은 연속이고 입력의 부분열이며, gi 는 0..glen-1", () => {
    const rows = flat(live);
    const groups = new Map<string, number[]>();
    rows.forEach((r, i) => {
      if (r.kind === "task") groups.set(r.group, [...(groups.get(r.group) ?? []), i]);
    });
    expect([...groups.keys()]).toEqual(["운영", "프로젝트/contextflow", "프로젝트/contextflow/ui", ""]);
    for (const [group, at] of groups) {
      // 연속이다 — 사이에 다른 행이 끼지 않는다.
      expect(at).toEqual(at.map((_, k) => at[0] + k));
      const items = at.map((i) => rows[i] as Extract<SideRow<{ id: string }>, { kind: "task" }>);
      expect(items.map((r) => r.task.id)).toEqual(
        live.filter((t) => keyOf(t.category) === group).map((t) => t.id),
      );
      expect(items.map((r) => [r.gi, r.glen])).toEqual(items.map((_, k) => [k, items.length]));
    }
  });
});

interface Move {
  note: string;
  cat: string | null;
  from: string;
  to: string | null;
  result?: string | null;
  skip?: true;
  error?: "depth" | "reserved";
}

describe("dropKind", () => {
  // 끝 행 아래 반 행까지는 묶음 안의 맨 끝 자리(`at === glen`)로 친다 — 그 자리가 아래 묶음의 머리다.
  const END = 3;

  it("머리가 순서보다 먼저다 — 끝 행 아래로 넘친 자리가 아래 묶음 머리와 겹쳐도 카테고리 바꾸기", () => {
    expect(dropKind({ at: END, overKey: "b", group: "a", armed: true })).toBe("category");
    expect(dropKind({ at: 0, overKey: "a/x", group: "a", armed: true })).toBe("category");
    expect(dropKind({ at: -1, overKey: "b", group: "a", armed: true })).toBe("category");
  });

  it("300ms 전후 — 머물기 전에 놓은 넘침은 지금처럼 맨 끝으로 옮기기, 묶음 밖이면 취소", () => {
    expect(dropKind({ at: END, overKey: "b", group: "a", armed: false })).toBe("reorder");
    expect(dropKind({ at: -1, overKey: "b", group: "a", armed: false })).toBe("cancel");
    expect(dropKind({ at: END, overKey: "b", group: "a", armed: true })).toBe("category");
    // `armed` 는 머리 위에 이만큼 머문 뒤에 켜진다(사이드바의 50ms 타이머).
    expect(HEAD_DWELL_MS).toBe(300);
  });

  it("자기 머리에는 머물러도 바뀔 것이 없다 — 자리로만 가른다", () => {
    expect(dropKind({ at: 0, overKey: "a", group: "a", armed: true })).toBe("reorder");
    expect(dropKind({ at: -1, overKey: "a", group: "a", armed: true })).toBe("cancel");
  });

  it("미분류 머리 — 빈 키도 다른 묶음이고, 미분류 업무에게는 자기 머리다", () => {
    expect(dropKind({ at: -1, overKey: "", group: "a", armed: true })).toBe("category");
    expect(dropKind({ at: -1, overKey: "a", group: "", armed: true })).toBe("category");
    expect(dropKind({ at: 2, overKey: "", group: "", armed: true })).toBe("reorder");
    expect(dropKind({ at: -1, overKey: "", group: "", armed: true })).toBe("cancel");
  });

  it("머리 위가 아니거나 평평한 목록이면 자리로만 가른다", () => {
    expect(dropKind({ at: 1, overKey: null, group: "a", armed: false })).toBe("reorder");
    expect(dropKind({ at: -1, overKey: null, group: "a", armed: false })).toBe("cancel");
    expect(dropKind({ at: 4, overKey: "b", group: undefined, armed: true })).toBe("reorder");
  });
});

describe("retarget — Rust 와 같은 fixture", () => {
  it.each((moves as Move[]).map((c) => [c.note, c] as const))("%s", (_note, c) => {
    const got = retarget(c.cat, c.from, c.to);
    if (c.skip) expect(got).toBeNull();
    else if (c.error) expect(got).toEqual({ value: null, error: c.error });
    else expect(got).toEqual({ value: c.result, error: null });
  });
});

describe("parentOf", () => {
  it("한 단계 위 — 최상위 · 미분류는 null", () => {
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(parentOf("프로젝트/ContextFlow")).toBe("프로젝트");
    expect(parentOf("a")).toBeNull();
    expect(parentOf("")).toBeNull();
  });
});

describe("movePlan", () => {
  const T = (title: string, category: string | null, archived = false) => ({ title, category, archived });
  type Row = ReturnType<typeof T>;
  const plan = (tasks: Row[], from: string, to: string | null) => movePlan(tasks, from, to, (t) => t.archived);

  it("대상 · 보관 · 하위 카테고리 수 — 서브트리 전부, 진행과 보관을 함께", () => {
    const tasks = [
      T("1", "a/b"),
      T("2", "a/b/c", true),
      T("3", "A/B/c", true),
      T("4", "a/b/d"),
      T("5", "a/bc"),
      T("6", "a"),
      T("7", null),
    ];
    const p = plan(tasks, "a/b", "x");
    expect(p.targets.map((t) => t.title)).toEqual(["1", "2", "3", "4"]);
    expect(p.archived).toBe(2);
    expect(p.subcats).toBe(2);
    expect(p.invalid).toBeNull();
  });

  it("이름 바꾸기 — 꼬리는 업무 자신의 철자로 따라오고 예시는 가장 깊은 업무", () => {
    const p = plan([T("1", "프로젝트/CF"), T("2", "프로젝트/CF/UI"), T("3", "프로젝트/Tauri")], "프로젝트/cf", "프로젝트/ContextFlow");
    expect(p.value).toBe("프로젝트/ContextFlow");
    expect(p.merge).toBeNull();
    expect(p.errors).toEqual([]);
    expect(p.example).toEqual({ from: "프로젝트/CF/UI", to: "프로젝트/ContextFlow/UI" });
  });

  it("목적지는 서브트리 밖의 철자로 맞추고, 서브트리 자신의 철자로는 맞추지 않는다", () => {
    expect(plan([T("1", "운영"), T("2", "Proj/x")], "운영", " proj › 운영 ").value).toBe("Proj/운영");
    // 대소문자만 고치기 — 자기 철자로 되돌아오지 않는다.
    expect(plan([T("1", "proj/x"), T("2", "proj")], "proj", "Proj").value).toBe("Proj");
  });

  describe("합치기", () => {
    it("이미 있는 이름으로 바꾸면 합치기 — 이름은 그 카테고리 업무의 철자", () => {
      const p = plan([T("1", "a/b"), T("2", "a/b/x"), T("3", "A/C")], "a/b", "a/c");
      expect(p.merge).toEqual({ key: "a/c", label: "A › C" });
    });

    it("상위로 올렸는데 하위가 이미 있는 형제와 겹치면 합치기", () => {
      const p = plan([T("1", "a/b"), T("2", "a/b/c"), T("3", "a/c")], "a/b", "a");
      expect(p.example).toEqual({ from: "a/b/c", to: "a/c" });
      expect(p.merge).toEqual({ key: "a/c", label: "a › c" });
    });

    it("최상위로 올렸는데 하위가 이미 있는 최상위와 겹치면 합치기 — 가장 얕은 키", () => {
      const p = plan([T("1", "a"), T("2", "a/x/y"), T("3", "X/y")], "a", null);
      expect(p.merge).toEqual({ key: "x", label: "X" });
    });

    it("이미 있는 부모 아래로 · 대소문자 고치기 · 형제만 있는 상위로 올리기는 합치기가 아니다", () => {
      const tasks = [T("1", "운영/점검"), T("2", "프로젝트/CF"), T("3", "a/b/c"), T("4", "a/d")];
      expect(plan(tasks, "운영", "프로젝트/운영").merge).toBeNull();
      expect(plan([T("1", "proj/x"), T("2", "proj")], "proj", "Proj").merge).toBeNull();
      expect(plan(tasks, "a/b", "a").merge).toBeNull();
      expect(plan([T("1", "a"), T("2", "a/x"), T("3", "y")], "a", null).merge).toBeNull();
    });
  });

  it("규칙을 어기는 업무를 모두 모은다 — 4단계 · 최상위에서 미분류", () => {
    const deep = plan([T("얕음", "a/b"), T("깊음", "a/b/c"), T("또", "a/x/y")], "a", "x/y");
    expect(deep.errors).toEqual([
      { title: "깊음", code: "depth" },
      { title: "또", code: "depth" },
    ]);
    expect(deep.example).toEqual({ from: "a/b", to: "x/y/b" });

    const top = plan([T("1", "a"), T("2", "a/미분류"), T("3", "a/null"), T("4", "a/x")], "a", null);
    expect(top.errors).toEqual([
      { title: "2", code: "reserved" },
      { title: "3", code: "reserved" },
    ]);
    expect(top.example).toEqual({ from: "a/x", to: "x" });
  });

  it("손으로 접힌 셋째 단계가 30자를 넘으면 옮길 때 잘리므로 4단계와 같은 오류", () => {
    const folded = `a/b/${"가".repeat(20)} · ${"나".repeat(20)}`;
    expect(plan([T("1", folded), T("2", "a/c")], "a", "x").errors).toEqual([{ title: "1", code: "depth" }]);
  });

  it("목적지가 안 되면 사유만 — 빈 칸 · 미분류 · 규칙 위반 · 자기 하위", () => {
    const tasks = [T("1", "a/b"), T("2", "a/b/c")];
    const msg = "옮길 경로를 입력하세요 — 미분류로 돌리려면 [해제] 를 쓰세요";
    expect(plan(tasks, "a/b", "").invalid).toBe(msg);
    expect(plan(tasks, "a/b", "  ").invalid).toBe(msg);
    expect(plan(tasks, "a/b", "미분류").invalid).toBe(msg);
    expect(plan(tasks, "a/b", "미분류/x").invalid).toBe("‘미분류’는 카테고리 이름으로 쓸 수 없습니다");
    expect(plan(tasks, "a/b", "x/y/z/w").invalid).toBe("카테고리는 3단계까지입니다");
    expect(plan(tasks, "a/b", "A/B/x").invalid).toBe("자기 하위 카테고리로는 옮길 수 없습니다");
    const p = plan(tasks, "a/b", "a/b/c");
    expect(p).toMatchObject({ targets: tasks, subcats: 1, merge: null, errors: [], example: null });
    // 앞부분만 같은 형제는 하위가 아니다.
    expect(plan(tasks, "a/b", "a/bc").invalid).toBeNull();
  });

  it("최상위로 올리기 — 노드 자신의 업무는 미분류, 하위는 최상위", () => {
    const p = plan([T("1", "a"), T("2", "a/x")], "a", null);
    expect(p).toMatchObject({ value: null, invalid: null, errors: [], example: { from: "a/x", to: "x" } });
  });
});
