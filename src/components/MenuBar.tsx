import { useState } from "react";
import { Box } from "../lib/ui";
import { useStore } from "../store/useStore";
import { GREEN } from "../lib/design";
import * as api from "../lib/api";

interface MenuItem {
  label: string;
  hint?: string;
  run: () => void;
  /** 지금 할 수 없는 항목. 흐리게 그리고 눌러도 아무 일도 하지 않는다. */
  off?: boolean;
}

/** The design's menu strip, wired to the actions it names. */
export default function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const s = useStore();

  /**
   * 고른 업무가 없다 — 완료로 창을 닫은 직후(`setStatus`)이거나 Vault 가 비었을 때다.
   * 그때 업무 하나를 집어야 하는 항목들은 폴더 경로가 빈 문자열이라, 그대로 누르면
   * 백엔드가 거절하고 실패 토스트만 뜬다. 눌리지 않는 것으로 먼저 보여 준다.
   */
  const noTask = !s.activeFolder;

  const menus: Record<string, MenuItem[]> = {
    파일: [
      { label: "새 업무…", hint: "Ctrl+N", run: () => s.set({ newOpen: true }) },
      {
        label: "새 파일",
        hint: "Ctrl+Alt+N",
        off: noTask,
        run: () => s.set({ mk: { kind: "file", parent: "", name: "" } }),
      },
      {
        label: "새 폴더",
        off: noTask,
        run: () => s.set({ mk: { kind: "folder", parent: "", name: "" } }),
      },
      { label: "저장", hint: "Ctrl+S", off: noTask, run: () => void s.saveAll() },
      {
        label: "업무 폴더 열기",
        off: noTask,
        run: () => {
          if (s.activeFolder) void api.revealPath(s.activeFolder);
        },
      },
    ],
    편집: [
      {
        label: "경로 복사",
        off: !s.ui.sel,
        run: () => {
          if (!s.ui.sel) return;
          void navigator.clipboard.writeText(`${s.activeFolder}/${s.ui.sel}`);
          s.toast("클립보드에 경로를 복사했습니다", `${s.activeFolder}/${s.ui.sel}`);
        },
      },
    ],
    보기: [
      { label: "업무 리스트 접기/펼치기", run: () => s.set({ sidebarMin: !s.sidebarMin }) },
      { label: "탐색기 접기/펼치기", run: () => s.set({ explorerMin: !s.explorerMin }) },
      { label: "메모장 접기/펼치기", run: () => s.set({ noteMin: !s.noteMin }) },
    ],
    업무: [
      { label: "진행 중으로", off: noTask, run: () => void s.setStatus("in-progress") },
      { label: "보류", off: noTask, run: () => void s.setStatus("on-hold") },
      // 완료는 그 자리에서 보관하고 창을 닫는다(`setStatus`).
      { label: "완료 (보관함으로)", off: noTask, run: () => void s.setStatus("completed") },
      { label: "지금 보관함으로", off: noTask, run: () => void s.archiveNow(s.activeFolder) },
      // 한 번 끌어 옮기면 그 순서가 계속 이긴다 — 돌아가는 길이 있어야 한다.
      // 업무 하나가 아니라 목록 전체를 다루므로 고른 업무가 없어도 쓸 수 있다.
      { label: "정렬 초기화 (최근 수정순)", run: () => void s.clearTaskOrder() },
      {
        label: "Obsidian에서 열기",
        off: noTask,
        run: () => void s.openTaskInObsidian(s.activeFolder),
      },
    ],
    도움말: [
      {
        label: "Obsidian 연동 상태",
        run: () =>
          s.toast(
            s.obsidianOk ? "Obsidian이 설치되어 있습니다" : "Obsidian이 설치되어 있지 않습니다",
            s.obsidianOk
              ? "obsidian:// 링크로 노트를 바로 엽니다"
              : "[Obsidian] 버튼은 탐색기로 폴백합니다",
            s.obsidianOk ? "#5fbf8d" : "#a8a29a",
          ),
      },
      { label: "설정 열기", run: () => s.setScreen("settings") },
    ],
  };

  return (
    <div
      style={{
        height: 27,
        flex: "0 0 27px",
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "0 8px",
        background: "#faf9f6",
        borderBottom: "1px solid #e6e2da",
        position: "relative",
      }}
      onMouseLeave={() => setOpen(null)}
    >
      {Object.keys(menus).map((m) => (
        <div key={m} style={{ position: "relative" }}>
          <Box
            style={{
              fontSize: 12.5,
              color: "#4e4a43",
              padding: "3px 7px",
              borderRadius: 4,
              cursor: "default",
              background: open === m ? "#ece8e0" : "transparent",
            }}
            hover={{ background: "#ece8e0" }}
            onClick={() => setOpen(open === m ? null : m)}
            onMouseEnter={() => open && setOpen(m)}
          >
            {m}
          </Box>
          {open === m && (
            <div
              style={{
                position: "absolute",
                top: 24,
                left: 0,
                minWidth: 190,
                background: "#fff",
                border: "1px solid #ddd8cf",
                borderRadius: 6,
                boxShadow: "0 12px 28px rgba(35,33,30,.18)",
                padding: 4,
                zIndex: 60,
                animation: "pIn .1s ease",
              }}
            >
              {menus[m].map((item) => (
                <Box
                  key={item.label}
                  title={item.off ? "먼저 왼쪽 업무 리스트에서 업무를 선택하세요" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    color: item.off ? "#b5afa2" : "#3a3630",
                    padding: "5px 8px",
                    borderRadius: 4,
                    cursor: item.off ? "default" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                  hover={item.off ? undefined : { background: "#f2efe9" }}
                  onClick={() => {
                    if (item.off) return;
                    setOpen(null);
                    item.run();
                  }}
                >
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.hint && (
                    <span
                      style={{
                        fontFamily: "'Roboto Mono',monospace",
                        fontSize: 10.5,
                        color: "#b5afa2",
                      }}
                    >
                      {item.hint}
                    </span>
                  )}
                </Box>
              ))}
            </div>
          )}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: s.bootError ? "#c04a4a" : GREEN,
          }}
        />
        <span
          style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, color: "#8a857c" }}
        >
          {s.settings.vault}
        </span>
      </div>
    </div>
  );
}
