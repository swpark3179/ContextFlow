/**
 * Markdown block/inline parser ported from design/ContextFlow.dc.html
 * (`mdParse` / `mdSegs`, lines 1279-1320). Deliberately a narrow grammar:
 * headings, rules, task lists, quotes, bullets, ordered items, fenced code,
 * and inline `[[wikilink]]` / `` `code` `` / `**bold**` / `~~strike~~`.
 *
 * 설계에 없던 추가는 셋이다.
 *
 * * `~~취소선~~` — 보통의 마크다운 뷰어(Obsidian · GitHub)가 전부 그리는 표기라,
 *   여기서만 물결표 네 개가 본문에 그대로 남으면 같은 노트가 Vault 안에서 두 가지로
 *   보인다.
 * * **펜스 코드 블록** — 업무 노트에 로그 · 명령 · 설정 조각이 들어오는 것은 예외가
 *   아니라 평범한 일이다. 블록으로 읽지 않으면 그 줄들이 하나씩 문단으로 흩어지고
 *   ``` 세 글자가 본문에 남는다.
 * * **표(GFM)** — 비교 · 일정 · 담당 같은 정리는 노트에서 표로 쓰는 것이 보통이다.
 *   읽지 않으면 `| a | b |` 줄과 `|---|` 구분 줄이 문단으로 흩어져 파이프만 남는다.
 *
 * * **이미지** — `![alt](경로)` 와 Obsidian 의 `![[파일.png]]`. 붙여넣은 스크린샷이
 *   업무 폴더의 `images/` 에 저장되고 링크가 들어오므로(`useStore.saveImage`) 뷰어가
 *   그려야 한다.
 *   **이미지만 있는 줄**만 이미지 블록이 된다 — 문장 사이에 끼운 그림은 노트에서 드물고,
 *   한 줄을 통째로 차지해야 크기 단계(작게 · 중간 · 크게)가 의미가 있다. 너비는 Obsidian
 *   과 같은 `![alt|320](경로)` · `![[파일.png|320]]` 표기로 문서에 남긴다.
 *
 * 블록마다 **원본 줄 번호(`line`)** 를 들고 다닌다. 뷰어에서 체크박스를 눌렀을 때
 * 고쳐야 할 줄이 어디인지가 그것으로 정해진다(`toggleTaskLine`).
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

export type TableAlign = "" | "left" | "center" | "right";

export interface Block {
  key: string;
  /** 파싱한 원본에서 이 블록이 시작하는 줄(0부터). `toggleTaskLine` 이 쓴다. */
  line: number;
  isH1: boolean;
  isH2: boolean;
  isH3: boolean;
  isHr: boolean;
  isBody: boolean;
  /** 인용. 이어지는 인용 줄은 뷰어에서 하나의 세로선으로 붙는다. */
  isQuote: boolean;
  /** 펜스 코드 블록 — `lang` 과 `code` 만 의미가 있다. */
  isFence: boolean;
  /** 펜스 뒤에 적힌 정보 문자열의 첫 낱말(`ts` · `bash` …). 없으면 빈 문자열. */
  lang: string;
  code: string;
  /** GFM 표 — `align` · `head` · `rows` 만 의미가 있다. */
  isTable: boolean;
  /** 열마다의 정렬. 구분 줄의 `:` 위치로 정한다. 없으면 빈 문자열(왼쪽). */
  align: TableAlign[];
  /** 머리 줄의 칸들. 칸마다 인라인 조각을 든다. */
  head: Seg[][];
  /** 본문 줄들. 모든 줄은 머리 줄과 같은 칸 수로 맞춰져 있다. */
  rows: Seg[][][];
  /** 이미지 — `src` · `alt` · `width` · `imgIdx` 만 의미가 있다. */
  isImage: boolean;
  /** 적힌 그대로의 경로(꺾쇠만 벗긴다). 풀어 읽는 것은 `resolveImageSrc` 다. */
  src: string;
  alt: string;
  /** `|320` 으로 정한 너비(px). 없으면 `null` — 원래 크기(글줄 폭을 넘지 않게). */
  width: number | null;
  /** 같은 줄에서 몇 번째 이미지인지(0부터). `setImageWidth` 가 고칠 자리를 찾는 데 쓴다. */
  imgIdx: number;
  /** 위키 표기(`![[…]]`)였는지. 이 표기의 경로는 퍼센트 인코딩하지 않는다. */
  wiki: boolean;
  /** 체크리스트 항목. 뷰어에서 눌러 토글할 수 있는 유일한 블록이다. */
  isTask: boolean;
  checked: boolean;
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

