/**
 * LLM 위키의 프롬프트와 응답 파서 — 순수 함수만.
 *
 * 반영 한 건은 **호출 두 번 이하**다.
 *
 * * 호출 A(항상): 업무 원본 → 소스 페이지 본문(구분자 블록) + 마지막에 ` ```wikiplan `
 *   펜스 하나(요약 · 태그 · 함께 고칠 페이지 계획). 계획 JSON 이 깨져도 소스 페이지는 쓴다.
 * * 호출 B(깊이 `full` 이고 계획에 페이지가 있을 때만): 소스 페이지 + 계획 + 기존 페이지
 *   본문 → 고칠 페이지마다 구분자 블록 하나.
 *
 * 페이지를 하나씩 따로 묻지 않는 이유: 느린 로컬 CLI 나 사내 게이트웨이에서 2+N 번 호출하면
 * 업무 하나에 몇 분, 일괄 반영은 몇 시간이 걸린다.
 *
 * 사용자 지침(프롬프트 팩)은 언제나 **출력 형식 바로 앞**에 들어간다(`promptPacks.ts`).
 * 규약(`SCHEMA.md`)도 사용자 문서지만 맨 앞에 둔다 — 규약은 "무엇을 쓸지" 를, 출력 형식은
 * "어떻게 돌려줄지" 를 정하고, 둘이 부딪히면 뒤의 형식이 이긴다고 못박는다.
 */
import type { WikiHit, WikiKind, WikiPageMeta, WikiSourceBundle } from "../api";
import { label } from "../category";
import { extractFencedJson } from "../fencedJson";
import { escapeDelims } from "./blocks";
import { findByTitle, normTitle } from "./links";
import { webFindingsBlock, webRequestBlock, type WebFinding } from "./web";

export const PLAN_LABEL = "wikiplan";
export const LINT_LABEL = "wikilint";

/**
 * 호출별 출력 토큰 상한. 설정의 "출력 토큰 상한" 재정의가 있으면 그쪽이 이긴다(백엔드).
 *
 * 넉넉히 잡는 이유: 추론 모델(사내 FabriX 의 GLM 등)은 **생각에 쓴 토큰도 이 상한에 센다**.
 * 사내망에서 4,096 으로 반영해 보니 생각을 마치고 소스 페이지를 쓰던 중에 잘려 계획 펜스가
 * 통째로 빠졌다. FabriX 는 32,768 까지 받는 것을 확인했다.
 */
export const SOURCE_MAX_TOKENS = 12_288;
export const INTEGRATE_MAX_TOKENS = 16_384;
export const QUERY_MAX_TOKENS = 8_192;
export const LINT_MAX_TOKENS = 8_192;
/** 위키 호출은 원문에 붙어 있어야 하므로 온도를 낮춘다. */
export const WIKI_TEMPERATURE = 0.2;

/** 프롬프트에 싣는 분량의 상한(글자). */
const RELATED_CAP = 25;
const TITLES_CAP = 300;
const EXISTING_PAGE_CAP = 6_000;
const QUERY_PAGE_CAP = 5_000;
const QUERY_TOTAL_CAP = 24_000;
const CATALOG_CAP = 200;
const SCHEMA_CAP = 6_000;
/** 대화 이력 — 최근 몇 턴을, 답은 앞부분만, 합쳐서 얼마까지 싣는가. */
const HISTORY_TURNS = 6;
const HISTORY_QUESTION_CAP = 500;
const HISTORY_ANSWER_CAP = 1_500;
const HISTORY_TOTAL_CAP = 8_000;

const PLAN_TYPES: WikiKind[] = ["procedure", "topic", "entity"];
const KIND_LABEL: Record<WikiKind, string> = {
  procedure: "절차",
  topic: "주제",
  entity: "시스템·도구",
  source: "업무 소스",
  answer: "질의 답변",
};

