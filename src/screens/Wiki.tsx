import { useEffect, useMemo, useState } from "react";
import { Box, Input, Select } from "../lib/ui";
import { VIOLET } from "../lib/design";
import { joinPath } from "../lib/format";
import * as api from "../lib/api";
import { narrowHits, wikiCategoryView } from "../lib/wiki/categories";
import { openCategoryHub, reportObsidianOpen, useStore } from "../store/useStore";
import { routeInfo, useAi } from "../store/aiStore";
import { useWiki, type QueueItem } from "../store/wikiStore";
import { AskPanel } from "./wiki/AskPanel";
import {
  catLabel,
  KIND_LABEL,
  KindChip,
  LintPanel,
  NO_PAGES,
  PagePanel,
  smallBtn,
} from "./wiki/WikiPanels";

type Tab = "page" | "ask" | "lint";

/** 분류 트리의 순서 — 색인(index.md)과 같다. 절차가 맨 앞이다. */
const ORDER: api.WikiKind[] = ["procedure", "topic", "entity", "source", "answer"];

/** 검색 결과를 보이는 최대 건수. */
const HIT_MAX = 30;

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

  // 화면에 들어왔다 — 도크의 `+N 반영` 은 여기서 지운다.
  useEffect(() => useWiki.getState().seenFresh(), []);

  // 화면에 들어올 때 위키 폴더를 마련하고(씨앗은 없을 때만) 상태를 다시 읽는다.
  useEffect(() => {
    if (!vault) return;
    void api
      .wikiInit(vault)
      .then(() => useWiki.getState().refresh())
      .catch((e) => useStore.getState().fail(e, "위키 폴더를 만들지 못했습니다"));
  }, [vault]);

  // 안정된 빈 목록 — 상태를 읽기 전에도 아래 메모가 렌더마다 다시 돌지 않게.
  const pages = w.status?.pages ?? NO_PAGES;
  /**
   * 카테고리 거르기. 업무 카테고리를 그때그때 보므로, 업무 카테고리를 바꾸면 위키 상태를 다시
   * 읽지 않아도 목록 · 개수 · 칩이 바로 따라간다.
   */
  const cats = useMemo(
    () => wikiCategoryView(s.tasks, pages, s.wikiCat),
    [s.tasks, pages, s.wikiCat],
  );
  const filtering = cats.effCat !== null;
  /** 카테고리 고르기가 보이는가 — 카테고리를 쓰지 않는 Vault 는 지금 화면 그대로다. */
  const pickable = cats.hasCats || filtering;
  // 고른 카테고리에 페이지가 없어지면(업무 카테고리 변경 · 페이지 삭제) 고른 값도 지운다 — 쥐고
  // 있으면 그 카테고리에 페이지가 다시 생길 때 아무것도 하지 않았는데 거르기가 되살아난다(보관함과
  // 같다). 상태를 읽기 전에는 모든 키가 0페이지라 지우지 않는다.
  useEffect(() => {
    if (s.wikiCat !== null && cats.effCat === null && w.status) s.set({ wikiCat: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.wikiCat, cats.effCat, w.status]);

  // 검색은 로컬이라 즉시지만, 글자마다 파일을 훑지 않게 잠깐 모은다. 카테고리를 고를 수 있는
  // Vault 에서는 늘 모두 받아 렌더에서 거른다 — 30건만 받아 거르면 그 카테고리의 결과가 앞의 다른
  // 결과에 밀려 사라지고, 거르기를 켤 때 다시 받는다면 받기 전까지 낡은 30건을 걸러 "찾지 못했습니다"
  // 가 잠깐 잘못 뜬다. 거르지 않을 때는 `narrowHits` 가 30건으로 자른다. 그래서 거르기를 켜고 끄거나
  // 다른 카테고리로 바꿔도 다시 받지 않는다.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let alive = true;
    const limit = pickable ? Math.max(HIT_MAX, pages.length) : HIT_MAX;
    const t = window.setTimeout(() => {
      void api
        .wikiSearch(vault, q, limit)
        .then((r) => alive && setHits(r))
        .catch(() => alive && setHits([]));
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // pages 는 w.status 에서 나온다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, vault, w.status, pickable]);
  /** 거르는 중이면 그 카테고리의 결과만, 거른 뒤에 자른다. `검색 결과 n` 도 이 수다. */
  const shownHits = useMemo(
    () => hits && narrowHits(hits, filtering ? cats.shown.map((p) => p.path) : null, HIT_MAX),
    [hits, filtering, cats.shown],
  );

  const grouped = useMemo(() => {
    const g: Record<string, api.WikiPageMeta[]> = {};
    for (const p of cats.shown) (g[p.kind] ??= []).push(p);
    for (const k of Object.keys(g)) g[k]!.sort((a, b) => a.title.localeCompare(b.title, "ko"));
    return g;
  }, [cats.shown]);

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
  const catName = catLabel(cats);

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
              {cats.shown.length}페이지 · 업무 {grouped.source?.length ?? 0}건
            </span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              {/*
                거르는 중이면 그 카테고리의 허브를 연다. 미분류도 안전하다 — 미분류 페이지가 있으면
                미분류 업무가 있고, 그러면 미분류 허브도 있다.
              */}
              <Box
                title={
                  cats.effCat === null
                    ? "Wiki/index.md 를 Obsidian 에서 엽니다"
                    : `‘${catName}’ 허브를 Obsidian 에서 엽니다`
                }
                style={{ ...smallBtn, height: 22, padding: "0 7px" }}
                hover={{ background: "#f2efe9" }}
                onClick={() =>
                  cats.effCat === null
                    ? openInObsidian("Wiki/index.md")
                    : void openCategoryHub(cats.effCat)
                }
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
          {/*
            제목 줄은 이미 폭이 찼으므로 한 줄을 따로 둔다. 카테고리를 쓰지 않는 Vault 에는 거를
            것이 없다 — 지금 화면 그대로. 미분류만 남았는데 미분류를 고른 채라면(카테고리 관리에서
            모두 미분류로) 전체로 돌아갈 길이 있어야 하므로 그때도 그린다.
          */}
          {pickable && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
              <span style={{ fontSize: 11, color: "#a09a8f" }}>카테고리</span>
              <Select
                // `*` 는 카테고리에 쓸 수 없는 글자라 어떤 키와도 겹치지 않는다.
                value={cats.effCat ?? "*"}
                onChange={(e) => s.set({ wikiCat: e.target.value === "*" ? null : e.target.value })}
                title="카테고리로 거르기 — 괄호는 위키 페이지 수(하위 포함)"
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 24,
                  padding: "0 4px",
                  border: "1px solid #ddd8cf",
                  borderRadius: 4,
                  background: "#fff",
                  color: "#4e4a43",
                  fontSize: 11.5,
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value="*">전체 ({pages.length})</option>
                {cats.opts.map((o) => (
                  // option 은 앞의 ASCII 공백을 지우므로 들여쓰기는 NBSP 로. 미분류는 맨 끝이다.
                  <option key={o.key} value={o.key}>
                    {`${"\u00a0\u00a0".repeat(o.depth - 1)}${o.name} (${o.count})`}
                  </option>
                ))}
              </Select>
            </div>
          )}
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
          {shownHits ? (
            <>
              <div style={head}>검색 결과 {shownHits.length}</div>
              {shownHits.length === 0 &&
                // 전체에서도 없으면 [전체에서 찾기] 는 거르기만 풀고 같은 빈 결과를 보인다.
                (filtering && hits!.length > 0 ? (
                  <div style={{ ...hint, padding: "0 12px" }}>
                    <div>이 카테고리에서 찾지 못했습니다.</div>
                    <Box
                      onClick={() => s.set({ wikiCat: null })}
                      style={{ ...smallBtn, display: "inline-flex", marginTop: 6 }}
                      hover={{ background: "#f2efe9" }}
                    >
                      전체에서 찾기
                    </Box>
                  </div>
                ) : (
                  <div style={{ ...hint, padding: "0 12px" }}>찾지 못했습니다.</div>
                ))}
              {shownHits.map((h) => (
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
          {!shownHits && pages.length === 0 && (
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
                  border: `1px solid ${canIngest ? "#d8cdf6" : "#e0dcd4"}`,
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
                ? `${ingest.name} · ${ingest.modelLabel} · ${depthText}`
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
        {tab === "page" && <PagePanel path={open} onOpen={openPage} cats={cats} />}
        {/*
          묻기 패널은 다른 탭에서도 내리지 않는다 — 대화가 이 패널의 상태라서, 인용 칩을 눌러
          페이지를 읽으러 가는 순간 대화가 사라지면 이어서 물을 수 없다. 받는 중인 답도 그대로
          흘러 들어온다. 위키 화면을 떠나면(다른 화면) 이 화면째 내려가며 대화도 끝난다.
        */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: tab === "ask" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <AskPanel onOpen={openPage} cats={cats} />
        </div>
        {tab === "lint" && <LintPanel onOpen={openPage} />}
      </div>
    </div>
  );
}