function base(key: string, line: number): Block {
  return {
    key,
    line,
    isH1: false,
    isH2: false,
    isH3: false,
    isHr: false,
    isBody: false,
    isQuote: false,
    isFence: false,
    lang: "",
    code: "",
    isTable: false,
    align: [],
    head: [],
    rows: [],
    isImage: false,
    src: "",
    alt: "",
    width: null,
    imgIdx: 0,
    wiki: false,
    isTask: false,
    checked: false,
    hasMark: false,
    mark: "",
    markFg: "#a09a8f",
    indent: 0,
    fg: "#3a3630",
    segs: [],
    text: "",
  };
}

/** 목록 한 단계당 들여쓰기 픽셀. 깊이는 폭이 아니라 조상과의 상대 비교로 정한다. */
const STEP = 16;
/** 펜스 코드 블록의 여닫는 줄. 백틱과 물결표 둘 다 받는다(CommonMark). */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const TASK = /^(\s*)[-*+][ \t]+\[([ xX])\](?:[ \t]+(.*))?$/;
const QUOTE = /^(\s*)>[ \t]?(.*)$/;
const BULLET = /^(\s*)[-*+][ \t]+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)][ \t]+(.*)$/;

/**
 * 여는 펜스만큼의 들여쓰기를 코드에서 걷어낸다(CommonMark 와 같은 규칙).
 * 목록 안에 들어간 코드 블록이 카드 안에서 또 한 번 밀려 보이지 않게 한다.
 */
function dedent(lines: string[], pad: number): string[] {
  if (pad <= 0) return lines;
  return lines.map((l) => {
    let cut = 0;
    while (cut < pad && (l[cut] === " " || l[cut] === "\t")) cut++;
    return l.slice(cut);
  });
}

/**
 * 블록 **끝의** 빈 줄을 걷어낸다. 안쪽의 빈 줄은 코드의 일부라 그대로 두지만, 끝의
 * 것은 파일 마지막 개행이 들어온 자취일 뿐이라 카드에 빈 줄 하나와 잘못된 줄 수를
 * 남긴다(닫는 펜스가 없는 블록에서 늘 그렇다).
 */
function trimTail(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

/**
 * 이미지 토큰 하나. `![alt](dest "title")` 또는 `![[name|alt]]`.
 * dest 는 꺾쇠(`<a b.png>`)로 감싸 공백을 넣을 수 있다(CommonMark).
 */
const IMAGE_SRC =
  /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)|!\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/
    .source;
/** 위키 표기는 이미지 확장자일 때만 이미지다 — `![[노트]]` 는 노트 삽입이라 다른 이야기다. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/** `alt|320` · `alt|320x200` 에서 너비를 떼어 낸다. 숫자가 아니면 전부 alt 다. */
function splitWidth(alt: string): { alt: string; width: number | null } {
  const m = alt.match(/^(.*?)\|\s*(\d{1,5})(?:\s*x\s*\d{1,5})?\s*$/);
  if (!m) return { alt, width: null };
  const w = parseInt(m[2], 10);
  return { alt: m[1], width: w > 0 ? w : null };
}

interface ImageToken {
  start: number;
  end: number;
  src: string;
  alt: string;
  width: number | null;
  wiki: boolean;
}

/** 한 줄의 이미지 토큰들. 위키 표기 중 이미지가 아닌 것은 건너뛴다. */
function imageTokens(line: string): ImageToken[] {
  const out: ImageToken[] = [];
  const re = new RegExp(IMAGE_SRC, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[4] !== undefined) {
      const name = m[4].trim();
      if (!IMAGE_FILE.test(name)) continue;
      const w = m[5] !== undefined ? splitWidth(`|${m[5]}`) : { alt: "", width: null };
      // `![[a.png|설명]]` 처럼 숫자가 아닌 꼬리는 alt 로 읽는다.
      const alt = m[5] !== undefined && w.width === null ? m[5] : "";
      out.push({ start: m.index, end: m.index + m[0].length, src: name, alt, width: w.width, wiki: true });
      continue;
    }
    const dest = m[2].startsWith("<") ? m[2].slice(1, -1) : m[2];
    const { alt, width } = splitWidth(m[1]);
    out.push({ start: m.index, end: m.index + m[0].length, src: dest, alt, width, wiki: false });
  }
  return out;
}

