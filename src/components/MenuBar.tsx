import { useState } from "react";
import { Box } from "../lib/ui";
import { useStore } from "../store/useStore";
import { GREEN } from "../lib/design";
import * as api from "../lib/api";

interface MenuItem {
  label: string;
  hint?: string;
  run: () => void;
}

/** The design's menu strip, wired to the actions it names. */
export default function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const s = useStore();

  const menus: Record<string, MenuItem[]> = {
    파일: [
      { label: "새 업무…", hint: "Ctrl+N", run: () => s.set({ newOpen: true }) },
      { label: "새 파일", hint: "Ctrl+Alt+N", run: () => s.set({ mk: { kind: "file", parent: "", name: "" } }) },
      { label: "새 폴더", run: () => s.set({ mk: { kind: "folder", parent: "", name: "" } }) },
      { label: "저장", hint: "Ctrl+S", run: () => void s.saveAll() },
      {
        label: "업무 폴더 열기",
        run: () => {
          if (s.activeFolder) void api.revealPath(s.activeFolder);
        },
      },
    ],
    편집: [
      {
        label: "경로 복사",
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
      { label: "진행 중으로", run: () => void s.setStatus("in-progress") },
      { label: "보류", run: () => void s.setStatus("on-hold") },
      { label: "완료", run: () => void s.setStatus("completed") },
      { label: "지금 보관함으로", run: () => void s.archiveNow(s.activeFolder) },
      {
        label: "Obsidian에서 열기",
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
              fontSize: 11.5,
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
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11.5,
                    color: "#3a3630",
                    padding: "5px 8px",
                    borderRadius: 4,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                  hover={{ background: "#f2efe9" }}
                  onClick={() => {
                    setOpen(null);
                    item.run();
                  }}
                >
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.hint && (
                    <span
                      style={{
                        fontFamily: "'IBM Plex Mono',monospace",
                        fontSize: 9.5,
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
          style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, color: "#8a857c" }}
        >
          {s.settings.vault}
        </span>
      </div>
    </div>
  );
}
