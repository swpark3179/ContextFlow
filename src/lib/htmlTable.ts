/**
 * HTML 표 — 병합한 칸이 있는 표를 적는 자리.
 *
 * GFM 표에는 칸을 합치는 문법이 없다. 그래서 표 편집기(`TableModal`)에서 칸을 합치면 그 표는
 * 마크다운 안의 HTML `<table>` 로 저장한다 — 마크다운이 허락하는 유일한 방법이고, Obsidian 과
 * GitHub 가 그대로 그린다. 여기에는 그 표를 **읽고 쓰는 데 필요한 것만** 있다.
 *
 * * `parseHtmlTable` — `<table>` 원문을 칸의 격자로 푼다(`rowspan` · `colspan` 자리 계산).
 * * `mdInlineToHtml` · `htmlInlineToMd` — 칸 안의 글. HTML 블록 안에서는 마크다운이 그려지지
 *   않으므로(Obsidian · GitHub 공통) 쓸 때는 `**굵게**` 를 `<strong>` 으로 바꾸고, 읽을 때는
 *   되돌린다. 편집기에서는 언제나 마크다운으로 고친다.
 *
 * 이 모듈은 `markdown.ts` 의 실행 코드를 가져오지 않는다 — 저쪽이 이쪽을 가져다 뷰어의 표를
 * 그리므로, 서로 가져오면 순환이 된다(타입은 컴파일에서 지워지므로 괜찮다).
 */
import type { TableAlign } from "./markdown";

/** 격자의 칸 하나. 합친 칸은 왼쪽 위 자리에만 있고, 그것이 덮은 자리는 `null` 이다. */
export interface HtmlCell {
  /** 칸 안의 HTML 원문. */
  html: string;
  /** `<th>` 였는지. */
  head: boolean;
  rs: number;
  cs: number;
  align: TableAlign;
}

export interface HtmlGrid {
  rows: (HtmlCell | null)[][];
  /** `<thead>` 안의 줄 수. `<thead>` 가 없으면 첫 줄이 전부 `<th>` 일 때 1. */
  headRows: number;
}

const STRUCT = /<(\/?)(table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)\b([^<>]*)>/gi;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function alignOf(attrs: string): TableAlign {
  const raw = (
    attr(attrs, "align") ??
    /text-align\s*:\s*(left|center|right)/i.exec(attr(attrs, "style") ?? "")?.[1] ??
    ""
  ).toLowerCase();
  return raw === "left" || raw === "center" || raw === "right" ? raw : "";
}

function span(attrs: string, name: string): number {
  const n = parseInt(attr(attrs, name) ?? "", 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 1000) : 1;
}

/**
 * `<table>…</table>` 원문을 격자로 푼다. 표가 아니거나(줄이 없다) 표 안에 표가 들어 있으면
 * `null` — 그런 표는 고칠 수 없으니 뷰어도 원문 그대로 둔다.
 *
 * 칸의 자리는 브라우저와 같은 규칙으로 정한다: 위에서 내려온 `rowspan` 이 차지한 자리를
 * 건너뛰고 다음 빈 자리에 놓는다. 줄마다 칸 수가 달라도 가장 넓은 줄에 맞춰 빈 칸을 채운다.
 */
export function parseHtmlTable(src: string): HtmlGrid | null {
  const opens = src.match(/<table\b/gi)?.length ?? 0;
  if (opens !== 1) return null;

  interface Raw {
    html: string;
    head: boolean;
    rs: number;
    cs: number;
    align: TableAlign;
  }
  const raw: Raw[][] = [];
  let headRows = 0;
  let section: "thead" | "tbody" | "tfoot" | "" = "";
  let row: Raw[] | null = null;
  let cell: { at: number; head: boolean; attrs: string } | null = null;
  /** `<caption>` · `<colgroup>` 안은 칸이 아니다. */
  let skip = false;

  const closeCell = (end: number) => {
    if (!cell) return;
    if (!row) {
      row = [];
      raw.push(row);
      if (section === "thead") headRows++;
    }
    row.push({
      html: src.slice(cell.at, end),
      head: cell.head,
      rs: span(cell.attrs, "rowspan"),
      cs: span(cell.attrs, "colspan"),
      align: alignOf(cell.attrs),
    });
    cell = null;
  };

  STRUCT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRUCT.exec(src)) !== null) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "caption" || tag === "colgroup") {
      closeCell(m.index);
      skip = !closing;
      continue;
    }
    if (skip || tag === "col") continue;
    // 칸은 닫는 태그가 없어도 다음 구조 태그에서 닫힌다(HTML 의 생략 규칙).
    closeCell(m.index);
    if (tag === "td" || tag === "th") {
      if (!closing) cell = { at: m.index + m[0].length, head: tag === "th", attrs: m[3] };
      continue;
    }
    if (tag === "tr") {
      if (!closing) {
        row = [];
        raw.push(row);
        if (section === "thead") headRows++;
      } else row = null;
      continue;
    }
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      section = closing ? "" : tag;
      row = null;
      continue;
    }
    if (tag === "table" && closing) break;
  }
  closeCell(src.length);
  if (!raw.length || raw.every((r) => !r.length)) return null;
  if (!headRows && raw[0].length && raw[0].every((c) => c.head)) headRows = 1;

  // 자리 잡기. `taken[r][c]` 가 참이면 위에서 내려온 칸이 이미 차지했다.
  const height = raw.length;
  const grid: (HtmlCell | null | undefined)[][] = raw.map(() => []);
  for (let r = 0; r < height; r++) {
    let c = 0;
    for (const x of raw[r]) {
      while (grid[r][c] !== undefined) c++;
      const rs = Math.min(x.rs, height - r);
      grid[r][c] = { html: x.html, head: x.head, rs, cs: x.cs, align: x.align };
      for (let dr = 0; dr < rs; dr++)
        for (let dc = 0; dc < x.cs; dc++) if (dr || dc) grid[r + dr][c + dc] = null;
      c += x.cs;
    }
  }
  const width = Math.max(...grid.map((r) => r.length));
  const rows = grid.map((r) =>
    Array.from({ length: width }, (_, c): HtmlCell | null =>
      r[c] === undefined ? { html: "", head: false, rs: 1, cs: 1, align: "" } : (r[c] as HtmlCell | null),
    ),
  );
  return { rows, headRows };
}

