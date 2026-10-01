import { useEffect, useMemo, useRef, useState } from "react";
import { Box, TextArea } from "../../lib/ui";
import { VIOLET } from "../../lib/design";
import { mdParse } from "../../lib/markdown";
import * as api from "../../lib/api";
import { CANCELED } from "../../lib/runOnce";
import { resolveLink } from "../../lib/wiki/links";
import { askWiki, fileAnswer, type AskOutcome } from "../../lib/wiki/pipeline";
import MarkdownView, { WikiLinkContext } from "../../components/MarkdownView";
import { useStore } from "../../store/useStore";
import { routeInfo, useAi } from "../../store/aiStore";
import { useWiki } from "../../store/wikiStore";
import { NO_PAGES, openTask, smallBtn, useTaskById, wikiLinks } from "./WikiPanels";

const hint: React.CSSProperties = { fontSize: 11.5, color: "#8a857c", lineHeight: 1.6 };

/** 대화 한 턴 — 질문 하나와 그 답. */
interface Turn {
  id: number;
  question: string;
  /** 받는 중이면 지금까지의 글, 끝났으면 답 전체. */
  text: string;
  state: "running" | "done" | "failed" | "canceled";
  /** 진행 단계 한 줄. */
  step: string;
  error?: string;
  out?: AskOutcome;
  /** [위키에 저장] 한 페이지 경로. */
  saved?: string;
}

