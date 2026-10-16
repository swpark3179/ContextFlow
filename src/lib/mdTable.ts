/**
 * 표 편집기(`TableModal`)의 모델 — 칸의 격자 · 열 정렬 · 병합.
 *
 * 편집기는 이 모델만 고치고, 문서에 쓰는 글은 확정할 때 한 번 만든다(`tableToMarkdown`).
 *
 * * 병합이 없으면 **GFM 표**다. 열 폭을 맞춰 적어 텍스트 에디터 · Obsidian 의 원문에서도
 *   표로 읽힌다(한글은 두 칸으로 센다).
 * * 병합이 있으면 **HTML 표**다. GFM 에는 칸을 합치는 문법이 없고, 마크다운이 허락하는 길은
 *   HTML 뿐이다 — Obsidian 과 GitHub 가 그대로 그리고, 이 앱의 뷰어도 읽는다(`mdParse`).
 *
 * 첫 줄은 언제나 **머리 행**이다. GFM 표는 머리 행 없이 쓸 수 없어서다. 병합은 머리 행과 본문
 * 행을 걸칠 수 없다 — HTML 에서도 `<thead>` 와 `<tbody>` 를 넘는 `rowspan` 은 잘린다.
 *
 * 모든 함수는 받은 모델을 고치지 않고 새 모델을 돌려준다(React 상태로 그대로 쓴다).
 */
import {
  brToNewline,
  delimRow,
  HTML_TABLE_OPEN,
  mdParse,
  splitFrontmatter,
  splitRow,
  type TableAlign,
} from "./markdown";
import { htmlInlineToMd, mdInlineToHtml, parseHtmlTable } from "./htmlTable";

/** 왼쪽 위 칸 `(r, c)` 에서 `rs × cs` 만큼 합친 칸. */
export interface Merge {
  r: number;
  c: number;
  rs: number;
  cs: number;
}

export interface TableModel {
  /** 칸의 글(`[행][열]`, 마크다운). 줄바꿈은 칸 안의 줄바꿈이다. 합쳐져 덮인 칸은 비어 있다. */
  cells: string[][];
  align: TableAlign[];
  merges: Merge[];
}

/** 고른 구간 — 양 끝을 포함한다. */
export interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export function blankTable(rows = 3, cols = 3): TableModel {
  return {
    cells: Array.from({ length: rows }, () => Array<string>(cols).fill("")),
    align: Array<TableAlign>(cols).fill(""),
    merges: [],
  };
}

export function tableSize(t: TableModel): { rows: number; cols: number } {
  return { rows: t.cells.length, cols: t.cells[0]?.length ?? 0 };
}

function inside(m: Merge, r: number, c: number): boolean {
  return r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs;
}

function overlaps(m: Merge, x: Rect): boolean {
  return m.r <= x.r1 && m.r + m.rs - 1 >= x.r0 && m.c <= x.c1 && m.c + m.cs - 1 >= x.c0;
}

/** 칸마다 그 칸을 덮은 병합(없으면 `null`). 그릴 때 덮인 칸을 건너뛰는 데 쓴다. */
export function coverMap(t: TableModel): (Merge | null)[][] {
  const map: (Merge | null)[][] = t.cells.map((row) => row.map(() => null));
  for (const m of t.merges)
    for (let r = m.r; r < m.r + m.rs; r++) for (let c = m.c; c < m.c + m.cs; c++) map[r][c] = m;
  return map;
}

export function mergeAt(t: TableModel, r: number, c: number): Merge | null {
  return t.merges.find((m) => inside(m, r, c)) ?? null;
}

