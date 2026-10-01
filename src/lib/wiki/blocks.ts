/**
 * 위키 페이지 출력의 파서.
 *
 * 추천처럼 펜스 JSON(` ```recommend `)으로 받지 않는 이유: 페이지 본문은 마크다운이라 안에
 * ``` 코드 블록이 흔하고, 그 첫 ``` 가 바깥 펜스를 닫아 버린다. 그래서 마크다운에 나올 일이
 * 없는 구분자를 쓴다.
 *
 * ```
 * <<<PAGE source>>>
 * 요약: 한 줄 요약           ← 선택. 있으면 걷어내 summary 로 쓴다
 * # 제목
 * 본문 …
 * <<<END>>>
 * ```
 *
 * 관대하게 읽는다 — 블록 바깥의 서술은 버리고, CRLF 를 받고, 모델이 본문을 ```markdown 으로
 * 한 번 더 감싸면 벗긴다. 닫는 `<<<END>>>` 가 없으면(출력 잘림) `complete: false` 로 돌려서
 * 호출자가 쓸지 말지 고르게 한다.
 *
 * 꺾쇠 수는 세지 않는다. 사내 FabriX(GLM)로 반영해 보니 모델이 닫는 줄을 `<<<END>>` 로 써서
 * 블록이 닫히지 않았고, 그 뒤의 ```wikiplan 펜스까지 소스 페이지 본문에 섞여 들어갔다. 그래서
 * 꺾쇠 2~3개를 모두 받고, 블록 안에서 계획 · 점검 펜스가 시작되면 거기서 블록을 닫는다 — 페이지
 * 본문에 그 펜스가 들어갈 일은 없다.
 */

export interface PageBlock {
  body: string;
  summary: string | null;
  /** 닫는 구분자까지 왔는가. false 면 출력이 잘린 것이다. */
  complete: boolean;
}

const OPEN = /^\s*<{2,3}\s*PAGE\s+([^>\s]+)\s*>{1,3}\s*$/i;
const CLOSE = /^\s*<{2,3}\s*\/?\s*(?:END|PAGE)\s*>{1,3}\s*$/i;
/** 응답 끝의 계획 · 점검 펜스. 블록 안에서 만나면 블록이 끝난 것이다. */
const TAIL_FENCE = /^\s*```(?:wikiplan|wikilint)\b/;
const SUMMARY = /^\s*(?:요약|summary)\s*[:：]\s*(.+?)\s*$/i;

/** 모델이 본문 전체를 ```markdown … ``` 으로 감쌌으면 벗긴다(안쪽 코드 블록은 그대로). */
function unwrap(body: string): string {
  const lines = body.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last--;
  if (first < 0 || last <= first) return body;
  if (/^```(?:markdown|md)?\s*$/i.test(lines[first]!.trim()) && lines[last]!.trim() === "```") {
    return lines.slice(first + 1, last).join("\n");
  }
  return body;
}

function finish(raw: string[], complete: boolean): PageBlock {
  let lines = unwrap(raw.join("\n")).split("\n");
  let summary: string | null = null;
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first >= 0) {
    const m = SUMMARY.exec(lines[first]!);
    if (m) {
      summary = m[1]!;
      lines = lines.slice(first + 1);
    }
  }
  return { body: lines.join("\n").trim(), summary, complete };
}

/**
 * 블록들을 키(`source` · `1` · `2` …)로 모은다. 같은 키가 두 번 나오면 뒤의 것이 이긴다 —
 * 모델이 고쳐 쓰는 경우가 대개 뒤에 온다.
 */
export function parsePageBlocks(text: string): Map<string, PageBlock> {
  const out = new Map<string, PageBlock>();
  let key: string | null = null;
  let buf: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const open = OPEN.exec(line);
    if (open) {
      if (key !== null) out.set(key, finish(buf, false)); // 닫지 않고 다음 블록을 열었다
      key = open[1]!.trim();
      buf = [];
      continue;
    }
    if (key !== null && (CLOSE.test(line) || TAIL_FENCE.test(line))) {
      out.set(key, finish(buf, true));
      key = null;
      buf = [];
      continue;
    }
    if (key !== null) buf.push(line);
  }
  if (key !== null) out.set(key, finish(buf, false));
  return out;
}

/**
 * 프롬프트에 싣는 입력(업무 파일 · 기존 페이지)에서 구분자를 무력화한다. 원본에 우연히
 * `<<<PAGE` 가 있으면 모델이 그것을 흉내 내 출력 구조가 꼬인다.
 */
export function escapeDelims(text: string): string {
  return text.replace(/<<</g, "‹‹‹").replace(/>>>/g, "›››");
}

/** 본문에서 한 줄 요약을 짐작한다 — 모델이 요약을 주지 않았을 때의 대비책. */
export function guessSummary(body: string, max = 80): string {
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("<!--") || line.startsWith(">")) continue;
    const text = line.replace(/^[-*]\s+|^\d+\.\s+/, "").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
    const clean = text.replace(/\[\[([^\]]+)\]\]/g, "$1").trim();
    if (clean) return [...clean].slice(0, max).join("");
  }
  return "";
}
