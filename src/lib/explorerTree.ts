/**
 * 탐색기 화면의 순수한 판정들 — 트리를 접힌 폴더째 중첩하기, 드롭 판정, 이름 미리 검사,
 * 방금 생긴 항목 찾기. 컴포넌트에서 떼어 둔 것은 시험하기 위해서다.
 */
import { dirname } from "./format";
import { buildTree, type FileEntry } from "./tree";

export type TreeItem =
  | { kind: "dir"; name: string; path: string; depth: number; count: number; kids: TreeItem[] }
  | {
      kind: "file";
      name: string;
      path: string;
      depth: number;
      size: string;
      bin: boolean;
      link: string | null;
    };

type Node = ReturnType<typeof buildTree>;

function nest(node: Node, prefix: string, depth: number): TreeItem[] {
  const out: TreeItem[] = [];
  node.order.forEach((d) => {
    const path = prefix + d + "/";
    const kid = node.dirs[d];
    out.push({
      kind: "dir",
      name: d,
      path,
      depth,
      count: kid.order.length + kid.files.length,
      kids: nest(kid, path, depth + 1),
    });
  });
  node.files.forEach((f) =>
    out.push({ kind: "file", name: f.name, path: f.p, depth, size: f.size, bin: f.bin, link: f.link }),
  );
  return out;
}

/**
 * `flatten` 과 같은 순서의 트리를 **접힌 폴더의 자식까지** 중첩해 돌려준다. 폴더를 높이째
 * 여닫으려면(`Collapse`) 닫히는 동안에도 자식을 그릴 수 있어야 해서다 — 펼침 여부는 그리는 쪽이 본다.
 */
export function nestTree(list: FileEntry[]): TreeItem[] {
  return nest(buildTree(list), "", 0);
}

/** 트리에 있는 폴더 경로 전부(`a/` · `a/b/`). 파일만 있고 폴더 항목이 없는 폴더도 든다. */
export function dirPaths(items: TreeItem[], out: Set<string> = new Set()): Set<string> {
  items.forEach((it) => {
    if (it.kind !== "dir") return;
    out.add(it.path);
    dirPaths(it.kids, out);
  });
  return out;
}

/** `a/b/c/` → `["a/", "a/b/", "a/b/c/"]`. 최상위(`""`)는 빈 목록. */
export function ancestorsOf(dir: string): string[] {
  const parts = dir.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/") + "/");
}

/** 새로 만들 자리 — 고른 것이 폴더면 그 안, 파일이면 그 파일의 폴더, 없으면 최상위(`""`). */
export function mkParentFor(sel: string): string {
  if (!sel) return "";
  return sel.endsWith("/") ? sel : dirname(sel);
}

/**
 * 드래그가 지금 무엇을 뜻하는가.
 *
 * * `out` — 창 밖. 놓으면 바탕화면으로 간다.
 * * `no` — 놓을 곳이 아니다(트리 밖, 또는 폴더를 자기 자신 아래로).
 * * `same` — 이미 그 폴더에 있다. 놓아도 아무 일도 없다.
 * * `move` — 그 폴더로 옮긴다. **이때만** 대상이 파랗게 된다.
 *
 * `moveFile` 이 조용히 무시하는 경우(같은 폴더 · 자기 아래)를 여기서 먼저 갈라야 고스트와
 * 강조가 "옮긴다" 고 거짓말하지 않는다.
 */
export type DropMode = "move" | "same" | "no" | "out";

export function dropMode(d: { path: string; over: string | null; outside: boolean }): DropMode {
  if (d.outside) return "out";
  if (d.over === null) return "no";
  if (d.over === dirname(d.path)) return "same";
  if (d.path.endsWith("/") && d.over.startsWith(d.path)) return "no";
  return "move";
}

/** 고스트의 모양. 보라는 AI 전용이라 링크는 청록(마크다운 배지와 같은 계열)이다. */
export interface GhostLook {
  glyph: string;
  /** 기호 칸의 바탕(글자는 흰색). */
  badge: string;
  bg: string;
  bd: string;
  /** 상태 글자색. */
  fg: string;
}