/** 이미지만으로 이뤄진 줄이면 그 토큰들, 아니면 `null`. */
function imageLine(line: string): ImageToken[] | null {
  if (!line.includes("![")) return null;
  const toks = imageTokens(line);
  if (!toks.length) return null;
  let rest = "";
  let at = 0;
  for (const t of toks) {
    rest += line.slice(at, t.start);
    at = t.end;
  }
  rest += line.slice(at);
  return rest.trim() ? null : toks;
}

/**
 * 그 줄의 `idx` 번째 이미지 너비를 바꾼 전체 텍스트. `null` 너비는 표기를 걷어내
 * 원래 크기로 되돌린다. 줄이나 이미지가 없으면 `null`.
 *
 * `toggleTaskLine` 과 같이 **그 토큰 하나만** 고친다 — alt 글자 · 경로 · 제목 · 줄 끝
 * (CRLF 포함)은 그대로 남는다.
 */
export function setImageWidth(
  src: string,
  line: number,
  idx: number,
  width: number | null,
): string | null {
  const lines = src.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const text = lines[line];
  const tok = imageTokens(text)[idx];
  if (!tok) return null;
  const raw = text.slice(tok.start, tok.end);
  const tail = width === null ? "" : `|${Math.round(width)}`;
  let next: string;
  if (tok.wiki) {
    const name = raw.slice(3, -2).split("|")[0];
    // 숫자가 아닌 꼬리(설명)는 너비와 함께 둘 자리가 없다. 너비를 고르면 그것이 이긴다.
    const keep = tok.alt && width === null ? `|${tok.alt}` : "";
    next = `![[${name}${tail || keep}]]`;
  } else {
    const close = raw.indexOf("](");
    next = `![${tok.alt}${tail}${raw.slice(close)}`;
  }
  lines[line] = text.slice(0, tok.start) + next + text.slice(tok.end);
  return lines.join("\n");
}

/** 표의 구분 줄 한 칸: `---` · `:--` · `--:` · `:-:`. */
const DELIM_CELL = /^:?-+:?$/;

/**
 * 표 한 줄을 칸으로 자른다(GFM 과 같은 규칙). 양 끝의 파이프는 있어도 없어도 되고,
 * `\|` 는 칸을 가르지 않는 글자 그대로의 파이프다.
 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** 구분 줄이면 열마다의 정렬을, 아니면 `null`. 파이프가 하나도 없으면 구분선(`---`)이다. */
function delimRow(line: string): TableAlign[] | null {
  if (!line.includes("|")) return null;
  const cells = splitRow(line);
  if (!cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : "";
  });
}

