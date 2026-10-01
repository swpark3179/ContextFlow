import { useEffect, useMemo, useRef, useState } from "react";
import { Box, TextArea } from "../../lib/ui";
import { VIOLET } from "../../lib/design";
import { joinPath } from "../../lib/format";
import { mdParse, splitFrontmatter } from "../../lib/markdown";
import * as api from "../../lib/api";
import { CANCELED } from "../../lib/runOnce";
import { resolveLink } from "../../lib/wiki/links";
import { aiLint, askWiki, fileAnswer, type AskOutcome } from "../../lib/wiki/pipeline";
import type { AiLintIssue } from "../../lib/wiki/prompts";
import MarkdownView, { WikiLinkContext, type WikiLinks } from "../../components/MarkdownView";
import { isArchived, reportObsidianOpen, useStore } from "../../store/useStore";
import { routeInfo, useAi } from "../../store/aiStore";
import { useWiki } from "../../store/wikiStore";

export const KIND_LABEL: Record<api.WikiKind, string> = {
  procedure: "절차",
  topic: "주제",
  entity: "시스템·도구",
  source: "업무 소스",
  answer: "질의 답변",
};

export const KIND_COLOR: Record<api.WikiKind, { fg: string; bg: string }> = {
  procedure: { fg: "#256b47", bg: "#e9f4ee" },
  topic: { fg: "#2f5cbb", bg: "#eef3fd" },
  entity: { fg: "#8f5d17", bg: "#fbf3e4" },
  source: { fg: "#6a665e", bg: "#f0ede7" },
  answer: { fg: "#5a44b4", bg: "#f4f0fd" },
};

