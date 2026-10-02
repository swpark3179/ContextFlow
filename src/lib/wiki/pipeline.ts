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
  pickContextPages,
  type AiLintIssue,
  type ChatTurnText,
} from "./prompts";
import {
  WEB_LABEL,
  WEB_READ_MAX_TOKENS,
  WEB_ROUNDS,
  WEB_TEMPERATURE,
  buildWebReadPrompt,
  buildWebSystemPrompt,
  citedWebSources,
  numberSources,
  parseWebSearch,
  snippetsAsFindings,
  stripWebFence,
  type WebFinding,
  type WebRequest,
  type WebSource,
} from "./web";

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
  /** 답이 `[웹n]` 으로 인용한 웹 출처. */
  webCited: WebSource[];
  /** 웹 결과 정리에 쓰인 출처(답이 아무것도 인용하지 않았을 때 보여 준다). */
  webUsed: WebSource[];
  /** 이번 질문에서 실제로 검색한 검색어. */
  searches: string[];
  /** 검색 · 정리 실패 사유(답은 그것 없이 나왔다). */
  webErrors: string[];
}

/** 위키 질의 중 웹 검색 — 쓸 정리 모델과 브라우저 옵션. */
export interface AskWeb {
  /** 웹 검색 연결(기능별 AI 연결의 "웹 검색"). */
  route: Route;
  browser: api.BrowserOptions;
  /** 검색어마다 본문을 읽을 결과 수. */
  pages: number;
}

/** 질의 한 번에 본문을 싣는 페이지 수. */
const QUERY_PAGES = 6;

/**
 * 위키에 묻는다 — 로컬 검색으로 페이지를 고르고, 그 본문으로 답하게 한다.
 *
 * 대화를 이어 갈 때는 `history`(앞선 턴의 질문과 답)와 `carry`(앞선 답이 인용한 페이지
 * 경로)를 준다. 이어지는 질문은 그것만으로는 검색이 안 되므로, 앞선 질문과 합친 검색과
 * 앞선 인용을 함께 후보로 둔다(`pickContextPages`).
 */
