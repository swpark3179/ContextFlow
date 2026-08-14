import { useEffect, useMemo, useRef } from "react";
import { Box, Input } from "../lib/ui";
import { BLUE, normalizeStatus, statusOf } from "../lib/design";
import { useDropGuard, useLongPress } from "../lib/longPress";
import { shortStamp } from "../lib/format";
import { isArchived, useStore, type Screen } from "../store/useStore";

const FILTERS: [string, string][] = [
  ["all", "전체"],
  ["in-progress", "진행중"],
  ["on-hold", "보류"],
  ["completed", "완료"],
];

const NAV: [Screen, string][] = [
  ["workspace", "워크스페이스"],
  ["templates", "템플릿"],
  ["archive", "보관함"],
  ["settings", "설정"],
];

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

  const { live, archived, visible, sideArch, counts } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const live = tasks.filter((t) => !isArchived(t, settings.archDays));
    const archived = tasks.filter((t) => isArchived(t, settings.archDays));
    const counts: Record<string, number> = {
      all: live.length,
      "in-progress": 0,
      "on-hold": 0,
      completed: 0,
    };
    live.forEach((t) => {
      const k = normalizeStatus(t.status);
      if (counts[k] !== undefined) counts[k]++;
    });
    const match = (t: (typeof tasks)[number]) =>
      `${t.title} ${t.tags.join(" ")} ${t.relFolder} ${t.tagline}`.toLowerCase().includes(q);
    const visible = live.filter((t) => {
      const st = normalizeStatus(t.status);
      if (filter !== "all" && st !== filter) return false;
      return !q || match(t);
    });
    const sideArch = q ? archived.filter(match) : [];
    return { live, archived, visible, sideArch, counts };
  }, [tasks, settings.archDays, query, filter]);

  /**
   * 순서를 바꿀 수 있는 상태인가.
   *
   * 걸러진 목록의 인덱스는 전체 목록의 인덱스가 아니다 — 필터나 검색이 걸린 채로 옮기면
   * 화면에 없는 업무들의 자리가 조용히 틀어진다. 그래서 그때는 아예 끌 수 없게 한다.
   */
  const sortable = listActive && filter === "all" && !query.trim();
  const drag = s.taskDrag;

  const listRef = useRef<HTMLDivElement | null>(null);

  /** 드롭 지점을 **삽입 인덱스**로 바꾼다. 행 중점을 넘었으면 그 아래 자리다. */
  const insertAt = (y: number): number => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-task-folder]"));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return rows.length;
  };

  const { startPress } = useLongPress<string>((folder, { y }) => {
    s.set({ taskDrag: { folder, y, at: insertAt(y) } });
  });
  const { markDropped, justDropped } = useDropGuard();

  /**
   * 드래그가 살아 있는 동안만 붙는 리스너. 탐색기와 같은 이유로 `[!!drag]` 에만
   * 의존한다 — 좌표가 바뀔 때마다 다시 붙이면 이벤트가 새고 포인터 캡처도 놓친다.
   */
  useEffect(() => {
    if (!drag) return;
    // 최신 좌표는 ref 가 아니라 이 지역 값으로 든다. 자동 스크롤 타이머도 같은 값을 본다.
    const pos = { y: drag.y };

    const sync = () => {
      const d = useStore.getState().taskDrag;
      if (d) useStore.getState().set({ taskDrag: { ...d, y: pos.y, at: insertAt(pos.y) } });
    };
    const move = (e: PointerEvent) => {
      pos.y = e.clientY;
      sync();
    };
    const up = () => {
      const st = useStore.getState();
      const d = st.taskDrag;
      st.set({ taskDrag: null });
      markDropped();
      if (d) void st.reorderTask(d.folder, d.at);
    };

    // 목록 가장자리에서는 스스로 스크롤한다. 사이드바 목록은 스크롤 컨테이너라
    // 이게 없으면 화면 밖 자리로는 옮길 수 없다. pointermove 는 커서가 멈추면 오지
    // 않으므로, 가장자리에 대고 가만히 있어도 계속 밀리도록 타이머로 돌린다.
    const scroller = window.setInterval(() => {
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

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.clearInterval(scroller);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag]);

  if (s.sidebarMin) {
    return (
      <div
        style={{
          flex: "0 0 auto",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "#f5f3ef",
          borderRight: "1px solid #e0dcd4",
          width: 34,
        }}
      >
        <Box
          onClick={() => s.set({ sidebarMin: false })}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 11,
            padding: "9px 0",
            cursor: "pointer",
          }}
          hover={{ background: "#ece8e0" }}
        >
          <span style={{ fontSize: 9, color: "#8a857c" }}>▶</span>
          <span
            style={{
              writingMode: "vertical-rl",
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: 1,
              color: "#8a857c",
            }}
          >
            업무 리스트
          </span>
          <span
            style={{
              writingMode: "vertical-rl",
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 10.5,
              color: "#b5afa2",
            }}
          >
            {live.length}개
          </span>
        </Box>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: "0 0 auto",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "#f5f3ef",
        borderRight: "1px solid #e0dcd4",
        width: Math.round(s.sidebarW),
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
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: ".6px",
            color: "#8a857c",
            flex: 1,
            minWidth: 0,
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
        <Box
          onClick={() => s.set({ sidebarMin: true })}
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
        <div style={{ display: "flex", gap: 4 }}>
          {FILTERS.map(([k, label]) => {
            const on = filter === k;
            return (
              <div
                key={k}
                onClick={() => s.set({ filter: k })}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontSize: 11.5,
                  lineHeight: "20px",
                  height: 21,
                  borderRadius: 4,
                  cursor: "pointer",
                  userSelect: "none",
                  border: `1px solid ${on ? "#d9d4ca" : "transparent"}`,
                  background: on ? "#fff" : "transparent",
                  color: on ? "#23211e" : "#8a857c",
                  fontWeight: on ? 600 : 400,
                }}
              >
                {label} {counts[k]}
              </div>
            );
          })}
        </div>
        {/* 순서를 정해 둔 사용자가 필터를 켠 채 끌어 보고 "왜 안 되지" 하는 것을 막는다.
            한 번도 순서를 바꾼 적 없으면 알릴 것도 없으므로 띄우지 않는다. */}
        {listActive && !sortable && live.some((t) => t.order !== null) && (
          <div style={{ fontSize: 10.5, color: "#a09a8f", lineHeight: 1.5 }}>
            검색·필터 중에는 순서를 바꿀 수 없습니다
          </div>
        )}
      </div>

      <div
        ref={listRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "2px 6px 8px 6px",
          opacity: listActive ? 1 : 0.42,
          pointerEvents: listActive ? "auto" : "none",
          // 드래그 중에는 텍스트가 잡히지 않게 한다.
          userSelect: drag ? "none" : undefined,
        }}
      >
        {!listActive && (
          <div
            style={{
              padding: "5px 7px 8px 7px",
              fontSize: 11.5,
              color: "#8a857c",
              lineHeight: 1.6,
            }}
          >
            워크스페이스에서 업무를 선택할 수 있습니다
          </div>
        )}
        {visible.map((t, i) => {
          const cfg = statusOf(t.status);
          const on = listActive && t.folder === s.activeFolder;
          const dragging = drag?.folder === t.folder;
          return (
            <Box
              key={t.folder}
              data-task-folder={t.folder}
              onPointerDown={(e) => {
                if (sortable) startPress(e, t.folder);
              }}
              onClick={() => {
                if (justDropped()) return;
                void s.selectTask(t.folder);
              }}
              style={{
                display: "flex",
                gap: 8,
                padding: "7px 8px 7px 7px",
                borderRadius: 5,
                cursor: drag ? "grabbing" : "pointer",
                marginBottom: 1,
                borderLeft: `2px solid ${on ? cfg.dot : "transparent"}`,
                background: on ? "#fff" : "transparent",
                boxShadow: on ? "0 1px 2px rgba(35,33,30,.10)" : "none",
                // 끌고 있는 행은 흐리게 — 지금 손에 쥔 것이 무엇인지 보여 준다.
                opacity: dragging ? 0.4 : 1,
                // 놓을 자리를 행 사이의 선으로 그린다. 고스트는 필요 없다 — 탐색기와
                // 달리 이 드래그는 창 밖으로 나가지 않는다. 테두리는 **드래그 중에만**
                // 깐다: 평소에도 투명 테두리를 두면 모든 행이 4px 씩 두꺼워져 설계의
                // 목록 밀도가 바뀐다. 드래그 중에는 모든 행에 똑같이 깔리므로 선이
                // 켜지고 꺼져도 행이 흔들리지 않는다.
                ...(drag && {
                  borderTop: `2px solid ${drag.at === i ? BLUE : "transparent"}`,
                  borderBottom: `2px solid ${
                    drag.at === visible.length && i === visible.length - 1 ? BLUE : "transparent"
                  }`,
                }),
              }}
              hover={drag ? undefined : { background: on ? "#fff" : "#ede9e2" }}
            >
              <div
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  marginTop: 4,
                  flex: "0 0 7px",
                  background: cfg.dot,
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
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
                      fontSize: 10.5,
                      color: "#a09a8f",
                      flex: "0 0 auto",
                    }}
                  >
                    {shortStamp(t.updated)}
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      color: "#a09a8f",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.tagline}
                  </span>
                </div>
              </div>
              {t.runs > 1 && (
                <div
                  style={{
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 10,
                    color: "#8a857c",
                    background: "#ece8e0",
                    borderRadius: 3,
                    padding: "1px 4px",
                    height: 16,
                    lineHeight: "14px",
                    marginTop: 1,
                  }}
                >
                  ×{t.runs}
                </div>
              )}
            </Box>
          );
        })}

        {visible.length === 0 && sideArch.length === 0 && (
          <div
            style={{
              padding: "22px 12px",
              textAlign: "center",
              fontSize: 12.5,
              color: "#a09a8f",
              lineHeight: 1.6,
            }}
          >
            조건에 맞는 업무가 없습니다.
            <br />
            보관함까지 찾으려면 아래 보관함을 열어보세요.
          </div>
        )}

        {sideArch.length > 0 && (
          <div style={{ marginTop: 9, padding: "0 2px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <div style={{ flex: 1, height: 1, background: "#e0dcd4" }} />
              <span
                style={{
                  fontSize: 10.5,
                  letterSpacing: ".3px",
                  color: "#a09a8f",
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
                      fontSize: 10.5,
                      color: "#b5afa2",
                      marginTop: 1,
                    }}
                  >
                    완료 {(t.completedAt ?? "").slice(2)}
                  </div>
                </div>
                <Box
                  onClick={(e) => {
                    e.stopPropagation();
                    void s.restoreTask(t.folder);
                  }}
                  style={{
                    flex: "0 0 auto",
                    fontSize: 10.5,
                    color: "#5a44b4",
                    background: "#f2eefc",
                    border: "1px solid #e4dcf8",
                    borderRadius: 3,
                    padding: "2px 6px",
                  }}
                  hover={{ background: "#ece5fb" }}
                >
                  재개
                </Box>
              </Box>
            ))}
            <Box
              onClick={() => s.set({ screen: "archive", archQuery: query.trim(), archOpen: "" })}
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
        <Box
          onClick={() =>
            s.set({
              newOpen: true,
              nt: { title: "", summary: "", tags: "", template: "(없음)" },
              ntRecs: [],
              recTag: {},
              ntRefs: [],
            })
          }
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
          onClick={() => s.setScreen("archive")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            height: 25,
            padding: "0 8px",
            borderRadius: 4,
            cursor: "pointer",
            background: "#ebe7df",
          }}
          hover={{ background: "#e2ded4" }}
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
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11,
              color: "#8a857c",
              flex: "0 0 auto",
            }}
          >
            {archived.length}개
          </span>
        </Box>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
          {NAV.map(([k, label]) => {
            const on = s.screen === k;
            return (
              <div
                key={k}
                onClick={() => s.setScreen(k)}
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
                  color: on ? "#23211e" : "#8a857c",
                  fontWeight: on ? 600 : 400,
                }}
              >
                {label}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
