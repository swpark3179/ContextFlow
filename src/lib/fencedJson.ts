/**
 * 펜스 JSON 출력 계약의 파서.
 *
 * 모델에게 "자유롭게 서술한 뒤 **맨 마지막에** 펜스 하나" 를 요구하고, 여기서 그 펜스를
 * 꺼낸다. 네이티브 structured output 이나 도구 호출을 쓰지 않는 이유는 연결 4종의 공통
 * 분모가 "텍스트를 흘려보내는 것" 뿐이기 때문이다 — 로컬 CLI 2종은 JSON 모드가 없다.
 *
 * 이 함수가 포기하면 그 답변은 통째로 버려지므로 관대하게 읽는다. 가장 흔한 실패는
 * 형식 위반이 아니라 **출력 잘림** 이다 — 모델이 출력 토큰 상한에 닿으면 닫는 ``` 도
 * 닫는 `}` 도 영영 오지 않는다. 그래서 온전한 후보를 먼저 다 시도하고, 하나도 없을
 * 때만 잘린 것으로 보고 닫아서 살린다.
 */

export interface FencedJson {
  value: unknown;
  /**
   * 잘린 JSON 을 닫아서 살려낸 값이다 — 앞쪽 필드는 온전하지만 뒤쪽 항목은 빠져 있다.
   * 호출자는 이것으로 "실패" 와 "일부만 확보" 를 구분한다.
   */
  truncated: boolean;
}

/** 재파싱 시도 상한. 절단점 하나가 파싱 1회이므로 무한정 늘리지 않는다. */
const MAX_REPAIR_CUTS = 400;

interface Scan {
  /** 아직 닫히지 않은 `{` · `[` 를 연 순서대로. */
  stack: string[];
  /** 문자열 안에서 끝났는가. */
  inStr: boolean;
  /** 역슬래시 뒤에서 끝났는가. */
  esc: boolean;
  /**
   * 잘라도 구조가 깨지지 않는 지점들 — 문자열 밖의 `,` 위치와 `{` · `[` 바로 뒤.
   * 뒤에서부터 되짚으며 "마지막 온전한 항목까지" 를 찾는 데 쓴다.
   */
  cuts: number[];
}

function scanJson(text: string): Scan {
  const stack: string[] = [];
  const cuts: number[] = [];
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") {
      stack.push(c);
      cuts.push(i + 1);
    } else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") cuts.push(i);
  }

  return { stack, inStr, esc, cuts };
}

/**
 * `from` 의 `{` 부터 균형이 맞는 지점까지. 끝까지 닫히지 않으면 남은 전부를 돌려준다.
 *
 * 단순한 `lastIndexOf("{")` ~ `lastIndexOf("}")` 를 대신한다. 그 방식은 잘린 응답에서
 * **맨 끝의 안쪽 객체 조각**(예: `{ "id": "Tasks/보고서`)을 집어 언제나 파싱에 실패한다.
 */
function balancedFrom(text: string, from: number): string {
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return text.slice(from);
}

/**
 * `cut` 까지 잘라 낸 뒤 열린 문자열 · 괄호를 닫아 올바른 JSON 으로 만든다.
 * 닫을 괄호가 없으면 애초에 잘린 게 아니므로 `null`.
 */
function closeAt(text: string, cut: number): string | null {
  let body = text.slice(0, cut).trimEnd();
  const { stack, inStr, esc } = scanJson(body);
  if (stack.length === 0) return null;

  if (esc) body = body.slice(0, -1); // 매달린 역슬래시
  if (inStr) body += '"';
  body = body.trimEnd();

  // 값이 오다 만 자리. `,` 는 지우고, `:` 는 `null` 로 채운다(키를 되짚는 것보다 안전하다).
  const last = body[body.length - 1];
  if (last === ",") body = body.slice(0, -1).trimEnd();
  else if (last === ":") body += "null";

  for (let i = stack.length - 1; i >= 0; i--) body += stack[i] === "{" ? "}" : "]";
  return body;
}

/**
 * 잘린 JSON 살리기 — 끝에서부터 안전한 절단점을 되짚으며 닫아 본다.
 *
 * 첫 시도(끝 그대로 닫기)가 실패하는 흔한 이유는 값 없이 키만 온 경우(`…,"items"`)라,
 * 그 다음 절단점(직전 `,`)에서 대개 성공한다. 앞쪽 필드는 그대로 살아남는다.
 */