/** 두 칸을 꼭짓점으로 하는 구간. 걸친 병합이 있으면 그것까지 다 들어오도록 넓힌다. */
export function rectOf(t: TableModel, a: { r: number; c: number }, b: { r: number; c: number }): Rect {
  const x: Rect = {
    r0: Math.min(a.r, b.r),
    c0: Math.min(a.c, b.c),
    r1: Math.max(a.r, b.r),
    c1: Math.max(a.c, b.c),
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of t.merges) {
      if (!overlaps(m, x)) continue;
      const next: Rect = {
        r0: Math.min(x.r0, m.r),
        c0: Math.min(x.c0, m.c),
        r1: Math.max(x.r1, m.r + m.rs - 1),
        c1: Math.max(x.c1, m.c + m.cs - 1),
      };
      if (next.r0 !== x.r0 || next.c0 !== x.c0 || next.r1 !== x.r1 || next.c1 !== x.c1) {
        Object.assign(x, next);
        grew = true;
      }
    }
  }
  return x;
}

/**
 * 모델을 바로잡는다 — 칸을 네모로 채우고, 격자를 벗어나거나 겹치거나 머리 행을 걸친 병합을
 * 고치고, 덮인 칸의 글을 비운다. 행 · 열을 넣고 지운 뒤에 언제나 거친다.
 */
export function normalize(t: TableModel): TableModel {
  const rows = Math.max(1, t.cells.length);
  const cols = Math.max(1, ...t.cells.map((r) => r.length));
  const cells = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => t.cells[r]?.[c] ?? ""),
  );
  const align = Array.from({ length: cols }, (_, c) => t.align[c] ?? "");
  const merges: Merge[] = [];
  for (const raw of t.merges) {
    if (raw.r < 0 || raw.c < 0 || raw.r >= rows || raw.c >= cols) continue;
    const m = { ...raw, rs: Math.min(raw.rs, rows - raw.r), cs: Math.min(raw.cs, cols - raw.c) };
    // 머리 행에서 시작해 본문까지 내려간 병합은 머리 행만 남긴다.
    if (m.r === 0) m.rs = 1;
    if (m.rs < 1 || m.cs < 1 || (m.rs === 1 && m.cs === 1)) continue;
    const box: Rect = { r0: m.r, c0: m.c, r1: m.r + m.rs - 1, c1: m.c + m.cs - 1 };
    if (merges.some((o) => overlaps(o, box))) continue;
    merges.push(m);
  }
  for (const m of merges)
    for (let r = m.r; r < m.r + m.rs; r++)
      for (let c = m.c; c < m.c + m.cs; c++) if (r !== m.r || c !== m.c) cells[r][c] = "";
  merges.sort((a, b) => a.r - b.r || a.c - b.c);
  return { cells, align, merges };
}

export function setCell(t: TableModel, r: number, c: number, text: string): TableModel {
  if (t.cells[r]?.[c] === undefined || t.cells[r][c] === text) return t;
  const cells = t.cells.map((row, i) => (i === r ? row.map((x, j) => (j === c ? text : x)) : row));
  return { ...t, cells };
}

export function setAlign(t: TableModel, c0: number, c1: number, a: TableAlign): TableModel {
  return { ...t, align: t.align.map((x, c) => (c >= c0 && c <= c1 ? a : x)) };
}

/** `at` 번째 행 자리에 빈 행을 넣는다. 병합의 한가운데에 넣으면 그 병합이 한 줄 늘어난다. */
export function insertRow(t: TableModel, at: number): TableModel {
  const { cols } = tableSize(t);
  const cells = [...t.cells];
  cells.splice(at, 0, Array<string>(cols).fill(""));
  const merges = t.merges.map((m) =>
    at <= m.r ? { ...m, r: m.r + 1 } : at < m.r + m.rs ? { ...m, rs: m.rs + 1 } : m,
  );
  return normalize({ ...t, cells, merges });
}

export function insertCol(t: TableModel, at: number): TableModel {
  const cells = t.cells.map((row) => {
    const next = [...row];
    next.splice(at, 0, "");
    return next;
  });
  const align = [...t.align];
  align.splice(at, 0, "");
  const merges = t.merges.map((m) =>
    at <= m.c ? { ...m, c: m.c + 1 } : at < m.c + m.cs ? { ...m, cs: m.cs + 1 } : m,
  );
  return normalize({ cells, align, merges });
}

