import { describe, expect, it } from "vitest";
import {
  addChildAt,
  ancestorTitles,
  layout,
  mapAt,
  newNode,
  nodeAt,
  parseBstorm,
  removeAt,
  seedBstorm,
  serializeBstorm,
  setFm,
  TREE_HEADING,
  trimmedBlock,
  trimmedLine,
  walkNodes,
  type BsNode,
} from "./bstorm";

/** 인스펙터가 노드 하나를 고쳤을 때 실제로 일어나는 일 — 직렬화하고 다시 읽는다. */
function roundTrip(n: Partial<BsNode>): BsNode {
  const roots = [{ ...newNode("뿌리"), ...n }];
  const out = serializeBstorm({ fmLines: [], before: "", after: "", roots });
  return parseBstorm(out).roots[0];
}

const DOC = `---
type: brainstorm
title: 온보딩 이탈 개선
tags: [onboarding]
---

${TREE_HEADING}

- 온보딩 첫 주 이탈이 42%다
    - 🔍 첫 화면에서 가장 많이 빠진다
        - ✅ 입력 필드를 3개로 줄인다
            세 개까지는 이탈이 완만하다.
            ![[attachments/funnel.png]]
            근거:: 세션 리플레이 40건 중 31건이 3번째 필드에서 멈췄다
            리스크:: 세그먼트 정보를 잃는다
        - ❌ 튜토리얼 영상을 넣는다
            폐기:: 제작 비용 대비 예상 효과가 낮다
    - ⏸ 알림 타이밍을 바꾼다
`;

describe("parseBstorm", () => {
  it("reads the nested bullets as a tree", () => {
    const doc = parseBstorm(DOC);
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0].title).toBe("온보딩 첫 주 이탈이 42%다");
    expect(doc.roots[0].children).toHaveLength(2);
    expect(doc.roots[0].children[0].children).toHaveLength(2);
  });

  it("reads the leading emoji as the status and drops it from the title", () => {
    const doc = parseBstorm(DOC);
    const first = doc.roots[0].children[0];
    expect(first.status).toBe("explore");
    expect(first.title).toBe("첫 화면에서 가장 많이 빠진다");
    expect(first.children[0].status).toBe("adopted");
    expect(first.children[0].title).toBe("입력 필드를 3개로 줄인다");
    expect(first.children[1].status).toBe("dropped");
    expect(doc.roots[0].children[1].status).toBe("hold");
  });

  it("reads an explicit 🔍 even though serializing never writes one", () => {
    // 형식 문서가 🔍 를 탐색중으로 규정한다. 손으로 적어 넣은 것을 제목에 남기면 안 된다.
    const n = parseBstorm(`${TREE_HEADING}\n\n- 🔍 손으로 적은 표시\n`).roots[0];
    expect(n.status).toBe("explore");
    expect(n.title).toBe("손으로 적은 표시");
  });

  it("treats a bullet with no emoji as exploring", () => {
    expect(parseBstorm(`${TREE_HEADING}\n\n- 그냥 생각\n`).roots[0].status).toBe("explore");
  });

  it("keeps inline fields as evidence instead of turning them into children", () => {
    const adopted = parseBstorm(DOC).roots[0].children[0].children[0];
    expect(adopted.children).toHaveLength(0);
    expect(adopted.evidence).toEqual([
      { kind: "근거", text: "세션 리플레이 40건 중 31건이 3번째 필드에서 멈췄다" },
      { kind: "리스크", text: "세그먼트 정보를 잃는다" },
    ]);
    expect(adopted.detail).toBe("세 개까지는 이탈이 완만하다.");
  });

  it("reads an Obsidian embed as an attached image, not as detail", () => {
    const adopted = parseBstorm(DOC).roots[0].children[0].children[0];
    expect(adopted.images).toEqual(["attachments/funnel.png"]);
    expect(adopted.detail).not.toContain("funnel");
  });

  it("puts the 폐기 field on reason, not on the evidence list", () => {
    const dropped = parseBstorm(DOC).roots[0].children[0].children[1];
    expect(dropped.reason).toBe("제작 비용 대비 예상 효과가 낮다");
    expect(dropped.evidence).toHaveLength(0);
  });

  it("survives an indent width other than four", () => {
    // Obsidian 의 들여쓰기 설정은 사람마다 다르다. 2칸으로 적은 파일도 같은 트리여야 한다.
    const two = parseBstorm(`${TREE_HEADING}\n\n- 뿌리\n  - 자식\n    - 손자\n`);
    expect(two.roots[0].children[0].children[0].title).toBe("손자");
  });

  it("recovers when a level is skipped", () => {
    // 손으로 고치다 한 단계를 건너뛰어도 트리가 무너지지 않아야 한다.
    const doc = parseBstorm(`${TREE_HEADING}\n\n- 뿌리\n        - 갑자기 깊은 자식\n- 다음 뿌리\n`);
    expect(doc.roots).toHaveLength(2);
    expect(doc.roots[0].children[0].title).toBe("갑자기 깊은 자식");
  });

  it("has no roots and keeps the body when the anchor heading is missing", () => {
    // 앵커가 없으면 산문을 노드로 바꾸지 않는다 — 본문을 그대로 두는 편이 되돌릴 수 있다.
    const doc = parseBstorm("---\ntitle: x\n---\n\n그냥 메모다.\n");
    expect(doc.roots).toEqual([]);
    expect(doc.before).toBe("그냥 메모다.");
  });

  it("is empty for empty input", () => {
    const doc = parseBstorm("");
    expect(doc.roots).toEqual([]);
    expect(doc.fmLines).toEqual([]);
  });

  it("keeps a section that follows the tree", () => {
    const doc = parseBstorm(`${TREE_HEADING}\n\n- 뿌리\n\n## 메모\n\n손으로 쓴 글\n`);
    expect(doc.roots).toHaveLength(1);
    expect(doc.after).toContain("## 메모");
    expect(doc.after).toContain("손으로 쓴 글");
  });
});

