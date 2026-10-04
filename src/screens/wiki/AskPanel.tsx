import { useEffect, useMemo, useRef, useState } from "react";
import { AiRail, AiSignal, AiStep, Box, Caret, ELAPSED_AFTER_MS, Select, TextArea, fmtSec, useElapsed } from "../../lib/ui";
import { AI, TEXT, VIOLET } from "../../lib/design";
import { mdParse } from "../../lib/markdown";
import * as api from "../../lib/api";
import { CANCELED, RUN_STALL_MS } from "../../lib/runOnce";
import { askScope } from "../../lib/wiki/categories";
import { resolveLink } from "../../lib/wiki/links";
import { askWiki, fileAnswer, type AskOutcome } from "../../lib/wiki/pipeline";
import { inlineWebRefs, type WebSource } from "../../lib/wiki/web";
import MarkdownView, { WikiLinkContext } from "../../components/MarkdownView";
import { browserOptions, useStore } from "../../store/useStore";
import { routeInfo, useAi } from "../../store/aiStore";
import { useWiki } from "../../store/wikiStore";
import { catLabel, NO_PAGES, openTask, smallBtn, useTaskById, wikiLinks, type WikiCats } from "./WikiPanels";

const hint: React.CSSProperties = { fontSize: 11.5, color: TEXT.sub, lineHeight: 1.6 };

/** 지나간(또는 지금) 단계 하나. `end` 가 없으면 지금 단계다. */
interface Step {
  label: string;
  at: number;
  end?: number;
}

/** 생각 토큰을 받는 동안의 단계 이름. */
const THINKING = "생각하는 중";
/** 답 글이 흐르기 시작한 단계인가 — 파이프라인은 웹 바퀴마다 이름을 조금 바꿔 부른다. */
const isWriting = (label: string) => label.endsWith("답 쓰는 중");

/** 응답 없이 이만큼 지나면 "응답이 n초째 없습니다" 를 띄운다 — 정지 감시가 끊기 전에. */
const IDLE_WARN_MS = RUN_STALL_MS * 0.7;

/** 대화 한 턴 — 질문 하나와 그 답. */
interface Turn {
  id: number;
  question: string;
  /** 받는 중이면 지금까지의 글, 끝났으면 답 전체. */
  text: string;
  state: "running" | "done" | "failed" | "canceled";
  /** 지나온 단계와 지금 단계. 끝난 단계는 ✓ 와 걸린 시간으로 남는다. */
  steps: Step[];
  startedAt: number;
  endedAt?: number;
  /** 마지막으로 무엇이든 받은 시각 — 오래 조용하면 알린다. */
  lastAt: number;
  /** 생각 토큰 — 받은 글자 수와 마지막 줄. 지금 바퀴의 것이다. */
  think: { chars: number; tail: string } | null;
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

/** 지금 단계를 `label` 로 넘긴다. 같은 이름이면 그대로. */
function stepTo(t: Turn, label: string, now: number): Turn {
  const cur = t.steps[t.steps.length - 1];
  if (cur && !cur.end && cur.label === label) return t;
  const steps = t.steps.map((x) => (x.end ? x : { ...x, end: now }));
  return { ...t, steps: [...steps, { label, at: now }] };
}

/** 지금 단계를 닫는다(끝 · 실패 · 취소). */
const closeSteps = (steps: Step[], now: number) => steps.map((x) => (x.end ? x : { ...x, end: now }));

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
  const live = (id: number, f: (t: Turn) => Turn) =>
    setTurns((ts) => ts.map((t) => (t.id === id && t.state === "running" ? f(t) : t)));
  const finish = (id: number, p: Partial<Turn>) =>
    live(id, (t) => {
      const now = Date.now();
      return { ...t, ...p, steps: closeSteps(t.steps, now), endedAt: now, think: null };
    });

  const cancel = () => {
    abort.current?.abort();
    const now = Date.now();
    setTurns((ts) =>
      ts.map((t) =>
        t.state === "running"
          ? { ...t, state: "canceled", steps: closeSteps(t.steps, now), endedAt: now, think: null }
          : t,
      ),
    );
  };