function repairJson(raw: string): unknown | null {
  const text = raw.trimEnd();
  const { cuts } = scanJson(text);
  const points = [text.length, ...[...cuts].reverse()].slice(0, MAX_REPAIR_CUTS);

  for (const cut of points) {
    const closed = closeAt(text, cut);
    if (closed === null) continue;
    try {
      const v: unknown = JSON.parse(closed);
      if (v !== null && typeof v === "object") return v;
    } catch {
      /* 다음 절단점으로 */
    }
  }
  return null;
}

/**
 * 출력이 잘린 것으로 보이는가 — 원격이 종료 사유를 주지 않을 때의 대비책이다.
 *
 * AI Pro 는 `finish_reason: "length"` 를 주지만(`RunEvent.truncated`) FabriX 는 주지 않고
 * 로컬 CLI 도 주지 않는다. 그때는 모양으로 판단한다: 펜스를 열고 닫지 않았거나, 펜스
 * 없이 괄호가 열린 채로 끝났다.
 */
export function looksTruncated(text: string, label: string): boolean {
  const fence = "```" + label;
  const open = text.lastIndexOf(fence);
  if (open !== -1) return !text.includes("```", open + fence.length);

  const first = text.indexOf("{");
  if (first === -1) return false;
  // 닫는 `}` 가 어딘가 있다는 것만으로는 부족하다 — 앞쪽 중첩 객체가 닫힌 것일 수 있다.
  return scanJson(text.slice(first)).stack.length > 0;
}

/**
 * 펜스에서 JSON 을 꺼낸다. 라벨이 붙은 펜스 → 아무 펜스 → 중괄호 블록 순서로 시도하고,
 * 각 단계에서 **닫히지 않은 펜스**도 후보로 받는다(모델이 라벨을 빼먹거나 출력이 잘린다).
 */
export function extractFencedJson(text: string, label: string): FencedJson | null {
  const candidates: string[] = [];

  // ① 라벨 펜스. 닫힌 것이 없으면 열린 채로라도 받는다 — 잘린 응답의 전형이다.
  const labeled = new RegExp("```" + label + "\\s*\\n([\\s\\S]*?)```", "g");
  for (const m of text.matchAll(labeled)) candidates.push(m[1]!);
  if (candidates.length === 0) {
    const open = new RegExp("```" + label + "\\s*\\n([\\s\\S]*)$").exec(text);
    if (open) candidates.push(open[1]!);
  }

  // ② 라벨 없는 펜스.
  if (candidates.length === 0) {
    for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) candidates.push(m[1]!);
    if (candidates.length === 0) {
      const open = /```(?:json)?\s*\n([\s\S]*)$/.exec(text);
      if (open) candidates.push(open[1]!);
    }
  }

  // ③ 펜스가 아예 없다. 뒤의 후보부터 시도되므로 균형 스캔을 나중에 넣는다.
  if (candidates.length === 0) {
    const last = text.lastIndexOf("{");
    const end = text.lastIndexOf("}");
    if (last !== -1 && end > last) candidates.push(text.slice(last, end + 1));
    const first = text.indexOf("{");
    if (first !== -1) candidates.push(balancedFrom(text, first));
  }

  // 여러 개면 마지막 것이 최종 답이다.
  const ordered = [...candidates].reverse().map((c) => c.trim());

  for (const raw of ordered) {
    try {
      return { value: JSON.parse(raw), truncated: false };
    } catch {
      /* 다음 후보로 */
    }
  }

  // 온전한 후보가 하나도 없다 — 잘린 것으로 보고 닫아서 살린다.
  for (const raw of ordered) {
    const repaired = repairJson(raw);
    if (repaired !== null) return { value: repaired, truncated: true };
  }
  return null;
}

/** 표시용으로 펜스를 걷어낸다. 닫히지 않은 펜스도 함께 지운다. */
export function stripFence(text: string, label: string): string {
  return text
    .replace(new RegExp("```" + label + "\\s*\\n[\\s\\S]*?```", "g"), "")
    .replace(new RegExp("```" + label + "\\s*\\n[\\s\\S]*$"), "")
    .trim();
}