const cap = (s: string, n: number) =>
  [...s].length > n ? [...s].slice(0, n).join("") + "\n…(이하 생략)" : s;

export function buildWikiSystemPrompt(): string {
  return [
    "당신은 한 사람의 업무 기록을 정리해 개인 위키를 관리하는 편집자입니다.",
    "원본에 없는 사실을 지어내지 않고, 다음에 같은 일을 할 사람이 그대로 따라 할 수 있게",
    "한국어로 짧고 구체적으로 씁니다. 비밀번호 · 토큰 · 개인 연락처 같은 민감 정보는 옮기지 않습니다.",
  ].join(" ");
}

function schemaBlock(schema: string): string {
  const body = schema.replace(/^---[\s\S]*?\n---\s*\n?/, "").trim();
  if (!body) return "";
  return ["# 위키 규약 (사용자가 관리하는 문서)", "", escapeDelims(cap(body, SCHEMA_CAP)), ""].join(
    "\n",
  );
}

/** 업무 원본 → 프롬프트 텍스트. 파일 본문은 태그로 감싸고 구분자는 무력화한다. */
export function renderBundle(b: WikiSourceBundle): string {
  const t = b.task;
  const lines = [
    "# 원본 업무",
    "",
    `- 업무 id: ${t.id}`,
    `- 제목: ${t.title}`,
    // 미분류는 적지 않는다 — `label(null)` 이 `미분류` 라 분류 이름처럼 읽힌다.
    ...(t.category ? [`- 카테고리: ${label(t.category)}`] : []),
    `- 태그: ${t.tags.length ? t.tags.join(", ") : "(없음)"}`,
    `- 만든 날: ${t.created || "?"} · 완료: ${t.completedAt ?? "?"}`,
    `- 폴더: ${t.relFolder}`,
    "",
  ];
  const skipped: string[] = [];
  for (const f of b.files) {
    if (f.text === null) {
      skipped.push(`- ${f.rel} — ${f.skipped ?? "본문 생략"}`);
      continue;
    }
    const attrs = f.truncated ? ` truncated="앞부분 ${[...f.text].length}자만"` : "";
    lines.push(`<file path="${f.rel}"${attrs}>`, escapeDelims(f.text), "</file>", "");
  }
  if (skipped.length) lines.push("## 본문을 싣지 않은 파일", "", ...skipped, "");
  return lines.join("\n");
}

function relatedBlock(related: WikiHit[], pages: WikiPageMeta[]): string {
  const lines = ["# 위키의 기존 페이지 (이 업무와 관련도 순)", ""];
  const shown = related.filter((h) => h.kind !== "source").slice(0, RELATED_CAP);
  if (!shown.length) lines.push("(관련된 기존 페이지가 없습니다)");
  for (const h of shown) {
    lines.push(`- [[${h.stem}]] (${KIND_LABEL[h.kind] ?? h.kind}) — ${h.summary || h.snippet}`);
  }
  const names = pages
    .filter((p) => p.kind !== "source")
    .slice(0, TITLES_CAP)
    .map((p) => p.stem);
  lines.push("", "# 링크할 수 있는 페이지 이름", "", names.length ? names.join(", ") : "(아직 없음)", "");
  return lines.join("\n");
}

export interface SourcePromptInput {
  schema: string;
  bundle: WikiSourceBundle;
  related: WikiHit[];
  pages: WikiPageMeta[];
  depth: "light" | "full";
  maxPages: number;
  /** 프롬프트 팩 주입 블록(이미 조립된 것). 비어 있으면 생략. */
  inject: string;
}

