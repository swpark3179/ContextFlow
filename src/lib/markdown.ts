/**
 * Markdown block/inline parser ported from design/ContextFlow.dc.html
 * (`mdParse` / `mdSegs`, lines 1279-1320). Deliberately the same limited
 * grammar the design renders: headings, rules, task lists, quotes, bullets,
 * ordered items, and inline `[[wikilink]]` / `` `code` `` / `**bold**`.
 *
 * `~~취소선~~` 은 설계에 없던 하나뿐인 추가다. 보통의 마크다운 뷰어(Obsidian ·
 * GitHub)가 전부 그리는 표기라, 여기서만 물결표 네 개가 본문에 그대로 남으면
 * 같은 노트가 Vault 안에서 두 가지로 보인다.
 */
import { GREEN } from "./design";

export interface Seg {
  key: string;
  text: string;
  isT: boolean;
  isB: boolean;
  isStrike: boolean;
  isCode: boolean;
  isLink: boolean;
}

export interface Block {
  key: string;
  isH2: boolean;
  isH3: boolean;
  isHr: boolean;
  isBody: boolean;
  hasMark: boolean;
  mark: string;
  markFg: string;
  indent: number;
  fg: string;
  segs: Seg[];
  text: string;
}

export function mdSegs(text: string, key: string): Seg[] {
  const out: Seg[] = [];
  const re = /(\[\[[^\]]+\]\]|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const push = (t: string, kind: "t" | "b" | "s" | "c" | "l") => {
    out.push({
      key: `${key}s${i++}`,
      text: t,
      isT: kind === "t",
      isB: kind === "b",
      isStrike: kind === "s",
      isCode: kind === "c",
      isLink: kind === "l",
    });
  };
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index), "t");
    const tk = m[0];
    if (tk[0] === "[") push(tk.slice(2, -2), "l");
    else if (tk[0] === "`") push(tk.slice(1, -1), "c");
    else if (tk[0] === "~") push(tk.slice(2, -2), "s");
    else push(tk.slice(2, -2), "b");
    last = m.index + tk.length;
  }
  if (last < text.length) push(text.slice(last), "t");
  if (!out.length) push(text, "t");
  return out;
}

function base(key: string): Block {
  return {
    key,
    isH2: false,
    isH3: false,
    isHr: false,
    isBody: false,
    hasMark: false,
    mark: "",
    markFg: "#a09a8f",
    indent: 0,
    fg: "#3a3630",
    segs: [],
    text: "",
  };
}

export function mdParse(src: string): Block[] {
  const out: Block[] = [];
  (src || "").split("\n").forEach((raw, i) => {
    const key = `b${i}`;
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) return;

    if (/^---+$/.test(line.trim())) {
      out.push({ ...base(key), isHr: true });
      return;
    }
    if (/^###\s+/.test(line)) {
      out.push({ ...base(key), isH3: true, text: line.replace(/^###\s+/, "") });
      return;
    }
    if (/^##\s+/.test(line)) {
      out.push({ ...base(key), isH2: true, text: line.replace(/^##\s+/, "") });
      return;
    }
    if (/^#\s+/.test(line)) {
      out.push({ ...base(key), isH2: true, text: line.replace(/^#\s+/, "") });
      return;
    }

    let m = line.match(/^-\s+\[([ xX])\]\s+(.*)$/);
    if (m) {
      const done = m[1] !== " ";
      out.push({
        ...base(key),
        isBody: true,
        hasMark: true,
        mark: done ? "☑" : "☐",
        markFg: done ? GREEN : "#b5afa2",
        indent: 2,
        fg: done ? "#8a857c" : "#3a3630",
        segs: mdSegs(m[2], key),
      });
      return;
    }
    m = line.match(/^>\s?(.*)$/);
    if (m) {
      out.push({
        ...base(key),
        isBody: true,
        hasMark: true,
        mark: "│",
        markFg: "#cfcabf",
        indent: 2,
        fg: "#6a665e",
        segs: mdSegs(m[1], key),
      });
      return;
    }
    // Indented bullets are checked before flush ones so nesting survives.
    m = line.match(/^\s{2,}[-*]\s+(.*)$/);
    if (m) {
      out.push({
        ...base(key),
        isBody: true,
        hasMark: true,
        mark: "–",
        indent: 18,
        fg: "#6a665e",
        segs: mdSegs(m[1], key),
      });
      return;
    }
    m = line.match(/^[-*]\s+(.*)$/);
    if (m) {
      out.push({ ...base(key), isBody: true, hasMark: true, mark: "·", indent: 2, segs: mdSegs(m[1], key) });
      return;
    }
    m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) {
      out.push({
        ...base(key),
        isBody: true,
        hasMark: true,
        mark: `${m[1]}.`,
        indent: 2,
        segs: mdSegs(m[2], key),
      });
      return;
    }
    out.push({ ...base(key), isBody: true, segs: mdSegs(line, key) });
  });
  return out;
}

/** Splits `---\n...\n---\n` off the top so the viewer can skip it. */
export function splitFrontmatter(src: string): { fm: string; body: string } {
  const text = src.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { fm: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fm: "", body: text };
  return { fm: text.slice(4, end), body: text.slice(end + 5) };
}

/** Reads one scalar out of a raw frontmatter block, for the editor's header. */
export function fmValue(fm: string, key: string): string {
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    let v = line.slice(idx + 1).trim();
    if (
      v.length >= 2 &&
      ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return "";
}
