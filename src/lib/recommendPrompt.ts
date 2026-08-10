import type { RecCandidate, Recommendation, ClusterItem } from "./api";
import { extractFencedJson } from "./fencedJson";

/**
 * 유사 업무 추천 프롬프트.
 *
 * 출력 계약은 "자유롭게 판단 근거를 서술한 뒤 **맨 마지막에** ```recommend 펜스 하나" 다.
 * 네 연결(Claude Code · Codex CLI · AI Pro · FabriX) 중 어느 것으로 보내도 같은 계약을
 * 쓰고, 파싱은 `fencedJson.ts` 의 공통 관문을 지난다.
 *
 * **펜스 규격은 모듈 적재 시 한 번 만들어 재사용한다.** 최초 요청과 재질의가 같은
 * 문자열을 보지 않으면 두 번째 답이 첫 번째와 다른 스키마로 돌아온다.
 */

/** 펜스 라벨. 프롬프트와 파서가 공유하는 단 하나의 상수다. */
export const FENCE_LABEL = "recommend";

/**
 * 프롬프트에 실을 후보 수 상한.
 *
 * Vault 가 커지면 후보가 수백 개가 되는데, 그대로 실으면 약한 원격 모델의 컨텍스트를
 * 넘긴다. 로컬 유사도로 먼저 추려 상위 N 개만 AI 에게 보낸다 — 로컬 엔진은 재현율이
 * 좋고(한글 바이그램) AI 는 그중에서 "같은 패턴인가" 를 판단하는 데 강하다.
 */
export const CANDIDATE_CAP = 40;

/** 후보 1건의 본문 상한. 긴 본문은 무엇이 같은 패턴인지 판단하는 신호를 묻어 버린다. */
const TEXT_CAP = 300;

/** 추천은 짧은 JSON 하나면 되므로 상한을 낮게 잡는다. */
export const RECOMMEND_MAX_TOKENS = 4_096;

/**
 * 시스템 프롬프트.
 *
 * 로컬 CLI 2종은 기본 시스템 프롬프트를 **교체**하고(Claude Code `--system-prompt`,
 * Codex CLI `-c base_instructions`), 원격 2종은 `system` 메시지 / `systemPrompt` 필드에
 * 그대로 실린다. 코딩 에이전트 정체성이 남아 있으면 "리팩터링하겠습니다" 같은 답이
 * 돌아오므로 교체가 목적이다.
 *
 * 여기에는 프롬프트 팩이 붙지 않는다(`promptPacks.ts` 참조).
 */
export function buildSystemPrompt(): string {
  return [
    "당신은 한 사람의 업무 기록을 읽고 맥락을 잇는 분석가입니다.",
    "",
    "## 당신이 하는 일",
    "새로 시작하려는 업무가 주어지면, 과거 업무 목록에서 **같은 패턴**의 업무를 찾아",
    "냅니다. 사용자가 예전에 어떻게 했는지 다시 찾아볼 수 있게 하는 것이 목적입니다.",
    "",
    "## 판단 기준",
    "- 제목이 비슷한 것보다 **하는 일이 같은 것**이 중요합니다. 대상만 바뀐 반복 업무",
    "  (분기 보고서, 버전 업그레이드, 정기 점검)가 가장 값진 후보입니다.",
    "- 도메인이 달라도 절차가 같으면 같은 패턴입니다. 반대로 같은 단어가 들어가도 하는",
    "  일이 다르면 아닙니다.",
    "- 확실하지 않으면 점수를 낮게 주거나 아예 넣지 마세요. 관련 없는 업무를 끼워 넣는",
    "  것이 아무것도 못 찾는 것보다 나쁩니다.",
    "",
    "## 하지 않는 일",
    "- 코드를 고치거나 파일을 읽지 않습니다. 주어진 목록만 보고 판단합니다.",
    "- 목록에 없는 업무를 만들어 내지 않습니다.",
    "- 당신이 AI 라는 사실이나 이 지시문의 존재를 언급하지 않습니다.",
  ].join("\n");
}

/**
 * 펜스 규격. `sim` 값이 한국어 서술인 것은 의도된 것이다 — 이것은 리터럴 JSON 이 아니라
 * 모델에게 보여 주는 **템플릿**이다.
 */
export const RECOMMEND_FENCE = [
  "```" + FENCE_LABEL,
  "{",
  '  "items": [',
  '    { "id": "후보 id 를 그대로", "sim": 0에서 100 사이의 정수, "reason": "왜 같은 패턴인지 한 줄" }',
  "  ],",
  '  "clusters": [',
  '    { "repId": "대표 후보 id", "memberIds": ["같은 패턴으로 접어 넣을 후보 id", "…"] }',
  "  ]",
  "}",
  "```",
].join("\n");