export function KindChip({ kind }: { kind: api.WikiKind }) {
  const c = KIND_COLOR[kind] ?? KIND_COLOR.topic;
  return (
    <span
      style={{
        flex: "0 0 auto",
        fontSize: 10.5,
        color: c.fg,
        background: c.bg,
        borderRadius: 3,
        padding: "1px 5px",
        whiteSpace: "nowrap",
      }}
    >
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

export const smallBtn: React.CSSProperties = {
  height: 24,
  padding: "0 10px",
  display: "flex",
  alignItems: "center",
  borderRadius: 4,
  border: "1px solid #e0dcd4",
  background: "#fff",
  color: "#4e4a43",
  fontSize: 11.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const hint: React.CSSProperties = { fontSize: 11.5, color: "#8a857c", lineHeight: 1.6 };

/** 안정된 빈 목록 — 스토어 셀렉터의 기본값으로 쓴다. */
const NO_PAGES: api.WikiPageMeta[] = [];

/** 업무 id → 지금 경로의 업무. 보관 'move' 로 옮겨졌어도 id 로 찾는다. */
function useTaskById() {
  const tasks = useStore((s) => s.tasks);
  return useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
}

/** 위키링크의 이동과 표시 — 업무 소스 링크는 업무 id 대신 그 업무의 제목을 보인다. */
function wikiLinks(pages: api.WikiPageMeta[], open: (target: string) => void): WikiLinks {
  return {
    open,
    label: (t) => {
      const p = resolveLink(t, pages);
      return p?.kind === "source" ? p.title : null;
    },
  };
}

/**
 * 원본 업무를 연다. 보관된 업무는 보관함 안에서(`peekArchived`), 그 뒤 재개된 업무는
 * 워크스페이스에서 연다 — 살아 있는 업무를 보관함 상세로 열면 [재개] 버튼이 뜨는 엉뚱한
 * 화면이 된다.
 */
export function openTask(task: api.TaskMeta) {
  const s = useStore.getState();
  if (isArchived(task, s.settings.archDays)) void s.peekArchived(task.folder);
  else void s.selectTask(task.folder);
}

/**
 * 페이지 보기. 위키링크를 누르면 그 페이지로 간다(`WikiLinkContext`). 소스 페이지는 원본
 * 업무로 가는 [원본 업무 열기] 를, 다른 페이지는 근거가 된 업무 목록을 함께 보여 준다 —
 * "위키에서 필요한 과거 업무를 찾는다" 는 이 두 길이다.
 */
export function PagePanel({ path, onOpen }: { path: string | null; onOpen: (path: string) => void }) {
  const s = useStore();
  const status = useWiki((w) => w.status);
  const pages = status?.pages ?? [];
  const meta = pages.find((p) => p.path === path) ?? null;
  const byId = useTaskById();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    if (!path) return;
    void api
      .wikiReadPages(s.settings.vault, [path])
      .then((r) => alive && setContent(r[0]?.content ?? ""))
      .catch((e) => alive && setError(api.errMessage(e)));
    return () => {
      alive = false;
    };
    // 페이지를 다시 반영하면 해시가 바뀐다 — 그때도 다시 읽는다.
  }, [path, meta?.hash, s.settings.vault]);

  const blocks = useMemo(
    () => (content === null ? [] : mdParse(splitFrontmatter(content).body)),
    [content],
  );

  const follow = (target: string) => {
    const hit = resolveLink(target, pages);
    if (hit) onOpen(hit.path);
    else s.toast("위키에 없는 페이지입니다", target, "#a8a29a");
  };

  if (!path) return <Welcome onOpen={onOpen} />;

  const task = meta?.taskId ? byId.get(meta.taskId) : undefined;
  const backing = (meta?.sources ?? [])
    .filter((id) => id !== meta?.taskId)
    .map((id) => ({ id, page: pages.find((p) => p.kind === "source" && p.taskId === id) }));

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          borderBottom: "1px solid #e6e2da",
          background: "#faf9f6",
        }}
      >
        {meta && <KindChip kind={meta.kind} />}
        <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, flex: 1 }}>
          {meta?.title ?? path}
          {meta?.updated && (
            <span style={{ fontWeight: 400, color: "#a09a8f", marginLeft: 8, fontSize: 11 }}>
              갱신 {meta.updated}
            </span>
          )}
        </span>
        {meta?.kind === "source" && (
          <Box
            style={{
              ...smallBtn,
              border: `1px solid ${task ? "#e0d6f8" : "#e0dcd4"}`,
              color: task ? "#5a44b4" : "#b5afa2",
              cursor: task ? "pointer" : "default",
            }}
            title={task ? task.relFolder : "원본 업무를 찾지 못했습니다(삭제되었거나 id 가 바뀜)"}
            hover={task ? { background: "#f4f0fd" } : undefined}
            onClick={() => task && openTask(task)}
          >
            원본 업무 열기
          </Box>
        )}
        <Box
          style={smallBtn}
          hover={{ background: "#f2efe9" }}
          onClick={() =>
            void api
              .openInObsidian(s.settings.vault, joinPath(s.settings.vault, `Wiki/${path}`))
              .then(reportObsidianOpen)
              .catch((e) => s.fail(e, "Obsidian 에서 열지 못했습니다"))
          }
        >
          Obsidian
        </Box>
      </div>
      {meta?.summary && (
        <div style={{ ...hint, padding: "6px 14px", borderBottom: "1px solid #f4f1ec" }}>
          {meta.summary}
        </div>
      )}
      {backing.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            alignItems: "center",
            padding: "6px 14px",
            borderBottom: "1px solid #f4f1ec",
          }}
        >
          <span style={{ ...hint, marginRight: 4 }}>근거 업무 {backing.length}건</span>
          {backing.map(({ id, page }) => (
            <Box
              key={id}
              title={id}
              style={{
                fontSize: 11.5,
                border: "1px solid #e6e2da",
                borderRadius: 4,
                padding: "1px 7px",
                background: "#fdfcfa",
                color: page ? "#2f5cbb" : "#a09a8f",
                cursor: page ? "pointer" : "default",
              }}
              hover={page ? { borderColor: "#cddcf8" } : undefined}
              onClick={() => page && onOpen(page.path)}
            >
              {page?.title ?? byId.get(id)?.title ?? id}
            </Box>
          ))}
        </div>
      )}
      {error && <div style={{ ...hint, color: "#c04a4a", padding: 14 }}>{error}</div>}
      <WikiLinkContext.Provider value={wikiLinks(pages, follow)}>
        <MarkdownView blocks={blocks} />
      </WikiLinkContext.Provider>
    </div>
  );
}

