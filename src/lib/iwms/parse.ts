import { extractFencedJson } from "../fencedJson";
import type { Material } from "./material";
import { FENCE_LABEL, NOTE_MAX, type CodeTable } from "./prompts";
import { categoryKey, type IwmsCategory, type Price } from "./types";

/**
 * 정제 결과의 한 줄 — 검토 화면이 그리고 사람이 고치는 값.
 *
 * AI 의 답은 믿되 확인한다: 코드표에 없거나 대가 구분이 다른 카테고리는 비우고(사람이 고른다),
 * 매핑으로 고정된 줄은 AI 가 무엇을 골랐든 고정값으로 둔다. 분과 글자 수는 i-WMS 의 상한으로 자른다.
 */
export interface Draft {
  entryId: number;
  title: string;
  price: Price;
  category: IwmsCategory | null;
  minutes: number;
  note: string;
  /** AI 의 자기보고 0~100. AI 가 빠뜨린 줄은 `null`. */
  confidence: number | null;
  alternatives: IwmsCategory[];
  /** 매핑으로 정해졌다. */
  fixed: boolean;
  /** 사람이 고친 칸 — 다시 정제해도 · 분을 다시 맞춰도 그대로 둔다. */
  edited: { category?: boolean; minutes?: boolean; note?: boolean };
  /** 사람이 알아야 할 것(카테고리를 비웠다 · 글을 잘랐다 · AI 가 빠뜨렸다). */
  issues: string[];
}

export interface ParsedRefine {
  parsed: boolean;
  /** 잘린 응답을 닫아서 살렸다 — 뒤쪽 줄이 빠졌을 수 있다. */
  truncated: boolean;
  drafts: Draft[];
}

interface RawItem {
  entryId?: unknown;
  category?: unknown;
  minutes?: unknown;
  note?: unknown;
  confidence?: unknown;
  alternatives?: unknown;
}

/**
 * 한 줄로 접힌 목록을 편다 — `첫 줄 / - 세부 / - 세부` → 줄바꿈. 모델이 프롬프트의 접은 모양을 흉내 낸
 * 일이 있어(2026-10-04 실측) 프롬프트를 고친 뒤에도 안전장치로 둔다.
 */
export function unfold(note: string): string {
  return note.replace(/\r\n/g, "\n").replace(/[ \t]+\/[ \t]+(?=-\s)/g, "\n").trim();
}

function int(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** 프롬프트에 실린 그 줄의 고정 카테고리(코드표에 있을 때만). */
function fixedOf(m: Material, table: CodeTable): IwmsCategory | null {
  if (!m.fixed) return null;
  const code = table.codeOf.get(categoryKey(m.fixed));
  return code ? (table.byCode.get(code) ?? null) : null;
}

/** AI 를 거치지 않은 빈 초안 — AI 가 빠뜨렸거나 연결이 없을 때. */
export function blankDraft(m: Material, table: CodeTable, issue?: string): Draft {
  const fixed = fixedOf(m, table);
  return {
    entryId: m.entryId,
    title: m.title,
    price: m.price,
    category: fixed,
    minutes: 0,
    note: m.body || m.title,
    confidence: null,
    alternatives: [],
    fixed: !!fixed,
    edited: {},
    issues: issue ? [issue] : [],
  };
}

/**
 * 다시 정제한 결과에 사람이 고친 칸을 되살린다. 분은 이것을 지난 뒤 `refit` 으로 다시 맞춰야 합이 맞는다.
 */
export function mergeDrafts(prev: Draft[], fresh: Draft[]): Draft[] {
  const old = new Map(prev.map((d) => [d.entryId, d]));
  return fresh.map((f) => {
    const o = old.get(f.entryId);
    if (!o) return f;
    return {
      ...f,
      category: o.edited.category ? o.category : f.category,
      minutes: o.edited.minutes ? o.minutes : f.minutes,
      note: o.edited.note ? o.note : f.note,
      edited: o.edited,
    };
  });
}

export function parseRefine(text: string, items: Material[], table: CodeTable): ParsedRefine {
  const fenced = extractFencedJson(text, FENCE_LABEL);
  const raw = (fenced?.value as { items?: unknown } | null)?.items;
  if (!fenced || !Array.isArray(raw)) {
    return { parsed: false, truncated: false, drafts: items.map((m) => blankDraft(m, table)) };
  }

  const byId = new Map<number, RawItem>();
  for (const it of raw as RawItem[]) {
    const id = int(it?.entryId);
    if (id !== null && !byId.has(id)) byId.set(id, it);
  }

  const drafts = items.map((m): Draft => {
    const it = byId.get(m.entryId);
    if (!it) return blankDraft(m, table, "AI 가 이 업무를 빠뜨렸습니다 — 카테고리와 내용을 채워 주세요");

    const issues: string[] = [];
    const pick = (code: unknown): IwmsCategory | null => {
      const c = typeof code === "string" ? table.byCode.get(code.trim().toUpperCase()) : undefined;
      return c && c.priceType === m.price ? c : null;
    };

    const fixed = fixedOf(m, table);
    let category = fixed ?? pick(it.category);
    if (!fixed && !category && it.category) {
      issues.push("AI 가 고른 카테고리가 후보에 없거나 대가 구분이 달라 비웠습니다");
    }

    let note = typeof it.note === "string" ? unfold(it.note) : "";
    if (!note) {
      note = m.body || m.title;
      issues.push("AI 가 상세 내용을 비워 제목을 넣었습니다");
    }
    if (note.length > NOTE_MAX) {
      note = note.slice(0, NOTE_MAX);
      issues.push(`상세 내용을 ${NOTE_MAX}자에서 잘랐습니다`);
    }

    const alternatives = (Array.isArray(it.alternatives) ? it.alternatives : [])
      .map(pick)
      .filter((c): c is IwmsCategory => !!c && (!category || categoryKey(c) !== categoryKey(category)))
      .slice(0, 2);
    if (!category && alternatives.length) {
      category = alternatives.shift()!;
      issues.push("차선 후보를 넣었습니다 — 확인해 주세요");
    }

    const confidence = int(it.confidence);
    return {
      entryId: m.entryId,
      title: m.title,
      price: m.price,
      category,
      minutes: Math.min(1440, Math.max(0, int(it.minutes) ?? 0)),
      note,
      confidence: confidence === null ? null : Math.min(100, Math.max(0, confidence)),
      alternatives,
      fixed: !!fixed,
      edited: {},
      issues,
    };
  });

  return { parsed: true, truncated: fenced.truncated, drafts };
}
