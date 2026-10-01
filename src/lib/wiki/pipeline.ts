/**
 * 위키 반영 · 질의 · 점검의 진행 — 커맨드와 AI 실행을 순서대로 엮는다.
 *
 * **`wiki_apply` 전에는 아무것도 쓰지 않는다.** LLM 호출이 전부 끝나 페이지가 손에 들어온
 * 뒤 한 번에 쓴다. 중간에 실패하거나 취소하면 위키는 그대로이고, 그 업무는 "반영 대기" 로
 * 남아 다시 시도할 수 있다.
 */
import type { AiSettings, PromptPack } from "../ai";
import * as api from "../api";
import { injectionFor } from "../promptPacks";
import { CANCELED, runWithRetry } from "../runOnce";
import { guessSummary, parsePageBlocks } from "./blocks";
import { extractWikiLinks, resolveLink } from "./links";
import {
  INTEGRATE_MAX_TOKENS,
  LINT_MAX_TOKENS,
  QUERY_MAX_TOKENS,
  SOURCE_MAX_TOKENS,
  WIKI_TEMPERATURE,
  buildIntegratePrompt,
  buildLintPrompt,
  buildQueryPrompt,
  buildSourcePrompt,
  buildWikiSystemPrompt,
  parseLint,
  parsePlan,
  type AiLintIssue,
} from "./prompts";

export interface Route {
  agentId: string;
  model: string;
}

/** 프롬프트 팩 주입에 필요한 AI 설정 조각. */
export interface PackSource {
  packs: PromptPack[];
  settings: AiSettings | null;
}

export interface IngestOptions {
  root: string;
  taskId: string;
  route: Route;
  depth: "light" | "full";
  maxPages: number;
  ai: PackSource;
  signal?: AbortSignal;
  /** 진행 단계 한 줄(화면 표시용). */
  onStep?: (step: string) => void;
}

export interface IngestOutcome {
  result: api.WikiApplyResult;
  /** log.md 에도 남긴 부가 사정(잘림 · 관련 페이지 실패 …). */
  notes: string[];
}

async function readSchema(root: string): Promise<string> {
  return api.readTextFile(`${root}/Wiki/SCHEMA.md`).catch(() => "");
}

function canceled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error(CANCELED);
}

/**
 * 업무 하나를 위키에 반영한다. 실패하면 던진다(사유 문구 그대로) — 큐가 그 업무를 실패로
 * 표시하고 다음으로 넘어간다.
 */