/** 페이지를 고르지 않았을 때 — 위키가 무엇이고 지금 얼마나 쌓였는지. */
function Welcome({ onOpen }: { onOpen: (path: string) => void }) {
  const status = useWiki((w) => w.status);
  const pages = status?.pages ?? [];
  const procedures = pages.filter((p) => p.kind === "procedure").slice(0, 12);
  const recent = [...pages].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 8);
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 22px" }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>LLM 위키</div>
      <div style={{ ...hint, marginTop: 6, maxWidth: 640 }}>
        완료한 업무를 AI 가 읽어 위키 페이지로 정리합니다 — 업무마다 소스 페이지 한 장, 여러
        업무에서 배운 것은 절차 · 주제 · 시스템 페이지로 합쳐집니다. 원본 업무 폴더는 건드리지
        않고, 모든 페이지는 Vault 의 <code>Wiki/</code> 폴더에 마크다운으로 있어 Obsidian
        그래프로도 볼 수 있습니다. 왼쪽에서 검색하거나 [AI에게 묻기] 로 과거 업무를 찾으세요.
      </div>
      {pages.length === 0 ? (
        <div style={{ ...hint, marginTop: 16 }}>
          아직 페이지가 없습니다. 업무를 [완료] 하면 자동으로 반영되고(설정에서 끌 수 있습니다),
          이미 보관된 업무는 왼쪽의 [모두 반영] 으로 한 번에 반영할 수 있습니다.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 24, marginTop: 18, flexWrap: "wrap" }}>
          <PageList title="절차" pages={procedures} onOpen={onOpen} />
          <PageList title="최근 갱신" pages={recent} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}