export function mdParse(src: string): Block[] {
  const out: Block[] = [];
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");

  /**
   * 목록 깊이는 **조상과의 상대 비교**로 정한다. 편집기 설정마다 2칸 · 4칸 · 탭이
   * 섞이므로 폭에 기대면 같은 문서가 사람마다 다르게 접힌다(`bstorm.ts` 와 같은 이유).
   * 목록이 아닌 블록을 만나면 비운다 — 그때 목록이 끝난다.
   */
  const stack: number[] = [];
  const depthOf = (indent: number): number => {
    while (stack.length && stack[stack.length - 1] >= indent) stack.pop();
    stack.push(indent);
    return stack.length - 1;
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const key = `b${i}`;
    const at = i;

    const fence = raw.match(FENCE);
    // 백틱 펜스의 정보 문자열에는 백틱이 올 수 없다(CommonMark). 이 규칙이 없으면
    // 한 줄에서 여닫은 `` ```x``` `` 같은 줄이 여는 펜스로 읽혀 문서의 나머지 전부를
    // 코드로 삼킨다 — 닫는 펜스를 못 찾으면 끝까지 코드이기 때문이다.
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
      const pad = fence[1].length;
      const bar = fence[2];
      const info = fence[3].trim();
      // 닫는 펜스는 같은 글자로 같은 수 이상이어야 한다. 없으면 문서 끝까지가 코드다
      // (CommonMark 와 같다) — 그래야 아직 닫지 않은 블록도 코드로 보인다.
      const closer = new RegExp(`^\\s*${bar[0]}{${bar.length},}\\s*$`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !closer.test(lines[j])) {
        body.push(lines[j]);
        j++;
      }
      out.push({
        ...base(key, at),
        isFence: true,
        lang: info.split(/[\s,:]/)[0] ?? "",
        code: trimTail(dedent(body, pad)).join("\n"),
      });
      stack.length = 0;
      i = j + 1;
      continue;
    }

    i++;
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;

    // 들여쓴 `---` 도 구분선으로 읽는다. CommonMark 는 네 칸부터 코드 블록으로 보지만
    // 이 뷰어에는 그런 문법이 없어서, 그대로 두면 본문에 `---` 세 글자가 남는다.
    if (/^\s*(-{3,}|_{3,}|\*{3,})$/.test(line)) {
      stack.length = 0;
      out.push({ ...base(key, at), isHr: true });
      continue;
    }
    if (/^###\s+/.test(line)) {
      stack.length = 0;
      out.push({ ...base(key, at), isH3: true, text: line.replace(/^###\s+/, "") });
      continue;
    }
    if (/^##\s+/.test(line)) {
      stack.length = 0;
      out.push({ ...base(key, at), isH2: true, text: line.replace(/^##\s+/, "") });
      continue;
    }
    if (/^#\s+/.test(line)) {
      stack.length = 0;
      out.push({ ...base(key, at), isH1: true, text: line.replace(/^#\s+/, "") });
      continue;
    }

    let m = line.match(TASK);
    if (m) {
      const done = m[2] !== " ";
      const depth = depthOf(m[1].length);
      out.push({
        ...base(key, at),
        isBody: true,
        isTask: true,
        checked: done,
        hasMark: true,
        mark: done ? "☑" : "☐",
        markFg: done ? GREEN : "#b5afa2",
        indent: 2 + depth * STEP,
        fg: done ? "#8a857c" : "#3a3630",
        segs: mdSegs(m[3] ?? "", key),
      });
      continue;
    }
    m = line.match(QUOTE);
    if (m) {
      stack.length = 0;
      out.push({
        ...base(key, at),
        isBody: true,
        isQuote: true,
        hasMark: true,
        mark: "│",
        markFg: "#cfcabf",
        indent: 2,
        fg: "#6a665e",
        segs: mdSegs(m[2], key),
      });
      continue;
    }
    m = line.match(BULLET);
    if (m) {
      const depth = depthOf(m[1].length);
      out.push({
        ...base(key, at),
        isBody: true,
        hasMark: true,
        mark: depth ? "–" : "·",
        indent: 2 + depth * STEP,
        // 깊이는 들여쓰기가 이미 말한다. 색을 단계마다 더 빼면 세 번째 단계부터는
        // 읽히지 않으므로 한 단만 낮추고 거기서 멈춘다.
        fg: depth ? "#4e4a43" : "#3a3630",
        segs: mdSegs(m[2], key),
      });
      continue;
    }
    m = line.match(ORDERED);
    if (m) {
      const depth = depthOf(m[1].length);
      out.push({
        ...base(key, at),
        isBody: true,
        hasMark: true,
        mark: `${m[2]}.`,
        indent: 2 + depth * STEP,
        fg: depth ? "#4e4a43" : "#3a3630",
        segs: mdSegs(m[3], key),
      });
      continue;
    }

    const imgs = imageLine(line);
    if (imgs) {
      stack.length = 0;
      imgs.forEach((t, n) =>
        out.push({
          ...base(n ? `${key}i${n}` : key, at),
          isImage: true,
          src: t.src,
          alt: t.alt,
          width: t.width,
          imgIdx: n,
          wiki: t.wiki,
        }),
      );
      continue;
    }

    // 표: 파이프가 든 줄 바로 아래에 같은 칸 수의 구분 줄이 오면 그때부터 표다.
    // 칸 수가 다르면 표가 아니다(GFM) — 파이프를 쓴 평범한 문장을 표로 오해하지 않게.
    const align = line.includes("|") && i < lines.length ? delimRow(lines[i]) : null;
    const headCells = align ? splitRow(line) : [];
    if (align && headCells.length === align.length) {
      const n = align.length;
      const fit = (cells: string[]) =>
        Array.from({ length: n }, (_, c) => cells[c] ?? "");
      const rows: Seg[][][] = [];
      let j = i + 1;
      // 표는 빈 줄이나 파이프가 없는 줄에서 끝난다. 펜스가 열리면 거기서도 끝난다.
      while (j < lines.length && lines[j].trim() && lines[j].includes("|") && !FENCE.test(lines[j])) {
        const r = rows.length;
        rows.push(fit(splitRow(lines[j])).map((t, c) => mdSegs(t, `${key}r${r}c${c}`)));
        j++;
      }
      stack.length = 0;
      out.push({
        ...base(key, at),
        isTable: true,
        align,
        head: fit(headCells).map((t, c) => mdSegs(t, `${key}h${c}`)),
        rows,
      });
      i = j;
      continue;
    }

    stack.length = 0;
    out.push({ ...base(key, at), isBody: true, segs: mdSegs(line, key) });
  }
  return out;
}

/**
 * `- [ ]` ↔ `- [x]`. 고친 전체 텍스트를 돌려주고, 그 줄이 체크 항목이 아니면 `null`.
 *
 * 줄 하나의 대괄호 **안쪽 한 글자만** 바꾼다. 그래서 CRLF 로 저장된 파일도, 줄 끝
 * 공백도, 손으로 맞춰 둔 들여쓰기도 그대로 남는다 — 체크 하나를 눌렀는데 파일 전체가
 * 다시 쓰이면 Obsidian 쪽 diff 가 통째로 뒤집힌다.
 */
const TASK_MARK = /^(\s*[-*+][ \t]+\[)([ xX])(\])/;

export function toggleTaskLine(src: string, line: number): string | null {
  const lines = src.split("\n");
  if (line < 0 || line >= lines.length) return null;
  if (!TASK_MARK.test(lines[line])) return null;
  lines[line] = lines[line].replace(
    TASK_MARK,
    (_all, open: string, mark: string, close: string) =>
      `${open}${mark === " " ? "x" : " "}${close}`,
  );
  return lines.join("\n");
}

export interface Frontmatter {
  fm: string;
  body: string;
  /**
   * 본문 첫 줄의 **문서 기준** 줄 번호. 뷰어는 본문만 파싱하지만(블록의 `line` 도
   * 본문 기준이다) 고쳐 쓰는 것은 문서 전체이므로, 그 사이를 잇는 값이 필요하다.
   *
   * 프런트마터의 줄 수를 세어 짐작하지 않고 **자른 자리에서 그대로** 얻는다. 닫는
   * 줄이 `---` 하나가 아닐 수 있기 때문이다(`--- ` 처럼 공백이 붙거나 `----` 처럼
   * 대시가 하나 더 많거나, 프런트마터가 비어 있거나). 짐작한 값이 한 줄만 밀려도
   * 체크박스를 눌렀을 때 **다른 줄**이 토글된다 — 눈에 띄지 않는 데이터 손상이다.
   */
  bodyLine: number;
}

/** Splits `---\n...\n---\n` off the top so the viewer can skip it. */
export function splitFrontmatter(src: string): Frontmatter {
  const text = src.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { fm: "", body: text, bodyLine: 0 };
  const lines = text.split("\n");
  // 닫는 줄은 **줄 단위로** 찾는다. 문자열 오프셋으로 자르면 그 줄의 꼬리(공백 ·
  // 네 번째 대시)가 본문 앞에 남아 본문이 한 줄 밀린다. Obsidian 도 닫는 줄 전체가
  // 대시일 때만 프런트마터로 읽는다.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^-{3,}\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { fm: "", body: text, bodyLine: 0 };
  return {
    fm: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
    bodyLine: end + 1,
  };
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
