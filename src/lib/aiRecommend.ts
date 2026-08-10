import type { RecCandidate, RecommendResult } from "./api";
import * as api from "./api";
import { looksTruncated } from "./fencedJson";
import { injectionFor } from "./promptPacks";
import {
  buildRecommendPrompt,
  buildRepairPrompt,
  buildSystemPrompt,
  CANDIDATE_CAP,
  FENCE_LABEL,
  RECOMMEND_MAX_TOKENS,
  parseRecommend,
} from "./recommendPrompt";
import { runWithRetry } from "./runOnce";
import { useAi } from "../store/aiStore";

/**
 * AI 기반 유사 업무 추천.
 *
 * 성공하면 `RecommendResult`(engine = 에이전트 id), 어느 단계든 실패하면 `null` 을 돌려
 * 호출부가 로컬 유사도로 폴백하게 한다. **여기서 예외를 던지지 않는다** — AI 는 추천의
 * 부가 기능이고, 실패가 새 업무 추가 흐름을 막아서는 안 된다.
 */

/** 화면에 낼 카드 수. 로컬 엔진의 기본값과 같다. */
const MAX_ITEMS = 3;

export interface AiRecommendInput {
  active: { agentId: string; model: string };
  query: string;
  candidates: RecCandidate[];
  threshold: number;
}

/**
 * 프롬프트에 실을 후보를 고른다.
 *
 * 후보가 상한 이내면 전부 보낸다. 넘으면 로컬 엔진을 재현율 단계로 한 번 더 돌려
 * 상위 묶음만 남긴다 — 클러스터에 접힌 자식까지 펼쳐서 넣는다(대표만 보내면 AI 가
 * "이 업무는 한 번뿐" 이라고 잘못 읽는다).
 */
async function shortlist(input: AiRecommendInput): Promise<RecCandidate[]> {
  const { query, candidates, threshold } = input;
  if (candidates.length <= CANDIDATE_CAP) return candidates;

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const recall = await api.recommendTasks(query, candidates, threshold, CANDIDATE_CAP);

  const picked: RecCandidate[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    const c = byId.get(id);
    if (c && !seen.has(id) && picked.length < CANDIDATE_CAP) {
      seen.add(id);
      picked.push(c);
    }
  };
  for (const item of recall.items) {
    push(item.id);
    for (const member of item.cluster ?? []) push(member.id);
  }
  // 로컬 점수가 0 이라 하나도 안 걸리면 AI 에게 물어볼 것이 없다.
  return picked;
}

export async function aiRecommend(input: AiRecommendInput): Promise<RecommendResult | null> {
  const { active, query, threshold } = input;
  const agentName =
    useAi.getState().detected[active.agentId]?.name ?? active.agentId;

  try {
    const candidates = await shortlist(input);
    if (candidates.length === 0) return null;

    const ai = useAi.getState();
    const systemPrompt = buildSystemPrompt();
    const prompt = buildRecommendPrompt({
      query,
      candidates,
      threshold,
      maxItems: MAX_ITEMS,
      inject: injectionFor("recommend.rank", ai.packs, ai.settings),
    });

    const base = {
      agentId: active.agentId,
      systemPrompt,
      model: active.model,
      maxTokens: RECOMMEND_MAX_TOKENS,
    };

    let run = await runWithRetry({ ...base, prompt });
    if (!run.ok && !run.text.trim()) return null;

    let parsed = parseRecommend(run.text, candidates, MAX_ITEMS);

    // 재질의 **1회만**. 서술은 이미 받았으니 펜스만 다시 달라고 한다.
    if (!parsed.parsed && run.text.trim()) {
      const repair = await runWithRetry({
        ...base,
        prompt: buildRepairPrompt(run.text, candidates.map((c) => c.id)),
      });
      if (repair.text.trim()) {
        const retried = parseRecommend(repair.text, candidates, MAX_ITEMS);
        if (retried.parsed) {
          parsed = retried;
          run = repair;
        }
      }
    }

    if (!parsed.parsed) {
      // 로컬로 떨어지지만 왜 떨어졌는지는 남긴다. 잘림과 형식 위반은 사용자가 할 수 있는
      // 조치가 다르다 — 전자는 출력 상한, 후자는 재시도.
      const cut = run.truncated || looksTruncated(run.text, FENCE_LABEL);
      throw new Error(
        cut
          ? "응답이 출력 길이 상한에서 잘렸습니다 (설정에서 출력 토큰 상한을 올려 보세요)"
          : "출력 형식(```recommend 펜스)을 지키지 않았습니다",
      );
    }

    const note = parsed.truncated
      ? `${agentName} · 응답이 잘려 뒤쪽 항목 일부가 빠졌습니다`
      : `${agentName} · ${active.model || "기본 모델"}`;

    return { engine: active.agentId, note, items: parsed.items };
  } catch (e) {
    // 폴백 사유는 호출부가 로컬 note 뒤에 붙일 수 있도록 콘솔에만 남긴다. 토스트로
    // 띄우면 오프라인에서 업무를 추가할 때마다 경고가 뜬다.
    console.warn(`[contextflow] ${agentName} 추천 실패 — 로컬 유사도로 대체:`, e);
    return null;
  }
}
