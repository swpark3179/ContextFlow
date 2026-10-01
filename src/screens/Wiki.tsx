import { useEffect, useMemo, useState } from "react";
import { Box, Input } from "../lib/ui";
import { VIOLET } from "../lib/design";
import { joinPath } from "../lib/format";
import * as api from "../lib/api";
import { reportObsidianOpen, useStore } from "../store/useStore";
import { routeInfo, useAi } from "../store/aiStore";
import { useWiki, type QueueItem } from "../store/wikiStore";
import { AskPanel, KIND_LABEL, KindChip, LintPanel, PagePanel, smallBtn } from "./wiki/WikiPanels";

type Tab = "page" | "ask" | "lint";

/** 분류 트리의 순서 — 색인(index.md)과 같다. 절차가 맨 앞이다. */
const ORDER: api.WikiKind[] = ["procedure", "topic", "entity", "source", "answer"];

const hint: React.CSSProperties = { fontSize: 11.5, color: "#8a857c", lineHeight: 1.6 };
const head: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: ".4px",
  color: "#8a857c",
  padding: "10px 12px 4px",
};

const STATE_LABEL: Record<QueueItem["state"], string> = {
  queued: "대기",
  running: "진행",
  done: "완료",
  failed: "실패",
  canceled: "취소",
};

const STATE_COLOR: Record<QueueItem["state"], string> = {
  queued: "#8a857c",
  running: VIOLET,
  done: "#2f7f57",
  failed: "#c04a4a",
  canceled: "#8a857c",
};

/**
 * LLM 위키 화면.
 *
 * 왼쪽은 찾는 곳(검색 · 분류 트리)과 반영을 다스리는 곳(대기 · 진행 · 기록), 오른쪽은 읽는
 * 곳(페이지 · AI 질의 · 점검)이다. 페이지는 마크다운 뷰어로 그리고 위키링크는 이 화면
 * 안에서 따라간다. 위키 자체는 Vault 의 `Wiki/` 폴더라 Obsidian 에서도 그대로 열린다.
 */
