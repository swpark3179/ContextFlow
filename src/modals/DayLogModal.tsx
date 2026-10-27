import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Box, CheckMark, Collapse, Input, TextArea, reducedMotion } from "../lib/ui";
import { TOAST } from "../lib/design";
import * as api from "../lib/api";
import { upsertEntry, type DayEntry } from "../lib/daylog";
import { shortStamp, today } from "../lib/format";
import * as iwmsApi from "../lib/iwms/api";
import { markMap, pushesByEntry, withMark } from "../lib/iwms/marks";
import type { IwmsMark, IwmsPush, Price } from "../lib/iwms/types";
import IwmsPriceSwitch from "../components/IwmsPriceSwitch";
import { liveHandoff, useIwms } from "../store/iwmsStore";
import { useStore } from "../store/useStore";
import { GhostButton, Modal, ModalFooter, PrimaryButton, inputFocus, inputStyle } from "./Modal";
import { SlidePane } from "./motion";

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 이 판의 크기 — i-WMS 로 넘어가면 그쪽 판이 이 크기에서 자란다(`ModalHandoff`). */
const SIZE = { width: 820, height: 540 };

/** `2026-09-11` → `09-11 (목)`. 연도는 왼쪽 목록이 이미 최신순이라 줄마다 되풀이하지 않는다. */
function dayLabel(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00`);
  const wd = Number.isNaN(d.getTime()) ? "" : ` (${WEEKDAY[d.getDay()]})`;
  return `${shortStamp(day)}${wd}`;
}

// ---------------------------------------------------------------------------
// 지운 줄 — 확인을 묻지 않는 대신 토스트의 [되돌리기] 동안 숨겨만 두고, DB 에서는 토스트가 닫힌 뒤에 지운다
// (도크의 ✕ 와 같다). 팝업을 닫았다 열어도 그 시간 안이면 숨겨 두도록 모듈에 둔다.

/** 되돌리기를 기다리는 줄 — id → 그날. */
const gone = new Map<number, string>();
const goneSubs = new Set<() => void>();
let goneVer = 0;

function markGone(id: number, day: string | null): void {
  if (day) gone.set(id, day);
  else gone.delete(id);
  goneVer++;
  goneSubs.forEach((f) => f());
}

function useGone(): number {
  return useSyncExternalStore(
    (f) => {
      goneSubs.add(f);
      return () => goneSubs.delete(f);
    },
    () => goneVer,
  );
}

/**
 * DB 에서도 지워졌다 — 열린 팝업이 목록과 날짜 수를 고친 뒤 `done` 을 부른다(같은 틱에 숨김을 풀어야 수가
 * 한 번 두 번 빠지지 않는다). 팝업이 닫혀 있으면 `null`.
 */
let onRemoved: ((id: number, done: () => void) => Promise<void>) | null = null;

/**
 * 오늘의 한일 — 날짜별 기록.
 *
 * 도크는 오늘만 보여 준다. 어제와 그제를 보고 고치는 곳이 여기다.
 *
 * **왼쪽이 달력이 아니라 날짜 목록인 이유.** 이 화면에서 사람이 묻는 질문은 "지난 화요일에
 * 뭐 했지" 이고, 날짜와 건수가 한 줄에 붙은 목록이 그 답을 한눈에 준다. 월 격자는 코드가
 * 더 들고 빈 칸이 대부분인 화면을 그리며, 지난달로 넘어가려면 화살표를 눌러야 한다. 목록은
 * 그냥 아래로 거슬러 올라가면 된다.
 *
 * **과거도 제한 없이 고친다.** 빠뜨린 일을 나중에 적어 넣는 것이 이 기록의 주된 쓸 일이라,
 * 오늘만 쓸 수 있게 하면 도크와 다를 바가 없어진다.
 */
export default function DayLogModal() {
  const day = useStore((s) => s.dayLogOpen);
  if (!day) return null;
  return <DayLogView day={day} />;
}

function DayLogView({ day }: { day: string }) {
  const s = useStore();
  useGone();
  const vault = s.settings.vault;

  /** i-WMS 에서 돌아왔다 — 바탕을 다시 흐리지 않고 그 판의 크기에서 줄어들며, 본문은 왼쪽에서 들어온다. */
  const [handoff] = useState(() => liveHandoff(useIwms.getState().handoff));
  useEffect(() => {
    if (useIwms.getState().handoff) useIwms.setState({ handoff: null });
  }, []);
  const dir = useRef(handoff ? -1 : 0);
  /** 방금 i-WMS 에 넣은 줄 — 그 줄의 `i-WMS ✓` 칩이 튄다. */
  const [popped] = useState(() => new Set(handoff?.pushed ?? []));
  /** i-WMS 로 넘기는 중 — 이 판은 잔상 없이 사라지고 저쪽이 이어 받는다. */
  const [passing, setPassing] = useState(false);

  const [days, setDays] = useState<api.DaySummary[]>([]);
  const [entries, setEntries] = useState<DayEntry[]>([]);
  /** 지금 보이는 목록의 날짜. 다른 날짜를 읽는 동안은 옛 목록을 흐리게 둔다. */
  const [shownDay, setShownDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  /** 펼쳐서 내용을 보고 있는 줄. 한 번에 하나다. */
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ title: string; body: string } | null>(null);
  /** 방금 적어 넣은 줄 — 한 번 빛난다. */
  const [fresh, setFresh] = useState<number | null>(null);
  /** i-WMS 업무량 입력 — 줄마다 고른 대가 구분과 이미 넣은 행(`docs/IWMS-ROADMAP.md`). */
  const [marks, setMarks] = useState<IwmsMark[]>([]);
  const [pushes, setPushes] = useState<IwmsPush[]>([]);
  const loadSeq = useRef(0);
  const addRef = useRef<HTMLDivElement | null>(null);

  /**
   * 날짜 목록은 구간을 넓게 잡아 통째로 읽는다. 개인의 업무 기록이라 날짜가 많아도 수백
   * 줄이고, `(vault_root, day)` 인덱스 위의 GROUP BY 는 그 정도에 값을 매길 일이 아니다.
   * 페이지를 나누면 "더 보기" 버튼이 하나 생기는데, 그 버튼이 막는 비용보다 비싸다.
   */
  const readDays = useCallback(() => api.dayIndex(vault, "0000-01-01", "9999-12-31"), [vault]);
  const reloadDays = useCallback(async () => {
    try {
      setDays(await readDays());
    } catch (e) {
      setErr(api.errMessage(e));
    }
  }, [readDays]);

  /**
   * 그 날짜의 기록과 i-WMS 표시를 함께 읽어 **함께** 바꾼다 — 따로 바꾸면 대가 구분이 잠깐 "–" 로 돌아갔다가
   * 다시 켜진다. 날짜를 빠르게 옮겨 다니면 늦게 온 옛 날짜의 답은 버린다.
   * i-WMS 표시는 곁가지다 — 못 읽어도 기록 화면은 그대로 쓸 수 있어야 하므로 실패는 빈 목록으로 접는다.
   */
  const load = useCallback(
    async (target: string) => {
      const my = ++loadSeq.current;
      setLoading(true);
      const [rows, m, p] = await Promise.all([
        api.dayEntries(vault, target).then(
          (r) => ({ r }),
          (e: unknown) => ({ e }),
        ),
        iwmsApi.iwmsMarks(vault, target).catch(() => [] as IwmsMark[]),
        iwmsApi.iwmsPushes(target).catch(() => [] as IwmsPush[]),
      ]);
      if (my !== loadSeq.current) return;
      if ("r" in rows) {
        setEntries(rows.r);
        setErr("");
      } else {
        setEntries([]);
        setErr(api.errMessage(rows.e));
      }
      setMarks(m);
      setPushes(p);
      setShownDay(target);
      setLoading(false);
    },
    [vault],
  );

  // 열릴 때와 날짜를 바꿀 때 읽는다. 옛 목록은 새 목록이 올 때까지 흐리게 남긴다.
  useEffect(() => {
    setOpen(null);
    setAdding(null);
    void reloadDays();
    void load(day);
  }, [day, reloadDays, load]);

  useEffect(() => {
    onRemoved = async (id, done) => {
      const next = await readDays().catch(() => null);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      if (next) setDays(next);
      done();
    };
    return () => {
      onRemoved = null;
    };
  }, [readDays]);

  // 추가 폼은 목록 끝에 생긴다 — 긴 날이면 보이지 않으므로 그 자리까지 내려 준다.
  const isAdding = !!adding;
  useEffect(() => {
    if (isAdding) addRef.current?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [isAdding]);

  const close = () => s.set({ dayLogOpen: null });
  const dock = s.dayLog;
  const inDock = (id: number) => dock.day === today() && dock.entries.some((e) => e.id === id);
  /** 되돌리기를 기다리는 줄은 숨긴다. 오늘 줄은 도크가 원본이다 — 도크로 돌아왔으면(되돌리기 · 다시 손댐) 보인다. */
  const hidden = (id: number) => gone.has(id) && !inDock(id);
  const visible = entries.filter((e) => !hidden(e.id));
  const goneOn = (d: string) => [...gone].filter(([id, g]) => g === d && !inDock(id)).length;
  const priceOf = markMap(marks);
  const pushedOf = pushesByEntry(pushes);
  /** 대가 구분을 고른 줄 — 지금 보이는 줄만 센다(지운 줄의 선택은 이미 빠져 있다). */
  const marked = visible.filter((e) => priceOf.has(e.id)).length;
  /** 다른 날짜를 읽는 중 — 옛 목록을 흐리게 두고 누르지 못하게 한다. */
  const stale = loading && shownDay !== day;
  // 오늘 수는 도크가 원본이다 — 되돌리기를 기다리는 줄은 이미 빠져 있다.
  const todayCount =
    dock.day === today() ? dock.entries.length : (days.find((d) => d.day === today())?.count ?? 0);

  /**
   * 오늘의 줄을 고쳤으면 도크도 따라간다 — 같은 목록을 두 곳에서 보고 있다. 도크를 통째로 다시 읽지 않고
   * 그 줄만 끼운다: 다시 읽으면 되돌리기를 기다리며 숨겨 둔 줄까지 DB 에서 되살아난다.
   */
  const syncDock = (row: DayEntry, how: "add" | "edit") => {
    const st = useStore.getState();
    if (row.day !== today() || st.dayLog.day !== row.day) return;
    if (how === "add") st.set({ dayLog: upsertEntry(st.dayLog, row.day, row) });
    else st.set({ dayLog: { ...st.dayLog, entries: st.dayLog.entries.map((x) => (x.id === row.id ? row : x)) } });
  };

  /** 실패는 다시 던진다 — 스위치가 원래 칸으로 돌아가며 흔들린다. */
  const setPrice = async (id: number, price: Price | null) => {
    try {
      await iwmsApi.setIwmsMark(id, price);
      setMarks((prev) => withMark(prev, id, price));
    } catch (e) {
      setErr(api.errMessage(e));
      throw e;
    }
  };

  /**
   * 확인을 묻지 않는다. 모달 위에 모달을 겹치는 것은 이 앱에서 하지 않고, 도크의 ✕ 에도 확인이 없다 —
   * 지우는 것은 파일이 아니라 기록 한 줄이다. 대신 6초 동안 되돌릴 수 있다. 도크에 있는 오늘 줄은 도크의
   * 되돌리기(`dropEntry`)를 그대로 쓴다 — 그래야 도크와 팝업이 같은 줄을 함께 숨기고 함께 되살린다.
   */
  const remove = (e: DayEntry) => {
    if (open === e.id) setOpen(null);
    markGone(e.id, e.day);
    if (inDock(e.id)) {
      s.dropEntry(e.id, { undo: true });
      return;
    }
    s.toast("기록 한 줄을 지웠습니다", e.at ? `${e.title} · ${e.at}` : e.title, TOAST.muted, {
      action: { label: "되돌리기", run: () => markGone(e.id, null) },
      onClose: () => {
        void api.removeDayEntry(e.id).then(
          () => (onRemoved ? onRemoved(e.id, () => markGone(e.id, null)) : markGone(e.id, null)),
          (err: unknown) => {
            markGone(e.id, null);
            useStore.getState().fail(err, "기록을 지우지 못했습니다");
          },
        );
      },
    });
  };

  const commitAdd = async () => {
    const draft = adding;
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) return setAdding(null);
    setAdding(null);
    try {
      // `folder` 는 `null` 이다 — 업무와 연결되지 않은 자유 항목이다.
      //
      // 시각은 **오늘에만** 적는다. 지난 날짜에 손으로 넣는 줄의 `at` 은 그 일을 한 시각이
      // 아니라 적어 넣은 시각이므로, 적으면 틀린 값이 된다. 비워 두면 그 칸이 비어 보일
      // 뿐이고 그것이 사실에 가깝다.
      const at = day === today() ? hhmmNow() : "";
      const row = await api.noteDayEntry(vault, day, at, null, title, draft.body);
      setFresh(row.id);
      syncDock(row, "add");
      await load(day);
      await reloadDays();
    } catch (e) {
      setErr(api.errMessage(e));
    }
  };

  /** i-WMS 로 — 이 판은 잔상 없이 사라지고(`exit={false}`) 저쪽 판이 이 크기에서 자란다. */
  const toPush = () => {
    flushSync(() => setPassing(true));
    useIwms.getState().openPush(day, SIZE);
  };

  return (
    <Modal
      width={SIZE.width}
      zIndex={72}
      onClose={close}
      panelStyle={{ height: SIZE.height }}
      exit={!passing}
      handoff={handoff}
    >
      <div
        style={{
          flex: "0 0 40px",
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 14px",
          borderBottom: "1px solid #e6e2da",
          background: "#faf9f6",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>오늘의 한일</span>
        <span style={{ fontSize: 11.5, color: "#6a665e" }}>날짜별 기록</span>
        <div style={{ flex: 1 }} />
        <span
          style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 11, color: "#6a665e" }}
          title="기록은 ~/.contextflow/today.db 에 남습니다"
        >
          {day}
          {day === today() && " · 오늘"}
        </span>
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0, position: "relative", overflow: "hidden", display: "flex" }}>
        <SlidePane dir={dir} style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0, display: "flex" }}>
          {/* -- 왼쪽: 날짜 목록 ------------------------------------------------ */}
          <div
            style={{
              flex: "0 0 190px",
              borderRight: "1px solid #e6e2da",
              background: "#faf9f6",
              overflowY: "auto",
              padding: "5px 0",
            }}
          >
            <DayRow
              day={today()}
              count={todayCount}
              on={day === today()}
              isToday
              onClick={() => void s.openDayLog(today())}
            />
            {days
              .filter((d) => d.day !== today())
              .map((d) => (
                <DayRow
                  key={d.day}
                  day={d.day}
                  count={Math.max(0, d.count - goneOn(d.day))}
                  on={day === d.day}
                  onClick={() => void s.openDayLog(d.day)}
                />
              ))}
            {!days.length && (
              <div style={{ padding: "8px 11px", fontSize: 11, color: "#6a665e", lineHeight: 1.6 }}>
                아직 쌓인 날짜가 없습니다
              </div>
            )}
          </div>

          {/* -- 오른쪽: 그 날짜의 항목 ----------------------------------------- */}
          <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div
              aria-busy={stale || undefined}
              style={{
                flex: "1 1 auto",
                minHeight: 0,
                overflowY: "auto",
                opacity: stale ? 0.5 : 1,
                transition: "opacity 140ms",
                pointerEvents: stale ? "none" : undefined,
              }}
            >
              {err && (
                <div
                  className="cf-enter"
                  style={{
                    margin: "9px 12px 0 12px",
                    padding: "7px 9px",
                    borderRadius: 5,
                    background: "#fdf3f2",
                    border: "1px solid #f2d6d2",
                    fontSize: 11.5,
                    color: "#9b4b42",
                    lineHeight: 1.6,
                  }}
                >
                  {err}
                </div>
              )}
              {!loading && !visible.length && !adding && (
                <div
                  className="cf-fade"
                  style={{
                    padding: "14px 14px",
                    fontSize: 11.5,
                    color: "#6a665e",
                    lineHeight: 1.7,
                  }}
                >
                  이 날짜에는 기록이 없습니다.
                  <br />
                  아래 [항목 추가] 로 그날 한 일을 적어 넣을 수 있습니다 — 앱 밖에서 한 일도
                  그날의 기록이 됩니다.
                </div>
              )}
              {visible.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  price={priceOf.get(e.id) ?? null}
                  pushed={pushedOf.get(e.id) ?? []}
                  pop={popped.has(e.id)}
                  fresh={fresh === e.id}
                  onPrice={(p) => setPrice(e.id, p)}
                  open={open === e.id}
                  onToggle={() => setOpen(open === e.id ? null : e.id)}
                  onRemove={() => remove(e)}
                  onSaved={(next) => {
                    setEntries((prev) => prev.map((x) => (x.id === next.id ? next : x)));
                    syncDock(next, "edit");
                  }}
                  onError={setErr}
                />
              ))}

              {adding && (
                <div
                  ref={addRef}
                  className="cf-enter"
                  style={{
                    margin: "9px 12px",
                    padding: 10,
                    border: "1px dashed #ddd8cf",
                    borderRadius: 6,
                    background: "#faf9f6",
                    display: "flex",
                    flexDirection: "column",
                    gap: 7,
                  }}
                >
                  <Input
                    autoFocus
                    value={adding.title}
                    placeholder="무엇을 했습니까 (제목)"
                    onChange={(ev) => setAdding({ ...adding, title: ev.target.value })}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" && !ev.nativeEvent.isComposing) void commitAdd();
                      else if (ev.key === "Escape") {
                        // App 의 Escape 체인이 모달을 닫기 전에 여기서 소비한다.
                        ev.preventDefault();
                        setAdding(null);
                      }
                    }}
                    style={inputStyle}
                    focusStyle={inputFocus}
                  />
                  <TextArea
                    value={adding.body}
                    placeholder="내용 (선택)"
                    spellCheck={false}
                    onChange={(ev) => setAdding({ ...adding, body: ev.target.value })}
                    style={{ ...bodyStyle, minHeight: 64 }}
                    focusStyle={inputFocus}
                  />
                  <div style={{ display: "flex", gap: 7 }}>
                    <div style={{ flex: 1 }} />
                    <GhostButton onClick={() => setAdding(null)}>취소</GhostButton>
                    <PrimaryButton disabled={!adding.title.trim()} onClick={() => void commitAdd()}>
                      추가
                    </PrimaryButton>
                  </div>
                </div>
              )}
            </div>
          </div>
        </SlidePane>
      </div>

      <ModalFooter>
        <GhostButton onClick={() => setAdding({ title: "", body: "" })}>＋ 항목 추가</GhostButton>
        <span style={{ fontSize: 11, color: "#6a665e" }}>{visible.length}건 · 제목을 누르면 내용이 열립니다</span>
        <div style={{ flex: 1 }} />
        {marked > 0 && <GhostButton onClick={toPush}>i-WMS 업무량 입력… ({marked})</GhostButton>}
        <PrimaryButton onClick={close}>닫기</PrimaryButton>
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function hhmmNow(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const bodyStyle = {
  width: "100%",
  border: "1px solid #ddd8cf",
  borderRadius: 5,
  padding: "7px 9px",
  fontSize: 12,
  lineHeight: 1.7,
  outline: "none",
  color: "#3a3630",
  background: "#fff",
  resize: "vertical",
} as const;

function DayRow({
  day,
  count,
  on,
  isToday,
  onClick,
}: {
  day: string;
  count: number;
  on: boolean;
  isToday?: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      onClick={onClick}
      title={day}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 9px 0 11px",
        height: 24,
        cursor: "pointer",
        background: on ? "#e9edf6" : "transparent",
        borderLeft: `2px solid ${on ? "#3a6fd8" : "transparent"}`,
      }}
      hover={on ? undefined : { background: "#f2efe9" }}
    >
      <span
        style={{
          fontFamily: "'Roboto Mono',monospace",
          fontSize: 11,
          color: on ? "#2f5cbb" : "#4e4a43",
          fontWeight: on ? 600 : 400,
          flex: "1 1 auto",
          minWidth: 0,
          whiteSpace: "nowrap",
        }}
      >
        {isToday ? "오늘" : dayLabel(day)}
      </span>
      <span
        style={{
          fontFamily: "'Roboto Mono',monospace",
          fontSize: 11.5,
          color: count ? "#6a665e" : "#c5c0b6",
          flex: "0 0 auto",
        }}
      >
        {count}
      </span>
    </Box>
  );
}

/**
 * 한 줄과 그 내용. 펼치면 제목과 내용이 그 자리에서 편집 가능해진다 — 2단 안에 또 2단을
 * 만들면 제목 목록이 읽을 수 없을 만큼 좁아진다. 펼치고 접는 것은 높이째 움직인다(`Collapse`).
 *
 * 저장은 **포커스가 떠날 때** 한다. 간단 메모장이 이미 그 규칙이고(`Notepad`), 글자마다
 * 커맨드를 부르지 않으면서 [저장] 버튼도 만들지 않는 방법이다. 값이 실제로 바뀌었을 때만
 * 부르므로, 그냥 지나가며 누른 줄은 아무것도 쓰지 않는다. 저장했으면 줄 머리에 "저장됨" 이 잠깐 뜬다 —
 * 포커스가 떠난 뒤라 눈이 칸에 없다.
 */
function EntryRow({
  entry,
  price,
  pushed,
  pop,
  fresh,
  onPrice,
  open,
  onToggle,
  onRemove,
  onSaved,
  onError,
}: {
  entry: DayEntry;
  /** i-WMS 대가 구분. `null` = 입력 안 함. */
  price: Price | null;
  /** 이 줄로 i-WMS 에 넣은 행(되돌리지 않은 것). */
  pushed: IwmsPush[];
  /** 방금 i-WMS 에 넣은 줄 — 칩이 튀며 나타난다. */
  pop: boolean;
  /** 방금 적어 넣은 줄 — 한 번 빛난다. */
  fresh: boolean;
  onPrice: (next: Price | null) => Promise<void>;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onSaved: (next: DayEntry) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  /** 저장된 값. 바뀌었는지는 이것과 비교해서 안다. */
  const saved = useRef({ title: entry.title, body: entry.body });
  /** "저장됨" 칩 — 저장할 때마다 새로 뜬다. */
  const [savedN, setSavedN] = useState(0);
  useEffect(() => {
    if (!savedN) return;
    const t = window.setTimeout(() => setSavedN(0), 3100);
    return () => window.clearTimeout(t);
  }, [savedN]);

  // 날짜를 바꾸거나 바깥에서 다시 읽어 오면 초안을 버리고 새 값으로 맞춘다.
  useEffect(() => {
    setTitle(entry.title);
    setBody(entry.body);
    saved.current = { title: entry.title, body: entry.body };
  }, [entry.id, entry.title, entry.body]);

  const commit = async () => {
    const nextTitle = title.trim() || saved.current.title;
    if (nextTitle === saved.current.title && body === saved.current.body) return;
    try {
      const row = await api.editDayEntry(entry.id, nextTitle, body);
      saved.current = { title: row.title, body: row.body };
      setTitle(row.title);
      setSavedN((n) => n + 1);
      onSaved(row);
    } catch (e) {
      onError(api.errMessage(e));
      setTitle(saved.current.title);
      setBody(saved.current.body);
    }
  };

  return (
    <div className={fresh ? "cf-flash" : undefined} style={{ borderBottom: "1px solid #efece5" }}>
      <Box
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 8px 0 12px",
          height: 28,
          cursor: "pointer",
          background: open ? "#f7f5f1" : "transparent",
        }}
        hover={open ? undefined : { background: "#faf9f6" }}
      >
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 11.5,
            color: "#6a665e",
            flex: "0 0 32px",
          }}
        >
          {entry.at}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "#3a3630",
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        {savedN > 0 && (
          <span
            key={savedN}
            role="status"
            className="cf-chip"
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 11,
              color: "#256b47",
              whiteSpace: "nowrap",
            }}
          >
            <CheckMark size={9} />
            저장됨
          </span>
        )}
        {!entry.folder && (
          <span
            style={{
              fontSize: 11,
              color: "#6a665e",
              background: "#f0ece4",
              borderRadius: 3,
              padding: "0 4px",
              lineHeight: "15px",
              flex: "0 0 auto",
            }}
            title="업무와 연결되지 않은 기록입니다"
          >
            메모
          </span>
        )}
        {!!entry.body && !open && (
          <span style={{ fontSize: 9, color: "#c5c0b6", flex: "0 0 auto" }} title="내용이 있습니다">
            ●
          </span>
        )}
        {pushed.length > 0 && (
          <span
            className={pop ? "cf-pop" : undefined}
            style={{
              display: "inline-block",
              fontSize: 11,
              fontWeight: pop ? 600 : 400,
              color: "#2f7f57",
              background: "#e9f5ee",
              borderRadius: 3,
              padding: "0 4px",
              lineHeight: "15px",
              flex: "0 0 auto",
              whiteSpace: "nowrap",
            }}
            title={pushed.map((p) => `${p.ciName} › ${p.task} · ${p.minutes}분\n${p.note}`).join("\n\n")}
          >
            i-WMS ✓ {pushed.reduce((n, p) => n + p.minutes, 0)}분
          </span>
        )}
        <IwmsPriceSwitch value={price} onChange={onPrice} label={`${entry.title} 대가 구분`} />
        <span style={{ fontSize: 9, color: "#6a665e", flex: "0 0 auto" }}>{open ? "▲" : "▼"}</span>
        <Box
          onClick={(ev) => {
            ev.stopPropagation();
            onRemove();
          }}
          title="이 기록을 지웁니다"
          aria-label="이 기록을 지웁니다"
          style={{
            flex: "0 0 16px",
            width: 16,
            height: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 3,
            fontSize: 11,
            color: "#c5c0b6",
          }}
          hover={{ background: "#e0dcd4", color: "#4e4a43" }}
        >
          ✕
        </Box>
      </Box>

      <Collapse open={open}>
        <div
          style={{
            padding: "8px 12px 11px 12px",
            background: "#f7f5f1",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <Input
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
            onBlur={() => void commit()}
            style={inputStyle}
            focusStyle={inputFocus}
          />
          <TextArea
            value={body}
            placeholder="내용"
            spellCheck={false}
            onChange={(ev) => setBody(ev.target.value)}
            onBlur={() => void commit()}
            style={{ ...bodyStyle, minHeight: 96 }}
            focusStyle={inputFocus}
          />
          {entry.folder && (
            <div
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11.5,
                color: "#6a665e",
                wordBreak: "break-all",
                lineHeight: 1.6,
              }}
            >
              {entry.folder}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}