// ---------------------------------------------------------------------------
// 칸 안의 글 — 마크다운 ↔ HTML.

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const TAG = /^(?:<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>)/;
const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;
const WORD = /[\p{L}\p{N}]/u;

function escHtml(ch: string): string {
  return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** `from` 부터 닫는 표시(`mark`)의 자리. 백슬래시로 막은 것과 코드 안의 것은 건너뛴다. */
function findClose(s: string, from: number, mark: string): number {
  for (let j = from; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(s.slice(j))![0];
      const end = s.indexOf(run, j + run.length);
      if (end >= 0) j = end + run.length - 1;
      continue;
    }
    if (!s.startsWith(mark, j)) continue;
    // `*` 하나를 찾는 중에 만난 `**` 는 안쪽 굵게의 표시다.
    if (mark.length === 1 && s[j + 1] === mark) {
      j++;
      continue;
    }
    if (j === from || /\s/.test(s[j - 1])) continue;
    if (mark[0] === "_" && WORD.test(s[j + mark.length] ?? "")) continue;
    return j;
  }
  return -1;
}

/**
 * 칸의 마크다운을 HTML 로. 굵게 · 기울임 · 취소선 · 코드 · 링크 · 줄바꿈을 바꾸고, 적어 둔 HTML
 * 태그와 문자 참조(`&lt;`)는 그대로 둔다(마크다운도 그렇게 읽는다). `[[위키링크]]` 는 HTML 안에서
 * 그릴 방법이 없어 글 그대로 남는다.
 */
export function mdInlineToHtml(src: string): string {
  return inline(src.replace(/\r\n?/g, "\n"));
}