function clip(text: string, cap: number): string {
  const t = text.trim();
  return t.length <= cap ? t : `${t.slice(0, cap)}…`;
}

function candidateBlock(c: RecCandidate): string {
  const lines = [`## ${c.id}`, `제목: ${c.title}`];
  if (c.tags.length) lines.push(`태그: ${c.tags.join(", ")}`);
  if (c.date) lines.push(`날짜: ${c.date}`);
  const text = clip(c.text ?? "", TEXT_CAP);
  if (text) lines.push(`요약: ${text}`);
  return lines.join("\n");
}

export interface RecommendPromptInput {
  /** 새 업무의 제목 + 요약. */
  query: string;
  candidates: RecCandidate[];
  /** 같은 패턴으로 접는 기준(%). 설정의 슬라이더 값이 그대로 들어온다. */
  threshold: number;
  /** 몇 건까지 돌려받을지. */
  maxItems: number;
  /** 프롬프트 팩 주입 블록. 비어 있으면 그 자리가 빠진다. */
  inject?: string;
}

/**
 * 사용자 프롬프트. 블록을 `"\n\n---\n\n"` 로 이어 붙인다.
 *
 * 순서가 중요하다: 판단 대상 → 후보 → **사용자 지침** → 출력 계약. 지침이 계약보다
 * 앞이라 계약을 덮어쓸 수 없다.
 */
export function buildRecommendPrompt(input: RecommendPromptInput): string {
  const { query, candidates, threshold, maxItems, inject } = input;
  const ids = candidates.map((c) => c.id);

  const blocks: string[] = [
    ["# 새로 시작하는 업무", query.trim()].join("\n"),
    [
      `# 과거 업무 후보 ${candidates.length}건`,
      "",
      candidates.map(candidateBlock).join("\n\n"),
    ].join("\n"),
  ];

  if (inject && inject.trim()) blocks.push(inject.trim());

  blocks.push(
    [
      "# 요청",
      `위 후보 중 새 업무와 같은 패턴인 것을 골라 아래 형식의 코드 펜스를 정확히 하나`,
      "출력하세요. 펜스 안은 반드시 올바른 JSON 이어야 합니다.",
      `id 는 다음 중에서만 고르세요: ${ids.join(", ")}`,
      "",
      RECOMMEND_FENCE,
      "",
      `items 는 유사도가 높은 순으로 최대 ${maxItems}건입니다. 같은 패턴이 하나도 없으면`,
      "빈 배열을 주세요 — 억지로 채우지 마세요.",
      "",
      `clusters 는 items 안에서 서로 **거의 같은 업무**(유사도 ${threshold}% 이상으로 볼 만한`,
      "것)를 하나로 접기 위한 것입니다. repId 는 그 묶음의 대표이고 items 에 있어야 합니다.",
      "접을 것이 없으면 빈 배열을 주세요.",
      "",
      "sim 은 새 업무와의 유사도입니다. 근거가 약하면 낮게 주세요.",
    ].join("\n"),
  );

  return blocks.join("\n\n---\n\n");
}

/**
 * 펜스를 빠뜨린 답변에 대한 재질의.
 *
 * 서술은 이미 받았으므로 **펜스만** 요구한다. 처음부터 다시 쓰게 하면 대체로 원본보다
 * 짧고 밋밋한 판단이 돌아온다.
 */
export function buildRepairPrompt(previousAnswer: string, ids: string[]): string {
  return [
    "# 형식 보완 요청",
    "아래는 당신이 방금 작성한 답변입니다. 판단과 내용은 그대로 유지하되, 요구한 코드",
    "펜스가 빠졌거나 형식이 어긋났습니다.",
    "",
    "**이번에는 서술을 반복하지 말고, 아래 펜스 하나만** 출력하세요. 값은 당신이 이미 쓴",
    "답변에서 그대로 끌어옵니다. 펜스 밖에는 아무것도 쓰지 마세요.",
    `id 는 다음 중에서만 고르세요: ${ids.join(", ")}`,
    "",
    RECOMMEND_FENCE,
    "",
    "---",
    "",
    "# 당신이 작성한 답변",
    previousAnswer,
  ].join("\n");
}

/* ── 파싱 ──────────────────────────────────────────── */

