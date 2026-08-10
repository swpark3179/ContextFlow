import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TitleBar from "./components/TitleBar";
import MenuBar from "./components/MenuBar";
import Sidebar from "./components/Sidebar";
import Toasts from "./components/Toasts";
import ContextMenu from "./components/ContextMenu";
import Workspace from "./screens/Workspace";
import Templates from "./screens/Templates";
import Archive from "./screens/Archive";
import Settings from "./screens/Settings";
import NewTaskModal from "./modals/NewTaskModal";
import MergeModal from "./modals/MergeModal";
import DeleteModal from "./modals/DeleteModal";
import ImportModal from "./modals/ImportModal";
import OpenWithModal from "./modals/OpenWithModal";
import TemplateModal from "./modals/TemplateModal";
import { Box } from "./lib/ui";
import { useStore } from "./store/useStore";
import { useAi } from "./store/aiStore";

export default function App() {
  const s = useStore();

  useEffect(() => {
    void useStore.getState().boot();
    // AI 연결 탐지는 Vault 부팅과 독립이다 — 캐시 우선이라 네트워크를 타지 않고,
    // 실패해도 앱은 로컬 유사도로 정상 동작한다.
    void useAi.getState().refreshAll();
  }, []);

  // OS-level file drops. The webview's HTML drop events never carry real paths,
  // so Tauri's window event is the only source that does.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        const st = useStore.getState();
        if (event.payload.type === "over" || event.payload.type === "enter") {
          if (!st.dragOver) st.set({ dragOver: true });
        } else if (event.payload.type === "drop") {
          const paths = event.payload.paths ?? [];
          if (st.activeFolder && paths.length) st.beginDrop(paths);
          else st.set({ dragOver: false });
        } else {
          st.set({ dragOver: false });
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  // Save on Ctrl+S and flush everything before the window closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void st.saveAll().then(() => st.toast("저장했습니다", "", "#5fbf8d"));
      } else if (e.ctrlKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        st.set({ newOpen: true, nt: { title: "", summary: "", tags: "", template: "(없음)" }, ntRecs: [] });
      } else if (e.key === "Escape") {
        if (st.ctx) st.set({ ctx: null });
        else if (st.mk) st.set({ mk: null });
      }
    };
    const onBeforeUnload = () => {
      const st = useStore.getState();
      void st.saveAll();
      void st.persistSnapshot();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  // Sidebar splitter.
  const startSidebarDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      useStore.getState().set({ sidebarW: Math.max(196, Math.min(430, ev.clientX - 10)) });
    };
    const stop = () => {
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  const task = s.tasks.find((t) => t.folder === s.activeFolder);
  const tab = s.ui.openTabs.find((t) => `${t.mode}|${t.path}` === s.ui.activeTab);
  const chromeTitle = task
    ? `${task.relFolder}${tab?.path ?? ""} — ContextFlow`
    : "ContextFlow";

  return (
    <div
      style={{
        height: "100vh",
        padding: 10,
        display: "flex",
        background: "radial-gradient(1200px 600px at 20% 0%,#efece6,#e2ded7)",
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          border: "1px solid #c6c1b6",
          borderRadius: 9,
          boxShadow: "0 24px 60px rgba(35,33,30,.22),0 2px 6px rgba(35,33,30,.10)",
          overflow: "hidden",
        }}
      >
        <TitleBar title={chromeTitle} />
        <MenuBar />

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <Sidebar />
          {!s.sidebarMin && (
            <Box
              onMouseDown={startSidebarDrag}
              style={{
                flex: "0 0 5px",
                cursor: "col-resize",
                background: "transparent",
                marginLeft: -2,
                zIndex: 5,
              }}
              hover={{ background: "#c9dbf7" }}
            />
          )}

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "#fff" }}>
            {!s.ready && (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  color: "#8a857c",
                }}
              >
                Vault를 읽는 중…
              </div>
            )}
            {s.ready && s.bootError && (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                  padding: 30,
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: "#a83c3c" }}>
                  Vault를 열지 못했습니다
                </div>
                <div
                  style={{
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 12,
                    color: "#6a665e",
                    maxWidth: 560,
                    lineHeight: 1.7,
                    wordBreak: "break-all",
                  }}
                >
                  {s.bootError}
                </div>
                <div style={{ fontSize: 12, color: "#8a857c" }}>
                  설정 화면에서 Vault Root 경로를 다시 지정해 보세요.
                </div>
                <Box
                  onClick={() => s.setScreen("settings")}
                  style={{
                    height: 28,
                    padding: "0 14px",
                    display: "flex",
                    alignItems: "center",
                    borderRadius: 5,
                    background: "#3a6fd8",
                    color: "#fff",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                  hover={{ background: "#2f5cbb" }}
                >
                  설정 열기
                </Box>
              </div>
            )}
            {s.ready && !s.bootError && (
              <>
                {s.screen === "workspace" && <Workspace />}
                {s.screen === "templates" && <Templates />}
                {s.screen === "archive" && <Archive />}
                {s.screen === "settings" && <Settings />}
              </>
            )}
          </div>
        </div>
      </div>

      <ContextMenu />
      <DeleteModal />
      <ImportModal />
      <OpenWithModal />
      <TemplateModal />
      <NewTaskModal />
      <MergeModal />
      <Toasts />
    </div>
  );
}