/**
 * 1차원으로 본 병합 하나에서 `[a, b]` 를 지운다. 왼쪽(위) 칸이 지워지면 남은 첫 칸으로
 * 옮겨 가고, 글도 따라간다(`move`) — 행을 지웠다고 합친 칸의 글까지 사라지지 않게.
 */
function shrink(start: number, len: number, a: number, b: number) {
  const n = b - a + 1;
  const end = start + len - 1;
  if (end < a) return { start, len, move: false };
  if (start > b) return { start: start - n, len, move: false };
  const cut = Math.min(end, b) - Math.max(start, a) + 1;
  return { start: Math.min(start, a), len: len - cut, move: start >= a };
}

/** `[r0, r1]` 행을 지운다. 모든 행을 지우게 되면 `null` — 표에는 머리 행 하나는 남아야 한다. */
export function deleteRows(t: TableModel, r0: number, r1: number): TableModel | null {
  const { rows } = tableSize(t);
  if (r1 - r0 + 1 >= rows) return null;
  const cells = t.cells.map((row) => [...row]);
  const merges: Merge[] = [];
  for (const m of t.merges) {
    const s = shrink(m.r, m.rs, r0, r1);
    if (s.len <= 0) continue;
    if (s.move) cells[r1 + 1][m.c] = cells[m.r][m.c];
    merges.push({ ...m, r: s.start, rs: s.len });
  }
  cells.splice(r0, r1 - r0 + 1);
  return normalize({ ...t, cells, merges });
}

export function deleteCols(t: TableModel, c0: number, c1: number): TableModel | null {
  const { cols } = tableSize(t);
  if (c1 - c0 + 1 >= cols) return null;
  const cells = t.cells.map((row) => [...row]);
  const merges: Merge[] = [];
  for (const m of t.merges) {
    const s = shrink(m.c, m.cs, c0, c1);
    if (s.len <= 0) continue;
    if (s.move) cells[m.r][c1 + 1] = cells[m.r][m.c];
    merges.push({ ...m, c: s.start, cs: s.len });
  }
  for (const row of cells) row.splice(c0, c1 - c0 + 1);
  const align = t.align.filter((_, c) => c < c0 || c > c1);
  return normalize({ cells, align, merges });
}

/** 합칠 수 없는 까닭. 합칠 수 있으면 `null`. */
export function mergeBlocker(x: Rect): string | null {
  if (x.r0 === x.r1 && x.c0 === x.c1) return "합칠 칸을 둘 이상 고르세요 (끌거나 Shift+클릭)";
  if (x.r0 === 0 && x.r1 > 0) return "머리 행과 본문 행은 합칠 수 없습니다";
  return null;
}

/** 구간을 한 칸으로 합친다. 글이 든 칸이 여럿이면 줄을 바꿔 이어 붙인다 — 지우지 않는다. */
export function mergeCells(t: TableModel, x: Rect): TableModel {
  if (mergeBlocker(x)) return t;
  const texts: string[] = [];
  for (let r = x.r0; r <= x.r1; r++)
    for (let c = x.c0; c <= x.c1; c++) {
      const v = t.cells[r][c].trim();
      if (v) texts.push(v);
    }
  const cells = t.cells.map((row, r) =>
    row.map((v, c) => (r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1 ? "" : v)),
  );
  cells[x.r0][x.c0] = texts.join("\n");
  const merges = t.merges.filter((m) => !overlaps(m, x));
  merges.push({ r: x.r0, c: x.c0, rs: x.r1 - x.r0 + 1, cs: x.c1 - x.c0 + 1 });
  return normalize({ ...t, cells, merges });
}

/** 구간에 걸친 병합을 푼다. 글은 왼쪽 위 칸에 남고 나머지 칸은 빈다. */
export function unmergeCells(t: TableModel, x: Rect): TableModel {
  const merges = t.merges.filter((m) => !overlaps(m, x));
  return merges.length === t.merges.length ? t : { ...t, merges };
}

export function hasMergeIn(t: TableModel, x: Rect): boolean {
  return t.merges.some((m) => overlaps(m, x));
}

