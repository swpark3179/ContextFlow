import { label as cfLabel } from "../category";
import { candidatesFor } from "./categories";
import type { Material } from "./material";
import {
  PRICE_LABEL,
  categoryKey,
  type Designated,
  type IwmsCategory,
  type IwmsDay,
  type IwmsPush,
  type Price,
} from "./types";

/**
 * i-WMS 정제 프롬프트 — 오늘의 한일 줄마다 카테고리 · 분 · 상세내용을 정한다.
 *
 * 출력 계약은 다른 기능과 같다: 맨 마지막에 ```iwms 펜스 하나(`fencedJson.ts` 가 꺼낸다). 카테고리는
 * `wbsid` 대신 **짧은 코드**(`O1` · `N3`)로 주고받는다 — 토큰이 줄고, 후보 밖 값을 만들어 내면 코드표에
 * 없어 바로 드러난다. 규칙의 바탕은 바탕화면 `auto-wms/app/src-tauri/src/planner.rs` 의 시스템 프롬프트다.
 */

export const FENCE_LABEL = "iwms";
/**
 * 보이는 출력은 업무 열 건에 2천 토큰 안팎이지만, 추론 모델은 생각 토큰도 이 상한에 센다. 2026-10-04
 * 사내 FabriX 로 10/2 일곱 건을 돌리니 출력 6,070 토큰 중 보이는 글은 1,643자였다 — 8,192 면 열 건을
 * 넘는 날 잘린다. FabriX 는 32,768 까지 받는다(`wiki/prompts.ts`).
 */
export const IWMS_MAX_TOKENS = 16_384;
export const IWMS_TEMPERATURE = 0.2;
/** i-WMS 의 상세내용 상한(서버 · 화면 모두). */
export const NOTE_MAX = 1000;

const SAMPLE_CAP = 200;
const TEMPLATE_CAP = 160;
const EXAMPLE_CAP = 12;

/** 프롬프트에 실린 후보 — 코드 → 카테고리. 파서가 같은 표로 되돌린다. */
export interface CodeTable {
  byCode: Map<string, IwmsCategory>;
  codeOf: Map<string, string>;
  /** 대가 구분별 후보와, 지정한 것이 없어 그날 전체로 대신했는지. */
  groups: { price: Price; list: IwmsCategory[]; fallback: boolean }[];
}

