/**
 * 업무 파일의 마크다운 구조 — 간략 입력 정리(`brief.ts`)와 이슈 추가(`issue.ts`)가 함께 쓰는 순수 조각.
 *
 * 둘 다 "사람이 쓴 노트의 알맞은 자리에 덧붙인다" 는 일을 하므로 frontmatter 를 떼는 규칙, 코드 펜스 밖의 제목을
 * 읽는 규칙, 열린 할 일을 찾는 규칙이 같아야 한다. 서로를 import 하지 않게 여기 모았다.
 */

export const RUN_LOG_HEADING = "## 실행 이력 (Run Log)";

export const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
export const FENCE_RE = /^\s*(```+|~~~+)/;
/** 열린 체크 줄 — `- [ ] 할 일`. 글머리표는 `-` · `*` · `+`, 들여쓰기 허용. */
export const OPEN_TODO_RE = /^(\s*[-*+]\s+)\[ \]\s+(.*?)\s*$/;

const HEADINGS_CAP = 20;
const HEAD_CAP = 200;
/** 파일 하나에서 싣는 열린 할 일 수. */
export const TODOS_CAP = 15;

const cut = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s);

/** 원문을 frontmatter(원문 바이트 그대로)와 본문으로 나눈다. 닫는 줄은 `splitFrontmatter` 와 같은 규칙. */
export function splitHead(full: string): { head: string; body: string } {
  if (!/^---\r?\n/.test(full)) return { head: "", body: full };
  const re = /\r?\n/g;
  let at = 0;
  let first = true;
  for (let m = re.exec(full); m; m = re.exec(full)) {
    const line = full.slice(at, m.index);
    const next = m.index + m[0].length;
    if (!first && /^-{3,}\s*$/.test(line)) return { head: full.slice(0, next), body: full.slice(next) };
    first = false;
    at = next;
  }
  // 닫는 줄 뒤에 줄바꿈 없이 끝난 노트.
  if (!first && /^-{3,}\s*$/.test(full.slice(at))) return { head: full, body: "" };
  return { head: "", body: full };
}

/** 코드 펜스 밖의 줄마다 `fn(줄, 번호)` — 펜스 안의 `#` 은 제목이 아니다. `true` 를 돌려주면 멈춘다. */
export function eachOutsideFence(lines: string[], fn: (line: string, i: number) => boolean | void): void {
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (fn(line, i) === true) return;
  }
}

/** 제목 줄 비교 — 단계와 글이 같으면 같은 제목. 제목이 아니면 `null`. */
export function headingKey(line: string): string | null {
  const h = HEADING_RE.exec(line.trim());
  return h && h[2] ? `${h[1]!.length} ${h[2]}` : null;
}

/** 제목 줄의 단계(`##` → 2). 제목이 아니면 0. 들여 쓴 줄은 제목으로 보지 않는다. */
export function headingLevel(line: string): number {
  const h = HEADING_RE.exec(line);
  return h && h[2] ? h[1]!.length : 0;
}

/** 원문 → 1~3단계 제목(펜스 밖)과 본문 앞부분. frontmatter 는 뺀다. */
export function outlineOf(text: string): { headings: { level: number; text: string; raw: string }[]; head: string } {
  const body = splitHead(text).body.replace(/\r\n/g, "\n");
  const headings: { level: number; text: string; raw: string }[] = [];
  eachOutsideFence(body.split("\n"), (line) => {
    const h = HEADING_RE.exec(line);
    if (h && h[1]!.length <= 3 && h[2]) headings.push({ level: h[1]!.length, text: h[2], raw: line.trim() });
    return headings.length >= HEADINGS_CAP;
  });
  // 앞부분은 무엇을 적는 문서인지 보이려는 것 — 코드는 뺀다.
  const prose = body.replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ");
  const head = cut(prose.replace(/\s+/g, " ").trim(), HEAD_CAP);
  return { headings, head };
}

export interface OpenTodo {
  /** 할 일 글(`PG 연동 교체`). */
  text: string;
  /** 원문 줄(앞뒤 공백 뺀 것) — 체크할 때 이것으로 다시 찾는다. */
  raw: string;
  /** 이 줄이 속한 제목 줄. 첫 제목보다 앞이면 `null`. */
  heading: string | null;
}

/** 원문 → 펜스 밖의 열린 할 일(`- [ ] …`)과 그 줄이 속한 제목. frontmatter 는 뺀다. */
export function openTodosOf(text: string, cap = TODOS_CAP): OpenTodo[] {
  const lines = splitHead(text).body.replace(/\r\n/g, "\n").split("\n");
  const out: OpenTodo[] = [];
  let heading: string | null = null;
  eachOutsideFence(lines, (line) => {
    if (HEADING_RE.test(line)) {
      heading = line.trim();
      return false;
    }
    const t = OPEN_TODO_RE.exec(line);
    if (t && t[2]) out.push({ text: t[2], raw: line.trim(), heading });
    return out.length >= cap;
  });
  return out;
}
