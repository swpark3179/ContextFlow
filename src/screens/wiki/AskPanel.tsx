import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Select, TextArea } from "../../lib/ui";
import { VIOLET } from "../../lib/design";
import { mdParse } from "../../lib/markdown";
import * as api from "../../lib/api";
import { CANCELED } from "../../lib/runOnce";
import { askScope } from "../../lib/wiki/categories";
import { resolveLink } from "../../lib/wiki/links";
import { askWiki, fileAnswer, type AskOutcome } from "../../lib/wiki/pipeline";
import { inlineWebRefs, type WebSource } from "../../lib/wiki/web";
import MarkdownView, { WikiLinkContext } from "../../components/MarkdownView";
import { browserOptions, useStore } from "../../store/useStore";
import { routeInfo, useAi } from "../../store/aiStore";
import { useWiki } from "../../store/wikiStore";
import { catLabel, NO_PAGES, openTask, smallBtn, useTaskById, wikiLinks, type WikiCats } from "./WikiPanels";

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
  /** 이 질문을 한정한 카테고리의 표시 이름(`a › b`). 전체에서 물었으면 `null`. */
  scope: string | null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

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
 *
 * [웹 검색] 을 켜 두면 위키만으로 답할 수 없을 때 AI 가 PC 의 브라우저로 웹을 찾는다
 * (`lib/wiki/web.ts`). 찾은 페이지는 "웹 검색" 연결의 모델이 먼저 추리고, 답에 `[웹n]` 으로
 * 인용된 출처가 칩으로 뜬다 — 누르면 사용자의 기본 브라우저로 연다.
 *
 * [범위] 로 카테고리를 고르면 그 카테고리(하위 포함)의 페이지만 근거로 찾는다(`askWiki` 의 `scope`).
 * 고르지 않았으면 왼쪽의 카테고리 거르기를 따르다가, 질문하는 순간 그 범위로 고정한다(스토어
 * `askCat`) — 대화 중에 페이지 칩을 눌러 화면 거르기가 바뀌어도 대화의 범위가 몰래 바뀌지 않게.
 * 고정은 [대화 초기화] · 위키 화면을 떠날 때 풀린다. `cats` 는 위키 화면이 만든 카테고리 계산이다.
 */