export default function Wiki() {
  const s = useStore();
  const w = useWiki();
  const ai = useAi();
  const { vault } = s.settings;
  const [tab, setTab] = useState<Tab>("page");
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<api.WikiHit[] | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    source: true,
    answer: true,
  });

  // 화면에 들어올 때 위키 폴더를 마련하고(씨앗은 없을 때만) 상태를 다시 읽는다.
  useEffect(() => {
    if (!vault) return;
    void api
      .wikiInit(vault)
      .then(() => useWiki.getState().refresh())
      .catch((e) => useStore.getState().fail(e, "위키 폴더를 만들지 못했습니다"));
  }, [vault]);

  // 검색은 로컬이라 즉시지만, 글자마다 파일을 훑지 않게 잠깐 모은다.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      void api
        .wikiSearch(vault, q, 30)
        .then((r) => alive && setHits(r))
        .catch(() => alive && setHits([]));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [query, vault, w.status]);

  const pages = w.status?.pages ?? [];
  const grouped = useMemo(() => {
    const g: Record<string, api.WikiPageMeta[]> = {};
    for (const p of pages) (g[p.kind] ??= []).push(p);
    for (const k of Object.keys(g)) g[k]!.sort((a, b) => a.title.localeCompare(b.title, "ko"));
    return g;
  }, [pages]);

  const pending = (w.status?.tasks ?? []).filter((t) => t.state !== "fresh");
  const ingest = routeInfo(ai, "wiki.ingest");
  const active = w.queue.filter((q) => q.state === "queued" || q.state === "running");
  const finished = w.queue.filter((q) => q.state !== "queued" && q.state !== "running");
  const canIngest = !!ingest.run && pending.length > 0;
  const depthText =
    s.settings.wikiDepth === "full"
      ? `관련 페이지 최대 ${s.settings.wikiMaxPages}장`
      : "소스 페이지만";

  const openPage = (path: string) => {
    setOpen(path);
    setTab("page");
  };

  const openInObsidian = (rel: string) =>
    void api
      .openInObsidian(vault, joinPath(vault, rel))
      .then(reportObsidianOpen)
      .catch((e) => s.fail(e, "Obsidian 에서 열지 못했습니다"));

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", background: "#fff" }}>
      {/* ── 왼쪽: 찾기 · 반영 ─────────────────────────────────────────── */}
      <div
        style={{
          flex: "0 0 300px",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid #e6e2da",
          background: "#fbfaf7",
        }}
      >
        <div style={{ padding: "12px 12px 8px", borderBottom: "1px solid #ece8e0" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>LLM 위키</span>
            <span style={{ ...hint, fontSize: 11 }}>
              {pages.length}페이지 · 업무 {grouped.source?.length ?? 0}건
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <Box
                title="Wiki/index.md 를 Obsidian 에서 엽니다"
                style={{ ...smallBtn, height: 22, padding: "0 7px" }}
                hover={{ background: "#f2efe9" }}
                onClick={() => openInObsidian("Wiki/index.md")}
              >
                Obsidian
              </Box>
              <Box
                title="탐색기에서 Wiki 폴더를 엽니다"
                style={{ ...smallBtn, height: 22, padding: "0 7px" }}
                hover={{ background: "#f2efe9" }}
                onClick={() => void api.revealPath(joinPath(vault, "Wiki")).catch(() => {})}
              >
                폴더
              </Box>
            </span>
          </div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="위키 검색 — 제목 · 요약 · 본문"
            style={{
              marginTop: 8,
              width: "100%",
              boxSizing: "border-box",
              height: 28,
              border: "1px solid #ddd8cf",
              borderRadius: 5,
              padding: "0 9px",
              fontSize: 12.5,
              outline: "none",
              background: "#fff",
            }}
            focusStyle={{ borderColor: "#3a6fd8", boxShadow: "0 0 0 2px #e6eefc" }}
          />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {hits ? (
            <>
              <div style={head}>검색 결과 {hits.length}</div>
              {hits.length === 0 && (
                <div style={{ ...hint, padding: "0 12px" }}>찾지 못했습니다.</div>
              )}
              {hits.map((h) => (
                <Box
                  key={h.path}
                  onClick={() => openPage(h.path)}
                  style={{
                    padding: "6px 12px",
                    cursor: "pointer",
                    background: open === h.path ? "#eef3fd" : "transparent",
                  }}
                  hover={{ background: open === h.path ? "#eef3fd" : "#f2efe9" }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <KindChip kind={h.kind} />
                    <span style={{ fontSize: 12.5, fontWeight: 500, minWidth: 0 }}>{h.title}</span>
                  </div>
                  <div style={{ ...hint, fontSize: 11, marginTop: 2 }}>{h.snippet}</div>
                </Box>
              ))}
            </>
          ) : (
            ORDER.filter((k) => grouped[k]?.length).map((k) => (
              <div key={k}>
                <Box
                  onClick={() => setCollapsed((c) => ({ ...c, [k]: !c[k] }))}
                  style={{ ...head, display: "flex", gap: 6, cursor: "pointer" }}
                >
                  <span style={{ width: 8 }}>{collapsed[k] ? "▸" : "▾"}</span>
                  <span>{KIND_LABEL[k]}</span>
                  <span style={{ fontWeight: 400 }}>{grouped[k]!.length}</span>
                </Box>
                {!collapsed[k] &&
                  grouped[k]!.map((p) => (
                    <Box
                      key={p.path}
                      title={p.summary}
                      onClick={() => openPage(p.path)}
                      style={{
                        padding: "3px 12px 3px 26px",
                        fontSize: 12.5,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        background: open === p.path ? "#eef3fd" : "transparent",
                        color: open === p.path ? "#2f5cbb" : "#23211e",
                      }}
                      hover={{ background: open === p.path ? "#eef3fd" : "#f2efe9" }}
                    >
                      {p.title}
                    </Box>
                  ))}
              </div>
            ))
          )}
          {!hits && pages.length === 0 && (
            <div style={{ ...hint, padding: "10px 12px" }}>아직 위키 페이지가 없습니다.</div>
          )}
        </div>

        {/* ── 반영 ─────────────────────────────────────────────────────── */}
        <div
          style={{
            borderTop: "1px solid #ece8e0",
            maxHeight: "42%",
            overflow: "auto",
            flex: "0 0 auto",
          }}
        >
          <div style={{ ...head, display: "flex", alignItems: "center", gap: 6 }}>
            <span>반영</span>
            {w.running && (
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: VIOLET }} />
            )}
            <span style={{ fontWeight: 400 }}>대기 {pending.length}</span>
          </div>
          <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <Box
                title={pending.map((t) => t.title).join("\n")}
                style={{
                  ...smallBtn,
                  color: canIngest ? VIOLET : "#b5afa2",
                  borderColor: canIngest ? "#d8cdf6" : "#e0dcd4",
                  cursor: canIngest ? "pointer" : "default",
                  fontWeight: 600,
                }}
                onClick={() => {
                  if (canIngest) w.enqueuePending();
                }}
              >
                모두 반영 ({pending.length})
              </Box>
              {w.running && (
                <Box style={smallBtn} hover={{ background: "#f2efe9" }} onClick={() => w.cancel()}>
                  취소
                </Box>
              )}
              {finished.length > 0 && !w.running && (
                <Box
                  style={smallBtn}
                  hover={{ background: "#f2efe9" }}
                  onClick={() => w.clearFinished()}
                >
                  결과 지우기
                </Box>
              )}
            </div>
            <div style={{ ...hint, fontSize: 11 }}>
              {ingest.run
                ? `${ingest.name} · ${ingest.run.model} · ${depthText}`
                : ingest.via === "route"
                  ? `지정한 반영 연결(${ingest.name})을 지금 쓸 수 없습니다`
                  : "반영에 쓸 AI 연결이 없습니다 — 설정 → 기능별 AI 연결"}
            </div>
            {[...active, ...finished].map((q) => (
              <div key={q.taskId} style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                <span style={{ color: STATE_COLOR[q.state], marginRight: 6 }}>
                  {STATE_LABEL[q.state]}
                </span>
                <span>{q.title}</span>
                {q.state === "running" && q.step && (
                  <span style={{ color: "#8a857c" }}> · {q.step}</span>
                )}
                {q.state === "done" && (
                  <span style={{ color: "#8a857c" }}> · 페이지 {q.written ?? 0}장</span>
                )}
                {q.state === "failed" && (
                  <div style={{ color: "#c04a4a", fontSize: 11, display: "flex", gap: 6 }}>
                    <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{q.error}</span>
                    <Box
                      style={{ color: "#2f5cbb", cursor: "pointer", flex: "0 0 auto" }}
                      onClick={() => w.enqueue(q.taskId, q.title)}
                    >
                      다시
                    </Box>
                  </div>
                )}
              </div>
            ))}
            {(w.status?.logTail.length ?? 0) > 0 && (
              <div style={{ marginTop: 4 }}>
                <div style={{ ...hint, fontSize: 11, fontWeight: 600 }}>최근 기록</div>
                {w.status!.logTail.slice(0, 5).map((l, i) => (
                  <div
                    key={i}
                    title={l}
                    style={{
                      ...hint,
                      fontSize: 11,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {l}
                  </div>
                ))}
              </div>
            )}
            {w.error && <div style={{ ...hint, color: "#c04a4a" }}>{w.error}</div>}
          </div>
        </div>
      </div>

      {/* ── 오른쪽: 읽기 ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            gap: 2,
            padding: "6px 10px 0",
            borderBottom: "1px solid #e6e2da",
            background: "#fff",
          }}
        >
          {(
            [
              ["page", "페이지"],
              ["ask", "AI에게 묻기"],
              ["lint", "점검"],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <Box
              key={k}
              onClick={() => setTab(k)}
              style={{
                padding: "5px 12px 6px",
                fontSize: 12.5,
                cursor: "pointer",
                borderBottom: `2px solid ${tab === k ? "#3a6fd8" : "transparent"}`,
                color: tab === k ? "#23211e" : "#8a857c",
                fontWeight: tab === k ? 600 : 400,
                marginBottom: -1,
              }}
            >
              {label}
            </Box>
          ))}
          {tab === "page" && open && (
            <Box
              onClick={() => setOpen(null)}
              style={{
                marginLeft: "auto",
                alignSelf: "center",
                fontSize: 11.5,
                color: "#8a857c",
                cursor: "pointer",
                padding: "0 6px",
              }}
            >
              처음으로
            </Box>
          )}
        </div>
        {tab === "page" && <PagePanel path={open} onOpen={openPage} />}
        {tab === "ask" && <AskPanel onOpen={openPage} />}
        {tab === "lint" && <LintPanel onOpen={openPage} />}
      </div>
    </div>
  );
}
