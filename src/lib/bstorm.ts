/**
 * `.bs.md` — 브레인스토밍 문서의 파서 · 직렬화기 · 배치 계산.
 *
 * 저장 형식은 평범한 마크다운이다. 앱 전용 포맷을 쓰지 않는 이유는 이 저장소의
 * 원칙 그대로다 — "Obsidian 에서 보이는 것이 곧 ContextFlow 에서 보이는 것"
 * (`README.md`). `.bs.md` 는 `.md` 로 끝나므로 Obsidian 이 그냥 아웃라인 노트로
 * 열고, 거기서 손으로 고친 내용이 그대로 캔버스에 돌아온다.
 *
 * **노드에 id 가 없다.** 트리에서의 위치가 곧 정체성이고(`"0.1.2"`), 캔버스 좌표는
 * 저장하지 않는다 — 열 때마다 `layout()` 이 계산한다. 손으로 고친 마크다운이 언제나
 * 유효한 문서가 되는 쪽이, 좌표를 보존하는 것보다 중요하다.
 *
 * 계산부를 훅 밖의 순수 함수로 빼 둔 이유는 `tree.ts` · `virtual.ts` 와 같다 —
 * 테스트하기 쉽고 렌더 경로와 분리된다.
 */
import { splitFrontmatter } from "./markdown";

/** 한 단계 들여쓰기. 직렬화가 쓰는 값이며, 파서는 이 값에 기대지 않는다. */
const INDENT = 4;

/** 생각 트리가 시작하는 앵커. `frontmatter.rs` 의 Run Log 헤딩과 같은 역할이다. */
export const TREE_HEADING = "## 생각 트리";

/**
 * 브레인스토밍 문서의 확장자. `.md` 로 끝나는 것이 핵심이다 — Obsidian 은 `.md` 만
 * 노트로 열고, 앱은 경로 끝만 보고 캔버스를 고를 수 있다(`viewerFor`).
 */
export const BSTORM_EXT = ".bs.md";

/** 경로에서 확장자를 뗀 이름. 탭 · 캔버스 제목에 쓴다. */
export function bstormName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.toLowerCase().endsWith(BSTORM_EXT) ? base.slice(0, -BSTORM_EXT.length) : base;
}

export type BsStatus = "explore" | "strong" | "adopted" | "hold" | "dropped";

export const STATUS_ORDER: BsStatus[] = ["explore", "strong", "adopted", "hold", "dropped"];

/**
 * 상태를 나타내는 앞머리 이모지. `explore` 는 빈 문자열이다 — 대부분의 노드가
 * 탐색중이라, 표시를 붙이면 파일 전체가 이모지로 뒤덮인다.
 *
 * 화면에서도 같은 글자를 쓴다(`BS_STATUS` 옆의 배지). 파일에서 ✅ 로 보이던 것이
 * 캔버스에서 다른 기호로 보이면, 같은 문서를 두 벌 외워야 한다.
 */
export const STATUS_MARK: Record<BsStatus, string> = {
  explore: "",
  strong: "⭐",
  adopted: "✅",
  hold: "⏸",
  dropped: "❌",
};

/**
 * 읽을 때만 쓰는 표. 직렬화는 탐색중에 표시를 붙이지 않지만, 형식 문서가 🔍 를
 * 탐색중으로 규정하므로 손으로 적어 넣은 것도 읽어야 한다.
 */
const READ_MARKS: [string, BsStatus][] = [
  ...STATUS_ORDER.filter((k) => STATUS_MARK[k]).map((k) => [STATUS_MARK[k], k] as [string, BsStatus]),
  ["🔍", "explore"],
];

export type EvidenceKind = "근거" | "리스크" | "질문";

export const EVIDENCE_KINDS: EvidenceKind[] = ["근거", "리스크", "질문"];

/** 폐기 이유를 적는 인라인 필드 키. 근거/리스크/질문과 같은 문법을 쓴다. */
const REASON_KEY = "폐기";

