import { looksTruncated } from "../fencedJson";
import { runWithRetry, type RunOnceOptions } from "../runOnce";
import type { Material } from "./material";
import { fitMinutes } from "./minutes";
import { blankDraft, parseRefine, type Draft } from "./parse";
import {
  FENCE_LABEL,
  IWMS_MAX_TOKENS,
  IWMS_TEMPERATURE,
  buildIwmsPrompt,
  buildIwmsRepairPrompt,
  buildIwmsSystemPrompt,
  codeTable,
  type CodeTable,
} from "./prompts";
import type { IwmsDay, IwmsPush, IwmsSettings, Price } from "./types";

/**
 * 정제 한 번 — 프롬프트를 만들어 AI 에 묻고, 답을 확인해 초안으로 돌려준다.
 *
 * 실패해도 던지지 않는다. 빈 초안(제목을 내용에 넣은 것)과 사유를 돌려주어 사람이 직접 채우게 한다 —
 * 검토 화면은 AI 없이도 끝까지 쓸 수 있어야 한다.
 */
export interface RefineInput {
  /** `routeRun(useAi.getState(), "iwms.refine")`. `null` 이면 AI 없이 빈 초안. */
  run: { agentId: string; model: string } | null;
  day: IwmsDay;
  items: Material[];
  settings: IwmsSettings;
  examples: IwmsPush[];
  inject: string;
}

export interface RefineResult {
  drafts: Draft[];
  table: CodeTable;
  error: string | null;
  truncated: boolean;
}

/** 배분할 분 — 기준시간에서 그날 이미 입력된 분을 뺀 것. */
export function remainingOf(day: IwmsDay): number {
  return Math.max(0, day.standardMinutes - day.totalMinutes);
}

/** 선택한 줄의 대가 구분들 — 프롬프트에 실을 후보 묶음. */
export function pricesOf(items: Material[]): Price[] {
  return [...new Set(items.map((m) => m.price))];
}

/**
 * 분을 다시 맞춘다. 남은 시간을 모두 채우는 설정이면 사람이 고치지 않은 줄을 비율대로 늘이거나 줄이고,
 * 아니면 단위로만 맞춘다.
 */
export function refit(drafts: Draft[], remaining: number, settings: IwmsSettings): Draft[] {
  const values = drafts.map((d) => d.minutes);
  const locked = drafts.map((d) => !!d.edited.minutes);
  const total = settings.fillToStandard ? remaining : 0;
  const next = fitMinutes(values, locked, total, settings.minuteStep);
  return drafts.map((d, i) => (d.minutes === next[i] ? d : { ...d, minutes: next[i] }));
}

export async function refine(input: RefineInput, opts: RunOnceOptions = {}): Promise<RefineResult> {
  const { run, day, items, settings, examples, inject } = input;
  const table = codeTable(day, pricesOf(items), settings.categories);
  const remaining = remainingOf(day);
  const blank = (error: string): RefineResult => ({
    drafts: refit(items.map((m) => blankDraft(m, table)), remaining, settings),
    table,
    error,
    truncated: false,
  });

  if (!run) return blank("AI 연결이 없어 초안만 만들었습니다 — 설정 → AI 연결에서 'i-WMS 정제' 연결을 고르세요");
  if (!items.length) return blank("입력할 업무가 없습니다");

  const base = {
    agentId: run.agentId,
    model: run.model,
    systemPrompt: buildIwmsSystemPrompt(),
    maxTokens: IWMS_MAX_TOKENS,
    temperature: IWMS_TEMPERATURE,
  };
  const prompt = buildIwmsPrompt({
    day,
    items,
    table,
    designated: settings.categories,
    styleGuide: settings.styleGuide,
    remaining,
    fill: settings.fillToStandard,
    step: settings.minuteStep,
    examples,
    inject,
  });

  let res = await runWithRetry({ ...base, prompt }, opts);
  if (!res.ok && !res.text.trim()) return blank(res.error ?? "AI 응답이 비어 있습니다");

  let parsed = parseRefine(res.text, items, table);
  if (!parsed.parsed && res.text.trim() && !opts.signal?.aborted) {
    const repair = await runWithRetry(
      { ...base, prompt: buildIwmsRepairPrompt(res.text, items.map((m) => m.entryId)) },
      opts,
    );
    const again = parseRefine(repair.text, items, table);
    if (again.parsed) {
      parsed = again;
      res = repair;
    }
  }
  if (!parsed.parsed) {
    const cut = res.truncated || looksTruncated(res.text, FENCE_LABEL);
    return blank(
      cut
        ? "AI 응답이 출력 길이 상한에서 잘렸습니다 — 업무를 나눠서 정제하거나 출력 토큰 상한을 올려 보세요"
        : "AI 가 출력 형식(```iwms 펜스)을 지키지 않았습니다 — [다시 정제] 를 눌러 보세요",
    );
  }

  return {
    drafts: refit(parsed.drafts, remaining, settings),
    table,
    error: parsed.truncated ? "응답이 잘려 뒤쪽 업무 일부가 빈 초안입니다" : null,
    truncated: parsed.truncated,
  };
}