/**
 * AI 에게 묻기 — 위키를 근거로 한 대화.
 *
 * 로컬 검색으로 페이지를 고르고 그 본문으로만 답하게 한다. 인용한 페이지가 칩으로 뜨고, 업무
 * 소스면 바로 원본 업무로 갈 수 있다. 쓸 만한 답은 턴마다 [위키에 저장] 으로 `answers/` 에
 * 남긴다(카파시 패턴의 "답도 위키에 쌓인다").
 *
 * **대화는 하나만, 화면에 있는 동안만 이어진다.** 대화는 이 컴포넌트의 상태이고, 위키 화면은
 * 탭을 옮겨도 이 패널을 내리지 않는다(`Wiki.tsx`) — 인용 칩을 눌러 페이지를 읽고 돌아와도
 * 이어서 물을 수 있다. 다른 화면으로 가면 위키 화면이 내려가며 대화도 끝난다. 처음부터 다시
 * 묻고 싶으면 [대화 초기화].
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
  const [turns, setTurns] = useState<Turn[]>([]);
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  /** 사용자가 맨 아래를 보고 있는가 — 위로 올려 읽는 중에는 새 글이 와도 끌어내리지 않는다. */
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const busy = turns.some((t) => t.state === "running");
  const canAsk = !!info.run && !!question.trim() && !busy;

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const patch = (id: number, p: Partial<Turn>) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));

  const ask = () => {
    const q = question.trim();
    if (!q || !info.run || busy) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    // 이력은 끝난 턴만 — 실패 · 취소한 질문은 맥락이 되지 못한다.
    const done = turns.filter((t) => t.state === "done" && t.out);
    const history = done.map((t) => ({ question: t.question, answer: t.out!.answer }));
    const carry = done[done.length - 1]?.out?.cited.map((p) => p.path) ?? [];
    const id = ++seq.current;
    stick.current = true;
    setTurns((ts) => [...ts, { id, question: q, text: "", state: "running", step: "위키에서 찾는 중" }]);
    setQuestion("");
    void askWiki({
      root: s.settings.vault,
      question: q,
      route: info.run,
      ai: { packs: ai.packs, settings: ai.settings },
      history,
      carry,
      signal: ctl.signal,
      onPartial: (text) => patch(id, { text, step: "" }),
    })
      .then((out) => patch(id, { state: "done", text: out.answer, out, step: "" }))
      .catch((e) => {
        const msg = api.errMessage(e);
        patch(id, msg === CANCELED ? { state: "canceled", step: "" } : { state: "failed", step: "", error: msg });
      });
  };

  const reset = () => {
    abort.current?.abort();
    abort.current = null;
    setTurns([]);
    setQuestion("");
    input.current?.focus();
  };

  const save = (turn: Turn) => {
    if (!turn.out) return;
    const before = turns
      .filter((t) => t.id < turn.id && t.state === "done")
      .map((t) => t.question);
    void fileAnswer({
      root: s.settings.vault,
      question: turn.question,
      answer: turn.out.answer,
      cited: turn.out.cited,
      context: before,
    })
      .then(async (r) => {
        const w = r.written[0];
        if (w) patch(turn.id, { saved: w.path });
        await refresh();
      })
      .catch((e) => s.fail(e, "위키에 저장하지 못했습니다"));
  };

  const follow = (target: string) => {
    const hit = resolveLink(target, pages);
    if (hit) onOpen(hit.path);
  };
  const links = wikiLinks(pages, follow);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 20px 20px" }}
      >
        {turns.length === 0 ? (
          <div style={{ ...hint, maxWidth: 640 }}>
            위키 페이지에 근거해서만 답합니다. 로컬 검색으로 관련 페이지를 골라 그 본문을 보내고,
            답에 인용된 페이지와 업무로 바로 갈 수 있습니다. 답을 받은 뒤 이어서 물으면 앞선
            대화를 맥락으로 함께 보냅니다 — 위키 화면을 떠나거나 [대화 초기화] 를 누를 때까지.
          </div>
        ) : (
          <WikiLinkContext.Provider value={links}>
            {turns.map((t, n) => (
              <TurnView
                key={t.id}
                turn={t}
                first={n === 0}
                byId={byId}
                onOpen={onOpen}
                onSave={() => save(t)}
                onRetry={() => {
                  setQuestion(t.question);
                  input.current?.focus();
                }}
              />
            ))}
          </WikiLinkContext.Provider>
        )}
      </div>

      <div
        style={{
          flex: "0 0 auto",
          borderTop: "1px solid #e6e2da",
          padding: "10px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          background: "#fff",
        }}
      >
        <TextArea
          ref={input}
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder={
            turns.some((t) => t.state === "done")
              ? "이어서 묻기 — 예: 그때 두 번째 단계는 뭐였어?"
              : "예: 배포 스크립트를 고쳤던 업무가 뭐였지? 그때 어떤 순서로 했어?"
          }
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
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Box
            onClick={ask}
            style={{
              ...smallBtn,
              height: 26,
              border: `1px solid ${canAsk ? "#d8cdf6" : "#e0dcd4"}`,
              background: canAsk ? "#f4f0fd" : "#f7f5f1",
              color: canAsk ? VIOLET : "#b5afa2",
              fontWeight: 600,
              cursor: canAsk ? "pointer" : "default",
            }}
          >
            {busy ? "답하는 중…" : turns.length ? "이어서 묻기 (Ctrl+Enter)" : "AI에게 묻기 (Ctrl+Enter)"}
          </Box>
          {busy && (
            <Box style={smallBtn} hover={{ background: "#f2efe9" }} onClick={() => abort.current?.abort()}>
              취소
            </Box>
          )}
          {turns.length > 0 && (
            <Box
              title="지금까지의 대화를 지우고 처음부터 묻습니다"
              style={smallBtn}
              hover={{ background: "#f2efe9" }}
              onClick={reset}
            >
              대화 초기화
            </Box>
          )}
          <span style={{ ...hint, fontSize: 11, marginLeft: "auto" }}>
            {turns.length > 0 && `대화 ${turns.length}턴 · `}
            {info.run
              ? `${info.name ?? info.run.agentId} · ${info.modelLabel}`
              : info.via === "route"
                ? `지정한 연결(${info.name})을 지금 쓸 수 없습니다`
                : "설정 → 기능별 AI 연결에서 연결을 고르세요"}
          </span>
        </div>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  first,
  byId,
  onOpen,
  onSave,
  onRetry,
}: {
  turn: Turn;
  first: boolean;
  byId: Map<string, api.TaskMeta>;
  onOpen: (path: string) => void;
  onSave: () => void;
  onRetry: () => void;
}) {
  const blocks = useMemo(() => mdParse(turn.text), [turn.text]);
  const out = turn.out;
  const shown = out ? (out.cited.length ? out.cited : out.used) : [];
  return (
    <div style={{ marginTop: first ? 0 : 22 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          background: "#f7f5f1",
          border: "1px solid #ece8e0",
          borderRadius: 6,
          padding: "7px 10px",
          marginBottom: 10,
          maxWidth: 860,
          boxSizing: "border-box",
        }}
      >
        <span style={{ flex: "0 0 auto", fontSize: 11, fontWeight: 600, color: VIOLET }}>질문</span>
        <span style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {turn.question}
        </span>
      </div>

      {turn.text && <MarkdownView blocks={blocks} inline />}

      {turn.state === "running" && (
        <div style={{ ...hint, display: "flex", alignItems: "center", gap: 6, marginTop: turn.text ? 6 : 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: VIOLET }} />
          {turn.step || "답하는 중…"}
        </div>
      )}
      {turn.state === "failed" && (
        <div style={{ ...hint, color: "#c04a4a", display: "flex", gap: 8, marginTop: 6 }}>
          <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
            {turn.error}
          </span>
          <Box style={{ color: "#2f5cbb", cursor: "pointer", flex: "0 0 auto" }} onClick={onRetry}>
            다시 묻기
          </Box>
        </div>
      )}
      {turn.state === "canceled" && <div style={{ ...hint, marginTop: 6 }}>취소했습니다</div>}

      {out && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            alignItems: "center",
            marginTop: 10,
            paddingTop: 8,
            borderTop: "1px dashed #eae6de",
            maxWidth: 860,
          }}
        >
          <span style={{ ...hint, marginRight: 4 }}>
            {out.cited.length ? `인용 ${out.cited.length}` : `읽은 페이지 ${out.used.length}`}
          </span>
          {shown.map((p) => {
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
          <span style={{ marginLeft: "auto" }}>
            {turn.saved ? (
              <Box style={{ ...smallBtn, color: "#256b47" }} onClick={() => onOpen(turn.saved!)}>
                저장됨 · 열기
              </Box>
            ) : (
              <Box style={smallBtn} hover={{ background: "#f2efe9" }} onClick={onSave}>
                위키에 저장
              </Box>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