/**
 * Dataview 인라인 필드. 자식 생각(그냥 불릿)과 문법으로 구분되고, Obsidian 이
 * 렌더링해 준다. 저장소는 이미 `_index/Archive.md` 에서 Dataview 를 쓴다.
 */
const FIELD_RE = /^(근거|리스크|질문|폐기)::\s*(.*)$/;

/**
 * 제목이 비어 있는 노드는 `-` 한 글자로 적힌다(줄 끝 공백은 남기지 않는다). 그래서
 * 불릿 뒤의 공백을 **선택**으로 둔다 — 필수로 두면 방금 만든 빈 생각이 다시 읽을 때
 * 사라진다. `---`(구분선)은 뒤에 `--` 가 남아 `$` 에 걸리므로 여기 걸리지 않는다.
 */
const BULLET_RE = /^(\s*)[-*](?:\s+(.*))?$/;

/**
 * 그림·다이어그램은 Obsidian 의 임베드 문법으로 적는다. 앱에서도 Obsidian 에서도
 * 같은 자리에 같은 그림이 보이고, 파일은 업무 폴더 안에 그대로 있다.
 */
const EMBED_RE = /^!\[\[(.+?)\]\]$/;

/** 앞뒤의 빈 줄만 걷어낸다. 사이에 낀 빈 줄은 사용자가 쓴 글의 일부다. */
function trimBlankLines(s: string): string {
  return s.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

/**
 * 한 줄짜리 값(제목 · 근거 · 폐기 이유)이 왕복하고 나면 남는 모양.
 *
 * 마크다운 한 줄에 담기는 값이라 줄 끝 공백이 남지 않는다 — 남기면 파일에 눈에
 * 보이지 않는 공백이 쌓이고, 편집기마다 그것을 다르게 지운다.
 */
export function trimmedLine(v: string): string {
  return v.trim();
}

/**
 * 여러 줄 값(상세)이 왕복하고 나면 남는 모양. 줄마다 앞뒤 공백을 떼고 빈 줄은 접는다 —
 * 불릿 아래의 빈 줄은 리스트를 끊어 놓는 마크다운이라 파일에 그대로 둘 수 없다.
 *
 * 편집 중인 글이 이것과 다르다고 해서 화면에서 지우지는 않는다. 지금 누르고 있는
 * 스페이스바와 방금 누른 Enter 는 아직 문서가 아니라 타이핑이다(`BrainstormBits.tsx`).
 */
export function trimmedBlock(v: string): string {
  return v
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

export interface Evidence {
  kind: EvidenceKind;
  text: string;
}

export interface BsNode {
  title: string;
  /** 여러 줄 서술. 빈 줄은 보존하지 않는다. */
  detail: string;
  status: BsStatus;
  /** 폐기 이유. 상태와 무관하게 값이 있으면 보존한다. */
  reason: string;
  evidence: Evidence[];
  /** 업무 폴더 기준 상대 경로. `![[attachments/x.png]]` 로 저장된다. */
  images: string[];
  children: BsNode[];
}

export interface BsDoc {
  /** frontmatter 원본 줄. 우리가 모르는 키도 그대로 되돌려 쓴다. */
  fmLines: string[];
  /** 트리 헤딩 앞의 본문. 사용자가 Obsidian 에서 덧붙인 글을 잃지 않는다. */
  before: string;
  /** 트리 다음 `##` 헤딩부터 끝까지. 같은 이유로 보존한다. */
  after: string;
  roots: BsNode[];
}

export function newNode(title = ""): BsNode {
  return { title, detail: "", status: "explore", reason: "", evidence: [], images: [], children: [] };
}

/** 앞머리 이모지를 떼어 상태와 제목으로 가른다. 표시가 없으면 탐색중이다. */
function splitStatus(text: string): { status: BsStatus; title: string } {
  for (const [mark, status] of READ_MARKS) {
    if (!text.startsWith(mark)) continue;
    // ⏸ 처럼 variation selector 가 따라붙는 이모지가 있다. 붙어 오든 아니든 같게 읽는다.
    return { status, title: text.slice(mark.length).replace(/^\uFE0F/, "").trim() };
  }
  return { status: "explore", title: text.trim() };
}

export function parseBstorm(src: string): BsDoc {
  const { fm, body } = splitFrontmatter(src || "");
  const fmLines = fm ? fm.split("\n") : [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");

  const head = lines.findIndex((l) => l.trim() === TREE_HEADING);
  if (head < 0) {
    // 앵커가 없으면 아무것도 트리로 삼지 않는다. 임의의 산문을 노드로 바꾸는 것보다
    // 빈 캔버스를 보여 주고 본문을 그대로 보존하는 편이 되돌릴 수 있다.
    return { fmLines, before: trimBlankLines(body), after: "", roots: [] };
  }

  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const roots: BsNode[] = [];
  const stack: { indent: number; node: BsNode }[] = [];

  for (const raw of lines.slice(head + 1, end)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      const indent = bullet[1].length;
      // 들여쓰기 폭은 편집기마다 다르다(2칸 · 4칸 · 탭). 절대 칸 수로 깊이를 나누지 않고
      // 쌓여 있는 조상들과 비교해 정하면 어떤 폭이든 트리 모양이 살아남는다.
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const { status, title } = splitStatus(bullet[2] ?? "");
      const node = { ...newNode(title), status };
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else roots.push(node);
      stack.push({ indent, node });
      continue;
    }

    const cur = stack.length ? stack[stack.length - 1].node : null;
    if (!cur) continue;

    const embed = line.trim().match(EMBED_RE);
    if (embed) {
      cur.images.push(embed[1].trim());
      continue;
    }

    const field = line.trim().match(FIELD_RE);
    if (field) {
      const [, key, value] = field;
      if (key === REASON_KEY) cur.reason = value.trim();
      else cur.evidence.push({ kind: key as EvidenceKind, text: value.trim() });
      continue;
    }
    cur.detail = cur.detail ? `${cur.detail}\n${line.trim()}` : line.trim();
  }

  return {
    fmLines,
    before: trimBlankLines(lines.slice(0, head).join("\n")),
    after: trimBlankLines(lines.slice(end).join("\n")),
    roots,
  };
}

function writeNode(n: BsNode, depth: number, out: string[]): void {
  const pad = " ".repeat(depth * INDENT);
  /**
   * 제목 자체가 상태 이모지로 시작하면 탐색중이라도 🔍 를 붙인다. 붙이지 않으면
   * 다시 읽을 때 사용자의 이모지를 상태로 삼켜서, 제목에서는 사라지고 상태는 제멋대로
   * 바뀐다("✅ 끝났다" → 채택 상태의 "끝났다").
   */
  const shadowed = READ_MARKS.some(([m]) => n.title.startsWith(m));
  const mark =
    n.status === "explore" ? (shadowed ? "🔍 " : "") : `${STATUS_MARK[n.status]} `;
  out.push(`${pad}- ${mark}${n.title}`.replace(/\s+$/, ""));

  const inner = " ".repeat((depth + 1) * INDENT);
  const block = trimmedBlock(n.detail);
  if (block) for (const line of block.split("\n")) out.push(inner + line);
  for (const src of n.images) {
    if (src.trim()) out.push(`${inner}![[${src.trim()}]]`);
  }
  /**
   * 내용이 아직 비어 있어도 줄을 남긴다. 지우면 인스펙터에서 [＋ 근거] 로 만든 빈 칸이
   * 왕복 한 번에 사라져서, 버튼이 아무 일도 하지 않는 것처럼 보인다. `근거::` 는
   * Dataview 인라인 필드로도, 파서(`FIELD_RE`)로도 값이 빈 필드로 멀쩡히 읽힌다.
   */
  for (const e of n.evidence) {
    const text = trimmedLine(e.text);
    out.push(`${inner}${e.kind}::${text ? ` ${text}` : ""}`);
  }
  if (trimmedLine(n.reason)) out.push(`${inner}${REASON_KEY}:: ${trimmedLine(n.reason)}`);

  for (const c of n.children) writeNode(c, depth + 1, out);
}

export function serializeBstorm(doc: BsDoc): string {
  const out: string[] = [];
  if (doc.fmLines.length) out.push("---", ...doc.fmLines, "---", "");
  if (doc.before.trim()) out.push(doc.before.replace(/\s+$/, ""), "");
  out.push(TREE_HEADING, "");
  for (const n of doc.roots) writeNode(n, 0, out);
  if (doc.after.trim()) out.push("", doc.after.replace(/\s+$/, ""));
  return `${out.join("\n").replace(/\s+$/, "")}\n`;
}

/**
 * frontmatter 의 키 하나만 제자리에서 고친다. `frontmatter.rs` 와 같은 이유로
 * YAML 직렬화기를 태우지 않는다 — 나머지 키의 순서 · 따옴표가 그대로 남아야
 * Obsidian 에서 손으로 고친 것이 앱 때문에 재작성되지 않는다.
 */
export function setFm(lines: string[], key: string, value: string): string[] {
  const at = lines.findIndex((l) => {
    const i = l.indexOf(":");
    return i > 0 && l.slice(0, i).trim() === key;
  });
  const line = `${key}: ${value}`;
  if (at < 0) return [...lines, line];
  const next = [...lines];
  next[at] = line;
  return next;
}

/** YAML 스칼라로 애매한 값만 감싼다. `vault.rs` 의 `quote_if_needed` 와 같은 규칙. */
export function quoteIfNeeded(v: string): string {
  if (!v) return '""';
  if (/^[\s]|[\s]$/.test(v) || /[:#[\]{}"'|>&*!%@`,]/.test(v)) return JSON.stringify(v);
  return v;
}

/** 새 `.bs.md` 의 첫 내용. 중심 생각 하나를 심어 두어 빈 캔버스를 마주하지 않게 한다. */
export function seedBstorm(title: string, now: string): string {
  return serializeBstorm({
    fmLines: [
      "type: brainstorm",
      `title: ${quoteIfNeeded(title)}`,
      `created: ${now}`,
      `updated: ${now}`,
      "tags: []",
    ],
    before: "",
    after: "",
    roots: [newNode(title)],
  });
}

// ---- 트리 조작 (경로 기반) ---------------------------------------------------

function pathIdx(path: string): number[] {
  return path.split(".").map(Number);
}

export function nodeAt(roots: BsNode[], path: string): BsNode | null {
  if (!path) return null;
  let list = roots;
  let node: BsNode | null = null;
  for (const i of pathIdx(path)) {
    node = list[i] ?? null;
    if (!node) return null;
    list = node.children;
  }
  return node;
}

export function parentPath(path: string): string {
  const at = path.lastIndexOf(".");
  return at < 0 ? "" : path.slice(0, at);
}

export function mapAt(roots: BsNode[], path: string, fn: (n: BsNode) => BsNode): BsNode[] {
  if (!path) return roots;
  const idx = pathIdx(path);
  const walk = (list: BsNode[], d: number): BsNode[] => {
    const i = idx[d];
    if (!list[i]) return list;
    const next = [...list];
    next[i] =
      d === idx.length - 1 ? fn(list[i]) : { ...list[i], children: walk(list[i].children, d + 1) };
    return next;
  };
  return walk(roots, 0);
}

export function removeAt(roots: BsNode[], path: string): BsNode[] {
  if (!path) return roots;
  const idx = pathIdx(path);
  const walk = (list: BsNode[], d: number): BsNode[] => {
    const i = idx[d];
    if (!list[i]) return list;
    if (d === idx.length - 1) return list.filter((_, k) => k !== i);
    const next = [...list];
    next[i] = { ...list[i], children: walk(list[i].children, d + 1) };
    return next;
  };
  return walk(roots, 0);
}

/** 자식을 끝에 붙이고 새 자식의 경로를 함께 돌려준다. */
export function addChildAt(
  roots: BsNode[],
  path: string,
  title = "",
): { roots: BsNode[]; path: string } {
  if (!path) {
    return { roots: [...roots, newNode(title)], path: String(roots.length) };
  }
  const parent = nodeAt(roots, path);
  if (!parent) return { roots, path };
  const at = parent.children.length;
  return {
    roots: mapAt(roots, path, (n) => ({ ...n, children: [...n.children, newNode(title)] })),
    path: `${path}.${at}`,
  };
}

export interface WalkedNode {
  path: string;
  node: BsNode;
  depth: number;
}

/**
 * 트리 전체를 위에서 아래로 편다. `layout()` 과 달리 접힌 가지도 포함한다 —
 * 개요와 결정 로그는 "전부 보는" 화면이라 캔버스에서 무엇을 접었는지와 무관해야 한다.
 */
export function walkNodes(roots: BsNode[]): WalkedNode[] {
  const out: WalkedNode[] = [];
  const go = (list: BsNode[], depth: number, prefix: string) => {
    list.forEach((node, i) => {
      const path = prefix ? `${prefix}.${i}` : String(i);
      out.push({ path, node, depth });
      go(node.children, depth + 1, path);
    });
  };
  go(roots, 0, "");
  return out;
}

/** 뿌리부터 이 노드의 부모까지의 제목. 결정 로그가 어디서 나온 생각인지 보여 준다. */
export function ancestorTitles(roots: BsNode[], path: string): string[] {
  const parts = path.split(".");
  const out: string[] = [];
  let list = roots;
  for (let d = 0; d < parts.length - 1; d++) {
    const n = list[Number(parts[d])];
    if (!n) break;
    out.push(n.title);
    list = n.children;
  }
  return out;
}

// ---- 배치 -------------------------------------------------------------------

const NODE_W = 210;
/** 열 간격. 노드 폭 + 가지선이 지나갈 여백. */
const COL = 268;
const GAP = 14;

export interface Placed {
  path: string;
  node: BsNode;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 부모 경로. 빈 문자열이면 루트다. */
  parent: string;
}

export interface LayoutResult {
  placed: Placed[];
  width: number;
  height: number;
}

function heightOf(n: BsNode): number {
  const titleLines = Math.max(1, Math.min(3, Math.ceil(n.title.length / 20)));
  let h = 24 + titleLines * 17;
  // 정해진 상태는 카드 위에 배지 한 줄을 차지한다(`BrainstormPane`). 배치가 그 줄을
  // 세지 않으면 카드끼리 겹친다.
  if (n.status !== "explore") h += 18;
  if (n.detail.trim()) h += 16;
  if (n.images.length) h += 40;
  h += n.evidence.length * 15;
  if (n.reason.trim()) h += 15;
  return h;
}

/**
 * 고전적인 tidy-tree. 잎은 커서를 밀고, 부모는 첫 자식과 마지막 자식의 가운데에 선다.
 * `collapsed[path]` 가 참이면 그 가지는 자식을 접고 잎처럼 자리를 차지한다.
 */
export function layout(roots: BsNode[], collapsed: Record<string, boolean> = {}): LayoutResult {
  const placed: Placed[] = [];
  let cursor = 0;
  let maxDepth = 0;

  const place = (n: BsNode, depth: number, path: string, parent: string): number => {
    const h = heightOf(n);
    const kids = collapsed[path] ? [] : n.children;
    if (depth > maxDepth) maxDepth = depth;

    let cy: number;
    if (!kids.length) {
      cy = cursor + h / 2;
      cursor += h + GAP;
    } else {
      const cys = kids.map((k, i) => place(k, depth + 1, `${path}.${i}`, path));
      cy = (cys[0] + cys[cys.length - 1]) / 2;
    }
    placed.push({ path, node: n, depth, x: depth * COL, y: cy - h / 2, w: NODE_W, h, parent });
    return cy;
  };

  roots.forEach((r, i) => place(r, 0, String(i), ""));

  return {
    placed,
    width: roots.length ? maxDepth * COL + NODE_W : 0,
    height: cursor > 0 ? cursor - GAP : 0,
  };
}