  // 받는 동안 Esc 로 중지 — 다른 곳이 먼저 쓴 Esc(모달 닫기 등)는 건드리지 않는다.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

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
    const now = Date.now();
    setTurns((ts) => [
      ...ts,
      {
        id,
        question: q,
        text: "",
        state: "running",
        steps: [{ label: "위키에서 관련 페이지 찾는 중", at: now }],
        startedAt: now,
        lastAt: now,
        think: null,
        scope: name,
      },
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
      onPartial: (text) =>
        live(id, (t) => {
          const now = Date.now();
          const cur = t.steps[t.steps.length - 1];
          // 글이 오기 시작하면 생각 단계를 닫고 "답 쓰는 중" 으로.
          const next = text && cur && !isWriting(cur.label) ? stepTo(t, "답 쓰는 중", now) : t;
          return { ...next, text, lastAt: now };
        }),
      onThinking: (chars, tail) =>
        live(id, (t) => {
          const now = Date.now();
          const cur = t.steps[t.steps.length - 1];
          // 답을 쓰기 전의 생각이면 지금 단계(“답 쓰는 중”)를 생각 단계로 바꿔 부른다 —
          // 글이 하나도 없는데 "답 쓰는 중" 에 멈춰 있으면 고장 난 것처럼 보인다.
          let next = t;
          if (cur && !cur.end && !t.text && isWriting(cur.label)) {
            next = { ...t, steps: [...t.steps.slice(0, -1), { ...cur, label: THINKING }] };
          } else if (cur && !cur.end && cur.label !== THINKING && !t.text) {
            next = stepTo(t, THINKING, now);
          }
          return { ...next, think: { chars, tail }, lastAt: now };
        }),
      onStep: (step) => live(id, (t) => ({ ...stepTo(t, step, Date.now()), lastAt: Date.now(), think: null })),
    })
      .then((out) => finish(id, { state: "done", text: out.answer, out }))
      .catch((e) => {
        const msg = api.errMessage(e);
        finish(id, msg === CANCELED ? { state: "canceled" } : { state: "failed", error: msg });
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

  const runningTurn = turns.find((t) => t.state === "running");
  const busyMs = useElapsed(runningTurn?.startedAt);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* 진행선 — 대화를 위로 올려 읽는 중이어도 주변 시야에 걸린다. */}
      <div style={{ flex: "0 0 2px", height: 2 }}>{busy && <AiRail />}</div>
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
                onCancel={cancel}
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
          {busy ? (
            // 답하는 동안 단추는 진행 표시가 된다 — 흐린 회색 글자로는 멈춘 것과 갈리지 않았다.
            <span
              role="status"
              style={{
                ...smallBtn,
                height: 28,
                minWidth: 150,
                gap: 8,
                padding: "0 11px",
                border: `1px solid ${AI.bd}`,
                background: AI.bg,
                color: AI.fg,
                fontWeight: 600,
                cursor: "default",
              }}
            >
              <AiSignal size={6} />
              <span>답하는 중</span>
              <span style={{ marginLeft: "auto", fontFamily: "'Roboto Mono',monospace", fontWeight: 500, fontSize: 11.5 }}>
                {fmtSec(busyMs)}
              </span>
            </span>
          ) : (
            <Box
              onClick={ask}
              style={{
                ...smallBtn,
                height: 28,
                border: `1px solid ${canAsk ? AI.bd : "#e0dcd4"}`,
                background: canAsk ? AI.bg : "#f7f5f1",
                color: canAsk ? AI.fg : "#b5afa2",
                fontWeight: 600,
                cursor: canAsk ? "pointer" : "default",
              }}
            >
              {turns.length ? "이어서 묻기 (Ctrl+Enter)" : "AI에게 묻기 (Ctrl+Enter)"}
            </Box>
          )}
          {busy && (
            <Box style={{ ...smallBtn, height: 28, gap: 6 }} hover={{ background: "#f2efe9" }} onClick={cancel}>
              중지
              <span
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11,
                  color: TEXT.sub,
                  border: "1px solid #e6e2da",
                  borderRadius: 3,
                  padding: "0 4px",
                }}
              >
                Esc
              </span>
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
              <span style={{ fontSize: 11, color: TEXT.sub }}>범위</span>
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
          <span style={{ ...hint, marginLeft: "auto", textAlign: "right" }}>
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
  onCancel,
}: {
  turn: Turn;
  first: boolean;
  byId: Map<string, api.TaskMeta>;
  onOpen: (path: string) => void;
  onSave: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const blocks = useMemo(() => mdParse(turn.text), [turn.text]);
  const running = turn.state === "running";
  // 도는 동안 1초마다 다시 그려 단계 · 전체 경과를 올린다.
  const elapsed = useElapsed(running ? turn.startedAt : null);
  const now = turn.startedAt + elapsed;
  /** 답이 흐르기 시작하면 단계 목록은 한 줄 요약으로 접힌다. 요약을 누르면 다시 편다. */
  const [unfold, setUnfold] = useState(false);
  const trail = turn.steps.filter((x) => !isWriting(x.label));
  const thinkMs = turn.steps
    .filter((x) => x.label === THINKING)
    .reduce((n, x) => n + ((x.end ?? now) - x.at), 0);
  const cur = running ? turn.steps[turn.steps.length - 1] : undefined;
  // 실패 · 취소한 턴은 ✓ 요약을 달지 않는다 — 끝나지 않은 일을 끝난 것처럼 보이게 한다.
  const folded = turn.state === "done" || (running && !!turn.text);
  const showTrail = running && !turn.text ? true : folded && unfold;
  const idle = running ? now - turn.lastAt : 0;
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

      {/* 접힌 요약 — 답이 오기 시작했거나 끝난 턴. */}
      {folded && trail.length > 0 && (
        <Box
          onClick={() => setUnfold((u) => !u)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexWrap: "wrap",
            fontSize: 12,
            color: TEXT.body,
            marginBottom: 8,
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <span style={{ color: "#2f7f57", fontWeight: 700 }}>✓</span>
          <span>
            근거 찾기 {trail.filter((x) => x.label !== THINKING).length}단계
            {thinkMs > 0 && ` · 생각 ${fmtSec(thinkMs, true)}`}
          </span>
          <span style={{ color: "#3a6fd8" }}>{showTrail ? "접기 ▾" : "펼치기 ▸"}</span>
        </Box>
      )}

      {showTrail && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8, maxWidth: 860 }}>
          {(folded ? trail : turn.steps)
            .filter((x) => x.end)
            .map((x, i) => (
              <div
                key={`${x.at}-${i}`}
                className="cf-up"
                style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: TEXT.body }}
              >
                <span style={{ width: 16, textAlign: "center", color: "#2f7f57", fontSize: 12, fontWeight: 700 }}>✓</span>
                <span style={{ flex: 1, minWidth: 0 }}>{x.label}</span>
                <span style={{ flex: "0 0 auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, color: TEXT.sub }}>
                  {fmtSec(x.end! - x.at, true)}
                </span>
              </div>
            ))}
          {cur && !turn.text && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 500 }}>
                <span style={{ width: 16, display: "flex", justifyContent: "center" }}>
                  <AiSignal />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <AiStep>{cur.label}</AiStep>
                </span>
                <span style={{ flex: "0 0 auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, color: AI.fg }}>
                  {fmtSec(now - cur.at)}
                </span>
              </div>
              {cur.label === THINKING && turn.think && (
                <div className="cf-up" style={{ marginLeft: 24, display: "flex", flexDirection: "column", gap: 5 }}>
                  {turn.think.tail && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                        color: TEXT.sub,
                        background: "#faf9f6",
                        border: "1px solid #efece5",
                        borderRadius: 5,
                        padding: "4px 9px",
                        WebkitMaskImage: "linear-gradient(90deg, transparent, #000 22%)",
                        maskImage: "linear-gradient(90deg, transparent, #000 22%)",
                      }}
                    >
                      {turn.think.tail}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: TEXT.body }}>
                    생각{" "}
                    <span style={{ fontFamily: "'Roboto Mono',monospace", color: AI.fg }}>
                      {turn.think.chars.toLocaleString()}자
                    </span>{" "}
                    받음
                    {now - cur.at >= ELAPSED_AFTER_MS && (
                      <span style={{ color: TEXT.sub }}> · 추론 모델은 답하기 전에 먼저 생각합니다</span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {turn.text && (
        <>
          <MarkdownView blocks={blocks} inline />
          {running && (
            <div style={{ lineHeight: 1.75, fontSize: 13 }}>
              <Caret />
            </div>
          )}
        </>
      )}

      {running && idle >= IDLE_WARN_MS && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
            maxWidth: 860,
            fontSize: 12,
            lineHeight: 1.5,
            color: TEXT.warn,
            background: "#fdf8ee",
            border: "1px solid #f1e2c2",
            borderRadius: 5,
            padding: "6px 9px",
          }}
        >
          <WarnIcon />
          <span style={{ flex: 1, minWidth: 0 }}>
            응답이 {fmtSec(idle)}째 없습니다 — {RUN_STALL_MS / 60_000}분이 지나면 자동으로 끊습니다
          </span>
          <Box style={{ flex: "0 0 auto", color: "#2f5cbb", fontWeight: 500, cursor: "pointer" }} onClick={onCancel}>
            중지
          </Box>
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
          {turn.endedAt && (
            <span className="cf-up" style={{ fontSize: 12, color: "#256b47", fontWeight: 600, marginRight: 6 }}>
              ✓ 답변 완료 · {fmtSec(turn.endedAt - turn.startedAt, true)}
            </span>
          )}
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

/** 경고 표식 — 글자색만으로는 묻히므로 아이콘 · 옅은 바탕과 함께 쓴다. */
function WarnIcon() {
  return (
    <span
      aria-hidden
      style={{
        flex: "0 0 15px",
        height: 15,
        borderRadius: "50%",
        background: "#b07520",
        color: "#fff",
        fontSize: 10.5,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      !
    </span>
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
