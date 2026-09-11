import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Input, TextArea } from "../lib/ui";
import * as api from "../lib/api";
import type { DayEntry } from "../lib/daylog";
import { shortStamp, today } from "../lib/format";
import { useStore } from "../store/useStore";
import { GhostButton, Modal, ModalFooter, PrimaryButton, inputFocus, inputStyle } from "./Modal";

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** `2026-09-11` → `09-11 (목)`. 연도는 왼쪽 목록이 이미 최신순이라 줄마다 되풀이하지 않는다. */
function dayLabel(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00`);
  const wd = Number.isNaN(d.getTime()) ? "" : ` (${WEEKDAY[d.getDay()]})`;
  return `${shortStamp(day)}${wd}`;
}

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
  const s = useStore();
  const day = s.dayLogOpen;

  const [days, setDays] = useState<api.DaySummary[]>([]);
  const [entries, setEntries] = useState<DayEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  /** 펼쳐서 내용을 보고 있는 줄. 한 번에 하나다. */
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ title: string; body: string } | null>(null);

  const vault = s.settings.vault;

  /**
   * 날짜 목록은 구간을 넓게 잡아 통째로 읽는다. 개인의 업무 기록이라 날짜가 많아도 수백
   * 줄이고, `(vault_root, day)` 인덱스 위의 GROUP BY 는 그 정도에 값을 매길 일이 아니다.
   * 페이지를 나누면 "더 보기" 버튼이 하나 생기는데, 그 버튼이 막는 비용보다 비싸다.
   */
  const reloadDays = useCallback(async () => {
    try {
      setDays(await api.dayIndex(vault, "0000-01-01", "9999-12-31"));
    } catch (e) {
      setErr(api.errMessage(e));
    }
  }, [vault]);

  const reloadEntries = useCallback(
    async (target: string) => {
      setLoading(true);
      try {
        setEntries(await api.dayEntries(vault, target));
        setErr("");
      } catch (e) {
        setEntries([]);
        setErr(api.errMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [vault],
  );

  // 열릴 때와 날짜를 바꿀 때 읽는다. 닫힌 동안은 아무것도 하지 않는다.
  useEffect(() => {
    if (!day) return;
    setOpen(null);
    setAdding(null);
    void reloadDays();
    void reloadEntries(day);
  }, [day, reloadDays, reloadEntries]);

  if (!day) return null;

  const close = () => s.set({ dayLogOpen: null });

  /** 오늘을 고쳤으면 도크도 따라가야 한다 — 같은 목록을 두 곳에서 보고 있는 셈이다. */
  const syncDock = () => {
    if (day === today()) void s.rescopeToday();
  };

  const afterWrite = async () => {
    await reloadEntries(day);
    await reloadDays();
    syncDock();
  };

  const remove = async (id: number) => {
    // 확인을 묻지 않는다. 모달 위에 모달을 겹치는 것은 이 앱에서 하지 않고, 도크의 ✕ 에도
    // 확인이 없다 — 지우는 것은 파일이 아니라 기록 한 줄이다.
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await api.removeDayEntry(id);
      await reloadDays();
      syncDock();
    } catch (e) {
      setErr(api.errMessage(e));
      await reloadEntries(day);
    }
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
      await api.noteDayEntry(vault, day, at, null, title, draft.body);
      await afterWrite();
    } catch (e) {
      setErr(api.errMessage(e));
    }
  };

  return (
    <Modal width={820} zIndex={72} onClose={close} panelStyle={{ height: 540 }}>
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
        <span style={{ fontSize: 11.5, color: "#a09a8f" }}>날짜별 기록</span>
        <div style={{ flex: 1 }} />
        <span
          style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 11, color: "#8a857c" }}
          title="기록은 ~/.contextflow/today.db 에 남습니다"
        >
          {day}
          {day === today() && " · 오늘"}
        </span>
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex" }}>
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
            count={days.find((d) => d.day === today())?.count ?? 0}
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
                count={d.count}
                on={day === d.day}
                onClick={() => void s.openDayLog(d.day)}
              />
            ))}
          {!days.length && (
            <div style={{ padding: "8px 11px", fontSize: 11, color: "#a09a8f", lineHeight: 1.6 }}>
              아직 쌓인 날짜가 없습니다
            </div>
          )}
        </div>

        {/* -- 오른쪽: 그 날짜의 항목 ----------------------------------------- */}
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}>
            {err && (
              <div
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
            {!loading && !entries.length && !adding && (
              <div
                style={{
                  padding: "14px 14px",
                  fontSize: 11.5,
                  color: "#a09a8f",
                  lineHeight: 1.7,
                }}
              >
                이 날짜에는 기록이 없습니다.
                <br />
                아래 [항목 추가] 로 그날 한 일을 적어 넣을 수 있습니다 — 앱 밖에서 한 일도
                그날의 기록이 됩니다.
              </div>
            )}
            {entries.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                open={open === e.id}
                onToggle={() => setOpen(open === e.id ? null : e.id)}
                onRemove={() => void remove(e.id)}
                onSaved={(next) => {
                  setEntries((prev) => prev.map((x) => (x.id === next.id ? next : x)));
                  syncDock();
                }}
                onError={setErr}
              />
            ))}

            {adding && (
              <div
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
      </div>

      <ModalFooter>
        <GhostButton onClick={() => setAdding({ title: "", body: "" })}>＋ 항목 추가</GhostButton>
        <span style={{ fontSize: 11, color: "#a09a8f" }}>
          {entries.length}건 · 제목을 누르면 내용이 열립니다
        </span>
        <div style={{ flex: 1 }} />
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
          fontSize: 10,
          color: count ? "#8a857c" : "#c5c0b6",
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
 * 만들면 제목 목록이 읽을 수 없을 만큼 좁아진다.
 *
 * 저장은 **포커스가 떠날 때** 한다. 간단 메모장이 이미 그 규칙이고(`Notepad`), 글자마다
 * 커맨드를 부르지 않으면서 [저장] 버튼도 만들지 않는 방법이다. 값이 실제로 바뀌었을 때만
 * 부르므로, 그냥 지나가며 누른 줄은 아무것도 쓰지 않는다.
 */
function EntryRow({
  entry,
  open,
  onToggle,
  onRemove,
  onSaved,
  onError,
}: {
  entry: DayEntry;
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
      onSaved(row);
    } catch (e) {
      onError(api.errMessage(e));
      setTitle(saved.current.title);
      setBody(saved.current.body);
    }
  };

  return (
    <div style={{ borderBottom: "1px solid #efece5" }}>
      <Box
        onClick={onToggle}
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
            fontSize: 10,
            color: "#b5afa2",
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
        {!entry.folder && (
          <span
            style={{
              fontSize: 9.5,
              color: "#8a857c",
              background: "#f0ece4",
              borderRadius: 3,
              padding: "0 4px",
              lineHeight: "14px",
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
        <span style={{ fontSize: 9, color: "#a09a8f", flex: "0 0 auto" }}>{open ? "▲" : "▼"}</span>
        <Box
          onClick={(ev) => {
            ev.stopPropagation();
            onRemove();
          }}
          title="이 기록을 지웁니다"
          style={{
            flex: "0 0 16px",
            width: 16,
            height: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 3,
            fontSize: 10,
            color: "#c5c0b6",
          }}
          hover={{ background: "#e0dcd4", color: "#4e4a43" }}
        >
          ✕
        </Box>
      </Box>

      {open && (
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
                fontSize: 10,
                color: "#a09a8f",
                wordBreak: "break-all",
                lineHeight: 1.6,
              }}
            >
              {entry.folder}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