export function AskPanel({ onOpen, cats }: { onOpen: (path: string) => void; cats: WikiCats }) {
  const s = useStore();
  const ai = useAi();
  const info = routeInfo(ai, "wiki.query");
  const webInfo = routeInfo(ai, "wiki.web");
  const webOn = s.settings.webSearch;
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
  useEffect(
    () => () => {
      abort.current?.abort();
      // 대화가 이 패널과 함께 끝나므로 고정한 범위도 푼다.
      useStore.getState().set({ askCat: null });
    },
    [],
  );

  /**
   * 유효 범위 — 고정했으면 그 키, 아니면 화면 거르기. 렌더에서 계산할 뿐 스토어에 되쓰지 않으므로
   * (effect 없음) 둘이 서로를 부르는 루프가 없다. 페이지가 없는 키면 전체(`null`)다.
   */
  const scope = askScope(s.askCat ? s.askCat.key : cats.effCat, cats.counts);
  /** 범위 고르기가 보이는가 — 위키 화면의 카테고리 고르기와 같은 규칙. */
  const pickable = cats.hasCats || scope !== null;

  const busy = turns.some((t) => t.state === "running");
  const canAsk = !!info.run && !!question.trim() && !busy;

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const patch = (id: number, p: Partial<Turn>) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...p } : t)));
  /**
   * 도는 턴에만 반영한다. [취소] 는 턴을 그 자리에서 끝내는데, 브라우저가 페이지를 여는 중이면
   * 그 한 장이 끝날 때까지(최대 몇십 초) 결과가 뒤늦게 올 수 있다 — 끝난 턴을 되살리지 않는다.
   */
  const live = (id: number, p: Partial<Turn>) =>
    setTurns((ts) => ts.map((t) => (t.id === id && t.state === "running" ? { ...t, ...p } : t)));

  const cancel = () => {
    abort.current?.abort();
    setTurns((ts) => ts.map((t) => (t.state === "running" ? { ...t, state: "canceled", step: "" } : t)));
  };

  const ask = () => {
    const q = question.trim();
    if (!q || !info.run || busy) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    // 이력은 끝난 턴만 — 실패 · 취소한 질문은 맥락이 되지 못한다.
    const done = turns.filter((t) => t.state === "done" && t.out);
    const history = done.map((t) => ({
      question: t.question,
      answer: inlineWebRefs(t.out!.answer, [...t.out!.webCited, ...t.out!.webUsed]),
    }));
    const carry = done[done.length - 1]?.out?.cited.map((p) => p.path) ?? [];
    // 따라가던 범위는 이 질문에서 고정한다 — 다음 질문도 같은 범위다.
    if (s.askCat === null) s.set({ askCat: { key: scope } });
    const name = catLabel(cats, scope);
    const range = scope === null || name === null ? null : { key: scope, label: name, tasks: s.tasks };
    const id = ++seq.current;
    stick.current = true;
    setTurns((ts) => [
      ...ts,
      { id, question: q, text: "", state: "running", step: "위키에서 찾는 중", scope: name },
    ]);
    setQuestion("");
    const web =
      webOn && webInfo.run
        ? { route: webInfo.run, browser: browserOptions(s.settings), pages: s.settings.webPages }
        : null;
    void askWiki({
      root: s.settings.vault,
      question: q,
      route: info.run,
      ai: { packs: ai.packs, settings: ai.settings },
      history,
      carry,
      web,
      scope: range,
      signal: ctl.signal,
      onPartial: (text) => live(id, { text, step: "" }),
      onStep: (step) => live(id, { step }),
    })
      .then((out) => live(id, { state: "done", text: out.answer, out, step: "" }))
      .catch((e) => {
        const msg = api.errMessage(e);
        live(id, msg === CANCELED ? { state: "canceled", step: "" } : { state: "failed", step: "", error: msg });
      });
  };

  const reset = () => {
    abort.current?.abort();
    abort.current = null;
    setTurns([]);
    setQuestion("");
    // 새 대화는 다시 화면 거르기를 따른다.
    s.set({ askCat: null });
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
      web: turn.out.webCited.length ? turn.out.webCited : turn.out.webUsed,
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
            <Box style={smallBtn} hover={{ background: "#f2efe9" }} onClick={cancel}>
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
          <Box
            role="switch"
            aria-checked={webOn}
            title={
              webOn
                ? "위키만으로 답할 수 없으면 AI 가 PC 의 브라우저로 웹을 검색합니다. 검색어는 바깥 검색 엔진으로 나갑니다."
                : "켜면 위키만으로 답할 수 없을 때 AI 가 PC 의 브라우저로 웹을 검색합니다"
            }
            onClick={() => s.patchSettings({ webSearch: !webOn })}
            style={{
              ...smallBtn,
              gap: 5,
              border: `1px solid ${webOn ? "#cddcf8" : "#e0dcd4"}`,
              background: webOn ? "#eef3fd" : "#fff",
              color: webOn ? "#2f5cbb" : "#6a665e",
              fontWeight: webOn ? 600 : 400,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: webOn ? (webInfo.run ? "#3a6fd8" : "#d9a13b") : "#c9c3b8",
              }}
            />
            웹 검색 {webOn ? "켜짐" : "꺼짐"}
          </Box>
          {/* 카테고리를 쓰지 않는 Vault 에는 고를 범위가 없다 — 지금 화면 그대로. */}
          {pickable && (
            <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: "#a09a8f" }}>범위</span>
              <Select
                // `*` 는 카테고리에 쓸 수 없는 글자라 어떤 키와도 겹치지 않는다(위키 화면과 같다).
                value={scope ?? "*"}
                onChange={(e) => s.set({ askCat: { key: e.target.value === "*" ? null : e.target.value } })}
                title={
                  s.askCat
                    ? "이 카테고리(하위 포함)의 위키 페이지만 근거로 찾습니다 — 괄호는 페이지 수. [대화 초기화] 하면 다시 왼쪽 카테고리 거르기를 따릅니다"
                    : "이 카테고리(하위 포함)의 위키 페이지만 근거로 찾습니다 — 괄호는 페이지 수. 지금은 왼쪽 카테고리 거르기를 따르고, 질문하면 이 범위로 고정됩니다"
                }
                style={{
                  maxWidth: 220,
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
            </span>
          )}
          <span style={{ ...hint, fontSize: 11, marginLeft: "auto", textAlign: "right" }}>
            {turns.length > 0 && `대화 ${turns.length}턴 · `}
            {info.run
              ? `${info.name ?? info.run.agentId} · ${info.modelLabel}`
              : info.via === "route"
                ? `지정한 연결(${info.name})을 지금 쓸 수 없습니다`
                : "설정 → 기능별 AI 연결에서 연결을 고르세요"}
            {webOn &&
              (webInfo.run
                ? ` · 웹 정리 ${webInfo.name ?? webInfo.run.agentId} · ${webInfo.modelLabel}`
                : " · 웹 검색 연결이 없어 검색하지 않습니다")}
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
        {turn.scope !== null && (
          <span
            title="이 카테고리(하위 포함)의 위키 페이지만 근거로 찾았습니다"
            style={{ flex: "0 1 auto", minWidth: 0, fontSize: 11, color: "#8a857c", whiteSpace: "nowrap" }}
          >
            ‘{turn.scope}’ 안에서
          </span>
        )}
        <span style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {turn.question}
        </span>
      </div>

      {out && out.searches.length > 0 && (
        <div style={{ ...hint, fontSize: 11, marginBottom: 6 }}>
          웹 검색: {out.searches.map((q) => `"${q}"`).join(" · ")}
        </div>
      )}

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
      {out && out.webErrors.length > 0 && (
        <div style={{ ...hint, color: "#a06a3b", marginTop: 6, whiteSpace: "pre-wrap" }}>
          {out.webErrors.join("\n")}
        </div>
      )}

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
          {(out.webCited.length ? out.webCited : out.webUsed).length > 0 && (
            <WebChips sources={out.webCited.length ? out.webCited : out.webUsed} cited={out.webCited.length > 0} />
          )}
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

/** 웹 출처 칩 — `[웹n]` 번호 + 사이트. 누르면 사용자의 기본 브라우저로 연다. */
function WebChips({ sources, cited }: { sources: WebSource[]; cited: boolean }) {
  return (
    <>
      <span style={{ ...hint, margin: "0 4px 0 8px" }}>
        {cited ? `웹 ${sources.length}` : `참고한 웹 ${sources.length}`}
      </span>
      {sources.map((w) => (
        <Box
          key={w.n}
          title={`${w.title}\n${w.url}`}
          onClick={() =>
            void api
              .openWebUrl(w.url)
              .catch((e) => useStore.getState().fail(e, "브라우저로 열지 못했습니다"))
          }
          style={{
            fontSize: 11.5,
            border: "1px solid #d9e6dc",
            borderRadius: 4,
            padding: "1px 7px",
            background: "#f6faf7",
            color: "#256b47",
            cursor: "pointer",
            maxWidth: 240,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          hover={{ borderColor: "#b9d6c2" }}
        >
          [웹{w.n}] {hostOf(w.url)} ↗
        </Box>
      ))}
    </>
  );
}