export async function ingestTask(o: IngestOptions): Promise<IngestOutcome> {
  const step = (s: string) => o.onStep?.(s);
  const notes: string[] = [];

  step("원본 읽는 중");
  await api.wikiInit(o.root);
  const bundle = await api.wikiReadSource(o.root, o.taskId);
  const [schema, status] = await Promise.all([readSchema(o.root), api.wikiStatus(o.root, 0)]);
  const pages = status.pages;
  const head = bundle.files[0]?.text?.slice(0, 600) ?? "";
  const query = [bundle.task.title, bundle.task.tags.join(" "), head].join(" ");
  const related = await api.wikiSearch(o.root, query, 30).catch(() => [] as api.WikiHit[]);
  canceled(o.signal);

  const system = buildWikiSystemPrompt();
  const base = {
    agentId: o.route.agentId,
    model: o.route.model,
    systemPrompt: system,
    temperature: WIKI_TEMPERATURE,
  };

  // ── 호출 A: 소스 페이지 + 계획 ───────────────────────────────────────────
  step("소스 페이지 쓰는 중");
  const a = await runWithRetry(
    {
      ...base,
      maxTokens: SOURCE_MAX_TOKENS,
      prompt: buildSourcePrompt({
        schema,
        bundle,
        related,
        pages,
        depth: o.depth,
        maxPages: o.maxPages,
        inject: injectionFor("wiki.ingest", o.ai.packs, o.ai.settings),
      }),
    },
    { signal: o.signal },
  );
  canceled(o.signal);
  if (!a.ok && !a.text.trim()) throw new Error(a.error ?? "응답이 비어 있습니다");

  const src = parsePageBlocks(a.text).get("source");
  if (!src || !src.body.trim()) {
    throw new Error(
      a.truncated
        ? "응답이 출력 길이 상한에서 잘려 소스 페이지를 받지 못했습니다 (설정에서 출력 토큰 상한을 올려 보세요)"
        : "출력 형식(<<<PAGE source>>> 블록)을 지키지 않았습니다",
    );
  }
  if (!src.complete) notes.push("소스 페이지 응답이 잘려 뒷부분이 빠졌을 수 있습니다");

  const plan = parsePlan(a.text, { maxPages: o.maxPages, light: o.depth === "light", pages });
  if (!plan && o.depth === "full") notes.push("반영 계획을 읽지 못해 소스 페이지만 썼습니다");

  const writes: api.WikiPageWrite[] = [
    {
      kind: "source",
      title: bundle.task.title,
      body: src.body,
      summary: plan?.summary || src.summary || guessSummary(src.body),
      tags: plan?.tags.length ? plan.tags : bundle.task.tags,
    },
  ];

  // ── 호출 B: 관련 페이지 ─────────────────────────────────────────────────
  const items = plan?.pages ?? [];
  if (o.depth === "full" && items.length) {
    step(`관련 페이지 ${items.length}장 고치는 중`);
    const paths = items.filter((it) => it.existing).map((it) => it.existing!.path);
    const current = paths.length ? await api.wikiReadPages(o.root, paths) : [];
    const byPath = Object.fromEntries(current.map((p) => [p.path, p]));
    canceled(o.signal);

    const b = await runWithRetry(
      {
        ...base,
        maxTokens: INTEGRATE_MAX_TOKENS,
        prompt: buildIntegratePrompt({
          schema,
          title: bundle.task.title,
          sourceStem: bundle.sourceStem,
          sourceBody: src.body,
          items,
          current: Object.fromEntries(current.map((p) => [p.path, p.content])),
          pages,
          reingest: bundle.reingest,
          inject: injectionFor("wiki.ingest", o.ai.packs, o.ai.settings),
        }),
      },
      { signal: o.signal },
    );
    canceled(o.signal);

    if (!b.text.trim()) {
      // 관련 페이지는 부가물이다 — 실패해도 소스 페이지는 쓴다.
      notes.push(`관련 페이지를 고치지 못했습니다: ${b.error ?? "응답 없음"}`);
    } else {
      const blocks = parsePageBlocks(b.text);
      items.forEach((it, n) => {
        const blk = blocks.get(String(n + 1));
        if (!blk || !blk.body.trim()) {
          notes.push(`응답에 없어 쓰지 못함: ${it.title}`);
          return;
        }
        // 잘린 블록은 쓰지 않는다 — 기존 페이지를 반쪽짜리로 덮으면 내용을 잃는다.
        if (!blk.complete) {
          notes.push(`응답이 잘려 쓰지 못함: ${it.title}`);
          return;
        }
        const cur = it.existing ? byPath[it.existing.path] : undefined;
        writes.push({
          kind: it.type,
          title: it.title,
          body: blk.body,
          summary: blk.summary || guessSummary(blk.body),
          // 기존 페이지인데 본문을 못 읽었으면 해시도 없다 — 백엔드가 덮어쓰지 않고 덧붙인다.
          baseHash: cur?.hash ?? null,
        });
      });
    }
  }

  canceled(o.signal);
  step("위키에 쓰는 중");
  const result = await api.wikiApply(o.root, {
    op: "ingest",
    title: bundle.task.title,
    taskId: o.taskId,
    pages: writes,
    log: notes,
  });
  return { result, notes };
}

export interface AskOutcome {
  answer: string;
  /** 답에 인용된 위키 페이지(실제로 있는 것만). */
  cited: api.WikiPageMeta[];
  /** 프롬프트에 본문을 실은 페이지. */
  used: api.WikiPageMeta[];
}

