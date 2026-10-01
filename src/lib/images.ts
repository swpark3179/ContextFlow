/**
 * 마크다운 노트의 이미지 — 클립보드에서 꺼내기, 링크 만들기, 경로 풀기.
 *
 * 저장은 Rust 가 한다(`save_pasted_image` — 업무 폴더 최상위의 `images/`). 여기 있는 것은
 * 전부 순수 함수라 테스트가 붙는다. 경로를 **어디 기준으로 푸는가** 가 요점이다: 마크다운의
 * 상대 경로는 노트가 들어 있는 폴더 기준이고(Obsidian · GitHub 와 같다), 업무 폴더 기준이
 * 아니다. 그래서 `refs/회의록.md` 에 붙인 그림은 `../images/…` 로 적힌다.
 */

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

export interface ClipImage {
  file: File;
  ext: string;
}

/**
 * 붙여넣기에서 이미지 한 장을 꺼낸다. 없으면 `null` — 그때는 평소의 붙여넣기다.
 *
 * **텍스트가 함께 왔으면 텍스트가 이긴다.** Excel · Word 에서 셀이나 문단을 복사하면
 * 클립보드에 글자와 함께 그 모양을 찍은 그림이 같이 실린다. 그림을 먼저 집으면 표를
 * 붙여넣으려던 사람의 노트에 스크린샷 파일이 생긴다.
 */
export function clipboardImage(dt: DataTransfer | null): ClipImage | null {
  if (!dt) return null;
  if (dt.getData("text/plain").trim()) return null;
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const ext = MIME_EXT[item.type.toLowerCase()];
    if (!ext) continue;
    const file = item.getAsFile();
    if (file) return { file, ext };
  }
  return null;
}

/** 붙여넣은 파일을 가리키는 마크다운 한 줄. 공백 · 괄호는 링크를 끊으므로 인코딩한다. */
export function imageMarkdown(name: string): string {
  // encodeURIComponent 는 괄호를 남기므로 직접 적는다.
  const dest = name.replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `![](${dest})`;
}

/**
 * 노트(`noteRel`)에서 업무 폴더 기준 경로 `targetRel` 을 가리키는 상대 경로. 둘 다 업무
 * 폴더 기준이고 `/` 로 나뉜다. `refs/a/n.md` → `images/x.png` 는 `../../images/x.png`.
 */
export function relativeFromNote(noteRel: string, targetRel: string): string {
  const from = noteRel.split("/").filter(Boolean).slice(0, -1);
  const to = targetRel.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

/**
 * `snippet` 을 `[from, to)` 자리에 넣되 **한 줄을 통째로** 차지하게 한다. 이미지만 있는
 * 줄이어야 뷰어가 그림으로 그리기 때문이다(`mdParse`). 앞뒤가 이미 줄바꿈이면 더 넣지
 * 않는다. 돌려주는 `caret` 은 넣은 줄 바로 뒤다.
 */
export function insertOwnLine(
  text: string,
  from: number,
  to: number,
  snippet: string,
): { text: string; insert: string; caret: number } {
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const trail = after.startsWith("\n") ? "" : "\n";
  const insert = `${lead}${snippet}${trail}`;
  return { text: before + insert + after, insert, caret: from + insert.length };
}

export type ImageRef =
  /** 업무 폴더 기준 상대 경로. `../` 로 업무 폴더 위를 가리키면 앞에 `../` 가 남는다. */
  | { kind: "rel"; path: string }
  /** 디스크의 절대 경로. */
  | { kind: "abs"; path: string }
  /** 그대로 쓸 수 있는 URL(`data:` · `asset:`). */
  | { kind: "url"; url: string }
  /** 외부 주소. 앱 창의 CSP 가 막으므로 그리지 않는다. */
  | { kind: "remote"; url: string };

/** `a/./b/../c.png` → `a/c.png`. 루트 위로 올라가는 `..` 는 앞에 남긴다. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * 노트(`noteRel`, 업무 폴더 기준)에 적힌 이미지 경로를 풀어 읽는다.
 *
 * 마크다운 표기의 경로는 퍼센트 인코딩되어 있을 수 있어(`%20`) 풀어서 쓰고, 위키
 * 표기(`![[…]]`)는 인코딩하지 않는 문법이라 그대로 쓴다. Obsidian 은 위키 표기를 Vault
 * 전체에서 이름으로 찾지만, 여기서는 노트 옆에서만 찾는다 — 붙여넣은 이미지는 언제나
 * 노트에서의 상대 경로가 든 마크다운 표기로 들어가므로 그것으로 충분하다.
 */
export function resolveImageSrc(noteRel: string, src: string, wiki = false): ImageRef {
  const s = src.trim();
  if (/^(data|asset|blob):/i.test(s) || /^https?:\/\/asset\.localhost\//i.test(s))
    return { kind: "url", url: s };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^file:/i.test(s)) return { kind: "remote", url: s };
  let path = s.replace(/^file:\/\/\/?/i, "");
  if (!wiki) {
    try {
      path = decodeURI(path);
    } catch {
      /* 잘못된 % 표기는 적힌 그대로 둔다 */
    }
  }
  path = path.replace(/\\/g, "/");
  if (/^[a-z]:\//i.test(path) || path.startsWith("/")) return { kind: "abs", path };
  const slash = noteRel.lastIndexOf("/");
  const dir = slash >= 0 ? noteRel.slice(0, slash + 1) : "";
  return { kind: "rel", path: normalize(dir + path) };
}
