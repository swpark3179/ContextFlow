import { useRef } from "react";
import { Box } from "../lib/ui";
import { statusOf, GREEN } from "../lib/design";
import EditorPane from "../components/EditorPane";
import Notepad from "../components/Notepad";
import Explorer from "../components/Explorer";
import { isArchived, useStore } from "../store/useStore";

const STATUS_OPTIONS: [string, string, string][] = [
  ["in-progress", "진행 중", "작업 재개"],
  ["on-hold", "보류", "스냅샷 저장"],
  ["completed", "완료", "이력 확정"],
];

export default function Workspace() {
  const s = useStore();
  const dockRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<"col" | "rowL" | null>(null);

  const task = s.tasks.find((t) => t.folder === s.activeFolder);

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

  if (!task) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          background: "#fdfcfa",
        }}
      >
        <div style={{ fontSize: 14, color: "#8a857c" }}>업무가 없습니다</div>
        <div style={{ fontSize: 12, color: "#a09a8f", textAlign: "center", lineHeight: 1.8 }}>
          왼쪽 아래 [+ 새 업무 추가]로 첫 업무를 만들어 보세요.
          <br />
          업무마다 전용 폴더가 Vault 안에 생성됩니다.
        </div>
      </div>
    );
  }

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
                  color: "#a09a8f",
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
                  fontSize: 10.5,
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
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 3 }}>
            <span
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11,
                color: "#a09a8f",
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
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#8a857c" }}>
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: GREEN }} />
          <span>스냅샷 {s.snapAt}</span>
        </div>
        <Box
          onClick={() => s.set({ statusMenuOpen: !s.statusMenuOpen })}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 26,
            padding: "0 9px",
            borderRadius: 5,
            cursor: "pointer",
            border: `1px solid ${st.bd}`,
            background: st.bg,
            color: st.fg,
            fontSize: 12.5,
            fontWeight: 600,
          }}
        >
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: st.dot }} />
          {st.label}
          <span style={{ fontSize: 9, opacity: 0.7 }}>▼</span>
        </Box>
        {s.statusMenuOpen && (
          <>
            <div
              onClick={() => s.set({ statusMenuOpen: false })}
              style={{ position: "fixed", inset: 0, zIndex: 25 }}
            />
            <div
              style={{
                position: "absolute",
                top: 44,
                right: 12,
                zIndex: 30,
                background: "#fff",
                border: "1px solid #d9d4ca",
                borderRadius: 6,
                boxShadow: "0 10px 26px rgba(35,33,30,.16)",
                padding: 4,
                minWidth: 172,
                animation: "pIn .12s ease-out",
              }}
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
                  <span style={{ fontSize: 11, color: "#a09a8f" }}>{hint}</span>
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
                <span style={{ fontSize: 11, color: "#a09a8f" }}>목록에서 숨김</span>
              </Box>
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
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#6a54c6" }} />
                <span style={{ flex: 1 }}>Obsidian에서 열기</span>
                <span style={{ fontSize: 11, color: "#a09a8f" }}>
                  {s.obsidianOk ? "index.md" : "탐색기 폴백"}
                </span>
              </Box>
            </div>
          </>
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
              border: "1px solid #e0d6f8",
              background: "#f4f0fd",
              color: "#5a44b4",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
            hover={{ background: "#ece5fb" }}
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
