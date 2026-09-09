/**
 * Markdown block/inline parser ported from design/ContextFlow.dc.html
 * (`mdParse` / `mdSegs`, lines 1279-1320). Deliberately a narrow grammar:
 * headings, rules, task lists, quotes, bullets, ordered items, fenced code,
 * and inline `[[wikilink]]` / `` `code` `` / `**bold**` / `~~strike~~`.
 *
 * 설계에 없던 추가는 둘이다.
 *
 * * `~~취소선~~` — 보통의 마크다운 뷰어(Obsidian · GitHub)가 전부 그리는 표기라,
 *   여기서만 물결표 네 개가 본문에 그대로 남으면 같은 노트가 Vault 안에서 두 가지로
 *   보인다.
 * * **펜스 코드 블록** — 업무 노트에 로그 · 명령 · 설정 조각이 들어오는 것은 예외가
 *   아니라 평범한 일이다. 블록으로 읽지 않으면 그 줄들이 하나씩 문단으로 흩어지고
 *   ``` 세 글자가 본문에 남는다.
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

    if (/^\s{0,3}(-{3,}|_{3,}|\*{3,})$/.test(line)) {
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