/** 위키에 묻는다 — 로컬 검색으로 페이지를 고르고, 그 본문으로 답하게 한다. */
export async function askWiki(o: {
  root: string;
  question: string;
  route: Route;
  ai: PackSource;
  signal?: AbortSignal;
  onPartial?: (text: string) => void;
}): Promise<AskOutcome> {
  const status = await api.wikiStatus(o.root, 0);
  const pages = status.pages;
  if (!pages.length) throw new Error("위키가 비어 있습니다 — 먼저 업무를 반영하세요");
  const hits = await api.wikiSearch(o.root, o.question, 6);
  const used = hits
    .map((h) => pages.find((p) => p.path === h.path))
    .filter((p): p is api.WikiPageMeta => !!p);
  const bodies = used.length ? await api.wikiReadPages(o.root, used.map((p) => p.path)) : [];
  canceled(o.signal);

  const run = await runWithRetry(
    {
      agentId: o.route.agentId,
      model: o.route.model,
      systemPrompt: buildWikiSystemPrompt(),
      temperature: WIKI_TEMPERATURE,
      maxTokens: QUERY_MAX_TOKENS,
      prompt: buildQueryPrompt({
        question: o.question,
        pages: used.map((p) => ({
          stem: p.stem,
          title: p.title,
          kind: p.kind,
          content: bodies.find((b) => b.path === p.path)?.content ?? "",
        })),
        catalog: pages,
        inject: injectionFor("wiki.query", o.ai.packs, o.ai.settings),
      }),
    },
    { signal: o.signal, onPartial: o.onPartial },
  );
  if (!run.ok && !run.text.trim()) throw new Error(run.error ?? "응답이 비어 있습니다");

  const cited: api.WikiPageMeta[] = [];
  for (const l of extractWikiLinks(run.text)) {
    const p = resolveLink(l.target, pages);
    if (p && !cited.includes(p)) cited.push(p);
  }
  return { answer: run.text.trim(), cited, used };
}

/** 답변을 위키로 되돌린다 — `answers/` 페이지 + log 의 `query` 항목. */
export async function fileAnswer(o: {
  root: string;
  question: string;
  answer: string;
  cited: api.WikiPageMeta[];
}): Promise<api.WikiApplyResult> {
  // 끝의 물음표 · 마침표는 뺀다 — 파일 이름에서 `-` 로 바뀌어 "순서는-.md" 가 된다.
  const q = o.question.trim().replace(/\s+/g, " ").replace(/[?？!.。\s]+$/, "");
  const title = [...q].slice(0, 60).join("");
  const sources = [
    ...new Set(o.cited.flatMap((p) => (p.kind === "source" && p.taskId ? [p.taskId] : p.sources))),
  ];
  return api.wikiApply(o.root, {
    op: "query",
    title,
    pages: [
      {
        kind: "answer",
        title,
        body: [`# ${title}`, "", `> 질문: ${o.question.trim()}`, "", o.answer].join("\n"),
        summary: guessSummary(o.answer),
        sources,
      },
    ],
  });
}

/** AI 점검 — 카탈로그(요약)만 보내 모순 · 누락을 보고받는다. 위키는 고치지 않는다. */
export async function aiLint(o: {
  root: string;
  route: Route;
  ai: PackSource;
  localIssues: api.WikiLintIssue[];
  signal?: AbortSignal;
}): Promise<AiLintIssue[]> {
  const status = await api.wikiStatus(o.root, 0);
  if (!status.pages.length) return [];
  const run = await runWithRetry(
    {
      agentId: o.route.agentId,
      model: o.route.model,
      systemPrompt: buildWikiSystemPrompt(),
      temperature: WIKI_TEMPERATURE,
      maxTokens: LINT_MAX_TOKENS,
      prompt: buildLintPrompt({
        catalog: status.pages,
        localIssues: o.localIssues.map((i) => `- ${i.kind}: ${i.path} — ${i.detail}`),
        inject: injectionFor("wiki.lint", o.ai.packs, o.ai.settings),
      }),
    },
    { signal: o.signal },
  );
  if (!run.ok && !run.text.trim()) throw new Error(run.error ?? "응답이 비어 있습니다");
  const issues = parseLint(run.text);
  if (!issues) throw new Error("출력 형식(```wikilint 펜스)을 지키지 않았습니다");
  await api
    .wikiApply(o.root, {
      op: "lint",
      title: `AI 점검 — ${issues.length}건`,
      pages: [],
      log: issues.map((i) => `${i.kind}: ${i.pages.join(", ")} — ${i.detail}`),
    })
    .catch(() => {});
  return issues;
}