export async function askWiki(o: {
  root: string;
  question: string;
  route: Route;
  ai: PackSource;
  history?: ChatTurnText[];
  carry?: string[];
  /** 주면 AI 가 웹 검색을 요청할 수 있다. */
  web?: AskWeb | null;
  signal?: AbortSignal;
  onPartial?: (text: string) => void;
  /** 진행 단계 한 줄(웹 검색 · 페이지 읽기 · 정리). */
  onStep?: (step: string) => void;
}): Promise<AskOutcome> {
  const status = await api.wikiStatus(o.root, 0);
  const pages = status.pages;
  if (!pages.length) throw new Error("위키가 비어 있습니다 — 먼저 업무를 반영하세요");
  const history = o.history ?? [];
  const prev = history[history.length - 1]?.question;
  const [hits, ctxHits] = await Promise.all([
    api.wikiSearch(o.root, o.question, QUERY_PAGES),
    prev ? api.wikiSearch(o.root, `${o.question} ${prev}`, QUERY_PAGES) : Promise.resolve([]),
  ]);
  const picked = pickContextPages(
    [hits.map((h) => h.path), (o.carry ?? []).slice(0, 3), ctxHits.map((h) => h.path)],
    QUERY_PAGES,
  );
  const used = picked
    .map((path) => pages.find((p) => p.path === path))
    .filter((p): p is api.WikiPageMeta => !!p);
  const bodies = used.length ? await api.wikiReadPages(o.root, used.map((p) => p.path)) : [];
  canceled(o.signal);

  const queryPages = used.map((p) => ({
    stem: p.stem,
    title: p.title,
    kind: p.kind,
    content: bodies.find((b) => b.path === p.path)?.content ?? "",
  }));
  const findings: WebFinding[] = [];
  const searches: string[] = [];
  const webErrors: string[] = [];
  let answer = "";

  // 웹 검색이 꺼져 있으면 한 바퀴. 켜져 있으면 모델이 검색을 요청할 때마다 검색 → 정리 →
  // 다시 묻기를 `WEB_ROUNDS` 번까지 하고, 마지막 바퀴는 검색 없이 답하게 한다.
  for (let round = 0; ; round++) {
    const remaining = o.web ? WEB_ROUNDS - round : 0;
    o.onStep?.(round === 0 ? "답 쓰는 중" : "웹 검색 결과로 답 쓰는 중");
    const run = await runWithRetry(
      {
        agentId: o.route.agentId,
        model: o.route.model,
        systemPrompt: buildWikiSystemPrompt(),
        temperature: WIKI_TEMPERATURE,
        maxTokens: QUERY_MAX_TOKENS,
        prompt: buildQueryPrompt({
          question: o.question,
          pages: queryPages,
          catalog: pages,
          inject: injectionFor("wiki.query", o.ai.packs, o.ai.settings),
          history,
          web: o.web ? { remaining, findings } : null,
        }),
      },
      {
        signal: o.signal,
        // 검색 요청이 시작되면 그 앞까지만 보여 준다 — 펜스가 답처럼 흘러나오면 안 된다.
        onPartial: o.onPartial ? (t) => o.onPartial!(o.web ? stripWebFence(t) : t) : undefined,
      },
    );
    canceled(o.signal);
    if (!run.ok && !run.text.trim()) throw new Error(run.error ?? "응답이 비어 있습니다");

    const req = o.web && remaining > 0 ? parseWebSearch(run.text) : null;
    if (!req) {
      answer = o.web ? stripWebFence(run.text) : run.text.trim();
      if (!answer) {
        const asked = o.web && run.text.includes("```" + WEB_LABEL);
        throw new Error(asked ? "AI 가 검색만 요청하고 답을 내지 못했습니다" : (run.error ?? "응답이 비어 있습니다"));
      }
      break;
    }
    o.onPartial?.("");
    searches.push(...req.queries);
    const known = findings.flatMap((f) => f.sources);
    const finding = await webRound({
      req,
      web: o.web!,
      question: o.question,
      context: history.map((h) => h.question),
      known,
      ai: o.ai,
      signal: o.signal,
      onStep: o.onStep,
    });
    if (finding.error) webErrors.push(finding.error);
    findings.push(finding);
  }

  const cited: api.WikiPageMeta[] = [];
  for (const l of extractWikiLinks(answer)) {
    const p = resolveLink(l.target, pages);
    if (p && !cited.includes(p)) cited.push(p);
  }
  const web = citedWebSources(answer, findings);
  return { answer, cited, used, webCited: web.cited, webUsed: web.used, searches, webErrors };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * 검색 한 바퀴 — 브라우저로 검색하고, 결과 몇 장의 본문을 읽고, 웹 검색 연결의 모델로 추린다.
 *
 * 실패해도 던지지 않는다(취소만 던진다). 검색이 막혔거나 정리 모델이 실패해도 질의 모델은 위키로
 * 답할 수 있어야 하므로, 사유를 `error` 에 담아 돌려준다. 정리 모델이 실패하면 결과 목록의 요약을
 * 그대로 사실 목록으로 쓴다.
 */
async function webRound(o: {
  req: WebRequest;
  web: AskWeb;
  question: string;
  context: string[];
  known: WebSource[];
  ai: PackSource;
  signal?: AbortSignal;
  onStep?: (step: string) => void;
}): Promise<WebFinding> {
  const step = (s: string) => o.onStep?.(s);
  const serps: api.SerpResult[] = [];
  const errors: string[] = [];
  for (const q of o.req.queries) {
    step(`웹 검색: ${q}`);
    try {
      serps.push(await api.webSearch(o.web.browser, q));
    } catch (e) {
      errors.push(api.errMessage(e));
    }
    canceled(o.signal);
  }
  const startAt = o.known.reduce((m, s) => Math.max(m, s.n), 0);
  const { sources, read } = numberSources(serps, startAt, Math.max(0, o.web.pages), o.known);
  const base = { queries: o.req.queries, reason: o.req.reason, sources };
  if (!sources.length) {
    const seenOnly = serps.some((r) => r.results.length > 0);
    const why = seenOnly ? "새 검색 결과가 없습니다 — 앞서 찾은 페이지와 같습니다" : "검색 결과가 없습니다";
    return { ...base, summary: "", error: errors[0] ?? why };
  }

  const pages: { source: WebSource; page: api.WebPage }[] = [];
  for (const [n, src] of read.entries()) {
    step(`웹 페이지 읽는 중 ${n + 1}/${read.length} · ${hostOf(src.url)}`);
    try {
      pages.push({ source: src, page: await api.webRead(o.web.browser, src.url) });
    } catch {
      /* 못 연 페이지는 결과 목록의 요약으로 대신한다 */
    }
    canceled(o.signal);
  }

  step("웹 검색 결과 정리 중");
  const run = await runWithRetry(
    {
      agentId: o.web.route.agentId,
      model: o.web.route.model,
      systemPrompt: buildWebSystemPrompt(),
      temperature: WEB_TEMPERATURE,
      maxTokens: WEB_READ_MAX_TOKENS,
      prompt: buildWebReadPrompt({
        question: o.question,
        context: o.context,
        reason: o.req.reason,
        sources,
        pages,
        inject: injectionFor("wiki.web", o.ai.packs, o.ai.settings),
      }),
    },
    { signal: o.signal },
  );
  canceled(o.signal);
  if (run.text.trim()) return { ...base, summary: run.text.trim() };
  return {
    ...base,
    summary: snippetsAsFindings(sources),
    error: `검색 결과를 정리하지 못해 요약만 썼습니다: ${run.error ?? "응답이 비어 있습니다"}`,
  };
}

/**
 * 답변을 위키로 되돌린다 — `answers/` 페이지 + log 의 `query` 항목.
 *
 * 대화 중간의 답이면 `context` 에 앞선 질문을 준다. "그럼 두 번째는?" 같은 질문은 그것만
 * 남기면 나중에 읽을 때 무엇을 물었는지 알 수 없다.
 */
export async function fileAnswer(o: {
  root: string;
  question: string;
  answer: string;
  cited: api.WikiPageMeta[];
  context?: string[];
  /** 답이 `[웹n]` 으로 인용한 웹 출처 — 본문 끝에 출처 목록으로 남긴다. */
  web?: WebSource[];
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
        body: [
          `# ${title}`,
          "",
          `> 질문: ${o.question.trim()}`,
          ...(o.context?.length ? [`> 앞선 질문: ${o.context.map((c) => c.trim()).join(" → ")}`] : []),
          "",
          o.answer,
          ...(o.web?.length
            ? ["", "## 웹 출처", "", ...o.web.map((w) => `- [웹${w.n}] [${w.title.replace(/[[\]]/g, "")}](${w.url})`)]
            : []),
        ].join("\n"),
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