function PageList({
  title,
  pages,
  onOpen,
}: {
  title: string;
  pages: api.WikiPageMeta[];
  onOpen: (path: string) => void;
}) {
  if (!pages.length) return null;
  return (
    <div style={{ minWidth: 260, flex: 1, maxWidth: 420 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#6a665e", marginBottom: 6 }}>{title}</div>
      {pages.map((p) => (
        <Box
          key={p.path}
          onClick={() => onOpen(p.path)}
          style={{ padding: "5px 6px", borderRadius: 4, cursor: "pointer" }}
          hover={{ background: "#f2efe9" }}
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <KindChip kind={p.kind} />
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>{p.title}</span>
          </div>
          {p.summary && <div style={{ ...hint, fontSize: 11, marginTop: 1 }}>{p.summary}</div>}
        </Box>
      ))}
    </div>
  );
}

/**
 * AI 에게 묻기. 로컬 검색으로 페이지를 고르고 그 본문으로만 답하게 한다 — 인용한 페이지가
 * 칩으로 뜨고, 업무 소스면 바로 원본 업무로 갈 수 있다. 쓸 만한 답은 [위키에 저장] 으로
 * `answers/` 에 남긴다(카파시 패턴의 "답도 위키에 쌓인다").
 */
export function AskPanel({ onOpen }: { onOpen: (path: string) => void }) {
  const s = useStore();
  const ai = useAi();
  const info = routeInfo(ai, "wiki.query");
  // 셀렉터가 매번 새 배열을 내면 React 가 스냅샷이 불안정하다고 보고 렌더 루프에 빠진다.
  const pages = useWiki((w) => w.status?.pages ?? NO_PAGES);
  const refresh = useWiki((w) => w.refresh);
  const byId = useTaskById();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [partial, setPartial] = useState("");
  const [out, setOut] = useState<AskOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const ask = () => {
    const q = question.trim();
    if (!q || !info.run || busy) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setError(null);
    setOut(null);
    setSaved(null);
    setPartial("");
    setAsked(q);
    void askWiki({
      root: s.settings.vault,
      question: q,
      route: info.run,
      ai: { packs: ai.packs, settings: ai.settings },
      signal: ctl.signal,
      onPartial: setPartial,
    })
      .then(setOut)
      .catch((e) => {
        const msg = api.errMessage(e);
        if (msg !== CANCELED) setError(msg);
      })
      .finally(() => setBusy(false));
  };

  const save = () => {
    if (!out) return;
    const req = { root: s.settings.vault, question: asked, answer: out.answer, cited: out.cited };
    void fileAnswer(req)
      .then(async (r) => {
        const w = r.written[0];
        setSaved(w?.path ?? null);
        await refresh();
      })
      .catch((e) => s.fail(e, "위키에 저장하지 못했습니다"));
  };

  const text = out?.answer ?? partial;
  const blocks = useMemo(() => mdParse(text), [text]);
  const follow = (target: string) => {
    const hit = resolveLink(target, pages);
    if (hit) onOpen(hit.path);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "12px 14px",
          borderBottom: "1px solid #e6e2da",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <TextArea
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder="예: 배포 스크립트를 고쳤던 업무가 뭐였지? 그때 어떤 순서로 했어?"
          style={{
            width: "100%",
            boxSizing: "border-box",
            border: "1px solid #ddd8cf",
            borderRadius: 5,
            padding: "7px 9px",
            fontSize: 13,
            lineHeight: 1.6,
            resize: "vertical",
            outline: "none",
          }}
          focusStyle={{ borderColor: "#3a6fd8", boxShadow: "0 0 0 2px #e6eefc" }}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Box
            onClick={ask}
            style={{
              ...smallBtn,
              height: 26,
              border: `1px solid ${info.run && question.trim() && !busy ? "#d8cdf6" : "#e0dcd4"}`,
              background: info.run && question.trim() && !busy ? "#f4f0fd" : "#f7f5f1",
              color: info.run && question.trim() && !busy ? VIOLET : "#b5afa2",
              fontWeight: 600,
              cursor: info.run && question.trim() && !busy ? "pointer" : "default",
            }}
          >
            {busy ? "답하는 중…" : "AI에게 묻기 (Ctrl+Enter)"}
          </Box>
          {busy && (
            <Box
              style={smallBtn}
              hover={{ background: "#f2efe9" }}
              onClick={() => abort.current?.abort()}
            >
              취소
            </Box>
          )}
          <span style={{ ...hint, fontSize: 11, marginLeft: "auto" }}>
            {info.run
              ? `${info.name ?? info.run.agentId} · ${info.modelLabel}`
              : info.via === "route"
                ? `지정한 연결(${info.name})을 지금 쓸 수 없습니다`
                : "설정 → 기능별 AI 연결에서 연결을 고르세요"}
          </span>
        </div>
      </div>
      {error && <div style={{ ...hint, color: "#c04a4a", padding: "10px 14px" }}>{error}</div>}
      {out && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            alignItems: "center",
            padding: "6px 14px",
            borderBottom: "1px solid #f4f1ec",
          }}
        >
          <span style={{ ...hint, marginRight: 4 }}>
            {out.cited.length ? `인용 ${out.cited.length}` : `읽은 페이지 ${out.used.length}`}
          </span>
          {(out.cited.length ? out.cited : out.used).map((p) => {
            const task = p.taskId ? byId.get(p.taskId) : undefined;
            return (
              <span key={p.path} style={{ display: "inline-flex", gap: 2 }}>
                <Box
                  title={p.path}
                  onClick={() => onOpen(p.path)}
                  style={{
                    fontSize: 11.5,
                    border: "1px solid #e6e2da",
                    borderRadius: 4,
                    padding: "1px 7px",
                    background: "#fdfcfa",
                    color: "#2f5cbb",
                    cursor: "pointer",
                  }}
                  hover={{ borderColor: "#cddcf8" }}
                >
                  {p.title}
                </Box>
                {task && (
                  <Box
                    title="원본 업무 열기"
                    onClick={() => openTask(task)}
                    style={{
                      fontSize: 11,
                      border: "1px solid #e0d6f8",
                      borderRadius: 4,
                      padding: "1px 5px",
                      color: "#5a44b4",
                      cursor: "pointer",
                    }}
                    hover={{ background: "#f4f0fd" }}
                  >
                    업무 ↗
                  </Box>
                )}
              </span>
            );
          })}
          <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
            {saved ? (
              <Box style={{ ...smallBtn, color: "#256b47" }} onClick={() => onOpen(saved)}>
                저장됨 · 열기
              </Box>
            ) : (
              <Box style={smallBtn} hover={{ background: "#f2efe9" }} onClick={save}>
                위키에 저장
              </Box>
            )}
          </span>
        </div>
      )}
      {text ? (
        <WikiLinkContext.Provider value={wikiLinks(pages, follow)}>
          <MarkdownView blocks={blocks} />
        </WikiLinkContext.Provider>
      ) : (
        !error && (
          <div style={{ ...hint, padding: 14 }}>
            위키 페이지에 근거해서만 답합니다. 로컬 검색으로 관련 페이지를 골라 그 본문을 보내고,
            답에 인용된 페이지와 업무로 바로 갈 수 있습니다.
          </div>
        )
      )}
    </div>
  );
}

