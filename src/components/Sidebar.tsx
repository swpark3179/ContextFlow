import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AiRail,
  AiSignal,
  AiStep,
  Box,
  Collapse,
  EASE_IN,
  EASE_OUT,
  HoldRing,
  Input,
  Popover,
  reducedMotion,
  useFlip,
} from "../lib/ui";
import { AI, BLUE, TEXT, normalizeStatus, statusOf } from "../lib/design";
import { useDropGuard, useLongPress } from "../lib/longPress";
import { shortStamp, today } from "../lib/format";
import {
  dropKind,
  flattenSideRows,
  HEAD_DWELL_MS,
  keyOf,
  knownCategories,
  label,
  openFor,
  type CategoryNode,
} from "../lib/category";
import type { TaskMeta } from "../lib/api";
import { emptyNewTask, isArchived, openCategoryHub, useStore, type Screen } from "../store/useStore";
import { useWiki } from "../store/wikiStore";

/**
 * 상태 필터. `완료` 칸은 두지 않는다 — 앱에서 완료로 바꾼 업무는 그 자리에서 보관되어
 * 업무 리스트를 떠나므로(`setStatus`), 늘 비어 있는 칸이 셋을 넷으로 좁힐 뿐이었다.
 * 밖에서 완료로 고쳐 둔 업무는 보관 기준일이 지나기 전까지 `전체` 에 그대로 보인다.
 */
const FILTERS: [string, string][] = [
  ["all", "전체"],
  ["in-progress", "진행중"],
  ["on-hold", "보류"],
];

const NAV: [Screen, string][] = [
  ["workspace", "워크스페이스"],
  ["templates", "템플릿"],
  ["archive", "보관함"],
  ["settings", "설정"],
];