/** 호출 A — 소스 페이지 + 계획. */
export function buildSourcePrompt(i: SourcePromptInput): string {
  const t = i.bundle.task;
  const stem = i.bundle.sourceStem;
  const parts = [
    schemaBlock(i.schema),
    "아래 업무를 위키에 반영합니다.",
    i.bundle.reingest
      ? `이 업무는 전에 반영된 적이 있고 그 뒤 내용이 바뀌었습니다. 소스 페이지를 지금 원본 기준으로 처음부터 다시 씁니다.`
      : "",
    "",
    renderBundle(i.bundle),
    relatedBlock(i.related, i.pages),
    i.inject,
    "# 출력 형식 (반드시 지킬 것)",
    "",
    "1. 먼저 이 업무의 소스 페이지 본문을 아래 구분자 사이에 씁니다. 구분자 줄은 그대로 씁니다.",
    "",
    "<<<PAGE source>>>",
    `# ${t.title}`,
    "(마크다운 본문)",
    "<<<END>>>",
    "",
    "   - 섹션은 `## 한눈에` · `## 한 일` · `## 결정과 이유` · `## 절차 (다시 할 때)` · `## 산출물` ·",
    "     `## 문제와 해결` · `## 키워드` · `## 관련` 중 원본에 내용이 있는 것만, 이 순서로.",
    "   - `## 관련` 에는 위 목록의 기존 페이지 중 실제로 관련된 것만 `[[이름|보이는 글]]` 로 적습니다.",
    "   - 원본에 없는 내용을 지어내지 않습니다. 업무 폴더 경로로 링크하지 않습니다.",
    t.category
      ? "   - `카테고리` 는 앱이 업무를 묶는 분류입니다. 관련 페이지를 고르는 데만 참고하고, 분류 이름을 그대로 소스 페이지 본문이나 wikiplan 의 `tags` 에 옮겨 적지 않습니다(원본에 나오는 낱말은 평소대로 씁니다)."
      : "",
    "",
    `2. 맨 마지막에 \`\`\`${PLAN_LABEL} 펜스 하나를 둡니다. 펜스 뒤에는 아무것도 쓰지 않습니다.`,
    "",
    "```" + PLAN_LABEL,
    '{"summary": "이 업무를 한 줄로 (80자 이내)", "tags": ["태그", "최대 5개"],',
    ' "pages": [{"action": "create" | "update", "type": "procedure" | "topic" | "entity",',
    '            "title": "페이지 제목", "reason": "왜 이 페이지를 고치나", "points": ["이 업무에서 옮길 요점"]}]}',
    "```",
    "",
    i.depth === "light"
      ? "   - 이번에는 소스 페이지만 씁니다. `pages` 는 빈 배열 `[]` 로 둡니다."
      : [
          `   - \`pages\` 는 최대 ${i.maxPages}개. 이 업무에서 배운 것이 **다른 업무에도 쓰일 때만** 넣습니다(없으면 \`[]\`).`,
          "   - 반복할 수 있는 작업 방법은 procedure, 배경 지식 · 개념은 topic, 시스템 · 서비스 · 도구는 entity.",
          "     사람에 관한 페이지는 만들지 않습니다.",
          "   - 이미 있는 페이지를 고칠 때는 action 을 update 로 하고 title 은 위 목록의 이름을 그대로 씁니다.",
          `   - 다른 페이지에서 이 업무를 인용할 때 쓰는 이름은 [[${stem}]] 입니다.`,
        ].join("\n"),
  ];
  return parts.filter((p) => p !== "").join("\n");
}

export interface PlanItem {
  action: "create" | "update";
  type: "procedure" | "topic" | "entity";
  title: string;
  reason: string;
  points: string[];
  /** 같은 제목의 기존 페이지. 있으면 계획이 "만들기" 라고 해도 고치기다. */
  existing: WikiPageMeta | null;
}

export interface WikiPlan {
  summary: string;
  tags: string[];
  pages: PlanItem[];
}

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? [...v.trim()].slice(0, max).join("") : "";