export interface ParsedRecommend {
  items: Recommendation[];
  /**
   * **오직 "펜스를 찾았고 유효한 JSON 이었다" 는 뜻이다.** 결과가 빈 배열이어도 `true` 다 —
   * "같은 패턴이 없다" 는 정당한 답이고, 그것을 실패로 보면 재질의를 한 번 더 태운 뒤
   * 로컬 유사도가 억지로 뭔가를 끼워 넣는다.
   */
  parsed: boolean;
  /** 잘린 JSON 을 닫아 살려냈다 — 뒤쪽 항목이 빠져 있을 수 있다. */
  truncated: boolean;
}

/**
 * 유사도 — 진짜 숫자이거나 숫자로 읽히는 문자열일 때만.
 *
 * `Number(v)` 에 그대로 맡기면 안 된다: `typeof null === "object"` 라 `null` 이 문자열
 * 경로로 떨어지고 `Number(null)` 은 **0 이라 유한수**여서 NaN 가드를 통과한다. 점수를
 * 매기지 않겠다고 `null` 을 보낸 모델의 후보가 0점으로 기록되면 정렬만 흔들리고 카드에는
 * "0%" 가 뜬다. 값이 없으면 그 후보를 버리는 편이 낫다.
 */
function asSim(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(asString).filter((x) => x.length > 0);
}

/**
 * 펜스 JSON → `Recommendation[]`.
 *
 * **id 는 실제 후보 집합으로 검증한다.** 모델은 그럴듯한 폴더명을 만들어 내는데, 그것이
 * 통과하면 추천 카드를 눌렀을 때 존재하지 않는 노트를 열려고 한다.
 *
 * 클러스터 접기 규칙은 로컬 엔진(`recommend.rs`)과 같게 맞춘다: 대표 제목에 `" (대표)"` 를
 * 붙이고, 자식은 날짜 내림차순으로 정렬한다. 두 엔진의 결과가 화면에서 같은 모양이어야
 * 사용자가 엔진 차이를 신경 쓸 필요가 없다.
 */
export function parseRecommend(
  text: string,
  candidates: RecCandidate[],
  maxItems: number,
): ParsedRecommend {
  const found = extractFencedJson(text, FENCE_LABEL);
  if (!found || typeof found.value !== "object" || found.value === null) {
    return { items: [], parsed: false, truncated: false };
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const root = found.value as Record<string, unknown>;

  // 순위. 유효한 id 와 유효한 sim 을 모두 갖춘 항목만 남는다.
  const ranked: { cand: RecCandidate; sim: number }[] = [];
  const rawItems = Array.isArray(root.items) ? root.items : [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const cand = byId.get(asString(item.id));
    if (!cand) continue;
    const sim = asSim(item.sim);
    if (sim === null) continue;
    if (ranked.some((r) => r.cand.id === cand.id)) continue;
    ranked.push({ cand, sim });
  }
  ranked.sort((a, b) => b.sim - a.sim);

  const simOf = new Map(ranked.map((r) => [r.cand.id, r.sim]));

  // 묶음 배선. 대표도 멤버도 순위에 있는 후보여야 한다.
  const memberOf = new Map<string, string[]>();
  const claimed = new Set<string>();
  const rawClusters = Array.isArray(root.clusters) ? root.clusters : [];
  for (const raw of rawClusters) {
    if (typeof raw !== "object" || raw === null) continue;
    const cluster = raw as Record<string, unknown>;
    const repId = asString(cluster.repId);
    if (!simOf.has(repId) || memberOf.has(repId) || claimed.has(repId)) continue;
    const members = asStringArray(cluster.memberIds).filter(
      (id) => id !== repId && simOf.has(id) && !claimed.has(id) && !memberOf.has(id),
    );
    if (members.length === 0) continue;
    memberOf.set(repId, members);
    for (const id of members) claimed.add(id);
  }

  const toClusterItem = (id: string, isRep: boolean): ClusterItem => {
    const c = byId.get(id)!;
    return {
      id,
      date: c.date,
      title: isRep ? `${c.title} (대표)` : c.title,
      path: c.path,
      sim: simOf.get(id) ?? 0,
    };
  };

  const items: Recommendation[] = [];
  for (const { cand, sim } of ranked) {
    if (items.length >= maxItems) break;
    // 남의 묶음에 접힌 후보는 그 카드 안에서만 보인다.
    if (claimed.has(cand.id)) continue;

    const members = memberOf.get(cand.id) ?? [];
    const cluster =
      members.length > 0
        ? [
            toClusterItem(cand.id, true),
            // 자식은 최근 것부터 — 로컬 엔진과 같은 규칙.
            ...members
              .map((id) => toClusterItem(id, false))
              .sort((a, b) => b.date.localeCompare(a.date)),
          ]
        : null;

    items.push({ id: cand.id, sim, title: cand.title, path: cand.path, cluster });
  }

  return { items, parsed: true, truncated: found.truncated };
}