function inline(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const rest = s.slice(i);
    if (ch === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      out += escHtml(s[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "\n") {
      out += "<br>";
      i++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(rest)![0];
      const end = s.indexOf(run, i + run.length);
      if (end >= 0 && s[end + run.length] !== "`") {
        let code = s.slice(i + run.length, end).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        out += `<code>${[...code].map(escHtml).join("")}</code>`;
        i = end + run.length;
        continue;
      }
      out += run;
      i += run.length;
      continue;
    }
    if (ch === "<") {
      const m = TAG.exec(rest);
      out += m ? m[0] : "&lt;";
      i += m ? m[0].length : 1;
      continue;
    }
    if (ch === "&") {
      const m = ENTITY.exec(rest);
      out += m ? m[0] : "&amp;";
      i += m ? m[0].length : 1;
      continue;
    }
    if (rest.startsWith("[[")) {
      const end = s.indexOf("]]", i + 2);
      if (end > i + 2) {
        out += [...s.slice(i, end + 2)].map(escHtml).join("");
        i = end + 2;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[((?:\\.|[^\]\\])*)\]\(\s*(<[^<>\n]*>|[^()\s]+)(?:\s+"([^"]*)")?\s*\)/.exec(rest);
      if (m) {
        const href = m[2].startsWith("<") ? m[2].slice(1, -1) : m[2];
        const title = m[3] !== undefined ? ` title="${escAttr(m[3])}"` : "";
        out += `<a href="${escAttr(href)}"${title}>${inline(m[1])}</a>`;
        i += m[0].length;
        continue;
      }
    }
    const pair = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : rest.startsWith("~~") ? "~~" : "";
    if (pair && s[i + 2] && !/\s/.test(s[i + 2]) && !(pair === "__" && WORD.test(s[i - 1] ?? ""))) {
      const end = findClose(s, i + 2, pair);
      if (end > i + 2) {
        const tag = pair === "~~" ? "del" : "strong";
        out += `<${tag}>${inline(s.slice(i + 2, end))}</${tag}>`;
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] && !/\s/.test(s[i + 1]) && !(ch === "_" && WORD.test(s[i - 1] ?? ""))) {
      const end = findClose(s, i + 1, ch);
      if (end > i + 1) {
        out += `<em>${inline(s.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }
    out += escHtml(ch);
    i++;
  }
  return out;
}

const MARK: Record<string, string> = {
  strong: "**",
  b: "**",
  em: "*",
  i: "*",
  del: "~~",
  s: "~~",
  strike: "~~",
};

/** 뷰어는 기울임을 그리지 않는다(`mdSegs`) — 보여 줄 때는 표시 없이 글만 남긴다. */
const SHOWN = new Set(["**", "~~"]);

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

/** 보여 줄 글 — 문자 참조를 모두 푼다. React 가 글자로만 그리므로 무엇이 나와도 안전하다. */
function decodeAll(s: string): string {
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, name: string) => {
    if (name[0] === "#") {
      const n = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[name.toLowerCase()] ?? m;
  });
}

/**
 * 고칠 글 — 다시 쓸 때 **다르게 읽히지 않는** 참조만 푼다. `&lt;b&gt;` 를 `<b>` 로 풀면 다음에
 * 쓸 때 태그가 되므로, `<` 뒤에 태그를 여는 글자가 오면 참조 그대로 둔다. `&amp;` 도 풀었을 때
 * 다른 참조가 되면 그대로 둔다.
 */
function decodeSafe(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#39|#124|vert);/g, (m, name: string, off: number, all: string) => {
    const next = all.slice(off + m.length);
    switch (name) {
      case "lt":
        return /^[A-Za-z/!]/.test(next) ? m : "<";
      case "amp":
        return ENTITY.test(`&${next}`) ? m : "&";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "#124":
      case "vert":
        return "|";
      default:
        return "'";
    }
  });
}

/** 마크다운 표시로 읽힐 글자를 막는다. `mdInlineToHtml` 이 읽는 자리만 — 그 밖은 그대로 둔다. */
function escMd(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const prev = s[i - 1] ?? "";
    const next = s[i + 1] ?? "";
    if (ch === "\\" && PUNCT.test(next)) out += "\\\\";
    else if (ch === "*" || ch === "`") out += `\\${ch}`;
    else if (ch === "~" && (next === "~" || prev === "~")) out += "\\~";
    else if (ch === "_" && !(WORD.test(prev) && WORD.test(next))) out += "\\_";
    else if (ch === "[" && (next === "[" || /^\[[^\]]*\]\(/.test(s.slice(i)))) out += "\\[";
    else out += ch;
  }
  return out;
}

/** 코드 조각을 감쌀 백틱. 안에 든 가장 긴 백틱 줄보다 하나 길게 둔다. */
function codeSpan(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

/**
 * 칸 안의 HTML 을 마크다운으로. `<br>` 은 칸 안의 줄바꿈(`\n`)이 된다.
 *
 * * 고칠 때(`display` 없음) — 모르는 태그는 원문 그대로 남기고(마크다운 칸에서도 HTML 은
 *   그려진다) 마크다운 표시로 읽힐 글자는 막는다. 다시 쓰면 같은 HTML 이 나온다.
 * * 보여 줄 때(`display`) — 모르는 태그는 걷어내고 참조는 모두 푼다. 뷰어가 `mdSegs` 로
 *   굵게 · 취소선 · 코드만 그리므로 그 셋만 표시로 남는다.
 */
export function htmlInlineToMd(html: string, opts: { display?: boolean } = {}): string {
  const display = !!opts.display;
  const text = (t: string) => {
    const flat = t.replace(/[ \t\r\n]+/g, " ");
    return display ? decodeAll(flat) : escMd(decodeSafe(flat));
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9-]*)\b([^<>]*)>/g;
  const links: (string | null)[] = [];
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out += text(html.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[2]?.toLowerCase();
    const closing = m[1] === "/";
    if (!tag) {
      if (!display) out += m[0];
    } else if (tag === "br") {
      out += "\n";
    } else if (tag === "p" || tag === "div") {
      if (out && !out.endsWith("\n")) out += "\n";
    } else if (MARK[tag]) {
      if (!display || SHOWN.has(MARK[tag])) out += MARK[tag];
    } else if (tag === "code" && !closing) {
      const end = html.toLowerCase().indexOf("</code>", last);
      if (end < 0) {
        if (!display) out += m[0];
        continue;
      }
      const code = decodeAll(html.slice(last, end).replace(/<[^<>]*>/g, "").replace(/[ \t\r\n]+/g, " "));
      out += codeSpan(code);
      last = re.lastIndex = end + "</code>".length;
    } else if (tag === "a") {
      const href = closing ? null : attr(m[3], "href");
      // 뷰어는 링크를 그리지 않는다 — 보여 줄 때는 글만 남긴다.
      if (display) continue;
      if (!closing) {
        links.push(href);
        out += href !== null ? "[" : m[0];
      } else {
        const h = links.pop();
        out += h !== undefined && h !== null ? `](${decodeAll(h)})` : m[0];
      }
    } else if (!display) {
      out += m[0];
    }
  }
  out += text(html.slice(last));
  return out
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}