/**
 * `(r, c)` 부터 붙여넣는다 — 모자라면 행 · 열을 늘린다. 붙여넣은 자리에 걸친 병합은 푼다
 * (덮인 칸에 쓴 글은 보이지 않으므로).
 */
export function pasteCells(t: TableModel, r: number, c: number, grid: string[][]): TableModel {
  const h = grid.length;
  const w = Math.max(0, ...grid.map((g) => g.length));
  if (!h || !w) return t;
  const { rows, cols } = tableSize(t);
  const R = Math.max(rows, r + h);
  const C = Math.max(cols, c + w);
  const cells = Array.from({ length: R }, (_, i) => Array.from({ length: C }, (_, j) => t.cells[i]?.[j] ?? ""));
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) cells[r + i][c + j] = grid[i][j] ?? "";
  const box: Rect = { r0: r, c0: c, r1: r + h - 1, c1: c + w - 1 };
  return normalize({
    cells,
    align: Array.from({ length: C }, (_, j) => t.align[j] ?? ""),
    merges: t.merges.filter((m) => !overlaps(m, box)),
  });
}

/**
 * 탭으로 나뉜 글(엑셀 · 구글 시트에서 복사한 칸). 줄바꿈이나 탭이 든 칸은 큰따옴표로 감싸고
 * 안의 따옴표는 둘로 적는다 — 그 규칙대로 푼다. 마지막 줄 끝의 줄바꿈은 빈 행이 아니다.
 */
export function parseTsv(text: string): string[][] {
  const s = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let fresh = true;
  while (i < s.length) {
    const ch = s[i];
    if (fresh && ch === '"') {
      let j = i + 1;
      let v = "";
      for (; j < s.length; j++) {
        if (s[j] !== '"') v += s[j];
        else if (s[j + 1] === '"') {
          v += '"';
          j++;
        } else break;
      }
      if (j < s.length) {
        cell += v;
        i = j + 1;
        fresh = false;
        continue;
      }
      // 닫는 따옴표가 없으면 따옴표가 아니라 글자다.
    }
    fresh = false;
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      fresh = true;
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      fresh = true;
    } else cell += ch;
    i++;
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((v) => v.trim()));
}

/**
 * 붙여넣은 글을 칸의 격자로 읽는다 — 마크다운 표이거나 탭이 든 글일 때만. 그 밖에는 `null`
 * 이고, 그 글은 한 칸에 평범하게 붙는다.
 */
export function parseClipboardGrid(text: string): string[][] | null {
  const s = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const lines = s.split("\n");
  if (lines[0].includes("|") || HTML_TABLE_OPEN.test(lines[0])) {
    const t = parseTableSource(lines);
    if (t) return t.cells;
  }
  if (!s.includes("\t")) return null;
  return parseTsv(s);
}

/** 격자에서 모델을 만든다. 첫 줄이 머리 행이 되고, 짧은 줄은 빈 칸으로 채운다. */
export function tableFromGrid(grid: string[][]): TableModel {
  const cols = Math.max(1, ...grid.map((r) => r.length));
  return normalize({
    cells: grid.length ? grid : [[""]],
    align: Array<TableAlign>(cols).fill(""),
    merges: [],
  });
}

// ---------------------------------------------------------------------------
// 쓰기.

/**
 * 고정폭 글꼴에서 차지하는 칸 수. 한글 · 한자 · 전각 문자는 두 칸으로 센다 — 그래야 원문에서
 * 세로선이 맞는다(Obsidian 의 Advanced Tables 와 같은 셈).
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

/** GFM 칸 하나. 줄바꿈은 `<br>`, 파이프는 `\|` 로 적는다(이미 막아 둔 `\|` 는 그대로). */
function gfmCell(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .join("<br>")
    .replace(/\\?\|/g, "\\|");
}