/** 펼침 화살표 — 글자(▶ ▼)를 갈아 끼우던 것을 돌린다. `open` 이면 아래를 본다. */
function Chevron({ open, closed = -90, dim }: { open: boolean; closed?: number; dim?: boolean }) {
  return (
    <svg
      aria-hidden
      className="cf-mv"
      width="9"
      height="9"
      viewBox="0 0 10 10"
      style={{
        flex: "0 0 9px",
        transform: open ? "none" : `rotate(${closed}deg)`,
        transition: `transform var(--m-base) ${EASE_OUT}`,
        opacity: dim ? 0.4 : 1,
      }}
    >
      <path
        d="M2.5 3.8 5 6.3l2.5-2.5"
        fill="none"
        stroke="#6a665e"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 한 번 튀기기(`cf-bump`) — 같은 요소에서 다시 돌리려면 클래스를 뗐다 붙인다. */
function bump(el: Element | null | undefined) {
  if (!el) return;
  el.classList.remove("cf-bump");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("cf-bump");
}

/**
 * 보관으로 빠지는 행 · 되돌리기로 돌아오는 행이 보관함 도크와의 사이를 날아간다. 예전에는 행이 그
 * 자리에서 사라져 어디로 갔는지가 보이지 않았다. 행을 복제해 `body` 에 띄우고 한 번 날린 뒤 지운다.
 * 목록의 보이는 칸 밖에 있던 행(스크롤로 가려졌다)은 날리지 않는다 — 엉뚱한 곳에서 튀어나온다.
 */
let flown: object | null = null;
function flyRow(el: HTMLElement, dir: "out" | "in", token: object) {
  if (flown === token || reducedMotion() || typeof el.animate !== "function") return;
  const dock = document.querySelector<HTMLElement>('[data-dock="archive"]');
  const list = el.closest<HTMLElement>("[data-task-list]");
  // 접어 둔 사이드바(보이지 않는 판)에서는 날리지 않는다.
  if (!dock || !list || el.closest("[inert]")) return;
  const a = el.getBoundingClientRect();
  const b = dock.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  if (!a.width || !b.width || a.bottom < box.top || a.top > box.bottom) return;
  flown = token;
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${a.left}px`,
    top: `${a.top}px`,
    width: `${a.width}px`,
    height: `${a.height}px`,
    margin: "0",
    zIndex: "60",
    pointerEvents: "none",
    background: "#fff",
    boxShadow: "0 8px 22px rgba(35,33,30,.18)",
    transformOrigin: "50% 50%",
  });
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const far = { transform: `translate(${dx}px,${dy}px) scale(.3)`, opacity: 0 };
  const near = { transform: "none", opacity: 1 };
  const ms = 460;
  const run = () => {
    document.body.appendChild(ghost);
    const anim = ghost.animate(dir === "out" ? [near, far] : [far, near], {
      duration: ms,
      easing: dir === "out" ? "cubic-bezier(.5,0,.2,1)" : EASE_OUT,
      fill: "forwards",
    });
    anim.onfinish = () => {
      ghost.remove();
      if (dir === "out") bump(dock.querySelector("[data-dock-count]"));
    };
    // 돌아오는 행은 잔상이 닿을 때까지 감춘다 — 둘이 한꺼번에 보이면 하나가 둘이 된다.
    if (dir === "in") el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: ms });
  };
  // 빠지는 행은 커밋이 끝나 원본이 문서에서 떨어진 뒤에 띄운다(`useExitSnapshot` 과 같다).
  if (dir === "out") {
    queueMicrotask(() => {
      if (!el.isConnected) run();
    });
  } else run();
}

/**
 * LLM 위키로 가는 도크 버튼. 2×2 NAV 에 다섯째 칸을 끼우면 격자가 깨지므로 "보관함" 도크와
 * 같은 모양으로 그 아래에 둔다 — 위키는 보관된 업무에서 자라므로 자리도 그 옆이다.
 *
 * 반영은 화면 밖(`Wiki/` 폴더)에서 일어난다. 위키 화면에 있지 않아도 지금 돌고 있다는
 * 것이 보이도록, 도는 동안은 두 줄로 늘려 진행선(n/m)과 지금 업무 · 단계를 적는다. 끝나면
 * 어느 화면에 있든 토스트로 알린다(`wikiStore` — [보기] 로 위키에 간다).
 */
function WikiDock() {
  const screen = useStore((s) => s.screen);
  const setScreen = useStore((s) => s.setScreen);
  const pages = useWiki((w) => w.status?.pages.length ?? 0);
  const running = useWiki((w) => w.running);
  const total = useWiki((w) => w.queue.length);
  const done = useWiki(
    (w) => w.queue.filter((q) => q.state !== "queued" && q.state !== "running").length,
  );
  const current = useWiki((w) => w.queue.find((q) => q.state === "running"));
  const fresh = useWiki((w) => w.fresh);
  const on = screen === "wiki";
  // 두 모양(평소 한 줄 · 도는 동안 두 줄)을 오갈 때 한 번 흐려졌다 나타난다 — 도크가 툭 늘어나지 않게.
  if (running && total > 0) {
    return (
      <Box
        className="cf-enter-down"
        role="button"
        onClick={() => setScreen("wiki")}
        title="위키 반영 중 — 눌러서 위키 화면으로"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 5,
          padding: "6px 7px",
          borderRadius: 5,
          cursor: "pointer",
          background: AI.soft,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: on ? AI.bd : AI.softBd,
        }}
        hover={{ borderColor: AI.bd }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 600, color: AI.fg }}>
          <span style={{ width: 12, display: "flex", justifyContent: "center" }}>
            <AiSignal size={6} />
          </span>
          위키 반영
          <span
            style={{
              marginLeft: "auto",
              flex: "0 0 auto",
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              fontWeight: 500,
            }}
          >
            {Math.min(done + 1, total)}/{total}
          </span>
        </div>
        <div style={{ borderRadius: 1, overflow: "hidden" }}>
          <AiRail pct={done / total} />
        </div>
        {current && (
          <div
            title={`${current.title}${current.step ? ` · ${current.step}` : ""}`}
            style={{ fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            <AiStep>
              {current.title}
              {current.step ? ` · ${current.step}` : ""}
            </AiStep>
          </div>
        )}
      </Box>
    );
  }
  return (
    <Box
      className="cf-fade"
      role="button"
      onClick={() => setScreen("wiki")}
      title="완료한 업무를 AI 가 정리한 위키"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        height: 25,
        padding: "0 8px",
        borderRadius: 4,
        cursor: "pointer",
        background: on ? "#fff" : "#ebe7df",
        border: on ? "1px solid #d9d4ca" : "1px solid transparent",
      }}
      hover={{ background: on ? "#fff" : "#e2ded4" }}
    >
      <div
        style={{
          width: 9,
          height: 9,
          borderRadius: 2,
          background: "#cfc6ec",
          flex: "0 0 9px",
        }}
      />
      <span style={{ fontSize: 11.5, color: TEXT.sub, flex: fresh ? "0 1 auto" : 1, minWidth: 0 }}>위키</span>
      {fresh > 0 && (
        <span
          className="cf-up"
          title="위키 화면 밖에 있는 동안 반영을 마친 업무 수 — 위키를 열면 지워집니다"
          style={{
            flex: "0 0 auto",
            fontSize: 11,
            fontWeight: 600,
            color: AI.fg,
            background: AI.bg,
            borderRadius: 3,
            padding: "0 5px",
            lineHeight: "16px",
            whiteSpace: "nowrap",
          }}
        >
          +{fresh} 반영
        </span>
      )}
      {fresh > 0 && <span style={{ flex: 1 }} />}
      <span
        style={{
          fontFamily: "'Roboto Mono',monospace",
          fontSize: 11.5,
          color: TEXT.sub,
          flex: "0 0 auto",
        }}
      >
        {pages}페이지
      </span>
    </Box>
  );
}

/**
 * 오늘의 한일 — **오늘** 손댄 업무의 제목을 모아 둔 목록.
 *
 * 업무 리스트 위에 겹치지 않는다: 저쪽은 "지금 하는 일"이고 이쪽은 "오늘 한 일"이라
 * 필터도 정렬도 다르다. 특히 완료한 업무는 그 즉시 업무 리스트에서 빠지므로
 * (`setStatus`), 하루를 돌아볼 자리는 저 목록이 아니라 여기다.
 *
 * 기록은 날짜별로 영구히 쌓이지만(`~/.contextflow/today.db`) **도크는 오늘만 보여 준다**.
 * 어제와 그제를 보고 고치는 곳은 팝업이고(`DayLogModal`), 머리말의 건수를 누르면 열린다.
 * 도크를 여러 날짜로 늘리면 사이드바에서 스크롤로 과거를 뒤지게 되는데, 그것은 이 자리가
 * 할 일이 아니다 — 여기는 지금 하루의 눈금이다.
 *
 * 항목은 눌러 그 업무로 갈 수 있고, 줄에 올리면 나타나는 ✕ 로 지운다(6초 [되돌리기]). 팝업 · 머리의
 * ＋ 로 손으로 넣은 자유 항목은 가리키는 업무가 없어 눌리지 않는다.
 */
function TodayDock() {
  const s = useStore();
  const { dayLog, tasks, settings } = s;
  // 날이 바뀌었는데 앱이 계속 떠 있었을 수도 있다 — 그리는 쪽에서 한 번 더 본다.
  const items = dayLog.day === today() ? dayLog.entries : [];

  /**
   * 자정에 목록을 새 날짜로 넘긴다.
   *
   * 위의 걸러 내기만으로는 부족하다 — 앱을 켜 둔 채 밤을 넘기면 다시 그릴 일이 없어서
   * 어제 목록이 화면에 그대로 남는다. 이 앱은 하루 종일 켜 두는 종류라 드문 경우가
   * 아니다. `tick` 은 타이머를 다시 걸기 위한 것이고(부른 뒤 날짜가 이미 맞아도 다음
   * 자정을 다시 예약해야 한다), `getState` 로 부르므로 스토어가 바뀔 때마다 타이머가
   * 새로 걸리지는 않는다.
   *
   * 넘어가는 것은 **화면**이다. 어제의 줄은 DB 에 그대로 있고 팝업에서 볼 수 있다.
   */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const now = new Date();
    // 자정 5초 뒤 — 경계에서 `today()` 가 아직 어제로 읽히는 일을 피한다.
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
    const timer = window.setTimeout(
      () => {
        void useStore.getState().rollToday();
        setTick((n) => n + 1);
      },
      Math.max(1000, next.getTime() - now.getTime()),
    );
    return () => window.clearTimeout(timer);
  }, [tick]);

  // 건수가 늘면 한 번 튄다. 처음 그릴 때와 날이 바뀌어 줄어들 때는 가만히 있다.
  const countRef = useRef<HTMLSpanElement | null>(null);
  const lastCount = useRef(items.length);
  useEffect(() => {
    if (items.length > lastCount.current) bump(countRef.current);
    lastCount.current = items.length;
  }, [items.length]);

  // 올라온 줄은 맨 위로 미끄러져 들어가고, 나머지는 한 칸씩 내려간다.
  const listRef = useRef<HTMLDivElement | null>(null);
  useFlip(listRef, items.map((it) => it.id).join(","), { enter: true, ms: 240 });

  // 직접 적어 넣기 — 회의 · 전화처럼 업무가 아닌 일. 예전에는 팝업을 열어야 했다.
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const addRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);
  const commit = async () => {
    const text = draft.trim();
    if (!text) {
      setAdding(false);
      return;
    }
    setDraft("");
    // 이어서 또 적을 수 있게 칸은 열어 둔다. 못 넣었으면 쓴 글을 돌려놓는다.
    if (!(await s.addTodayNote(text))) setDraft(text);
  };

  /**
   * ✕ — 줄을 접어 없앤 뒤 지운다. 확인을 묻지 않는 대신 6초 [되돌리기] 가 있다(`dropEntry` 의 `undo`).
   * 예전에는 묻지도 되돌리지도 않고 곧바로 DB 에서 지웠다.
   */
  const remove = (id: number, el: HTMLElement | null) => {
    const drop = () => s.dropEntry(id, { undo: true });
    if (!el || reducedMotion() || typeof el.animate !== "function") return drop();
    el.style.overflow = "hidden";
    el.animate(
      [
        { height: `${el.offsetHeight}px`, opacity: 1 },
        { height: "0px", opacity: 0 },
      ],
      { duration: 160, easing: EASE_IN, fill: "forwards" },
    ).onfinish = drop;
  };

  const open = !s.todayMin;
  const peek = items[0]?.title;

  return (
    <div
      style={{
        border: "1px solid #e6e2da",
        borderRadius: 5,
        background: "#faf9f6",
        overflow: "hidden",
        flex: "0 0 auto",
      }}
    >
      {/* 접기 · 건수(팝업) · ＋ 는 나란한 세 단추다 — 단추 안에 단추를 넣으면 화면 읽기가 하나로 읽는다. */}
      <Box
        style={{ display: "flex", alignItems: "center", gap: 2, height: 25, padding: "0 4px 0 0" }}
        hover={{ background: "#f2efe9" }}
      >
        <Box
          onClick={() => s.set({ todayMin: !s.todayMin })}
          role="button"
          tabIndex={0}
          className="cf-focus"
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            s.set({ todayMin: !s.todayMin });
          }}
          aria-expanded={open}
          title={open ? "오늘의 한일 접기" : "오늘의 한일 펼치기"}
          style={{
            flex: 1,
            minWidth: 0,
            alignSelf: "stretch",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 4px 0 7px",
            cursor: "pointer",
          }}
        >
          {/* 도크는 아래에 붙어 있어 위로 열린다 — 접혔을 때 위를 본다. */}
          <Chevron open={open} closed={180} />
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: ".4px",
              color: "#6a665e",
              flex: "0 0 auto",
              whiteSpace: "nowrap",
            }}
          >
            오늘의 한일
          </span>
          {/* 접어 둔 동안에도 방금 무엇이 올라왔는지는 보인다. */}
          <span
            key={peek ?? ""}
            className={!open && peek ? "cf-fade" : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11,
              color: "#6a665e",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {!open && peek ? `· ${peek}` : ""}
          </span>
        </Box>
          {/* 건수가 곧 팝업을 여는 곳이다. */}
          <Box
            onClick={() => void s.openDayLog()}
            role="button"
            title="날짜별 기록 보기"
            aria-label={`날짜별 기록 보기 — 오늘 ${items.length}건`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              height: 19,
              borderRadius: 3,
              padding: "0 4px",
              flex: "0 0 auto",
              color: "#6a665e",
            }}
            hover={{ background: "#e0dcd4", color: "#3a3630" }}
          >
            <svg aria-hidden width="11" height="11" viewBox="0 0 12 12">
              <rect x="1.5" y="2.5" width="9" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <path d="M1.5 5h9M4 1.2v2.4M8 1.2v2.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <span
              ref={countRef}
              style={{
                display: "inline-block",
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11.5,
                color: items.length ? undefined : "#b5afa2",
              }}
            >
              {items.length}건
            </span>
          </Box>
          <Box
            onClick={() => {
              if (!open) s.set({ todayMin: false });
              setAdding(!adding || !open);
            }}
            role="button"
            title="직접 적어 넣기"
            aria-label="오늘의 한일에 직접 적어 넣기"
            style={{
              flex: "0 0 19px",
              width: 19,
              height: 19,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 3,
              color: adding && open ? BLUE : "#6a665e",
            }}
            hover={{ background: "#e0dcd4", color: "#3a3630" }}
          >
            <svg aria-hidden width="10" height="10" viewBox="0 0 10 10">
              <path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </Box>
      </Box>

      <Collapse open={open} ms={220}>
        <Collapse open={adding} ms={180}>
          <div style={{ padding: "2px 6px 4px 6px" }}>
            <Input
              ref={addRef}
              value={draft}
              aria-label="오늘 한 일"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                } else if (e.key === "Escape") {
                  // 겹친 레이어를 닫는 App 의 Esc 사슬로 넘기지 않는다.
                  e.preventDefault();
                  e.stopPropagation();
                  setDraft("");
                  setAdding(false);
                }
              }}
              onBlur={() => {
                if (!draft.trim()) setAdding(false);
              }}
              placeholder="무엇을 했습니까 — Enter 로 추가"
              style={{
                width: "100%",
                height: 24,
                border: "1px solid #ddd8cf",
                borderRadius: 4,
                background: "#fff",
                padding: "0 7px",
                fontSize: 11.5,
                color: "#23211e",
                outline: "none",
              }}
              focusStyle={{ borderColor: "#cddcf8", boxShadow: "0 0 0 2px #e6eefc" }}
            />
          </div>
        </Collapse>

        {!items.length && (
          <div
            style={{
              padding: "5px 8px 7px 8px",
              fontSize: 11,
              color: "#6a665e",
              lineHeight: 1.5,
              borderTop: "1px solid #efece5",
            }}
          >
            업무를 고치면 여기에 쌓입니다. 지난 날짜는 위 건수를 눌러 봅니다
          </div>
        )}

        {items.length > 0 && (
          <div ref={listRef} style={{ maxHeight: 116, overflowY: "auto", borderTop: "1px solid #efece5" }}>
            {items.map((it) => {
              // 자유 항목은 가리키는 업무가 없다(팝업 · 도크에서 손으로 넣은 회의 · 전화 · 지원 업무).
              const task = it.folder ? tasks.find((t) => t.folder === it.folder) : undefined;
              const archived = !!task && isArchived(task, settings.archDays);
              // 취소선은 "있었던 업무가 사라졌다" 는 뜻이다. 애초에 업무가 아니었던 줄에
              // 그으면 거짓말이 되므로, 자유 항목은 흐린 글자로만 구분한다.
              const missing = it.folder !== null && !task;
              return (
                <Box
                  key={it.id}
                  data-flip={it.id}
                  className="cf-reveal-host"
                  onClick={() => {
                    // 사라진 업무(Vault 밖에서 지웠다)는 열 곳이 없다. 제목은 남겨 둔다 —
                    // 오늘 그 일을 한 것은 사실이다.
                    if (!task) return;
                    if (archived) void s.peekArchived(task.folder);
                    else void s.selectTask(task.folder);
                  }}
                  title={
                    task
                      ? it.folder ?? ""
                      : missing
                        ? `${it.folder} · 지금은 없는 업무입니다`
                        : it.body || "업무와 연결되지 않은 기록입니다"
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 4px 3px 8px",
                    cursor: task ? "pointer" : "default",
                  }}
                  hover={task ? { background: "#f2efe9" } : undefined}
                >
                  <span
                    style={{
                      fontSize: 11.5,
                      lineHeight: "16px",
                      color: task ? "#3a3630" : "#6a665e",
                      flex: "1 1 auto",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textDecoration: missing ? "line-through" : "none",
                    }}
                  >
                    {it.title}
                  </span>
                  {/* 업무가 아닌 줄 — 손으로 넣은 일이다. */}
                  {it.folder === null && (
                    <span
                      style={{
                        fontSize: 10.5,
                        color: "#4e4a43",
                        background: "#ece8e0",
                        borderRadius: 3,
                        padding: "0 4px",
                        lineHeight: "15px",
                        flex: "0 0 auto",
                      }}
                    >
                      메모
                    </span>
                  )}
                  {/* 내용이 있는 줄에는 점을 하나 찍는다 — 팝업에 더 있다는 표시다. */}
                  {!!it.body && (
                    <span
                      title="내용이 있습니다"
                      style={{ width: 4, height: 4, borderRadius: "50%", background: "#a09a8f", flex: "0 0 4px" }}
                    />
                  )}
                  {archived && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "#6a665e",
                        background: "#ece8e0",
                        borderRadius: 3,
                        padding: "0 3px",
                        lineHeight: "15px",
                        flex: "0 0 auto",
                      }}
                    >
                      보관
                    </span>
                  )}
                  <span
                    // 시각이 바뀌면(다시 손댔다) 한 번 흐려졌다 나타난다.
                    key={it.at}
                    className="cf-fade"
                    style={{
                      fontFamily: "'Roboto Mono',monospace",
                      fontSize: 11.5,
                      color: "#6a665e",
                      flex: "0 0 auto",
                    }}
                  >
                    {it.at}
                  </span>
                  <Box
                    className="cf-reveal"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(it.id, e.currentTarget.parentElement);
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      e.stopPropagation();
                      remove(it.id, e.currentTarget.parentElement);
                    }}
                    title="오늘의 한일에서 제거"
                    aria-label={`${it.title} 기록 지우기`}
                    style={{
                      flex: "0 0 17px",
                      width: 17,
                      height: 17,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 3,
                      color: "#8a857c",
                    }}
                    hover={{ background: "#e0dcd4", color: "#4e4a43" }}
                  >
                    <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
                      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </Box>
                </Box>
              );
            })}
          </div>
        )}
      </Collapse>
    </div>
  );
}

/** 끄는 행 위에 적는 "지금 놓으면" — `TaskRow` 의 `verdict`. */
type Verdict = { kind: "cancel" } | { kind: "dwell"; name: string; since: number } | { kind: "armed"; name: string };

/** 업무 행을 누를 때 롱프레스에 넘기는 것. `group` 은 카테고리로 묶었을 때만 있다(미분류 `""`). */
interface TaskPress {
  folder: string;
  group?: string;
}

/**
 * 업무 리스트의 업무 한 줄. 평평한 목록과 카테고리 트리가 같은 행을 쓴다 — 트리에서는
 * 들여 쓰고 카테고리 라벨을 숨길 뿐이다(머리 행이 이미 말한다).
 *
 * 선택 표시(흰 바탕 · 왼쪽 띠)는 행이 아니라 목록의 알약 하나가 그린다(`Sidebar`) — 고른 행으로
 * 미끄러져 간다. 끄는 동안 이 행은 손을 따라 떠오르고(`lift`), 이웃 행은 자리를 비켜 준다(`shift`).
 *
 * 강조한 업무는 제목 아래 형광펜 획이 깔린다(`.cf-mark`) — 켜고 끌 때 그어지고 되감긴다. 진행 중일 때만
 * 칠한다: 보류 중에 남은 `highlight` 는 획이 되감긴 채 쉬고, 다시 진행하면 그어진다. 우클릭은 업무 메뉴
 * (`TaskMenu`)를 연다.
 */
function TaskRow({
  task: t,
  on,
  drag,
  dragging,
  dim,
  shift,
  lift,
  verdict,
  holding,
  flash,
  focusable,
  indent,
  showCategory,
  group,
  sortable,
  startPress,
  onClick,
  onMenu,
}: {
  task: TaskMeta;
  /** 지금 열려 있는(또는 막 고른) 업무. */
  on: boolean;
  /** 어느 업무든 끄는 중이다. */
  drag: boolean;
  /** 이 행을 끌고 있다. */
  dragging: boolean;
  /** 끄는 업무와 다른 묶음 — 여기에는 놓을 수 없다. */
  dim: boolean;
  /** 끄는 행에 자리를 비켜 주는 거리(px). */
  shift: number;
  /** 끄는 행이 손을 따라 떠오른 거리(px). */
  lift: number;
  /**
   * 끄는 행이 들고 다니는 "지금 놓으면" — 묶음 밖이면 취소, 다른 묶음 머리 위면 머무는 동안 막대가 차고
   * 다 차면 그 카테고리로. 행이 손을 따라 떠올라 그 아래 머리를 가리므로 결과를 행 위에 적는다.
   */
  verdict: Verdict | null;
  /** 누르고 있다 — 1초 링이 찬다. */
  holding: boolean;
  /** 방금 옮겨 놓았다. */
  flash: boolean;
  /** Tab 으로 목록에 들어올 때 이 행에 닿는다(한 목록에 한 행). */
  focusable: boolean;
  indent: number;
  showCategory: boolean;
  group?: string;
  sortable: boolean;
  startPress: (e: React.PointerEvent, press: TaskPress) => void;
  onClick: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const cfg = statusOf(t.status);
  const live = normalizeStatus(t.status) === "in-progress";
  const marked = live && t.highlight;
  const ref = useRef<HTMLDivElement | null>(null);
  // 보관 · 되돌리기로 목록을 떠나고 들어오는 순간 보관함 도크와의 사이를 난다(`fly`).
  useLayoutEffect(() => {
    const el = ref.current;
    const folder = t.folder;
    const f = useStore.getState().fly;
    if (el && f?.dir === "in" && f.folder === folder) flyRow(el, "in", f);
    return () => {
      const g = useStore.getState().fly;
      if (el && g?.dir === "out" && g.folder === folder) flyRow(el, "out", g);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Box
      ref={ref}
      data-task-folder={t.folder}
      data-task-group={group}
      data-flip={t.folder}
      role="option"
      aria-selected={on}
      tabIndex={focusable ? 0 : -1}
      title={[
        t.title,
        sortable && "1초 길게 눌러 옮기기 · Alt+↑↓",
        live && (marked ? "강조됨 · 우클릭으로 해제" : "우클릭으로 강조"),
      ]
        .filter(Boolean)
        .join("\n")}
      className={flash ? "cf-mv cf-focus cf-flash" : "cf-mv cf-focus"}
      onPointerDown={(e) => {
        if (sortable) startPress(e, { folder: t.folder, group });
      }}
      onClick={onClick}
      onContextMenu={onMenu}
      style={{
        position: "relative",
        zIndex: dragging ? 3 : undefined,
        // 손을 따라 떠오른 행이 포인터 밑을 가리면 `elementFromPoint` 가 그 아래 머리를 찾지 못한다.
        pointerEvents: dragging ? "none" : undefined,
        display: "flex",
        gap: 8,
        padding: "7px 8px 7px 7px",
        marginLeft: indent,
        borderRadius: 5,
        cursor: drag ? "grabbing" : "pointer",
        marginBottom: 1,
        // 띠의 자리만 둔다 — 색은 알약이 칠한다. 행마다 두께가 같아야 알약과 글자가 맞는다.
        borderLeft: "2px solid transparent",
        background: dragging ? "#fff" : holding ? "#e9e5dd" : "transparent",
        boxShadow: dragging ? "0 10px 24px rgba(35,33,30,.18), 0 1px 3px rgba(35,33,30,.12)" : "none",
        opacity: dim ? 0.45 : 1,
        // 끄는 행은 손을 그대로 따라간다(전환 없음). 비켜 주는 행만 미끄러진다 — 끌기가 끝나는 순간에는
        // 전환을 끈다: 새 순서로 다시 그려진 자리에서 옛 비켜 준 거리를 되감으면 한 칸 튄다(그쪽은 FLIP 이 맡는다).
        transform: dragging ? `translateY(${lift}px) scale(1.02)` : shift ? `translateY(${shift}px)` : undefined,
        transition: dragging
          ? "box-shadow 140ms, background-color 90ms"
          : drag
            ? `transform var(--m-base) ${EASE_OUT}, opacity 140ms, background-color 90ms`
            : "opacity 140ms, background-color 90ms",
      }}
      hover={drag || on ? undefined : { background: "#ede9e2" }}
    >
      <div style={{ position: "relative", width: 7, height: 7, marginTop: 4, flex: "0 0 7px" }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: cfg.dot }} />
        {holding && <HoldRing size={17} style={{ left: -5, top: -5 }} />}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          className={marked ? "cf-mark on" : "cf-mark"}
          style={{
            fontSize: 13,
            lineHeight: "17px",
            fontWeight: on ? 600 : 400,
            color: on ? "#23211e" : "#3a3630",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t.title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 2 }}>
          <span
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              color: "#6a665e",
              flex: "0 0 auto",
            }}
          >
            {shortStamp(t.updated)}
          </span>
          {showCategory && t.category && (
            <span
              style={{
                fontSize: 11,
                color: "#6a665e",
                flex: "0 1 auto",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {label(t.category)}
            </span>
          )}
          {showCategory && t.category && t.tagline && (
            <span style={{ fontSize: 11, color: "#6a665e", flex: "0 0 auto" }}>·</span>
          )}
          <span
            style={{
              fontSize: 11,
              color: "#6a665e",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {t.tagline}
          </span>
        </div>
      </div>
      {verdict && (
        <span
          key={verdict.kind}
          className="cf-fade"
          style={{
            position: "relative",
            overflow: "hidden",
            alignSelf: "center",
            flex: "0 1 auto",
            minWidth: 0,
            maxWidth: "55%",
            fontSize: 11,
            fontWeight: verdict.kind === "armed" ? 600 : 400,
            color: verdict.kind === "armed" ? "#2f5cbb" : "#6a665e",
            background: verdict.kind === "armed" ? "#e6eefc" : "#f0ede7",
            border: `1px solid ${verdict.kind === "armed" ? "#cddcf8" : "#e4e0d8"}`,
            borderRadius: 3,
            padding: "0 5px",
            lineHeight: "17px",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {verdict.kind === "cancel" ? "놓으면 취소" : verdict.kind === "armed" ? `‘${verdict.name}’(으)로` : `‘${verdict.name}’…`}
          {verdict.kind === "dwell" && (
            <span
              key={verdict.since}
              aria-hidden
              className="cf-sweep"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                background: BLUE,
                animationDuration: `${HEAD_DWELL_MS}ms`,
              }}
            />
          )}
        </span>
      )}
      {!verdict && t.runs > 1 && (
        <div
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 11.5,
            color: "#6a665e",
            background: "#ece8e0",
            borderRadius: 3,
            padding: "1px 4px",
            height: 17,
            lineHeight: "15px",
            marginTop: 1,
          }}
        >
          ×{t.runs}
        </div>
      )}
    </Box>
  );
}

/**
 * 카테고리 트리의 머리 행. 탐색기 폴더 행과 같은 치수다(폴더 아이콘만 없다) — 사이드바의
 * 두 트리가 같은 눈금으로 읽히게. 누르면 접고 편다. 검색 중에는 모두 펼쳐 보이므로 눌러도
 * 그대로다. 우클릭은 묶음 머리 메뉴(`CategoryMenu`)를 연다.
 *
 * 업무를 끄는 동안에는 놓을 곳이다 — 다른 묶음의 업무를 여기 머물렀다 놓으면 이 카테고리로
 * 바뀐다. 끌기 쪽은 `data-cat-key` · `data-cat-path` 로 포인터 아래의 머리를 찾는다(`catAt`).
 * 키 · 철자는 사용자가 지은 이름이라 셀렉터에 넣지 않고 dataset 으로 읽는다.
 *
 * 머무는 동안 아래에 막대가 차오르고(`dwell`, `HEAD_DWELL_MS`), 다 차면 건수 자리에 무엇이 될지
 * 적는다 — 예전에는 0.3초가 보이지 않아 왜 어떤 때는 바뀌고 어떤 때는 안 바뀌는지 알 수 없었다.
 */
function CategoryRow({
  row,
  forceOpen,
  drag,
  dim,
  dwell,
  target,
  onToggle,
  onNew,
  onMenu,
}: {
  row: CategoryNode & { open: boolean };
  forceOpen: boolean;
  drag: boolean;
  /** 끄는 업무가 든 묶음의 머리 — 놓아도 바뀔 것이 없다. */
  dim: boolean;
  /** 머무는 중 — 이 시각부터 막대가 찬다. 아니면 0. */
  dwell: number;
  /** 지금 놓으면 이 카테고리로 바뀐다(머물러 켜졌다). */
  target: boolean;
  onToggle: () => void;
  onNew: () => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const uncat = row.key === "";
  return (
    <Box
      data-cat-key={row.key}
      data-cat-path={row.path}
      data-flip={`cat:${row.key}`}
      onClick={onToggle}
      onContextMenu={onMenu}
      role="button"
      aria-expanded={row.open}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 23,
        borderRadius: 4,
        cursor: drag ? "grabbing" : forceOpen ? "default" : "pointer",
        userSelect: "none",
        paddingRight: 6,
        paddingLeft: 6 + (row.depth - 1) * 13,
        opacity: dim ? 0.45 : 1,
        // 탐색기에서 폴더 안으로 끌 때와 같은 강조.
        background: target ? "#e6eefc" : "transparent",
        boxShadow: target ? `inset 0 0 0 1px ${BLUE}` : "none",
        transition: "background-color 90ms, box-shadow 140ms, opacity 140ms",
      }}
      hover={drag || forceOpen ? undefined : { background: "#efece6" }}
    >
      <Chevron open={row.open} dim={forceOpen} />
      <span
        style={{
          fontSize: 12.5,
          fontWeight: 500,
          color: uncat ? "#8a857c" : "#4e4a43",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.name}
      </span>
      {target ? (
        <span className="cf-fade" style={{ fontSize: 11, fontWeight: 600, color: "#2f5cbb", whiteSpace: "nowrap" }}>
          {uncat ? "놓으면 미분류로" : `놓으면 ‘${row.name}’(으)로`}
        </span>
      ) : (
        <span
          data-cat-count
          style={{
            display: "inline-block",
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 11.5,
            color: "#6a665e",
            flex: "0 0 auto",
          }}
        >
          {row.count}
        </span>
      )}
      {uncat ? (
        // 미분류로 만드는 새 업무는 아래 [새 업무 추가] 와 같다. 개수 칸의 줄만 맞춘다.
        <span style={{ flex: "0 0 15px" }} />
      ) : (
        <Box
          onClick={(e) => {
            e.stopPropagation();
            onNew();
          }}
          title="이 카테고리로 새 업무"
          aria-label={`${row.name} 카테고리로 새 업무`}
          style={{
            flex: "0 0 15px",
            width: 15,
            height: 15,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 3,
            fontSize: 11,
            color: "#c5c0b6",
            cursor: "pointer",
            // 끄는 동안에는 감추되 자리는 남긴다 — 개수 칸이 옆으로 밀리지 않게.
            visibility: drag ? "hidden" : "visible",
          }}
          hover={{ background: "#e0dcd4", color: "#4e4a43" }}
        >
          ＋
        </Box>
      )}
      {dwell > 0 && !target && (
        <span
          key={dwell}
          aria-hidden
          className="cf-sweep"
          style={{
            position: "absolute",
            left: 6,
            right: 6,
            bottom: 1,
            height: 2,
            borderRadius: 1,
            background: BLUE,
            animationDuration: `${HEAD_DWELL_MS}ms`,
          }}
        />
      )}
    </Box>
  );
}

export default function Sidebar() {
  const s = useStore();
  const { tasks, settings, query, filter } = s;
  /**
   * 업무 목록은 워크스페이스 전용이다. 템플릿 · 보관함 · 설정 화면에서는 목록의
   * 선택 표시가 "지금 이 업무를 보고 있다"는 거짓말이 되므로, 목록을 흐리게 죽이고
   * 선택도 지운다. 아래 도크(새 업무 · 보관함 · 화면 전환)는 그대로 살려 둔다 —
   * 워크스페이스로 돌아오는 길이 여기에 있다.
   */
  const listActive = s.screen === "workspace";

  // 진행 중 · 보관 나누기는 검색어 · 필터와 따로 묶는다 — 카테고리 트리(`nodes`)가 키 입력마다
  // 다시 만들어지지 않게.
  const { live, archived } = useMemo(
    () => ({
      live: tasks.filter((t) => !isArchived(t, settings.archDays)),
      archived: tasks.filter((t) => isArchived(t, settings.archDays)),
    }),
    [tasks, settings.archDays],
  );
  const { visible, sideArch, counts } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const counts: Record<string, number> = { all: live.length, "in-progress": 0, "on-hold": 0 };
    live.forEach((t) => {
      const k = normalizeStatus(t.status);
      if (counts[k] !== undefined) counts[k]++;
    });
    const match = (t: (typeof tasks)[number]) => {
      // 카테고리는 저장 형태(`a/b`)와 화면 형태(`a › b`) 둘 다로 찾는다 — 화면의 라벨을 보고 친다.
      const cat = t.category ? `${t.category} ${label(t.category)}` : "";
      return `${t.title} ${t.tags.join(" ")} ${cat} ${t.relFolder} ${t.tagline}`.toLowerCase().includes(q);
    };
    const visible = live.filter((t) => {
      const st = normalizeStatus(t.status);
      if (filter !== "all" && st !== filter) return false;
      return !q || match(t);
    });
    const sideArch = q ? archived.filter(match) : [];
    return { visible, sideArch, counts };
  }, [live, archived, query, filter]);

  /**
   * 순서를 바꿀 수 있는 상태인가.
   *
   * 상태 필터가 걸려 있어도 끌 수 있다 — 놓은 자리를 **보이는 목록의 새 이웃**으로
   * 넘기므로(`reorderTask` 의 `scope`), 사이에 숨어 있던 업무들은 있던 자리에 남는다.
   *
   * 검색 중에는 막는다. 검색 결과는 목록의 한 조각이 아니라 여기저기서 걷어 온 것이라,
   * 옆에 보이는 업무가 실제 이웃이라는 보장이 없어 놓은 자리가 곧 결과가 되지 않는다.
   * 머리에 놓아 카테고리를 바꾸는 것도 같은 끌기라 함께 꺼진다.
   */
  const sortable = listActive && !query.trim();
  const drag = s.taskDrag;
  /** 끄는 중이다. Esc 로 취소한 끌기는 손을 뗄 때까지 남아 있지만, 끌지 않는 모양으로 그린다. */
  const dragOn = !!drag && !drag.esc;
  /**
   * 지금 놓으면 카테고리가 바뀔 머리의 키. 그때는 순서 선을 감추고 그 머리만 강조한다 — 판정은
   * 놓을 때(`up`)와 같은 `dropKind` 다.
   */
  const dropCat =
    dragOn &&
    drag.over &&
    dropKind({ at: drag.at, overKey: drag.over.key, group: drag.group, armed: drag.over.armed }) === "category"
      ? drag.over.key
      : null;
  /** 비켜 줄 자리. 카테고리 바꾸기가 켜지면 모두 제자리로 돌아간다. */
  const lineAt = dragOn && dropCat === null ? drag.at : -1;
  /**
   * 선택 표시가 가 있을 업무 — 누른 순간 옮긴다(`pendingFolder`). 앞 업무의 저장 · 스냅샷을 기다리는
   * 동안 예전 업무에 표시가 남아 있으면 눌렸는지 알 수 없었다.
   */
  const sel = listActive ? s.pendingFolder || s.activeFolder : "";
  /** 검색 중에는 접어 둔 묶음도 모두 펼쳐 보인다 — 찾은 업무가 접힌 머리 행 뒤에 숨지 않게. */
  const forceOpen = !!query.trim();

  /**
   * 카테고리 트리. 순서와 철자는 진행 중 업무 **전체**에서 만들고(`nodes`), 행은 보이는
   * 업무로 편다. 사이드바는 스토어 전체를 구독하므로 키 입력 · pointermove 마다 다시 펴지
   * 않게 묶어 둔다. `nodes` 가 있다 = 진행 중 업무에 카테고리가 하나라도 있다 — 상태
   * 필터로 보이는 것이 비어도 트리는 그대로 둔다.
   */
  const nodes = useMemo(() => knownCategories(live), [live]);
  const grouped = settings.sideGroup && nodes.length > 0;
  const rows = useMemo(
    () =>
      grouped ? flattenSideRows(visible, { nodes, closed: settings.catClosed, forceOpen }) : null,
    [grouped, visible, nodes, settings.catClosed, forceOpen],
  );
  const [viewMenu, setViewMenu] = useState(false);
  // 모두 접기 · 펼치기는 트리를 접을 수 있을 때만 쓴다.
  const bulkOff = !grouped
    ? "카테고리별로 묶었을 때만 쓸 수 있습니다"
    : forceOpen
      ? "검색 중에는 모두 펼쳐 보입니다"
      : "";
  const viewItems: {
    label: string;
    check?: boolean;
    /** 위에 구분선을 긋는다. */
    line?: boolean;
    /** 흐린 까닭(항목의 title). 비어 있지 않으면 흐리게 그리고 눌러도 아무 일도 없다. */
    off?: string;
    run: () => void;
  }[] = [
    {
      label: "카테고리별로 묶기",
      check: settings.sideGroup,
      run: () => s.patchSettings({ sideGroup: !settings.sideGroup }),
    },
    {
      label: "모두 접기",
      line: true,
      off: bulkOff,
      run: () =>
        s.patchSettings({
          catClosed: [...nodes.map((n) => n.key), ...(live.some((t) => !t.category) ? [""] : [])],
        }),
    },
    { label: "모두 펼치기", off: bulkOff, run: () => s.patchSettings({ catClosed: [] }) },
    {
      label: "카테고리 관리…",
      line: true,
      // 보고 있는 업무의 카테고리에서 연다 — 대개 그 묶음을 정리하려고 여는 것이다.
      run: () => s.openCatMgr(keyOf(tasks.find((t) => t.folder === s.activeFolder)?.category ?? null)),
    },
    // 전체 허브(`_index/카테고리.md`)를 연다 — 묶음 머리 메뉴는 그 카테고리의 허브를 연다. 이 ⋯ 는 진행 중
    // 업무에 카테고리가 있을 때만 보이므로 메뉴 띠의 업무 메뉴에도 같은 항목이 있다(`MenuBar`).
    { label: "카테고리 허브 열기", run: () => void openCategoryHub(null) },
  ];

  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * 지금 화면에 늘어서 있는 행들. 삽입 인덱스와 그 인덱스가 가리키는 목록을 **같은
   * 곳에서** 읽어야 둘이 어긋나지 않는다 — 렌더 클로저의 `visible` 은 드래그 중에
   * 낡을 수 있다.
   *
   * `group` 이 있으면 그 묶음의 행만이다. 셀렉터에 키를 넣지 않고 dataset 으로 거른다 —
   * 키는 사용자가 지은 이름이라 따옴표 · 역슬래시가 들어 있을 수 있다. 평평한 목록의
   * 행에는 `data-task-group` 이 없어 `undefined` 끼리 맞는다.
   */
  const rowsOnScreen = (group?: string) =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-task-folder]")).filter(
      (el) => el.dataset.taskGroup === group,
    );

  /**
   * 드롭 지점을 **삽입 인덱스**로 바꾼다. 행 중점을 넘었으면 그 아래 자리다.
   *
   * 묶음 안에서 끌 때는 첫 행 위 · 끝 행 아래로 반 행 넘게 벗어나면 `-1`(묶음 밖)이다. 끝 행
   * 아래 반 행은 바로 아래 묶음의 머리와 겹치므로, 놓을 때는 머리 판정이 먼저다(`dropKind`).
   * 머리가 아닌 묶음 밖에 놓으면 아무것도 하지 않는다.
   */
  const insertAt = (y: number, group?: string): number => {
    const rows = rowsOnScreen(group);
    if (group !== undefined && rows.length) {
      const first = slot(rows[0]);
      const last = slot(rows[rows.length - 1]);
      if (y < first.top - first.height / 2 || y > last.bottom + last.height / 2) return -1;
    }
    for (let i = 0; i < rows.length; i++) {
      const r = slot(rows[i]);
      if (y < r.top + r.height / 2) return i;
    }
    return rows.length;
  };

  /**
   * 행이 **놓인** 자리(화면 좌표). 끄는 동안 행들은 자리를 비켜 주며 `transform` 으로 움직이는데,
   * `getBoundingClientRect` 로 재면 비켜 준 자리를 다시 재어 삽입 지점이 흔들린다. 그래서 움직임에
   * 상관없는 `offsetTop` 으로 잰다(목록이 행들의 기준 상자다 — `position: relative`).
   */
  const slot = (el: HTMLElement) => {
    const list = listRef.current;
    if (!list || el.offsetParent !== list) return el.getBoundingClientRect();
    const top = list.getBoundingClientRect().top + list.clientTop - list.scrollTop + el.offsetTop;
    return { top, height: el.offsetHeight, bottom: top + el.offsetHeight };
  };

  /**
   * 끌기를 시작한 자리 — 목록 안 좌표(스크롤을 더한 값)와 행 한 칸의 높이. 손을 따라 떠오르는 거리와
   * 이웃이 비켜 줄 거리를 여기서 잰다. 자동 스크롤이 돌아도 행이 손에서 떨어지지 않는다.
   */
  const grab = useRef<{ y0: number; h: number }>({ y0: 0, h: 0 });
  const { startPress, holding } = useLongPress<TaskPress>((press, { x, y }) => {
    const list = listRef.current;
    const row = rowsOnScreen(press.group).find((el) => el.dataset.taskFolder === press.folder);
    if (list && row) {
      grab.current = { y0: y - list.getBoundingClientRect().top + list.scrollTop, h: row.offsetHeight + 1 };
    }
    s.set({ taskDrag: { ...press, x, y, at: insertAt(y, press.group), over: null } });
  });
  /** 방금 옮겨 놓은 행 — 한 번 파랗게 빛난다(`cf-flash`). */
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(""), 950);
    return () => window.clearTimeout(t);
  }, [flash]);
  const { markDropped, justDropped } = useDropGuard();

  const pick = (folder: string) => {
    if (justDropped()) return;
    void s.selectTask(folder);
  };
  // 업무 행 우클릭 — 카테고리 머리와 같은 까닭으로 끄는 중 · 놓은 직후는 무시하고, 웹뷰 기본 메뉴는 늘 막는다.
  const openTaskMenu = (e: React.MouseEvent, folder: string) => {
    e.preventDefault();
    if (drag || justDropped()) return;
    s.set({ taskCtx: { x: e.clientX, y: e.clientY, folder } });
  };
  // 사이드바 버튼 · 카테고리 머리 행의 ＋ 가 같은 빈 칸으로 연다(카테고리만 다르다).
  const openNew = (category?: string) =>
    s.set({ newOpen: true, nt: emptyNewTask(category), ntRecs: [], recTag: {}, ntRefs: [] });

  /**
   * 드래그가 살아 있는 동안만 붙는 리스너. 탐색기와 같은 이유로 `[!!drag]` 에만
   * 의존한다 — 좌표가 바뀔 때마다 다시 붙이면 이벤트가 새고 포인터 캡처도 놓친다.
   */
  useEffect(() => {
    if (!drag) return;
    // 최신 좌표는 ref 가 아니라 이 지역 값으로 든다. 자동 스크롤 타이머도 같은 값을 본다.
    const pos = { x: drag.x, y: drag.y };

    /**
     * 포인터 아래의 묶음 머리. 목록 안에서만 본다 — 목록 밖에 놓으면 카테고리는 그대로다.
     * 포인터를 잡아 둔 동안에도 `elementFromPoint` 는 실제로 그 아래 있는 요소를 준다
     * (탐색기의 `folderAt` 과 같다).
     */
    const catAt = (x: number, y: number): { key: string; path: string } | null => {
      const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-cat-key]");
      if (!hit || !listRef.current?.contains(hit)) return null;
      return { key: hit.dataset.catKey ?? "", path: hit.dataset.catPath ?? "" };
    };

    const sync = () => {
      const st = useStore.getState();
      const d = st.taskDrag;
      if (!d || d.esc) return;
      const hit = catAt(pos.x, pos.y);
      // 머문 시각은 머리가 바뀔 때만 새로 잡는다 — 그 머리 안에서 움직여도 이어서 센다.
      const over = !hit
        ? null
        : d.over?.key === hit.key
          ? d.over
          : { ...hit, since: Date.now(), armed: false };
      st.set({ taskDrag: { ...d, x: pos.x, y: pos.y, at: insertAt(pos.y, d.group), over } });
    };
    const move = (e: PointerEvent) => {
      pos.x = e.clientX;
      pos.y = e.clientY;
      sync();
    };
    const up = () => {
      const st = useStore.getState();
      const d = st.taskDrag;
      // 놓은 자리(`at`)가 가리키는 것은 **보이던 목록**의 칸이다. 상태 필터가 걸려 있으면
      // 그것이 전체의 부분집합이라, 그 목록을 함께 넘겨야 자리를 옳게 읽는다. 묶었을 때는
      // 그 묶음의 행들이 곧 보이던 목록이다 — 다른 묶음의 업무는 있던 자리에 남는다.
      const scope = rowsOnScreen(d?.group).map((el) => el.getAttribute("data-task-folder") ?? "");
      st.set({ taskDrag: null });
      // Esc 로 취소한 끌기도 여기까지 와서 뒤따르는 click 을 삼킨다.
      markDropped();
      if (!d || d.esc) return;
      const kind = dropKind({
        at: d.at,
        overKey: d.over?.key ?? null,
        group: d.group,
        armed: !!d.over?.armed,
      });
      if (kind === "category" && d.over) {
        const key = d.over.key;
        void st.dropOnCategory(d.folder, d.over.path).then(() => {
          // 들어간 묶음의 건수가 한 번 튀고, 옮긴 행이 그 묶음 안에서 빛난다.
          const head = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-cat-key]") ?? []).find(
            (el) => el.dataset.catKey === key,
          );
          bump(head?.querySelector("[data-cat-count]"));
          setFlash(d.folder);
        });
        return;
      }
      // 묶음 밖에 놓았다 — 취소다(아무것도 쓰지 않는다).
      if (kind !== "reorder") return;
      // 제자리도 취소다. 보이던 목록 사이사이에 다른 묶음 · 걸러진 업무가 끼어 있으면, 그대로
      // 넘길 때 `reorderedList` 가 다음 이웃 바로 앞으로 당겨 순서를 다시 쓴다(아무것도 끼지
      // 않은 목록에서는 원래 null 이라 달라지는 것이 없다).
      const from = scope.indexOf(d.folder);
      if (d.at === from || d.at === from + 1) return;
      setFlash(d.folder);
      void st.reorderTask(d.folder, d.at, scope);
    };
    /**
     * Esc 는 끌기를 취소한다. capture 단계에서 먼저 받아 `preventDefault()` 하므로, 겹친 레이어를
     * 닫는 App 의 Esc 사슬은 `defaultPrevented` 를 보고 빠진다. 끌기는 지우지 않고 취소 표시만
     * 남긴다(`TaskDrag.esc`) — 손을 뗄 때 `up` 이 뒤따르는 click 을 삼켜야 업무가 열리지 않는다.
     */
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const st = useStore.getState();
      const d = st.taskDrag;
      if (d && !d.esc) st.set({ taskDrag: { ...d, esc: true, at: -1, over: null } });
    };

    // 목록 가장자리에서는 스스로 스크롤한다. 사이드바 목록은 스크롤 컨테이너라
    // 이게 없으면 화면 밖 자리로는 옮길 수 없다. pointermove 는 커서가 멈추면 오지
    // 않으므로, 가장자리에 대고 가만히 있어도 계속 밀리도록 타이머로 돌린다.
    // 같은 까닭으로 머리 위에 가만히 머문 시간도 이 타이머가 잰다.
    const scroller = window.setInterval(() => {
      const st = useStore.getState();
      const d = st.taskDrag;
      if (!d || d.esc) return;
      if (d.over && !d.over.armed && Date.now() - d.over.since >= HEAD_DWELL_MS) {
        st.set({ taskDrag: { ...d, over: { ...d.over, armed: true } } });
      }
      const el = listRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const EDGE = 26;
      const step = pos.y < r.top + EDGE ? -14 : pos.y > r.bottom - EDGE ? 14 : 0;
      if (!step) return;
      const before = el.scrollTop;
      el.scrollTop += step;
      // 실제로 움직였을 때만 다시 센다 — 끝에 닿으면 삽입 지점도 그대로다.
      if (el.scrollTop !== before) sync();
    }, 50);

    // 휠로 목록을 굴리면 pointermove 없이 손 밑의 행 · 머리가 바뀐다. 다시 세지 않으면 이미 지나간
    // 머리가 그대로 무르익어(`armed`) 손이 가리키지 않는 카테고리로 바뀐다.
    const list = listRef.current;
    list?.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
    return () => {
      list?.removeEventListener("scroll", sync);
      window.clearInterval(scroller);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag]);

  /**
   * 열린 업무의 묶음을 펼치고 그 행을 보이게 한다. 서명이 바뀔 때만 돈다 — 다른 업무를
   * 고르거나, 재개로 다시 진행 중이 되거나(태그 모드에서는 `activeFolder` 가 그대로다),
   * 카테고리가 바뀌거나, 묶어 보기를 켰을 때다. 열기만 하고 닫지는 않는다.
   *
   * 부팅이 끝나기 전에는 하지 않는다. 앱을 켤 때 자동으로 고른 첫 업무의 묶음까지 펼치면,
   * 접어 둔 것이 재시작할 때마다 풀린다. `ready` 를 deps 에 넣지 않는 것도 그래서다 — 부팅이
   * 끝나는 순간 다시 돌면 같은 일이 된다.
   *
   * 한 번 펼친 서명은 기억해 다시 펼치지 않는다. 검색하는 동안은 미뤘다가 검색을 지운 뒤에
   * 하는데, 그때 같은 업무를 또 펼치면 사용자가 일부러 접어 둔 묶음이 풀린다.
   */
  const active = grouped ? live.find((t) => t.folder === s.activeFolder) : undefined;
  const revealSig = active ? `${active.folder}\0${keyOf(active.category)}` : "";
  const shown = useRef("");
  useEffect(() => {
    // 묶어 보기를 끄거나 업무가 진행 중에서 빠지면 잊는다 — 다시 켜거나 재개하면 펼친다.
    if (!active) {
      shown.current = "";
      return;
    }
    if (forceOpen || shown.current === revealSig) return;
    shown.current = revealSig;
    const st = useStore.getState();
    if (!st.ready) return;
    const next = openFor(st.settings.catClosed, active.category);
    if (next) st.patchSettings({ catClosed: next });
    // 펼친 행이 그려진 다음 프레임에 찾는다.
    const frame = requestAnimationFrame(() => {
      Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-task-folder]") ?? [])
        .find((el) => el.dataset.taskFolder === active.folder)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSig, forceOpen]);

  /**
   * 이웃이 비켜 줄 거리. 끄는 행은 원래 칸을 그대로 차지하고 있으므로(목록은 다시 흐르지 않는다), 그
   * 칸과 놓을 자리 사이의 행만 한 칸씩 당기거나 민다 — 놓을 자리에 빈칸이 열리고, 묶음 밖의 행 ·
   * 머리는 움직이지 않는다. 예전에는 행 사이에 2px 선만 그었다.
   */
  const shifts = new Map<string, number>();
  if (dragOn && lineAt >= 0 && grab.current.h) {
    const order = rows
      ? rows.flatMap((r) => (r.kind === "task" && r.group === drag.group ? [r.task.folder] : []))
      : visible.map((t) => t.folder);
    const from = order.indexOf(drag.folder);
    order.forEach((f, i) => {
      if (from < 0 || i === from) return;
      if (from < i && i < lineAt) shifts.set(f, -grab.current.h);
      else if (lineAt <= i && i < from) shifts.set(f, grab.current.h);
    });
  }
  const list = listRef.current;
  const lift =
    dragOn && list ? drag.y - list.getBoundingClientRect().top + list.scrollTop - grab.current.y0 : 0;
  const overHead = dragOn && drag.over && drag.over.key !== drag.group ? drag.over : null;
  const headName = overHead
    ? overHead.key === ""
      ? "미분류"
      : (rows?.find((r) => r.kind === "cat" && r.key === overHead.key) as { name?: string } | undefined)?.name ??
        label(overHead.path)
    : "";
  const verdict: Verdict | null = !dragOn
    ? null
    : overHead
      ? overHead.armed
        ? { kind: "armed", name: headName }
        : { kind: "dwell", name: headName, since: overHead.since }
      : drag.at < 0
        ? { kind: "cancel" }
        : null;

  // 순서가 바뀌거나(놓기 · Alt+↑↓ · 다른 창의 고침) 거르기 · 접기로 행이 빠지고 들면 옛 자리에서 미끄러진다.
  // 끌기가 끝나는 순간도 센다 — 제자리에 놓거나 취소한 행이 손에서 원래 칸으로 돌아간다.
  const flipKey = `${dragOn ? "d|" : ""}${
    rows
      ? rows.map((r) => (r.kind === "cat" ? `c:${r.key}` : r.task.folder)).join("|")
      : visible.map((t) => t.folder).join("|")
  }`;
  useFlip(listRef, flipKey, { enter: true });

  /**
   * 선택 알약 — 고른 행 밑에 깔린 흰 바탕 하나가 그 행으로 미끄러진다. 행마다 바탕을 켜고 끄면 눈이
   * 어디서 어디로 옮겨 갔는지를 따라가지 못한다. 자리는 행의 `offsetTop`(+ 비켜 준 거리)로 잡는다.
   * 처음 나타날 때는 미끄러지지 않고 그 자리에서 떠오른다.
   */
  const pillRef = useRef<HTMLDivElement | null>(null);
  const pillOn = useRef(false);
  const selTask = sel ? live.find((t) => t.folder === sel) : undefined;
  const pillColor = selTask ? statusOf(selTask.status).dot : BLUE;
  const selShift = shifts.get(sel) ?? 0;
  const selDragging = dragOn && drag.folder === sel;
  useLayoutEffect(() => {
    const pill = pillRef.current;
    const box = listRef.current;
    if (!pill || !box) return;
    const row = sel
      ? Array.from(box.querySelectorAll<HTMLElement>("[data-task-folder]")).find((el) => el.dataset.taskFolder === sel)
      : undefined;
    if (!row || selDragging) {
      pill.style.opacity = "0";
      pillOn.current = false;
      return;
    }
    const moving = pillOn.current && !reducedMotion();
    pill.style.transition = moving
      ? `transform var(--m-base) ${EASE_OUT}, height var(--m-base) ${EASE_OUT}, border-color var(--m-base), opacity 140ms`
      : "opacity 140ms";
    pill.style.transform = `translateY(${row.offsetTop + selShift}px)`;
    pill.style.left = `${row.offsetLeft}px`;
    pill.style.width = `${row.offsetWidth}px`;
    pill.style.height = `${row.offsetHeight}px`;
    pill.style.borderLeftColor = pillColor;
    pill.style.opacity = "1";
    pillOn.current = true;
  });

  /**
   * 키보드 — ↑↓ 로 행 사이를 옮겨 다니고 Enter 로 연다. Alt+↑↓ 는 그 업무를 한 칸 옮긴다(끌기와 같은
   * `reorderTask`). 끌기는 1초 누르기가 필요해 손이 불편하면 순서를 바꿀 길이 없었다. Tab 으로 들어오면
   * 고른 행에 닿는다(목록 전체가 한 번의 Tab).
   */
  const focusRow = (folder: string) =>
    requestAnimationFrame(() =>
      Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-task-folder]") ?? [])
        .find((el) => el.dataset.taskFolder === folder)
        ?.focus({ preventScroll: false }),
    );
  const onListKey = (e: React.KeyboardEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-task-folder]");
    if (!el || drag) return;
    const folder = el.dataset.taskFolder ?? "";
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(folder);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const up = e.key === "ArrowUp";
    if (e.altKey) {
      if (!sortable) return;
      const scope = rowsOnScreen(el.dataset.taskGroup).map((r) => r.dataset.taskFolder ?? "");
      const from = scope.indexOf(folder);
      // 삽입 인덱스다 — 아래로 한 칸은 다음 행의 뒤(`from + 2`).
      const at = up ? from - 1 : from + 2;
      if (from < 0 || at < 0 || at > scope.length) return;
      setFlash(folder);
      void s.reorderTask(folder, at, scope);
      focusRow(folder);
      return;
    }
    const all = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-task-folder]") ?? []);
    all[all.indexOf(el) + (up ? -1 : 1)]?.focus();
  };
  // Tab 으로 닿을 행 — 고른 업무, 보이지 않으면 맨 위.
  const shownFolders = rows ? rows.flatMap((r) => (r.kind === "task" ? [r.task.folder] : [])) : visible.map((t) => t.folder);
  const tabStop = shownFolders.includes(sel) ? sel : shownFolders[0];

  /**
   * 접고 펴기. 예전에는 250px 이 한 프레임에 34px 로 바뀌어 옆의 작업공간이 통째로 튀었다. 폭이
   * 미끄러지는 동안 넓은 판은 먼저 흐려지고 좁은 띠가 늦게 떠오른다(펼 때는 그 반대). 끌어서 폭을
   * 바꿀 때는 손을 따라야 하므로, 전환은 접기 · 펴기를 누른 그 한 번에만 건다.
   */
  const min = s.sidebarMin;
  const [prevMin, setPrevMin] = useState(min);
  const [toggling, setToggling] = useState(false);
  if (prevMin !== min) {
    setPrevMin(min);
    setToggling(true);
  }
  useEffect(() => {
    if (!toggling) return;
    const t = window.setTimeout(() => setToggling(false), 320);
    return () => window.clearTimeout(t);
  }, [toggling]);
  const W = Math.round(s.sidebarW);

  // 오른쪽 위 업무 리스트 묶음 보기 메뉴 · 필터 알약의 자리.
  const fi = FILTERS.findIndex(([k]) => k === filter);

  return (
    <div
      className="cf-mv"
      style={{
        flex: "0 0 auto",
        minWidth: 0,
        position: "relative",
        overflow: "hidden",
        background: "#f5f3ef",
        borderRight: "1px solid #e0dcd4",
        width: min ? 34 : W,
        transition: toggling ? `width var(--m-screen) ${EASE_OUT}` : "none",
      }}
    >
      <div
        inert={min}
        aria-hidden={min || undefined}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: W - 1,
          display: "flex",
          flexDirection: "column",
          opacity: min ? 0 : 1,
          transition: toggling ? (min ? "opacity 90ms" : "opacity 140ms 80ms") : "none",
        }}
      >
        <div
          style={{
            height: 30,
            flex: "0 0 30px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 6px 0 11px",
            borderBottom: "1px solid #e6e2da",
            position: "relative",
          }}
        >
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: ".6px",
              color: "#6a665e",
              flex: 1,
              minWidth: 0,
              // 최소 폭(196px)에서 버튼이 하나 늘어도 두 줄로 꺾이지 않게.
              whiteSpace: "nowrap",
            }}
          >
            업무 리스트
          </span>
          <span
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11,
              color: "#9b968c",
              flex: "0 0 auto",
            }}
          >
            {live.length}개
          </span>
          {/* 묶어 보기를 꺼도 남는다 — 다시 켜는 곳이 여기뿐이다. */}
          {nodes.length > 0 && (
            <Box
              onClick={() => setViewMenu(!viewMenu)}
              role="button"
              aria-haspopup="menu"
              aria-expanded={viewMenu}
              title="카테고리 보기"
              style={{
                flex: "0 0 17px",
                width: 17,
                height: 17,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 3,
                cursor: "pointer",
                color: "#8a857c",
                fontSize: 12,
                lineHeight: 1,
                background: viewMenu ? "#e6e2da" : "transparent",
              }}
              hover={{ background: "#e6e2da", color: "#3a3630" }}
            >
              ⋯
            </Box>
          )}
          {viewMenu && nodes.length > 0 && (
            <Popover onClose={() => setViewMenu(false)} origin="top right" style={{ top: 28, right: 6, minWidth: 172 }}>
              {viewItems.map((it) => (
                <Fragment key={it.label}>
                  {it.line && <div style={{ height: 1, background: "#f0ede7", margin: "3px 0" }} />}
                  <Box
                    role="menuitemcheckbox"
                    aria-checked={it.check}
                    aria-disabled={!!it.off || undefined}
                    onClick={() => {
                      if (it.off) return;
                      setViewMenu(false);
                      it.run();
                    }}
                    title={it.off || undefined}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 4,
                      cursor: it.off ? "default" : "pointer",
                      fontSize: 12.5,
                      color: it.off ? "#b5afa2" : "#3a3630",
                      whiteSpace: "nowrap",
                    }}
                    hover={it.off ? undefined : { background: "#f2efe9" }}
                  >
                    <span style={{ flex: "0 0 10px", fontSize: 11 }}>{it.check ? "✓" : ""}</span>
                    <span style={{ flex: 1 }}>{it.label}</span>
                  </Box>
                </Fragment>
              ))}
            </Popover>
          )}
          <Box
            onClick={() => s.set({ sidebarMin: true })}
            role="button"
            title="업무 리스트 접기"
            aria-label="업무 리스트 접기"
            style={{
              flex: "0 0 17px",
              width: 17,
              height: 17,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 3,
              cursor: "pointer",
              color: "#8a857c",
              fontSize: 12,
              lineHeight: 1,
            }}
            hover={{ background: "#e6e2da", color: "#3a3630" }}
          >
            –
          </Box>
        </div>

        <div
          style={{
            padding: "8px 9px 6px 9px",
            display: "flex",
            flexDirection: "column",
            gap: 7,
            opacity: listActive ? 1 : 0.42,
            pointerEvents: listActive ? "auto" : "none",
            transition: "opacity 140ms",
          }}
        >
          <Input
            value={query}
            disabled={!listActive}
            onChange={(e) => s.set({ query: e.target.value })}
            placeholder="업무 · 태그 · 경로 검색"
            style={{
              height: 26,
              border: "1px solid #ddd8cf",
              borderRadius: 5,
              background: "#fff",
              padding: "0 8px",
              fontSize: 12.5,
              color: "#23211e",
              outline: "none",
            }}
            focusStyle={{ borderColor: "#3a6fd8", boxShadow: "0 0 0 2px #e6eefc" }}
          />
          {/* 고른 칸 밑의 흰 알약이 옆 칸으로 미끄러진다 — 칸마다 테두리를 켜고 끄던 것. */}
          <div role="radiogroup" aria-label="상태 필터" style={{ position: "relative", display: "flex", gap: 4 }}>
            <div
              aria-hidden
              className="cf-mv"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                height: 21,
                width: "calc((100% - 8px) / 3)",
                transform: `translateX(calc(${Math.max(fi, 0) * 100}% + ${Math.max(fi, 0) * 4}px))`,
                opacity: fi < 0 ? 0 : 1,
                transition: `transform var(--m-base) ${EASE_OUT}, opacity 140ms`,
                background: "#fff",
                border: "1px solid #d9d4ca",
                borderRadius: 4,
                boxShadow: "0 1px 2px rgba(35,33,30,.06)",
              }}
            />
            {FILTERS.map(([k, label]) => {
              const on = filter === k;
              return (
                <Box
                  key={k}
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  className="cf-focus"
                  onClick={() => s.set({ filter: k })}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    const n = FILTERS.length;
                    const next = FILTERS[(Math.max(fi, 0) + (e.key === "ArrowLeft" ? n - 1 : 1)) % n][0];
                    s.set({ filter: next });
                    const box = e.currentTarget.parentElement;
                    requestAnimationFrame(() => box?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
                  }}
                  style={{
                    position: "relative",
                    flex: 1,
                    textAlign: "center",
                    fontSize: 11.5,
                    lineHeight: "21px",
                    height: 21,
                    borderRadius: 4,
                    cursor: "pointer",
                    userSelect: "none",
                    color: on ? "#23211e" : "#6a665e",
                    fontWeight: on ? 600 : 400,
                  }}
                  hover={on ? undefined : { color: "#3a3630", background: "rgba(35,33,30,.04)" }}
                >
                  {label} {counts[k]}
                </Box>
              );
            })}
          </div>
          {/* 순서를 정해 둔 사용자가 검색을 켠 채 끌어 보고 "왜 안 되지" 하는 것을 막는다.
              한 번도 순서를 바꾼 적 없으면 알릴 것도 없으므로 띄우지 않는다. */}
          {listActive && !sortable && live.some((t) => t.order !== null) && (
            <div className="cf-fade" style={{ fontSize: 11, color: "#6a665e", lineHeight: 1.5 }}>
              검색 중에는 순서를 바꿀 수 없습니다
            </div>
          )}
        </div>

        <div
          ref={listRef}
          data-task-list
          role="listbox"
          aria-label="업무 리스트"
          onKeyDown={onListKey}
          style={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "2px 6px 8px 6px",
            opacity: listActive ? 1 : 0.42,
            pointerEvents: listActive ? "auto" : "none",
            transition: "opacity 140ms",
            // 드래그 중에는 텍스트가 잡히지 않게 한다.
            userSelect: drag ? "none" : undefined,
          }}
        >
          <div
            ref={pillRef}
            aria-hidden
            className="cf-mv"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              opacity: 0,
              borderRadius: 5,
              borderLeft: `2px solid ${BLUE}`,
              background: "#fff",
              boxShadow: "0 1px 2px rgba(35,33,30,.10)",
              pointerEvents: "none",
            }}
          />
          {!listActive && (
            <div
              style={{
                padding: "5px 7px 8px 7px",
                fontSize: 11.5,
                color: "#6a665e",
                lineHeight: 1.6,
              }}
            >
              워크스페이스에서 업무를 선택할 수 있습니다
            </div>
          )}
          {/* 묶지 않았으면 지금까지의 평평한 목록 그대로다 — 자리는 보이는 목록 전체의 인덱스. */}
          {!rows &&
            visible.map((t) => {
              const dragging = dragOn && drag.folder === t.folder;
              return (
                <TaskRow
                  key={t.folder}
                  task={t}
                  on={t.folder === sel}
                  drag={dragOn}
                  dragging={dragging}
                  dim={false}
                  shift={shifts.get(t.folder) ?? 0}
                  lift={dragging ? lift : 0}
                  verdict={dragging ? verdict : null}
                  holding={holding?.folder === t.folder && !drag}
                  flash={flash === t.folder && !drag}
                  focusable={t.folder === tabStop}
                  indent={0}
                  showCategory
                  sortable={sortable}
                  startPress={startPress}
                  onClick={() => pick(t.folder)}
                  onMenu={(e) => openTaskMenu(e, t.folder)}
                />
              );
            })}
          {rows?.map((r) => {
            if (r.kind === "cat") {
              const over = dragOn && drag.over?.key === r.key && r.key !== drag.group ? drag.over : null;
              return (
                <CategoryRow
                  key={`cat:${r.key}`}
                  row={r}
                  forceOpen={forceOpen}
                  drag={dragOn}
                  // 다른 묶음의 머리는 놓을 곳이라 그대로 둔다. 자기 묶음의 머리만 흐리게 — 거기 놓아도
                  // 바뀔 것이 없다.
                  dim={dragOn && r.key === drag.group}
                  dwell={over && !over.armed ? over.since : 0}
                  target={dropCat === r.key}
                  onToggle={() => {
                    if (justDropped() || forceOpen) return;
                    s.patchSettings({
                      catClosed: r.open
                        ? [...settings.catClosed, r.key]
                        : settings.catClosed.filter((k) => k !== r.key),
                    });
                  }}
                  onNew={() => openNew(r.path)}
                  // 놓은 직후의 우클릭도 접기와 같은 까닭으로 무시한다. 웹뷰 기본 메뉴는 늘 막는다.
                  onMenu={(e) => {
                    e.preventDefault();
                    if (drag || justDropped()) return;
                    s.set({ catCtx: { x: e.clientX, y: e.clientY, key: r.key, path: r.path } });
                  }}
                />
              );
            }
            const t = r.task;
            // 업무 행 사이에 놓을 수 있는 곳은 끄는 업무와 같은 묶음뿐이다. 다른 묶음으로는 그 머리에 놓는다.
            const here = dragOn && drag.group === r.group;
            const dragging = dragOn && drag.folder === t.folder;
            return (
              <TaskRow
                key={t.folder}
                task={t}
                on={t.folder === sel}
                drag={dragOn}
                dragging={dragging}
                dim={dragOn && !here}
                shift={shifts.get(t.folder) ?? 0}
                lift={dragging ? lift : 0}
                verdict={dragging ? verdict : null}
                holding={holding?.folder === t.folder && !drag}
                flash={flash === t.folder && !drag}
                focusable={t.folder === tabStop}
                indent={r.depth * 13}
                showCategory={false}
                group={r.group}
                sortable={sortable}
                startPress={startPress}
                onClick={() => pick(t.folder)}
                onMenu={(e) => openTaskMenu(e, t.folder)}
              />
            );
          })}

          {visible.length === 0 && sideArch.length === 0 && (
            <div
              className="cf-fade"
              style={{
                padding: "22px 12px",
                textAlign: "center",
                fontSize: 12.5,
                color: "#8a857c",
                lineHeight: 1.6,
              }}
            >
              조건에 맞는 업무가 없습니다.
              <br />
              보관함까지 찾으려면 아래 보관함을 열어보세요.
            </div>
          )}

          {sideArch.length > 0 && (
            <div className="cf-enter" style={{ marginTop: 9, padding: "0 2px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <div style={{ flex: 1, height: 1, background: "#e0dcd4" }} />
                <span
                  style={{
                    fontSize: 11,
                    letterSpacing: ".3px",
                    color: "#6a665e",
                    whiteSpace: "nowrap",
                  }}
                >
                  보관함 {sideArch.length}건
                </span>
                <div style={{ flex: 1, height: 1, background: "#e0dcd4" }} />
              </div>
              {sideArch.slice(0, 4).map((t) => (
                <Box
                  key={t.folder}
                  onClick={() => void s.peekArchived(t.folder)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "6px 7px",
                    borderRadius: 5,
                    cursor: "pointer",
                    marginBottom: 1,
                  }}
                  hover={{ background: "#ece8e0" }}
                >
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flex: "0 0 7px",
                      border: "1px solid #c5c0b6",
                      background: "#e6e2da",
                    }}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        lineHeight: "16px",
                        color: "#7d7871",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.title}
                    </div>
                    <div
                      style={{
                        fontFamily: "'Roboto Mono',monospace",
                        fontSize: 11.5,
                        color: "#6a665e",
                        marginTop: 1,
                      }}
                    >
                      완료 {(t.completedAt ?? "").slice(2)}
                    </div>
                  </div>
                  {/* 조작은 파랑이다 — 보라는 AI 가 일하는 중에만 쓴다. */}
                  <Box
                    onClick={(e) => {
                      e.stopPropagation();
                      void s.restoreTask(t.folder);
                    }}
                    role="button"
                    style={{
                      flex: "0 0 auto",
                      fontSize: 11,
                      color: "#2f5cbb",
                      background: "#eef3fd",
                      border: "1px solid #cddcf8",
                      borderRadius: 3,
                      padding: "2px 6px",
                    }}
                    hover={{ background: "#e2ebfc" }}
                  >
                    재개
                  </Box>
                </Box>
              ))}
              <Box
                // 카테고리 거르기도 푼다 — 약속한 n건이 그대로 보여야 한다.
                onClick={() =>
                  s.set({ screen: "archive", archQuery: query.trim(), archOpen: "", archCat: null })
                }
                style={{ fontSize: 11.5, color: "#3a6fd8", cursor: "pointer", padding: "5px 7px" }}
                hover={{ textDecoration: "underline" }}
              >
                {sideArch.length > 4
                  ? `보관함에서 ${sideArch.length}건 모두 보기 →`
                  : "보관함에서 열기 →"}
              </Box>
            </div>
          )}
        </div>

        <div
          style={{
            flex: "0 0 auto",
            borderTop: "1px solid #e6e2da",
            padding: "8px 9px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <TodayDock />
          <Box
            onClick={() => openNew()}
            role="button"
            title="새 업무 추가 (Ctrl+N)"
            style={{
              height: 28,
              borderRadius: 5,
              background: "#3a6fd8",
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              cursor: "pointer",
            }}
            hover={{ background: "#2f5cbb" }}
          >
            <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> 새 업무 추가
          </Box>
          <Box
            data-dock="archive"
            onClick={() => s.setScreen("archive")}
            role="button"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              height: 25,
              padding: "0 8px",
              borderRadius: 4,
              cursor: "pointer",
              background: s.screen === "archive" ? "#fff" : "#ebe7df",
              border: s.screen === "archive" ? "1px solid #d9d4ca" : "1px solid transparent",
            }}
            hover={{ background: s.screen === "archive" ? "#fff" : "#e2ded4" }}
          >
            <div
              style={{
                width: 9,
                height: 7,
                borderRadius: "1px 2px 2px 2px",
                background: "#cfcabf",
                flex: "0 0 9px",
              }}
            />
            <span style={{ fontSize: 11.5, color: "#6a665e", flex: 1, minWidth: 0 }}>보관함</span>
            <span
              data-dock-count
              style={{
                display: "inline-block",
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11,
                color: "#6a665e",
                flex: "0 0 auto",
              }}
            >
              {archived.length}개
            </span>
          </Box>
          <WikiDock />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {NAV.map(([k, label]) => {
              const on = s.screen === k;
              return (
                <Box
                  key={k}
                  onClick={() => s.setScreen(k)}
                  role="button"
                  aria-current={on ? "page" : undefined}
                  style={{
                    height: 24,
                    borderRadius: 4,
                    fontSize: 11.5,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    border: `1px solid ${on ? "#d9d4ca" : "#e6e2da"}`,
                    background: on ? "#fff" : "transparent",
                    color: on ? "#23211e" : "#6a665e",
                    fontWeight: on ? 600 : 400,
                  }}
                  hover={on ? undefined : { background: "#ece8e0", color: "#3a3630" }}
                >
                  {label}
                </Box>
              );
            })}
          </div>
        </div>
      </div>

      {/* 접었을 때의 띠 — 펼치기와, 업무마다 상태 점 하나. 점을 누르면 펼치지 않고도 그 업무로 간다. */}
      <div
        inert={!min}
        aria-hidden={!min || undefined}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: 33,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          opacity: min ? 1 : 0,
          pointerEvents: min ? undefined : "none",
          transition: toggling ? (min ? "opacity 140ms 110ms" : "opacity 90ms") : "none",
        }}
      >
        <Box
          onClick={() => s.set({ sidebarMin: false })}
          role="button"
          title="업무 리스트 펼치기"
          aria-label="업무 리스트 펼치기"
          style={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 11,
            padding: "10px 0 9px",
            cursor: "pointer",
            flex: "0 0 auto",
          }}
          hover={{ background: "#ece8e0" }}
        >
          <Chevron open={false} />
          <span
            style={{
              writingMode: "vertical-rl",
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: 1,
              color: "#6a665e",
            }}
          >
            업무 리스트
          </span>
          <span
            style={{
              writingMode: "vertical-rl",
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              color: "#6a665e",
            }}
          >
            {live.length}개
          </span>
        </Box>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            width: "100%",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
            padding: "6px 0 10px",
            borderTop: "1px solid #e6e2da",
            // 33px 띠에 스크롤바 자리(11px)를 잡으면 점이 가운데서 밀린다 — 휠로만 굴린다.
            scrollbarWidth: "none",
            opacity: listActive ? 1 : 0.42,
            pointerEvents: listActive ? undefined : "none",
          }}
        >
          {live.map((t) => {
            const dot = statusOf(t.status).dot;
            const on = t.folder === sel;
            return (
              <Box
                key={t.folder}
                onClick={() => pick(t.folder)}
                role="button"
                title={t.title}
                aria-label={`${t.title} 열기`}
                aria-current={on || undefined}
                style={{
                  flex: "0 0 20px",
                  width: 20,
                  height: 20,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
                hover={{ background: "#e6e2da" }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: dot,
                    boxShadow: on ? `0 0 0 2px #f5f3ef, 0 0 0 3.5px ${dot}` : "none",
                    transition: "box-shadow var(--m-base)",
                  }}
                />
              </Box>
            );
          })}
        </div>
      </div>
    </div>
  );
}
