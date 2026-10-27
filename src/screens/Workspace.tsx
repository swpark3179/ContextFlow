import { useCallback, useEffect, useRef, useState } from "react";
import { Box, CheckMark, EASE_OUT, Popover, Spinner, reducedMotion } from "../lib/ui";
import { statusOf, GREEN, TEXT, normalizeStatus } from "../lib/design";
import { shortStamp } from "../lib/format";
import EditorPane from "../components/EditorPane";
import Notepad from "../components/Notepad";
import Explorer from "../components/Explorer";
import CategoryPicker, { CategoryChip } from "../components/CategoryPicker";
import AssistMenu from "../components/AssistMenu";
import { isArchived, useStore } from "../store/useStore";
import type { TaskMeta } from "../lib/api";

const STATUS_OPTIONS: [string, string, string][] = [
  ["in-progress", "진행 중", "작업 재개"],
  ["on-hold", "보류", "스냅샷 저장"],
  // 완료는 그 자리에서 보관까지 간다(`setStatus`) — 누르기 전에 그 사실이 보여야 한다.
  ["completed", "완료", "보관함으로"],
];

export default function Workspace() {
  const s = useStore();
  const dockRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<"col" | "rowL" | null>(null);
  /** 카테고리 팝오버의 입력. `null` = 닫힘. */
  const [catText, setCatText] = useState<string | null>(null);
  // 다른 업무로 넘어가면 닫는다 — 열어 둔 채로 고르면 넘어간 업무에 지정된다.
  useEffect(() => setCatText(null), [s.activeFolder]);

  const task = s.tasks.find((t) => t.folder === s.activeFolder);
  // 팝오버의 picker 는 이 함수가 바뀌면 철자 목록을 다시 만든다 — 업무가 바뀔 때만 새로 만든다.
  const isSelf = useCallback((t: TaskMeta) => t.folder === task?.folder, [task?.folder]);

  /**
   * 업무를 바꾸면 작업공간이 아래에서 살짝 떠오른다 — 같은 자리에 다른 글이 한 프레임에 바뀌어 들면
   * 바뀐 것인지 알아채기 어렵다. 편집기 · 탐색기를 다시 마운트하지 않도록 키를 바꾸지 않고 상자만 움직인다.
   */
  const shownFolder = useRef(task?.folder);
  useEffect(() => {
    const was = shownFolder.current;
    shownFolder.current = task?.folder;
    const el = dockRef.current;
    if (!el || !was || was === task?.folder || reducedMotion() || typeof el.animate !== "function") return;
    el.animate(
      [
        { opacity: 0.35, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 200, easing: EASE_OUT },
    );
  }, [task?.folder]);

  /** "맥락 복원" 칩 — 되살린 탭 · 메모를 한 번 알리고 사라진다(`cf-chip`, 2.8초 + 들어오기 0.2초). */
  const restored = s.restored && s.restored.folder === task?.folder ? s.restored : null;
  const [chipGone, setChipGone] = useState(0);
  useEffect(() => {
    if (!restored) return;
    const n = restored.n;
    const t = window.setTimeout(() => setChipGone(n), 3100);
    return () => window.clearTimeout(t);
  }, [restored]);

  const onMove = (e: MouseEvent) => {
    if (drag.current === "col" && dockRef.current) {
      const r = dockRef.current.getBoundingClientRect();
      s.setUi({ colPct: Math.max(28, Math.min(80, ((e.clientX - r.left) / r.width) * 100)) });
    } else if (drag.current === "rowL" && leftRef.current) {
      const r = leftRef.current.getBoundingClientRect();
      s.setUi({ rowPct: Math.max(18, Math.min(88, ((e.clientY - r.top) / r.height) * 100)) });
    }
  };
  const stop = () => {
    drag.current = null;
    document.body.style.cursor = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", stop);
  };
  const startDrag = (kind: "col" | "rowL") => (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = kind;
    document.body.style.cursor = kind === "rowL" ? "row-resize" : "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  if (!task) return <NoTask />;

  const st = statusOf(task.status);
  // 보관함 화면 안에서 열린 경우(Archive.tsx 의 상세)에는 위쪽 [보관함 목록] 바가
  // 이미 같은 말을 하고 [여기서 재개]도 거기에 있다 — 배너를 한 번 더 쌓지 않는다.
  const archived = isArchived(task, s.settings.archDays) && s.screen !== "archive";

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 auto",
          borderBottom: "1px solid #e6e2da",
          padding: "8px 12px 7px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "#fdfcfa",
          position: "relative",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Box
              onDoubleClick={() => s.set({ ren: { folder: task.folder, title: task.title } })}
              title="더블클릭하면 업무명을 바꿉니다"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
                borderRadius: 4,
                padding: "0 4px",
                margin: "0 -4px",
                cursor: "default",
              }}
              hover={{ background: "#f2efe9" }}
            >
              <span
                key={task.folder}
                className="cf-fade"
                style={{
                  fontSize: 15.5,
                  fontWeight: 600,
                  letterSpacing: "-.2px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {task.title}
              </span>
              <Box
                onClick={() => s.set({ ren: { folder: task.folder, title: task.title } })}
                title="업무명 변경"
                style={{
                  flex: "0 0 18px",
                  height: 18,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 4,
                  fontSize: 11,
                  color: "#6a665e",
                  cursor: "pointer",
                }}
                hover={{ background: "#e6e2da", color: "#4e4a43" }}
              >
                ✎
              </Box>
            </Box>
            {task.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11.5,
                  color: "#6a665e",
                  background: "#f0ede7",
                  border: "1px solid #e4e0d8",
                  borderRadius: 3,
                  padding: "1px 5px",
                }}
              >
                #{tag}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 3, minWidth: 0 }}>
            <CategoryChip category={task.category} onClick={() => setCatText(task.category ?? "")} />
            <span
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11,
                color: "#6a665e",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={task.folder}
            >
              {task.relFolder}
            </span>
          </div>
        </div>
        {catText !== null && (
          // Esc 는 고르기가 다룬다 — 펼친 목록을 먼저 닫고, 그다음에 판을 닫는다.
          <Popover
            onClose={() => setCatText(null)}
            esc={false}
            role="dialog"
            style={{ top: 50, left: 12, width: 300, padding: 8 }}
          >
            <CategoryPicker
              popover
              autoFocus
              exclude={isSelf}
              value={catText}
              onChange={setCatText}
              onCommit={(v) => {
                setCatText(null);
                if (v !== task.category) void s.setCategory([task.folder], v);
              }}
              onCancel={() => setCatText(null)}
            />
          </Popover>
        )}
        <div style={{ flex: 1 }} />
        {/* AI 도우미는 살아 있는 업무에만 — 보관된 업무의 index.md 에 정리를 덧붙일 일은 없다. */}
        {!isArchived(task, s.settings.archDays) && s.screen !== "archive" && <AssistMenu folder={task.folder} />}
        {/* 다시 연 업무의 탭 · 메모를 되살렸다 — 한 번 떴다 사라진다. 아무것도 없던 업무에는 뜨지 않는다. */}
        {restored && chipGone !== restored.n && (
          <span
            key={restored.n}
            className="cf-chip"
            role="status"
            style={{
              flex: "0 0 auto",
              fontSize: 11,
              color: "#2f5cbb",
              background: "#eef3fd",
              border: "1px solid #cddcf8",
              borderRadius: 10,
              padding: "0 8px",
              lineHeight: "18px",
              whiteSpace: "nowrap",
            }}
          >
            맥락 복원 · {[restored.tabs ? `탭 ${restored.tabs}` : "", restored.memo ? "메모" : ""].filter(Boolean).join(" · ")}
          </span>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#6a665e" }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: GREEN }} />
          <span key={s.snapAt} className="cf-fade">
            스냅샷 {s.snapAt}
          </span>
        </div>
        {/* 완료를 누르면 메뉴는 곧바로 닫히고, 저장 · 보관이 도는 동안 배지가 그것을 말한다(`completing`).
            예전에는 메뉴가 멈춘 채 열려 있어 눌렸는지 알 수 없었다. 보라가 아니다 — AI 의 일이 아니다. */}
        {s.completing === task.folder ? (
          <div
            role="status"
            className="cf-fade"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 26,
              padding: "0 9px",
              borderRadius: 5,
              border: "1px solid #e0dcd4",
              background: "#f4f2ee",
              color: TEXT.sub,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "progress",
            }}
          >
            <Spinner size={10} />
            보관하는 중
          </div>
        ) : (
          <Box
            onClick={() => s.set({ statusMenuOpen: !s.statusMenuOpen })}
            role="button"
            aria-haspopup="menu"
            aria-expanded={s.statusMenuOpen}
            title="상태 바꾸기"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 26,
              padding: "0 9px",
              borderRadius: 5,
              cursor: "pointer",
              // 호버가 `borderColor` 만 바꾸므로 줄여 쓰기(`border`)와 섞지 않는다.
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: st.bd,
              background: st.bg,
              color: st.fg,
              fontSize: 12.5,
              fontWeight: 600,
            }}
            hover={{ borderColor: st.dot }}
          >
            {normalizeStatus(task.status) === "completed" ? (
              <CheckMark size={10} color={st.dot} />
            ) : (
              <div
                key={task.status}
                className="cf-pop"
                style={{ width: 6, height: 6, borderRadius: "50%", background: st.dot }}
              />
            )}
            {st.label}
            <span
              className="cf-mv"
              style={{
                fontSize: 9,
                opacity: 0.7,
                display: "inline-block",
                transform: s.statusMenuOpen ? "rotate(180deg)" : "none",
                transition: `transform var(--m-base) ${EASE_OUT}`,
              }}
            >
              ▼
            </span>
          </Box>
        )}
        {s.statusMenuOpen && (
          <Popover
            onClose={() => s.set({ statusMenuOpen: false })}
            origin="top right"
            style={{ top: 44, right: 12, minWidth: 172 }}
          >
            {STATUS_OPTIONS.map(([k, label, hint]) => (
              <Box
                key={k}
                onClick={() => void s.setStatus(k)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 12.5,
                  color: "#3a3630",
                  background: task.status === k ? "#f4f2ee" : "transparent",
                }}
                hover={{ background: "#f2efe9" }}
              >
                <div
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: statusOf(k).dot,
                  }}
                />
                <span style={{ flex: 1 }}>{label}</span>
                <span style={{ fontSize: 11, color: "#6a665e" }}>{hint}</span>
              </Box>
            ))}
            <Box
              onClick={() => void s.archiveNow(task.folder)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12.5,
                color: "#3a3630",
              }}
              hover={{ background: "#f2efe9" }}
            >
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#b5afa2" }} />
              <span style={{ flex: 1 }}>지금 보관함으로</span>
              <span style={{ fontSize: 11, color: "#6a665e" }}>목록에서 숨김</span>
            </Box>
            {/* 업무의 경계를 다시 그리는 두 항목. 상태를 바꾸는 것도 보관하는 것도
                아니라 **폴더를 옮기는** 일이라, 선 하나를 두고 아래에 모아 둔다. */}
            <div style={{ height: 1, background: "#f0ede7", margin: "3px 0" }} />
            <Box
              onClick={() => void s.openAbsorb(task.folder)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12.5,
                color: "#3a3630",
              }}
              hover={{ background: "#f2efe9" }}
            >
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#3a6fd8" }} />
              <span style={{ flex: 1 }}>다른 업무에 편입…</span>
              <span style={{ fontSize: 11, color: "#6a665e" }}>하위 폴더로</span>
            </Box>
            <Box
              onClick={() => void s.openSplit(task.folder)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12.5,
                color: "#3a3630",
              }}
              hover={{ background: "#f2efe9" }}
            >
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#3a6fd8" }} />
              <span style={{ flex: 1 }}>업무 분할…</span>
              <span style={{ fontSize: 11, color: "#6a665e" }}>새 업무로</span>
            </Box>
            <div style={{ height: 1, background: "#f0ede7", margin: "3px 0" }} />
            <Box
              onClick={() => {
                s.set({ statusMenuOpen: false });
                void s.openTaskInObsidian(task.folder);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12.5,
                color: "#3a3630",
              }}
              hover={{ background: "#f2efe9" }}
            >
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#8a857c" }} />
              <span style={{ flex: 1 }}>Obsidian에서 열기</span>
              <span style={{ fontSize: 11, color: "#6a665e" }}>
                {s.obsidianOk ? "index.md" : "탐색기 폴백"}
              </span>
            </Box>
            {/* 되돌릴 수 없는 항목은 맨 아래, 선 하나 너머에 따로 둔다. 살아 있는 업무만 —
                보관된 업무는 'move' 방식이면 Archive 에 있어 지울 수 없다(`vault::delete_task`). */}
            {!isArchived(task, s.settings.archDays) && (
              <>
                <div style={{ height: 1, background: "#f0ede7", margin: "3px 0" }} />
                <Box
                  onClick={() => void s.askDeleteTask(task.folder)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12.5,
                    color: "#a83c3c",
                  }}
                  hover={{ background: "#fdf2f1" }}
                >
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#c04a4a" }} />
                  <span style={{ flex: 1 }}>업무 삭제…</span>
                  <span style={{ fontSize: 11, color: "#6a665e" }}>되돌릴 수 없음</span>
                </Box>
              </>
            )}
          </Popover>
        )}
      </div>

      {archived && (
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "7px 12px",
            background: "#f4f2ee",
            borderBottom: "1px solid #e6e2da",
          }}
        >
          <div
            style={{ width: 6, height: 6, borderRadius: "50%", background: "#b5afa2", flex: "0 0 6px" }}
          />
          <span style={{ fontSize: 12, color: "#6a665e", flex: 1, minWidth: 0 }}>
            보관된 업무입니다 · 읽기 참조용으로 열려 있으며 목록에는 표시되지 않습니다
          </span>
          <Box
            onClick={() => void s.restoreTask(task.folder)}
            style={{
              flex: "0 0 auto",
              height: 24,
              padding: "0 11px",
              display: "flex",
              alignItems: "center",
              borderRadius: 4,
              // 조작은 파랑이다 — 보라는 AI 가 일하는 중에만 쓴다.
              border: "1px solid #cddcf8",
              background: "#eef3fd",
              color: "#2f5cbb",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
            hover={{ background: "#e2ebfc" }}
          >
            여기서 재개
          </Box>
        </div>
      )}

      <div ref={dockRef} style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div
          ref={leftRef}
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            flex: s.explorerMin ? "1 1 auto" : "0 0 auto",
            width: s.explorerMin ? "auto" : `${Math.round(s.ui.colPct * 10) / 10}%`,
          }}
        >
          <EditorPane />
          {!s.noteMin && (
            <Box
              onMouseDown={startDrag("rowL")}
              style={{ flex: "0 0 5px", cursor: "row-resize", marginTop: -3, zIndex: 5 }}
              hover={{ background: "#c9dbf7" }}
            />
          )}
          <Notepad />
        </div>

        {!s.explorerMin && (
          <Box
            onMouseDown={startDrag("col")}
            style={{ flex: "0 0 5px", cursor: "col-resize", marginLeft: -2, zIndex: 5 }}
            hover={{ background: "#c9dbf7" }}
          />
        )}

        <Explorer />
      </div>
    </div>
  );
}