/**
 * 계획 펜스를 꺼내 검증한다. 펜스가 없거나 JSON 이 깨지면 `null` — 호출자는 소스 페이지만
 * 쓴다(= light 결과). 모르는 유형 · 빈 제목 · 중복은 버리고 상한에서 자른다. 기존 페이지와
 * 제목이 같으면 "만들기" 를 "고치기" 로 바꾼다 — 같은 개념이 두 장으로 갈라지지 않게.
 */
export function parsePlan(
  text: string,
  opts: { maxPages: number; light: boolean; pages: WikiPageMeta[] },
): WikiPlan | null {
  const got = extractFencedJson(text, PLAN_LABEL);
  if (!got || typeof got.value !== "object" || got.value === null) return null;
  const v = got.value as Record<string, unknown>;
  const tags = Array.isArray(v.tags)
    ? [...new Set(v.tags.map((t) => str(t, 30).replace(/^#/, "")).filter(Boolean))].slice(0, 5)
    : [];
  const pages: PlanItem[] = [];
  const seen = new Set<string>();
  if (!opts.light && Array.isArray(v.pages)) {
    for (const raw of v.pages) {
      if (pages.length >= opts.maxPages) break;
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const type = str(r.type, 20) as PlanItem["type"];
      const title = str(r.title, 80);
      if (!PLAN_TYPES.includes(type) || !title) continue;
      const key = normTitle(title);
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = findByTitle(title, opts.pages);
      pages.push({
        action: existing ? "update" : "create",
        type,
        title: existing ? existing.title : title,
        reason: str(r.reason, 200),
        points: Array.isArray(r.points)
          ? r.points.map((p) => str(p, 300)).filter(Boolean).slice(0, 8)
          : [],
        existing,
      });
    }
  }
  return { summary: str(v.summary, 120), tags, pages };
}

export interface IntegratePromptInput {
  schema: string;
  title: string;
  sourceStem: string;
  sourceBody: string;
  items: PlanItem[];
  /** 고치기 항목의 현재 본문(경로 → 내용). */
  current: Record<string, string>;
  pages: WikiPageMeta[];
  reingest: boolean;
  inject: string;
}

/** 호출 B — 계획된 페이지들을 한 번에 쓴다. */
export function buildIntegratePrompt(i: IntegratePromptInput): string {
  const items = i.items.map((it, n) => {
    const verb = it.action === "update" ? "고치기" : "새로 만들기";
    const head = `## ${n + 1}. ${KIND_LABEL[it.type]} · ${it.title} (${verb})`;
    const points = it.points.length ? it.points.map((p) => `- ${p}`).join("\n") : "- (계획에 요점이 없습니다)";
    const cur = it.existing ? i.current[it.existing.path] : undefined;
    const body =
      cur !== undefined
        ? [
            `<page name="${it.existing!.stem}">`,
            escapeDelims(cap(cur, EXISTING_PAGE_CAP)),
            "</page>",
          ].join("\n")
        : "(새 페이지 — 기존 본문 없음)";
    return [head, "", `이유: ${it.reason || "-"}`, "", "옮길 요점:", points, "", "기존 본문:", body, ""].join(
      "\n",
    );
  });
  const names = i.pages
    .filter((p) => p.kind !== "source")
    .slice(0, TITLES_CAP)
    .map((p) => p.stem);
  return [
    schemaBlock(i.schema),
    `업무 「${i.title}」 를 위키에 반영하는 중입니다. 이 업무의 소스 페이지는 이미 썼고, 이제 관련 페이지를 고칩니다.`,
    "",
    `# 이 업무의 소스 페이지 ([[${i.sourceStem}]])`,
    "",
    escapeDelims(cap(i.sourceBody, EXISTING_PAGE_CAP)),
    "",
    "# 고칠 페이지",
    "",
    ...items,
    "# 링크할 수 있는 페이지 이름",
    "",
    names.length ? names.join(", ") : "(아직 없음)",
    "",
    i.inject,
    "# 출력 형식 (반드시 지킬 것)",
    "",
    "항목마다 아래 블록 하나씩, 번호를 맞춰 씁니다. 블록 안은 그 페이지의 **전체** 본문입니다.",
    "",
    "<<<PAGE 1>>>",
    "요약: 이 페이지를 한 줄로",
    "# 페이지 제목",
    "(마크다운 본문)",
    "<<<END>>>",
    "",
    "- 기존 본문의 내용은 지우지 말고 유지하며, 새 내용을 알맞은 자리에 합칩니다.",
    `- 이 업무에서 온 사실에는 글머리 끝에 \`([[${i.sourceStem}]])\` 을 붙입니다.`,
    "- 새 내용이 기존 내용과 부딪히면 지우지 말고 `> [!warning] 상충` 으로 둘 다 남깁니다.",
    i.reingest
      ? `- 이 업무는 전에도 반영됐습니다. 이미 [[${i.sourceStem}]] 를 인용한 줄은 예전 판에서 온 것이니 중복으로 더하지 말고 고쳐 씁니다.`
      : "",
    "- 절차 페이지는 번호 목록으로 따라 할 수 있게 씁니다. 사람에 관한 내용은 쓰지 않습니다.",
  ]
    .filter((p) => p !== "")
    .join("\n");
}

export interface QueryPage {
  stem: string;
  title: string;
  kind: WikiKind;
  content: string;
}

/** 대화의 앞선 턴 하나 — 질문과 (완료된) 답. */
export interface ChatTurnText {
  question: string;
  answer: string;
}

/**
 * 대화 이력 블록. 이어지는 질문("그럼 두 번째 단계는?")이 가리키는 대상을 모델이 알 수 있게
 * 앞선 질문과 답을 싣는다.
 *
 * 연결이 전부 상태 없는 텍스트 스트림이라(로컬 CLI 는 매번 새 실행, FabriX 는 요청마다 새 대화)
 * 이력은 프롬프트에 접어 넣는다. 위키 페이지 본문은 턴마다 다시 고르므로 이력에는 질문과 답만
 * 둔다 — 앞선 프롬프트를 통째로 되풀이하면 페이지 본문이 턴마다 쌓인다. 최근 턴부터 남기고,
 * 상한을 넘으면 오래된 턴을 버린다(마지막 턴은 언제나 남는다).
 */
export function historyBlock(history: ChatTurnText[]): string {
  if (!history.length) return "";
  let turns = history.slice(-HISTORY_TURNS).map((t) => ({
    q: cap(t.question.trim(), HISTORY_QUESTION_CAP),
    a: cap(t.answer.trim(), HISTORY_ANSWER_CAP),
  }));
  const size = () => turns.reduce((n, t) => n + t.q.length + t.a.length, 0);
  while (turns.length > 1 && size() > HISTORY_TOTAL_CAP) turns = turns.slice(1);
  const skipped = history.length - turns.length;
  const lines = ["# 지금까지의 대화 (이어지는 질문의 맥락)", ""];
  if (skipped > 0) lines.push(`(앞선 ${skipped}개 턴은 생략)`, "");
  turns.forEach((t, n) => {
    lines.push(`<turn n="${skipped + n + 1}">`, `질문: ${escapeDelims(t.q)}`, `답: ${escapeDelims(t.a)}`, "</turn>", "");
  });
  return lines.join("\n");
}

/**
 * 질의에 본문을 실을 페이지를 고른다 — 목록 여럿을 번갈아 돌며 겹치는 것은 빼고 `cap` 장까지.
 *
 * 이어지는 질문은 그것만으로는 검색이 안 된다("두 번째 단계는?"). 그래서 호출부는 지금 질문의
 * 검색 결과, 앞선 답이 인용한 페이지, 앞선 질문과 합친 검색 결과를 함께 넘긴다. 앞에서부터
 * 번갈아 고르므로 화제를 바꾼 질문이면 지금 질문의 결과가, 이어지는 질문이면 앞선 맥락이
 * 자리를 차지한다.
 */
export function pickContextPages(lists: string[][], cap: number): string[] {
  const out: string[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let n = 0; n < longest && out.length < cap; n++) {
    for (const list of lists) {
      const p = list[n];
      if (p !== undefined && !out.includes(p)) out.push(p);
      if (out.length >= cap) break;
    }
  }
  return out;
}

/** 질의에 실을 웹 검색 상태 — 남은 검색 횟수와 지금까지 찾은 것. `null` 이면 웹 검색을 끈 질의. */
export interface QueryWebState {
  remaining: number;
  findings: WebFinding[];
}

/**
 * 질의 — 로컬 검색으로 고른 페이지 본문 + 나머지 페이지 목록. 답은 자유 마크다운.
 * `history` 가 있으면 앞선 대화에 이어지는 질문으로 묻는다. `web` 이 있으면 웹 검색을
 * 요청할 수 있음을 알리고(`web.ts`), 이미 찾은 결과를 함께 싣는다.
 */
export function buildQueryPrompt(i: {
  question: string;
  pages: QueryPage[];
  catalog: WikiPageMeta[];
  inject: string;
  history?: ChatTurnText[];
  web?: QueryWebState | null;
}): string {
  let used = 0;
  const bodies: string[] = [];
  for (const p of i.pages) {
    if (used >= QUERY_TOTAL_CAP) break;
    const text = cap(p.content.replace(/^---[\s\S]*?\n---\s*\n?/, "").trim(), QUERY_PAGE_CAP);
    used += text.length;
    const kind = KIND_LABEL[p.kind] ?? p.kind;
    bodies.push(`<page name="${p.stem}" title="${p.title}" kind="${kind}">`, escapeDelims(text), "</page>", "");
  }
  const shown = new Set(i.pages.map((p) => p.stem));
  const catalog = i.catalog
    .filter((p) => !shown.has(p.stem))
    .slice(0, CATALOG_CAP)
    .map((p) => `- [[${p.stem}]] (${KIND_LABEL[p.kind] ?? p.kind}) — ${p.summary}`);
  const history = historyBlock(i.history ?? []);
  const web = i.web ?? null;
  const found = web ? webFindingsBlock(web.findings) : "";
  return [
    history,
    history ? "# 지금 질문 (앞선 대화에 이어서)" : "# 질문",
    "",
    i.question.trim(),
    "",
    "# 관련 위키 페이지 (관련도 순)",
    "",
    bodies.length ? bodies.join("\n") : "(검색에 걸린 페이지가 없습니다)",
    "# 그 밖의 페이지 목록 (본문은 싣지 않음)",
    "",
    catalog.length ? catalog.join("\n") : "(없음)",
    "",
    found,
    web ? webRequestBlock(web.remaining) : "",
    i.inject,
    "# 답변 형식",
    "",
    web
      ? "- 위 위키 페이지와 웹 검색 결과에 적힌 내용에 근거해서만 답합니다. 둘 다 근거가 없으면 그렇다고 말하고, 위키에서 열어 볼 만한 페이지를 제안합니다."
      : "- 위 페이지에 적힌 내용에 근거해서만 답합니다. 근거가 없으면 \"위키에 없습니다\" 라고 하고, 목록에서 열어 볼 만한 페이지를 제안합니다.",
    found
      ? "- 웹 검색 결과에서 온 문장 끝에는 `[웹1]` 처럼 출처 번호를 붙입니다. 위키와 웹이 다르면 둘 다 밝히고, 업무에 관한 것은 위키를 앞세웁니다."
      : "",
    history
      ? "- 앞선 대화에 이어지는 질문이면 그 맥락(가리키는 대상 · 생략된 주어)을 이어받아 답하고, 앞선 답을 그대로 되풀이하지 않습니다."
      : "",
    "- 근거로 쓴 페이지를 문장 끝에 `[[이름]]` 으로 인용합니다.",
    "- 과거에 한 작업을 찾는 질문이면, 해당하는 업무를 목록으로 정리합니다(업무 소스 페이지 이름으로).",
    "- 맨 마지막 줄에 `관련 업무: [[task-…]], [[task-…]]` 처럼 근거가 된 업무 소스 페이지를 적습니다(없으면 생략).",
  ]
    .filter((p) => p !== "")
    .join("\n");
}

export interface AiLintIssue {
  kind: "contradiction" | "stale" | "missing-page" | "missing-link" | "gap";
  pages: string[];
  detail: string;
  suggestion: string;
}

const LINT_KINDS: AiLintIssue["kind"][] = [
  "contradiction",
  "stale",
  "missing-page",
  "missing-link",
  "gap",
];

export function buildLintPrompt(i: {
  catalog: WikiPageMeta[];
  localIssues: string[];
  inject: string;
}): string {
  const rows = i.catalog.slice(0, CATALOG_CAP * 2).map((p) => {
    const kind = KIND_LABEL[p.kind] ?? p.kind;
    const when = p.updated.slice(0, 10);
    const out = p.links.length ? ` → 링크: ${p.links.slice(0, 12).join(", ")}` : " → 링크 없음";
    return `- [[${p.stem}]] (${kind}, 근거 업무 ${p.sources.length}건, ${when}) — ${p.summary}${out}`;
  });
  return [
    "아래는 개인 업무 위키의 페이지 목록(제목 · 유형 · 요약)입니다. 위키의 건강 상태를 점검합니다.",
    "",
    "# 페이지 목록 (각 줄 끝의 → 는 그 페이지가 이미 걸어 둔 링크)",
    "",
    rows.length ? rows.join("\n") : "(비어 있음)",
    "",
    "# 앱이 이미 찾은 기계적 문제 (다시 보고하지 않음)",
    "",
    i.localIssues.length ? i.localIssues.slice(0, 50).join("\n") : "(없음)",
    "",
    i.inject,
    "# 출력 형식",
    "",
    "요약만으로 판단할 수 있는 것을 찾습니다: 서로 부딪히는 요약(contradiction), 낡아 보이는 내용(stale),",
    "여러 페이지가 언급하지만 자기 페이지가 없는 개념(missing-page), 이어져야 할 페이지 사이의 빠진 링크",
    "(missing-link), 채우면 좋을 빈칸(gap). 이미 걸려 있는 링크(→)는 빠진 링크로 보고하지 않습니다.",
    "자유롭게 근거를 서술한 뒤 맨 마지막에 펜스 하나:",
    "",
    "```" + LINT_LABEL,
    '{"issues": [{"kind": "contradiction" | "stale" | "missing-page" | "missing-link" | "gap",',
    '             "pages": ["페이지 이름"], "detail": "무엇이 문제인가", "suggestion": "어떻게 고치나"}]}',
    "```",
    "",
    "- issues 는 중요한 것부터 최대 15개. 문제가 없으면 빈 배열.",
  ]
    .filter((p) => p !== "")
    .join("\n");
}

export function parseLint(text: string): AiLintIssue[] | null {
  const got = extractFencedJson(text, LINT_LABEL);
  if (!got || typeof got.value !== "object" || got.value === null) return null;
  const issues = (got.value as Record<string, unknown>).issues;
  if (!Array.isArray(issues)) return null;
  const out: AiLintIssue[] = [];
  for (const raw of issues) {
    if (out.length >= 15) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = str(r.kind, 20) as AiLintIssue["kind"];
    const detail = str(r.detail, 400);
    if (!LINT_KINDS.includes(kind) || !detail) continue;
    out.push({
      kind,
      pages: Array.isArray(r.pages) ? r.pages.map((p) => str(p, 80)).filter(Boolean).slice(0, 6) : [],
      detail,
      suggestion: str(r.suggestion, 400),
    });
  }
  return out;
}