describe("serializeBstorm", () => {
  it("round-trips a document without drifting", () => {
    const once = serializeBstorm(parseBstorm(DOC));
    const twice = serializeBstorm(parseBstorm(once));
    expect(twice).toBe(once);
    expect(parseBstorm(once).roots).toEqual(parseBstorm(DOC).roots);
  });

  it("writes no emoji for an exploring node", () => {
    const out = serializeBstorm({ fmLines: [], before: "", after: "", roots: [newNode("생각")] });
    expect(out).toContain("- 생각");
    expect(out).not.toContain("🔍");
  });

  it("keeps frontmatter keys it does not understand", () => {
    const out = serializeBstorm(parseBstorm("---\nmine: 42\n---\n\n" + TREE_HEADING + "\n\n- a\n"));
    expect(out).toContain("mine: 42");
  });

  it("keeps a reason even when the node is no longer dropped", () => {
    // 상태를 되돌렸다고 사용자가 적어 둔 이유를 지우지 않는다.
    const doc = parseBstorm(DOC);
    const revived = mapAt(doc.roots, "0.0.1", (n) => ({ ...n, status: "explore" as const }));
    expect(serializeBstorm({ ...doc, roots: revived })).toContain("폐기:: 제작 비용");
  });

  it("keeps a title that itself starts with a status emoji", () => {
    // 붙이지 않으면 다시 읽을 때 사용자의 이모지를 상태로 삼킨다 — 제목에서 사라지고
    // 상태까지 바뀐다. 탐색중이라도 이때만 🔍 를 앞에 세운다.
    const roots = [{ ...newNode("✅ 끝났다"), status: "explore" as const }];
    const out = serializeBstorm({ fmLines: [], before: "", after: "", roots });
    const back = parseBstorm(out).roots[0];
    expect(back.status).toBe("explore");
    expect(back.title).toBe("✅ 끝났다");
    expect(serializeBstorm(parseBstorm(out))).toBe(out);
  });

  it("round-trips a node whose title is still empty", () => {
    // 캔버스에서 ＋ 를 누르면 제목이 빈 노드가 먼저 생긴다. 이것이 다시 읽을 때 사라지면
    // 생각을 추가해도 화면에 아무것도 나타나지 않는다.
    const roots = [{ ...newNode("뿌리"), children: [newNode("")] }];
    const out = serializeBstorm({ fmLines: [], before: "", after: "", roots });
    expect(out).not.toMatch(/[ \t]+$/m);
    const back = parseBstorm(out).roots[0];
    expect(back.children).toHaveLength(1);
    expect(back.children[0].title).toBe("");
  });

  it("does not read a horizontal rule as an empty bullet", () => {
    expect(parseBstorm(`${TREE_HEADING}\n\n- 뿌리\n\n---\n`).roots).toHaveLength(1);
  });

  it("ends with exactly one newline", () => {
    const out = serializeBstorm(parseBstorm(DOC));
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

describe("편집 중인 값", () => {
  // 인스펙터의 입력칸은 이 왕복을 거친 값을 다시 화면에 띄운다. 왕복이 지워 버리는 것은
  // 곧 타이핑할 수 없는 것이다 — 스페이스바와 Enter 가 먹히지 않던 원인이 여기였다.

  it("keeps an evidence row that has no text yet", () => {
    // [＋ 근거] 로 만든 빈 칸이 여기서 사라지면 버튼이 아무 일도 안 하는 것처럼 보인다.
    const back = roundTrip({ evidence: [{ kind: "근거", text: "" }] });
    expect(back.evidence).toEqual([{ kind: "근거", text: "" }]);
  });

  it("writes an empty evidence row without trailing whitespace", () => {
    const out = serializeBstorm({
      fmLines: [],
      before: "",
      after: "",
      roots: [{ ...newNode("뿌리"), evidence: [{ kind: "질문", text: "" }] }],
    });
    expect(out).toContain("질문::");
    expect(out).not.toMatch(/[ \t]+$/m);
    expect(serializeBstorm(parseBstorm(out))).toBe(out);
  });

  it("keeps every line of a multi-line detail", () => {
    expect(roundTrip({ detail: "첫 줄\n둘째 줄\n셋째 줄" }).detail).toBe("첫 줄\n둘째 줄\n셋째 줄");
  });

  it("trims exactly what trimmedLine and trimmedBlock say it trims", () => {
    // 이 둘이 왕복과 어긋나면 입력칸이 자기 메아리를 남의 변경으로 오해해서, 방금 친
    // 글자를 되돌려 버린다(`BrainstormBits.tsx`).
    const typed = { title: "띄어 쓰는 중 ", detail: "첫 줄\n", reason: " 왜 접었나 " };
    const back = roundTrip({ ...typed, evidence: [{ kind: "리스크", text: "아직 적는 중 " }] });
    expect(back.title).toBe(trimmedLine(typed.title));
    expect(back.detail).toBe(trimmedBlock(typed.detail));
    expect(back.reason).toBe(trimmedLine(typed.reason));
    expect(back.evidence[0].text).toBe(trimmedLine("아직 적는 중 "));
  });
});

describe("walkNodes", () => {
  it("flattens the whole tree in reading order with depths", () => {
    const walked = walkNodes(parseBstorm(DOC).roots);
    expect(walked.map((w) => w.path)).toEqual(["0", "0.0", "0.0.0", "0.0.1", "0.1"]);
    expect(walked.map((w) => w.depth)).toEqual([0, 1, 2, 2, 1]);
  });

  it("includes branches the canvas has collapsed", () => {
    // 개요와 결정 로그는 "전부 보는" 화면이다. 캔버스에서 무엇을 접었는지와 무관해야 한다.
    expect(walkNodes(parseBstorm(DOC).roots)).toHaveLength(5);
  });

  it("is empty for an empty tree", () => {
    expect(walkNodes([])).toEqual([]);
  });
});

describe("ancestorTitles", () => {
  it("lists the titles from the root down to the parent", () => {
    const roots = parseBstorm(DOC).roots;
    expect(ancestorTitles(roots, "0.0.0")).toEqual([
      "온보딩 첫 주 이탈이 42%다",
      "첫 화면에서 가장 많이 빠진다",
    ]);
  });

  it("is empty for a root node", () => {
    expect(ancestorTitles(parseBstorm(DOC).roots, "0")).toEqual([]);
  });
});

describe("seedBstorm", () => {
  it("plants one root named after the file", () => {
    const doc = parseBstorm(seedBstorm("온보딩 이탈 개선", "2026-08-22 14:37"));
    expect(doc.roots).toHaveLength(1);
    expect(doc.roots[0].title).toBe("온보딩 이탈 개선");
    expect(doc.fmLines).toContain("type: brainstorm");
  });

  it("quotes a title that would break the YAML scalar", () => {
    expect(seedBstorm("a: b", "now")).toContain('title: "a: b"');
  });
});

describe("setFm", () => {
  it("replaces a key in place and leaves the order alone", () => {
    expect(setFm(["a: 1", "b: 2"], "a", "9")).toEqual(["a: 9", "b: 2"]);
  });

  it("appends a key that is not there yet", () => {
    expect(setFm(["a: 1"], "b", "2")).toEqual(["a: 1", "b: 2"]);
  });
});

describe("tree edits", () => {
  const roots = parseBstorm(DOC).roots;

  it("finds a node by its path", () => {
    expect(nodeAt(roots, "0.0.0")!.title).toBe("입력 필드를 3개로 줄인다");
    expect(nodeAt(roots, "9.9")).toBeNull();
    expect(nodeAt(roots, "")).toBeNull();
  });

  it("replaces only the node at the path", () => {
    const next = mapAt(roots, "0.1", (n) => ({ ...n, title: "바뀜" }));
    expect(nodeAt(next, "0.1")!.title).toBe("바뀜");
    expect(nodeAt(next, "0.0")!.title).toBe(nodeAt(roots, "0.0")!.title);
    expect(nodeAt(roots, "0.1")!.title).toBe("알림 타이밍을 바꾼다");
  });

  it("removes a node together with its whole subtree", () => {
    const next = removeAt(roots, "0.0");
    expect(nodeAt(next, "0")!.children).toHaveLength(1);
    expect(nodeAt(next, "0.0")!.title).toBe("알림 타이밍을 바꾼다");
  });

  it("appends a child and reports where it landed", () => {
    const { roots: next, path } = addChildAt(roots, "0.1", "새 생각");
    expect(path).toBe("0.1.0");
    expect(nodeAt(next, path)!.title).toBe("새 생각");
  });

  it("appends a root when the path is empty", () => {
    const { roots: next, path } = addChildAt(roots, "", "새 뿌리");
    expect(path).toBe("1");
    expect(nodeAt(next, "1")!.title).toBe("새 뿌리");
  });
});

describe("layout", () => {
  const roots = parseBstorm(DOC).roots;

  it("places every node once", () => {
    expect(layout(roots).placed).toHaveLength(5);
  });

  it("puts depth on the x axis", () => {
    const by = new Map(layout(roots).placed.map((p) => [p.path, p]));
    expect(by.get("0")!.x).toBe(0);
    expect(by.get("0.0")!.x).toBeGreaterThan(by.get("0")!.x);
    expect(by.get("0.0.0")!.x).toBeGreaterThan(by.get("0.0")!.x);
  });

  it("centers a parent between its first and last child", () => {
    const by = new Map(layout(roots).placed.map((p) => [p.path, p]));
    const mid = (k: string) => by.get(k)!.y + by.get(k)!.h / 2;
    expect(mid("0.0")).toBeCloseTo((mid("0.0.0") + mid("0.0.1")) / 2, 5);
  });

  it("records the parent path so edges can be drawn", () => {
    const by = new Map(layout(roots).placed.map((p) => [p.path, p]));
    expect(by.get("0")!.parent).toBe("");
    expect(by.get("0.0.1")!.parent).toBe("0.0");
  });

  it("hides the children of a collapsed branch", () => {
    const placed = layout(roots, { "0.0": true }).placed;
    expect(placed.map((p) => p.path)).not.toContain("0.0.0");
    expect(placed.map((p) => p.path)).toContain("0.0");
  });

  it("leaves a row for the status badge on a decided node", () => {
    // 배지를 세지 않으면 채택·유력 카드가 아래 카드와 겹친다(`BrainstormPane`).
    const exploring = layout([newNode("생각")]).height;
    const adopted = layout([{ ...newNode("생각"), status: "adopted" }]).height;
    expect(adopted).toBeGreaterThan(exploring);
  });

  it("has no size for an empty tree", () => {
    expect(layout([])).toEqual({ placed: [], width: 0, height: 0 });
  });
});
