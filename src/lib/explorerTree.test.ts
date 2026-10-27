import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  dirPaths,
  dropMode,
  freshEntry,
  ghostLook,
  ghostStatus,
  mkParentFor,
  nestTree,
  normalizeName,
  renameProblem,
  type TreeItem,
} from "./explorerTree";
import { flatten, type FileEntry } from "./tree";

function f(p: string, dir = false): FileEntry {
  return {
    p,
    name: p.replace(/\/$/, "").split("/").pop() ?? p,
    dir,
    size: dir ? "" : "1.0 KB",
    bytes: dir ? 0 : 1024,
    bin: false,
    link: null,
  };
}

const LIST: FileEntry[] = [
  f("index.md"),
  f("notes.md"),
  f("refs/", true),
  f("refs/guide.md"),
  f("refs/deep/", true),
  f("refs/deep/note.md"),
  f("attachments/", true),
  f("attachments/shot.png"),
];

function walk(items: TreeItem[], out: string[] = []): string[] {
  items.forEach((it) => {
    out.push(it.path);
    if (it.kind === "dir") walk(it.kids, out);
  });
  return out;
}

describe("nestTree", () => {
  it("모두 펼친 flatten 과 같은 순서다", () => {
    expect(walk(nestTree(LIST))).toEqual(flatten(LIST, {}).map((r) => r.path));
  });

  it("접힌 폴더도 자식을 들고 있다 — 닫히는 동안 그릴 것이 있어야 한다", () => {
    const refs = nestTree(LIST).find((r) => r.path === "refs/");
    expect(refs?.kind === "dir" && refs.kids.map((k) => k.path)).toEqual(["refs/deep/", "refs/guide.md"]);
    expect(refs?.kind === "dir" && refs.count).toBe(2);
  });

  it("폴더 경로를 모두 모은다", () => {
    expect([...dirPaths(nestTree(LIST))].sort()).toEqual(["attachments/", "refs/", "refs/deep/"]);
  });
});

describe("ancestorsOf · mkParentFor", () => {
  it("폴더의 조상을 위에서부터 돌려준다", () => {
    expect(ancestorsOf("a/b/c/")).toEqual(["a/", "a/b/", "a/b/c/"]);
    expect(ancestorsOf("")).toEqual([]);
  });

  it("폴더면 그 안, 파일이면 그 폴더, 없으면 최상위", () => {
    expect(mkParentFor("refs/")).toBe("refs/");
    expect(mkParentFor("refs/guide.md")).toBe("refs/");
    expect(mkParentFor("notes.md")).toBe("");
    expect(mkParentFor("")).toBe("");
  });
});

describe("dropMode", () => {
  const d = (path: string, over: string | null, outside = false) => dropMode({ path, over, outside });

  it("창 밖이면 반출", () => {
    expect(d("notes.md", null, true)).toBe("out");
  });

  it("트리 밖은 놓을 수 없다 — 최상위(\"\")와 헷갈리지 않는다", () => {
    expect(d("notes.md", null)).toBe("no");
    expect(d("refs/guide.md", "")).toBe("move");
  });

  it("같은 폴더면 제자리", () => {
    expect(d("notes.md", "")).toBe("same");
    expect(d("refs/guide.md", "refs/")).toBe("same");
    expect(d("refs/deep/", "refs/")).toBe("same");
  });

  it("폴더를 자기 자신 아래로는 놓을 수 없다", () => {
    expect(d("refs/", "refs/")).toBe("no");
    expect(d("refs/", "refs/deep/")).toBe("no");
    expect(d("refs/", "attachments/")).toBe("move");
  });
});

describe("ghostLook · ghostStatus", () => {
  it("링크는 보라가 아니라 청록이다", () => {
    const link = ghostLook("out", true);
    expect(link.badge).toBe("#2f6f80");
    expect(link.bg).toBe("#e8f3f5");
    expect(link.bd).toBe("#bcdde3");
    const all = (["move", "same", "no", "out"] as const).flatMap((m) => [ghostLook(m, false), ghostLook(m, true)]);
    expect(JSON.stringify(all).toLowerCase()).not.toMatch(/6a54c6|5a44b4/);
  });

  it("상태 문구", () => {
    expect(ghostStatus("move", "", false)).toBe("업무 폴더 최상위 로 이동");
    expect(ghostStatus("move", "refs/", false)).toBe("refs/ 로 이동");
    expect(ghostStatus("out", null, true)).toBe("바탕화면에 링크");
    expect(ghostStatus("no", null, false)).toContain("여기엔 놓을 수 없음");
  });
});

describe("renameProblem", () => {
  it("쓸 수 없는 글자와 점으로 시작하는 이름을 거절한다", () => {
    for (const bad of ["a/b.md", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a\tb"]) {
      expect(renameProblem(bad, "notes.md", LIST)).toMatch(/쓸 수 없습니다/);
    }
    expect(renameProblem(".hidden.md", "notes.md", LIST)).toMatch(/점으로 시작/);
    expect(renameProblem("  .hidden.md", "notes.md", LIST)).toMatch(/점으로 시작/);
  });

  it("같은 폴더의 같은 이름은 대소문자를 가리지 않고 거절한다", () => {
    expect(renameProblem("index.md", "notes.md", LIST)).toMatch(/같은 이름/);
    expect(renameProblem("REFS", "notes.md", LIST)).toMatch(/같은 이름/);
    expect(renameProblem("guide.md", "refs/deep/", LIST)).toMatch(/같은 이름/);
  });

  it("다른 폴더의 같은 이름 · 자기 자신 · 빈 이름은 막지 않는다", () => {
    expect(renameProblem("guide.md", "notes.md", LIST)).toBeNull();
    expect(renameProblem("Notes.md", "notes.md", LIST)).toBeNull();
    expect(renameProblem("   ", "notes.md", LIST)).toBeNull();
    expect(renameProblem("회의록.md", "refs/guide.md", LIST)).toBeNull();
  });

  it("백엔드처럼 앞뒤 공백과 끝의 점을 다듬고 판정한다", () => {
    expect(normalizeName(" a.md. ")).toBe("a.md");
    expect(renameProblem(" index.md. ", "notes.md", LIST)).toMatch(/같은 이름/);
  });
});

describe("freshEntry", () => {
  const before = new Set(LIST.map((x) => x.p));

  it("옮긴 파일을 새 폴더에서 찾는다 — 겹친 이름에 붙은 (2) 도 그대로", () => {
    const after = [...LIST.filter((x) => x.p !== "notes.md"), f("refs/notes (2).md")];
    expect(freshEntry(before, after, "refs/", false)).toBe("refs/notes (2).md");
  });

  it("옮긴 폴더는 바로 아래의 그 폴더 하나다", () => {
    const after = [
      ...LIST.filter((x) => !x.p.startsWith("refs/")),
      f("attachments/refs/", true),
      f("attachments/refs/guide.md"),
      f("attachments/refs/deep/", true),
      f("attachments/refs/deep/note.md"),
    ];
    expect(freshEntry(before, after, "attachments/", true)).toBe("attachments/refs/");
  });

  it("아무것도 바뀌지 않았으면(실패) 없다", () => {
    expect(freshEntry(before, LIST, "refs/", false)).toBeNull();
  });
});