export function codeTable(day: IwmsDay, prices: Price[], designated: Designated[]): CodeTable {
  const byCode = new Map<string, IwmsCategory>();
  const codeOf = new Map<string, string>();
  const groups: CodeTable["groups"] = [];
  for (const price of (["O", "N"] as Price[]).filter((p) => prices.includes(p))) {
    const { list, fallback } = candidatesFor(day, price, designated);
    list.forEach((c, i) => {
      const code = `${price}${i + 1}`;
      byCode.set(code, c);
      codeOf.set(categoryKey(c), code);
    });
    groups.push({ price, list, fallback });
  }
  return { byCode, codeOf, groups };
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

function weekday(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : ` (${WEEKDAY[d.getDay()]})`;
}

/** 한 줄로 접어 자른다 — 설명 · 메모처럼 줄바꿈이 뜻을 갖지 않는 글. */
function cut(text: string, n: number): string {
  const one = text.replace(/\s*\n\s*/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * 줄바꿈을 살린 인용 블록 — 샘플 · 템플릿 · 확정한 예. 한 줄로 접어 보이면 모델이 ` / - ` 같은 접은 모양을
 * 그대로 흉내 내 상세내용을 쓴다(2026-10-04 실측). i-WMS 의 상세내용은 줄바꿈으로 나뉜다.
 */
function quote(label: string, text: string, n: number): string[] {
  const t = text.replace(/\r\n/g, "\n").trim();
  const body = t.length > n ? `${t.slice(0, n)}…` : t;
  return [`    ${label}:`, ...body.split("\n").map((l) => `      | ${l}`)];
}

export function buildIwmsSystemPrompt(): string {
  return [
    "당신은 삼성SDS i-WMS 의 MH(공수) 입력을 돕는 도우미입니다.",
    "",
    "## 당신이 하는 일",
    "한 사람의 하루 업무 기록(제목 · 메모 · 업무 개요 · 작업 이력)을 읽고, 업무마다 i-WMS 에 입력할",
    "**카테고리 · 분 · 업무 상세 내용**을 정합니다.",
    "",
    "## 판단 기준",
    "- 카테고리는 반드시 주어진 후보 코드 중에서, **그 업무의 대가 구분과 같은 목록**에서만 고릅니다.",
    "  카테고리의 설명 · 샘플 · 예전에 확정한 예가 가장 강한 신호입니다.",
    "- 분은 업무의 크기를 보고 정합니다. 기록에 시간이 드러나면 그것을 따르고, 드러나지 않으면 업무들 사이의",
    "  상대적인 크기로 나눕니다.",
    "- 상세 내용은 기록에 근거해 씁니다. 기록에 없는 사실(수치 · 대상 · 결과)을 지어내지 않습니다.",
    "",
    "## 하지 않는 일",
    "- 파일을 읽거나 코드를 고치지 않습니다. 주어진 글만 보고 판단합니다.",
    "- 후보에 없는 카테고리를 만들지 않습니다.",
  ].join("\n");
}

export interface IwmsPromptInput {
  day: IwmsDay;
  items: Material[];
  table: CodeTable;
  designated: Designated[];
  styleGuide: string;
  /** 배분할 분. `fill` 이 거짓이면 상한으로만 쓴다. */
  remaining: number;
  fill: boolean;
  step: number;
  examples: IwmsPush[];
  /** 프롬프트 팩(`injectionFor("iwms.refine", …)`). */
  inject: string;
}

export function buildIwmsPrompt(input: IwmsPromptInput): string {
  const { day, items, table, designated, styleGuide, remaining, fill, step, examples, inject } = input;
  const des = new Map(designated.map((d) => [categoryKey(d), d]));
  const out: string[] = [];

  out.push(`# i-WMS 업무량 입력 초안 — ${day.workDate}${weekday(day.workDate)}`, "");
  out.push(
    `- 기준 ${day.standardMinutes}분 · 이미 입력됨 ${day.totalMinutes}분 · 남은 시간 **${remaining}분**`,
    fill
      ? `- 아래 업무들에 남은 시간 ${remaining}분을 **모두** 나눠 배분합니다(합계가 정확히 ${remaining}분).`
      : `- 업무마다 실제로 걸렸을 법한 분을 정합니다(합계는 ${remaining}분을 넘지 않습니다).`,
    `- 분은 ${step}분 단위입니다. 모든 업무에 ${step}분 이상을 줍니다.`,
    "",
  );

  out.push("## 후보 카테고리", "");
  for (const g of table.groups) {
    out.push(`### ${PRICE_LABEL[g.price]} 업무의 후보`);
    if (!g.list.length) out.push("(그날 입력할 수 있는 카테고리가 없습니다)");
    for (const c of g.list) {
      const code = table.codeOf.get(categoryKey(c))!;
      out.push(`- ${code}: ${c.ciName} · ${c.path} > ${c.task}`);
      const d = des.get(categoryKey(c));
      if (d?.hint) out.push(`    설명: ${cut(d.hint, SAMPLE_CAP)}`);
      for (const s of d?.samples.slice(0, 2) ?? []) out.push(...quote("샘플", s, SAMPLE_CAP));
      const tpl = c.templates[0];
      if (tpl) out.push(...quote("i-WMS 템플릿", tpl.content, TEMPLATE_CAP));
    }
    out.push("");
  }

  out.push("## 업무", "");
  for (const m of items) {
    out.push(`### 업무 ${m.entryId} — ${PRICE_LABEL[m.price]}`);
    out.push(`- 제목: ${m.title}`);
    const fixed = m.fixed ? table.codeOf.get(categoryKey(m.fixed)) : undefined;
    if (fixed) out.push(`- 카테고리 고정: ${fixed} (사용자가 정한 매핑 — 이 코드를 그대로 씁니다)`);
    if (m.taskCategory) out.push(`- 업무 분류: ${cfLabel(m.taskCategory)}`);
    if (m.tags.length) out.push(`- 태그: ${m.tags.join(", ")}`);
    if (m.body) out.push(`- 메모: ${cut(m.body, 600)}`);
    if (m.runLog.length) out.push("- 그날 작업 이력:", ...m.runLog.map((l) => `  - ${l}`));
    if (m.overview) out.push("- 업무 개요:", ...m.overview.split("\n").map((l) => `  > ${l}`));
    out.push("");
  }

  out.push("## 상세 내용 작성 규칙 (사용자 지정)", styleGuide.trim(), "");

  const ex = examples.slice(0, EXAMPLE_CAP);
  if (ex.length) {
    out.push("## 예전에 확정한 예 (참고 — 같은 일이면 같은 카테고리 · 비슷한 문체)");
    for (const p of ex) {
      out.push(`- "${p.title}" → ${p.ciName} · ${p.task} · ${p.minutes}분`, ...quote("상세 내용", p.note, SAMPLE_CAP));
    }
    out.push("");
  }

  if (inject.trim()) out.push(inject.trim(), "");

  out.push(
    "## 출력 형식",
    "판단 근거는 짧게 적어도 되지만, **맨 마지막에** 아래 펜스 하나를 반드시 냅니다.",
    "",
    "```" + FENCE_LABEL,
    '{"items":[{"entryId":123,"category":"O1","minutes":60,"note":"상세 내용","confidence":80,"alternatives":["O2"]}]}',
    "```",
    "",
    "- 위 업무마다 정확히 한 항목. `entryId` 는 업무 번호 그대로.",
    "- `category` 는 그 업무의 대가 구분 목록의 코드만(대가포함 업무는 O…, 대가미포함 업무는 N…).",
    "  '카테고리 고정' 이 있으면 그 코드.",
    `- \`minutes\` 는 ${step}의 배수인 정수.`,
    `- \`note\` 는 i-WMS '업무 상세 내용'. 작성 규칙을 따르고 ${NOTE_MAX}자 이하. 줄은 줄바꿈(\\n)으로 나눕니다`,
    "  (첫 줄은 무엇을 했는지 한 줄, 다음 줄부터 `- ` 로 세부 — 샘플 · 템플릿과 같은 모양).",
    "- `confidence` 는 카테고리 판단의 확신도 0~100, `alternatives` 는 차선 코드 최대 2개.",
  );
  return out.join("\n");
}

/** 형식 위반 한 번만 다시 묻는다 — 판단은 이미 받았으니 펜스만. */
export function buildIwmsRepairPrompt(previous: string, ids: number[]): string {
  return [
    "아래는 방금 당신이 쓴 답입니다. 출력 형식(맨 마지막 ```" + FENCE_LABEL + " 펜스)을 지키지 않았습니다.",
    "판단은 그대로 두고, 아래 형식의 펜스 하나만 다시 내 주세요.",
    "",
    "```" + FENCE_LABEL,
    '{"items":[{"entryId":123,"category":"O1","minutes":60,"note":"상세 내용","confidence":80,"alternatives":[]}]}',
    "```",
    `업무 번호: ${ids.join(", ")}`,
    "",
    "---",
    previous.slice(-6000),
  ].join("\n");
}