/**
 * 고른 업무가 없는 작업공간. 업무가 하나도 없는 것과, 있는데 아무것도 고르지 않은 것은 다른 상태다.
 * 완료로 창을 닫은 직후가 후자이고, 그때 "업무가 없습니다"는 사실이 아니다.
 *
 * 완료 직후에는 방금 보낸 업무가 어디로 갔는지(보관함)와, 이어서 할 업무 셋(최근에 고친 순)을 바로
 * 보인다 — 예전에는 빈 화면에서 왼쪽 목록을 다시 훑어야 했다.
 */
function NoTask() {
  const s = useStore();
  const live = s.tasks.filter((t) => !isArchived(t, s.settings.archDays));
  const gone = s.justArchived ? s.tasks.find((t) => t.folder === s.justArchived) : undefined;
  const next = [...live].sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 3);
  return (
    <div
      className="cf-fade"
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fdfcfa",
        padding: 24,
      }}
    >
      <div style={{ width: 420, maxWidth: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 5, textAlign: "center" }}>
          <span style={{ fontSize: 14, color: "#4e4a43", fontWeight: 500 }}>
            {live.length ? "선택된 업무가 없습니다" : "업무가 없습니다"}
          </span>
          <span style={{ fontSize: 12.5, color: "#6a665e", lineHeight: 1.7 }}>
            {live.length ? (
              "왼쪽 업무 리스트에서 이어서 할 업무를 고르세요."
            ) : (
              <>
                왼쪽 아래 [+ 새 업무 추가]로 첫 업무를 만들어 보세요.
                <br />
                업무마다 전용 폴더가 Vault 안에 생성됩니다.
              </>
            )}
          </span>
        </div>
        {gone && (
          <div
            className="cf-enter"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              border: "1px solid #c9e4d5",
              background: "#f1faf5",
              borderRadius: 7,
            }}
          >
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: GREEN,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "0 0 18px",
              }}
            >
              <CheckMark size={10} color="#fff" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11.5, color: "#256b47" }}>방금 보관함으로 옮긴 업무</div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#23211e",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {gone.title}
              </div>
            </div>
            <Box
              onClick={() => void s.peekArchived(gone.folder)}
              role="button"
              style={{
                flex: "0 0 auto",
                fontSize: 12,
                fontWeight: 600,
                color: "#2f5cbb",
                padding: "4px 8px",
                borderRadius: 4,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
              hover={{ background: "#e2f1e8" }}
            >
              보관함에서 보기
            </Box>
          </div>
        )}
        {live.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".4px", color: "#6a665e" }}>
              이어서 할 업무
            </span>
            {next.map((t, i) => (
              <Box
                key={t.folder}
                onClick={() => void s.selectTask(t.folder)}
                role="button"
                className="cf-enter"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  padding: "9px 11px",
                  borderWidth: 1,
                  borderStyle: "solid",
                  borderColor: "#e6e2da",
                  borderRadius: 6,
                  background: "#fff",
                  cursor: "pointer",
                  animationDelay: `${60 + i * 40}ms`,
                }}
                hover={{ background: "#f7fafe", borderColor: "#c9dbf7" }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: statusOf(t.status).dot,
                    flex: "0 0 7px",
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    color: "#23211e",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.title}
                </span>
                <span style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, color: "#6a665e" }}>
                  {shortStamp(t.updated)}
                </span>
                <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" style={{ color: "#8a857c", flex: "0 0 12px" }}>
                  <path
                    d="M3 6h6M6.5 3.2 9.3 6 6.5 8.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Box>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