const LOCAL_LABEL: Record<string, string> = {
  "broken-link": "깨진 링크",
  orphan: "들어오는 링크 없음",
  "bare-index": "모호한 [[index]]",
  "no-summary": "요약 없음",
  "orphan-source": "원본 없는 소스",
  "moved-source": "옮겨진 업무",
  "stale-source": "반영 뒤 바뀐 업무",
  "stale-page": "근거보다 오래된 페이지",
};

const AI_LABEL: Record<AiLintIssue["kind"], string> = {
  contradiction: "모순",
  stale: "낡은 내용",
  "missing-page": "빠진 페이지",
  "missing-link": "빠진 링크",
  gap: "채울 빈칸",
};

/** 점검 — 기계적 문제(로컬)는 바로, 내용의 문제(모순 · 누락)는 AI 에게. 고치지는 않는다. */
export function LintPanel({ onOpen }: { onOpen: (path: string) => void }) {
  const s = useStore();
  const ai = useAi();
  const info = routeInfo(ai, "wiki.query");
  const status = useWiki((w) => w.status);
  const refresh = useWiki((w) => w.refresh);
  const enqueue = useWiki((w) => w.enqueue);
  const [local, setLocal] = useState<api.WikiLintIssue[] | null>(null);
  const [aiIssues, setAiIssues] = useState<AiLintIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { vault, archDays } = s.settings;

  const runLocal = () =>
    void api
      .wikiLintLocal(vault, archDays)
      .then(setLocal)
      .catch((e) => setError(api.errMessage(e)));

  useEffect(runLocal, [vault, archDays, status]);

  const runAi = () => {
    if (!info.run || busy) return;
    setBusy(true);
    setError(null);
    void aiLint({
      root: vault,
      route: info.run,
      ai: { packs: ai.packs, settings: ai.settings },
      localIssues: local ?? [],
    })
      .then(setAiIssues)
      .catch((e) => setError(api.errMessage(e)))
      .finally(() => setBusy(false));
  };

  const relink = () =>
    void api
      .wikiRelink(vault, archDays)
      .then(async (n) => {
        s.toast("소스 페이지 경로를 고쳤습니다", `${n}건`, "#5fbf8d");
        await refresh();
      })
      .catch((e) => s.fail(e, "경로를 고치지 못했습니다"));

  const byStem = (name: string) =>
    (status?.pages ?? NO_PAGES).find((p) => p.stem === name || p.title === name);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Box style={smallBtn} hover={{ background: "#f2efe9" }} onClick={runLocal}>
          다시 점검
        </Box>
        {(status?.moved.length ?? 0) > 0 && (
          <Box style={smallBtn} hover={{ background: "#f2efe9" }} onClick={relink}>
            옮겨진 업무 {status!.moved.length}건 경로 고치기
          </Box>
        )}
        <Box
          style={{
            ...smallBtn,
            color: info.run && !busy ? VIOLET : "#b5afa2",
            border: `1px solid ${info.run && !busy ? "#d8cdf6" : "#e0dcd4"}`,
            cursor: info.run && !busy ? "pointer" : "default",
          }}
          onClick={runAi}
        >
          {busy ? "AI 검토 중…" : "AI 검토 (모순 · 빠진 페이지)"}
        </Box>
        {!info.run && <span style={hint}>AI 검토에는 위키 질의 연결이 필요합니다</span>}
      </div>
      {error && <div style={{ ...hint, color: "#c04a4a" }}>{error}</div>}

      <section>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#6a665e", marginBottom: 6 }}>
          기계적 점검 {local ? `· ${local.length}건` : ""}
        </div>
        {local && local.length === 0 && <div style={hint}>문제가 없습니다.</div>}
        {local?.map((i, n) => {
          const stale = i.kind === "stale-source";
          const task = stale ? status?.tasks.find((t) => t.page === i.path) : undefined;
          return (
            <div
              key={n}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "baseline",
                padding: "4px 0",
                borderBottom: "1px solid #f4f1ec",
              }}
            >
              <span style={{ flex: "0 0 120px", fontSize: 11.5, color: "#8f5d17" }}>
                {LOCAL_LABEL[i.kind] ?? i.kind}
              </span>
              <Box
                style={{
                  flex: "0 0 auto",
                  fontSize: 11.5,
                  color: "#2f5cbb",
                  cursor: i.path ? "pointer" : "default",
                }}
                onClick={() => i.path && onOpen(i.path)}
              >
                {i.path.replace(/\.md$/, "")}
              </Box>
              <span style={{ ...hint, flex: 1 }}>{i.detail}</span>
              {task && (
                <Box
                  style={smallBtn}
                  hover={{ background: "#f2efe9" }}
                  onClick={() => enqueue(task.taskId, task.title)}
                >
                  다시 반영
                </Box>
              )}
            </div>
          );
        })}
      </section>

      {aiIssues && (
        <section>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6a665e", marginBottom: 6 }}>
            AI 검토 · {aiIssues.length}건
          </div>
          {aiIssues.length === 0 && <div style={hint}>AI 가 찾은 문제가 없습니다.</div>}
          {aiIssues.map((i, n) => (
            <div key={n} style={{ padding: "6px 0", borderBottom: "1px solid #f4f1ec" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11.5, color: VIOLET, fontWeight: 600 }}>
                  {AI_LABEL[i.kind]}
                </span>
                {i.pages.map((name) => {
                  const p = byStem(name);
                  return (
                    <Box
                      key={name}
                      onClick={() => p && onOpen(p.path)}
                      style={{
                        fontSize: 11.5,
                        color: p ? "#2f5cbb" : "#8a857c",
                        cursor: p ? "pointer" : "default",
                      }}
                    >
                      [[{p?.title ?? name}]]
                    </Box>
                  );
                })}
              </div>
              <div style={{ fontSize: 12.5, marginTop: 2 }}>{i.detail}</div>
              {i.suggestion && <div style={{ ...hint, marginTop: 1 }}>→ {i.suggestion}</div>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