export function ghostLook(mode: DropMode, alt: boolean): GhostLook {
  switch (mode) {
    case "move":
      return { glyph: "↳", badge: "#3a6fd8", bg: "#fff", bd: "#d9d4ca", fg: "#2f5cbb" };
    case "same":
      return { glyph: "↳", badge: "#a09a8f", bg: "#fff", bd: "#d9d4ca", fg: "#6a665e" };
    case "no":
      return { glyph: "⦸", badge: "#a09a8f", bg: "#fff", bd: "#d9d4ca", fg: "#6a665e" };
    case "out":
      return alt
        ? { glyph: "↗", badge: "#2f6f80", bg: "#e8f3f5", bd: "#bcdde3", fg: "#2f6f80" }
        : { glyph: "＋", badge: "#2f7f57", bg: "#eef3fd", bd: "#cddcf8", fg: "#256b47" };
  }
}

export function ghostStatus(mode: DropMode, over: string | null, alt: boolean): string {
  switch (mode) {
    case "out":
      return alt ? "바탕화면에 링크" : "바탕화면으로 복사";
    case "no":
      return "여기엔 놓을 수 없음 · Esc 로 취소";
    case "same":
      return "이미 이 폴더에 있음";
    case "move":
      return `${over || "업무 폴더 최상위"} 로 이동`;
  }
}

/**
 * 백엔드(`fsops::rename_path`)가 받는 모양으로 다듬은 이름 — 앞뒤 공백과 끝의 점은 Windows 가
 * 잘라 버리므로 저쪽도 먼저 다듬는다.
 */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\.+$/, "").trim();
}

/**
 * 이름 바꾸기를 보내기 전에 걸러 낼 수 있는 거절 사유. README(탐색기에서 이름 바꾸기)와
 * `rename_path` 의 규칙 중 **확실히 거절될 것만** 미리 본다 — 그 밖의 판정은 여전히 스토어와
 * 백엔드가 한다. 빈 이름 · 그대로인 이름은 취소라 사유가 없다(`null`).
 *
 * 같은 이름은 대소문자를 가리지 않고 본다. Windows 파일시스템이 그렇게 판정하기 때문이다 —
 * 자기 자신의 대소문자만 바꾸는 것은 막지 않는다.
 */
export function renameProblem(raw: string, path: string, files: FileEntry[]): string | null {
  const name = normalizeName(raw);
  if (!name) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return '이름에 \\ / : * ? " < > | 는 쓸 수 없습니다';
  if (name.startsWith(".")) return "점으로 시작하는 이름은 탐색기에 나타나지 않습니다";
  const parent = dirname(path);
  const lower = name.toLowerCase();
  const taken = files.some((f) => {
    if (f.p === path || dirname(f.p) !== parent) return false;
    const n = f.p.replace(/\/$/, "").split("/").pop() ?? "";
    return n.toLowerCase() === lower;
  });
  return taken ? "같은 이름이 이미 있습니다 — 덮어쓰지 않습니다" : null;
}

/**
 * 조작 전후의 파일 목록을 견주어 `parent` 폴더에 **새로 생긴** 항목을 찾는다 — 옮긴 · 만든 ·
 * 이름을 바꾼 행을 반짝이려고. 스토어의 조작은 새 경로를 돌려주지 않고, 드래그 이동은 겹치는
 * 이름에 ` (2)` 를 붙이므로 경로를 짐작하지 않고 목록에서 찾는다. 폴더를 옮기면 그 아래 경로도
 * 모두 새로 생기지만 바로 아래(`parent`)에 있는 것은 그 폴더 하나다.
 */
export function freshEntry(
  before: ReadonlySet<string>,
  after: FileEntry[],
  parent: string,
  isDir: boolean,
): string | null {
  const hit = after.find((f) => !before.has(f.p) && f.dir === isDir && dirname(f.p) === parent);
  return hit ? hit.p : null;
}