function pad(s: string, width: number, a: TableAlign): string {
  const gap = Math.max(0, width - displayWidth(s));
  if (a === "right") return " ".repeat(gap) + s;
  if (a === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
  return s + " ".repeat(gap);
}

function delimCell(width: number, a: TableAlign): string {
  if (a === "left") return `:${"-".repeat(width - 1)}`;
  if (a === "right") return `${"-".repeat(width - 1)}:`;
  if (a === "center") return `:${"-".repeat(width - 2)}:`;
  return "-".repeat(width);
}

function toGfm(t: TableModel): string {
  const cells = t.cells.map((row) => row.map(gfmCell));
  const widths = t.align.map((_, c) => Math.max(3, ...cells.map((row) => displayWidth(row[c]))));
  const line = (row: string[]) => `| ${row.map((v, c) => pad(v, widths[c], t.align[c])).join(" | ")} |`;
  return [
    line(cells[0]),
    `| ${widths.map((w, c) => delimCell(w, t.align[c])).join(" | ")} |`,
    ...cells.slice(1).map(line),
  ].join("\n");
}

/**
 * HTML 표. 마크다운의 HTML 블록은 **빈 줄에서 끝나므로** 안에 빈 줄을 두지 않는다. 정렬은
 * `align` 속성으로 적는다 — GitHub 는 `style` 을 걷어내지만 `align` 은 남긴다.
 */
function toHtml(t: TableModel): string {
  const cover = coverMap(t);
  const row = (r: number, tag: "th" | "td") => {
    let out = "<tr>";
    t.cells[r].forEach((text, c) => {
      const m = cover[r][c];
      if (m && (m.r !== r || m.c !== c)) return;
      const attrs =
        (m && m.cs > 1 ? ` colspan="${m.cs}"` : "") +
        (m && m.rs > 1 ? ` rowspan="${m.rs}"` : "") +
        (t.align[c] ? ` align="${t.align[c]}"` : "");
      out += `<${tag}${attrs}>${mdInlineToHtml(text.trim())}</${tag}>`;
    });
    return `${out}</tr>`;
  };
  const body = t.cells.slice(1).map((_, i) => row(i + 1, "td"));
  return [
    "<table>",
    "<thead>",
    row(0, "th"),
    "</thead>",
    ...(body.length ? ["<tbody>", ...body, "</tbody>"] : []),
    "</table>",
  ].join("\n");
}

export function isHtmlTable(t: TableModel): boolean {
  return normalize(t).merges.length > 0;
}

/** 문서에 쓸 표. 앞뒤 줄바꿈은 붙이지 않는다(`spliceBlock` 이 붙인다). */
export function tableToMarkdown(t: TableModel): string {
  const n = normalize(t);
  return n.merges.length ? toHtml(n) : toGfm(n);
}

// ---------------------------------------------------------------------------
// 읽기.

/** 표의 원문 줄(GFM 또는 HTML)을 모델로. 표가 아니면 `null`. */
export function parseTableSource(lines: string[]): TableModel | null {
  const src = lines.map((l) => l.replace(/\r$/, ""));
  while (src.length && !src[src.length - 1].trim()) src.pop();
  while (src.length && !src[0].trim()) src.shift();
  if (!src.length) return null;

  if (HTML_TABLE_OPEN.test(src[0])) {
    const grid = parseHtmlTable(src.join("\n"));
    if (!grid) return null;
    const cols = grid.rows[0].length;
    const align = Array.from({ length: cols }, (_, c): TableAlign => {
      for (const r of grid.rows) if (r[c]?.align) return r[c]!.align;
      return "";
    });
    const merges: Merge[] = [];
    const cells = grid.rows.map((row, r) =>
      row.map((x, c) => {
        if (!x) return "";
        if (x.rs > 1 || x.cs > 1) merges.push({ r, c, rs: x.rs, cs: x.cs });
        return htmlInlineToMd(x.html);
      }),
    );
    return normalize({ cells, align, merges });
  }

  if (src.length < 2) return null;
  const align = delimRow(src[1]);
  const head = splitRow(src[0]);
  if (!align || head.length !== align.length) return null;
  const n = align.length;
  const fit = (cells: string[]) => Array.from({ length: n }, (_, c) => brToNewline(cells[c] ?? ""));
  return normalize({
    cells: [fit(head), ...src.slice(2).map((l) => fit(splitRow(l)))],
    align,
    merges: [],
  });
}

// ---------------------------------------------------------------------------
// 문서의 어디에 넣는가.

export type Placement =
  /** `[from, to)` 를 새 표로 바꾼다(`spliceBlock` 이 앞뒤에 빈 줄을 맞춘다). */
  | { kind: "insert"; from: number; to: number; model: TableModel }
  /** 커서가 표 안이다 — `[from, to)` 의 그 표를 고친다. */
  | { kind: "edit"; from: number; to: number; model: TableModel }
  /** 표를 온전히 넣을 수 없는 자리. 토스트로 알린다. */
  | { kind: "deny"; title: string; sub: string };

const deny = (title: string, sub: string): Placement => ({ kind: "deny", title, sub });

/**
 * 텍스트 에디터의 커서(`selStart`–`selEnd`)에서 표를 어디에 넣을지 정한다.
 *
 * * 빈 줄 · 줄 맨 앞 · 줄 끝이면 그 자리에 **한 블록으로** 넣는다. 줄 한가운데는 거절한다 —
 *   줄을 둘로 쪼개면 목록 · 인용의 뒷부분이 표시를 잃고 엉뚱한 문단이 된다.
 * * 코드 블록 · 프런트마터 안은 거절한다. 여는 펜스 줄의 맨 앞(그 앞에 넣기)과 닫는 펜스 ·
 *   프런트마터 닫는 줄의 끝(그 뒤에 넣기)은 받는다.
 * * 커서가 표 안이면 그 표를 고친다.
 * * 탭이 든 구간을 골랐으면(엑셀에서 붙여넣은 글) 그 줄들을 표로 바꾼다.
 *
 * `frontmatter` 는 이 글이 문서 전체인지 — index.md 편집기는 본문만 보여 주므로 거짓이다.
 */
export function placeTable(
  value: string,
  selStart: number,
  selEnd: number,
  frontmatter = true,
): Placement {
  const lines = value.split("\n");
  const starts: number[] = [];
  let acc = 0;
  for (const l of lines) {
    starts.push(acc);
    acc += l.length + 1;
  }
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineEnd = (ln: number) => starts[ln] + lines[ln].length;

  const fm = frontmatter ? splitFrontmatter(value) : { bodyLine: 0, body: value };
  const off = fm.bodyLine;
  const blocks = mdParse(fm.body)
    .filter((b) => b.isFence || b.isTable)
    .map((b) => ({ ...b, line: b.line + off, end: b.end + off }));
  const blockAt = (ln: number) => blocks.find((b) => b.line <= ln && ln < b.end);

  const a = Math.min(selStart, selEnd);
  const z = Math.max(selStart, selEnd);
  if (a !== z && value.slice(a, z).includes("\t")) {
    const first = lineOf(a);
    let last = lineOf(z);
    if (last > first && z === starts[last]) last--;
    for (let ln = first; ln <= last; ln++)
      if (ln < off || blockAt(ln))
        return deny(
          "고른 구간을 표로 바꿀 수 없습니다",
          "코드 블록 · 표 · 프런트마터가 걸쳐 있습니다",
        );
    const from = starts[first];
    const to = lineEnd(last);
    return { kind: "insert", from, to, model: tableFromGrid(parseTsv(value.slice(from, to))) };
  }

  const pos = Math.max(0, Math.min(selEnd, value.length));
  const ln = lineOf(pos);
  const col = pos - starts[ln];
  const line = lines[ln];
  const atStart = !line.slice(0, col).trim();
  const atEnd = !line.slice(col).trim();
  const here = (from: number, to = from): Placement => ({ kind: "insert", from, to, model: blankTable() });

  if (ln < off) {
    if (ln === off - 1 && atEnd) return here(lineEnd(ln));
    return deny("프런트마터 안에는 표를 넣을 수 없습니다", "아래 --- 다음의 본문에 커서를 두세요");
  }

  const b = blockAt(ln);
  if (b?.isTable) {
    const model = parseTableSource(lines.slice(b.line, b.end));
    if (!model) return deny("이 표는 고칠 수 없습니다", "표 안에 다른 표가 들어 있습니다");
    return { kind: "edit", from: starts[b.line], to: lineEnd(b.end - 1), model };
  }
  if (b?.isFence) {
    const open = /^\s*(`{3,}|~{3,})/.exec(lines[b.line])![1];
    const closer = new RegExp(`^\\s*${open[0]}{${open.length},}\\s*$`);
    const closed = b.end - 1 > b.line && closer.test(lines[b.end - 1]);
    if (ln === b.line && atStart) return here(starts[ln]);
    if (ln === b.end - 1 && closed && atEnd) return here(lineEnd(ln));
    return deny("코드 블록 안에는 표를 넣을 수 없습니다", "코드 블록 밖의 빈 줄이나 줄 끝에 커서를 두세요");
  }

  if (!line.trim()) return here(starts[ln], lineEnd(ln));
  if (atStart) return here(starts[ln]);
  if (atEnd) return here(lineEnd(ln));
  return deny("줄 중간에는 표를 넣을 수 없습니다", "빈 줄이나 줄 끝(또는 줄 맨 앞)에 커서를 두세요");
}

/** 바로 앞에 빈 줄을 두기 위해 붙일 줄바꿈. 문서 맨 앞이면 붙이지 않는다. */
function leadFor(before: string): string {
  if (!before.trim()) return "";
  const nl = before.lastIndexOf("\n");
  if (before.slice(nl + 1).trim()) return "\n\n";
  const prev = before.slice(before.lastIndexOf("\n", nl - 1) + 1, nl);
  return prev.trim() ? "\n" : "";
}

/** 바로 뒤에 빈 줄을 두기 위해 붙일 줄바꿈. 문서 끝이면 줄바꿈 하나로 끝낸다. */
function trailFor(after: string): string {
  if (!after.trim()) return after.startsWith("\n") ? "" : "\n";
  const nl = after.indexOf("\n");
  if (nl < 0 || after.slice(0, nl).trim()) return "\n\n";
  const end = after.indexOf("\n", nl + 1);
  const next = after.slice(nl + 1, end < 0 ? undefined : end);
  return next.trim() ? "\n" : "";
}

/**
 * `md` 블록을 `[from, to)` 자리에 넣는다. 앞뒤 블록과는 빈 줄 하나로 떨어지게 하고(이미 빈 줄이면
 * 더 넣지 않는다), 돌려주는 `caret` 은 표의 마지막 줄 끝이다.
 */
export function spliceBlock(
  value: string,
  from: number,
  to: number,
  md: string,
): { from: number; to: number; insert: string; caret: number; text: string } {
  const lead = leadFor(value.slice(0, from));
  const trail = trailFor(value.slice(to));
  const insert = `${lead}${md}${trail}`;
  return {
    from,
    to,
    insert,
    caret: from + lead.length + md.length,
    text: value.slice(0, from) + insert + value.slice(to),
  };
}

/**
 * 문서의 `[start, end)` 줄(뷰어에서 고른 표)을 새 표로 바꾼다. 그 줄들이 `expect` 와 다르면
 * (그사이 바뀌었다) `null`. CRLF 로 저장된 문서면 새 줄에도 `\r` 을 붙인다.
 */
export function replaceTableLines(
  src: string,
  start: number,
  end: number,
  expect: string[],
  md: string,
): string | null {
  const lines = src.split("\n");
  const cur = lines.slice(start, end);
  if (cur.length !== expect.length || cur.some((l, i) => l !== expect[i])) return null;
  // 문서 끝의 줄에는 줄바꿈이 없으므로 `\r` 도 없다 — 마지막 줄은 원래 끝 그대로 둔다.
  const crlf = expect[0]?.endsWith("\r") ?? false;
  const lastCr = expect[expect.length - 1]?.endsWith("\r") ?? false;
  const out = md.split("\n");
  const next = out.map((l, i) => (crlf && (i < out.length - 1 || lastCr) ? `${l}\r` : l));
  lines.splice(start, end - start, ...next);
  return lines.join("\n");
}
