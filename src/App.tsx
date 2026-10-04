import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TitleBar from "./components/TitleBar";
import MenuBar from "./components/MenuBar";
import Sidebar from "./components/Sidebar";
import Toasts from "./components/Toasts";
import ContextMenu from "./components/ContextMenu";
import TabMenu from "./components/TabMenu";
import CategoryMenu from "./components/CategoryMenu";
import Workspace from "./screens/Workspace";
import Templates from "./screens/Templates";
import Archive from "./screens/Archive";
import Settings from "./screens/Settings";
import Wiki from "./screens/Wiki";
import NewTaskModal from "./modals/NewTaskModal";
import MergeModal from "./modals/MergeModal";
import DayLogModal from "./modals/DayLogModal";
import IwmsPushModal from "./modals/IwmsPushModal";
import DeleteModal from "./modals/DeleteModal";
import ImportModal from "./modals/ImportModal";
import OpenWithModal from "./modals/OpenWithModal";
import TemplateModal from "./modals/TemplateModal";
import RenameTaskModal from "./modals/RenameTaskModal";
import AbsorbModal from "./modals/AbsorbModal";
import SplitModal from "./modals/SplitModal";
import CategoryModal from "./modals/CategoryModal";
import { Box } from "./lib/ui";
import { emptyNewTask, lastReloadAt, useStore } from "./store/useStore";
import { RELOAD_DELAY_MS, shouldReload } from "./lib/focus";
import { useAi } from "./store/aiStore";
import { useIwms } from "./store/iwmsStore";
import { useWiki } from "./store/wikiStore";
import { startIndexSync } from "./store/indexSync";

export default function App() {
  const s = useStore();

  useEffect(() => {
    // 위키 상태는 Vault 를 연 뒤에 읽는다 — 사이드바 도크의 페이지 수가 거기서 나온다.
    void useStore
      .getState()
      .boot()
      .then(() => useWiki.getState().refresh());
    // AI 연결 탐지는 Vault 부팅과 독립이다 — 캐시 우선이라 네트워크를 타지 않고,
    // 실패해도 앱은 로컬 유사도로 정상 동작한다.
    void useAi.getState().refreshAll();
  }, []);

  // Obsidian 색인 노트(보관함 MOC · 카테고리 허브)의 자동 갱신. boot 와 따로 둔다 — StrictMode 의
  // 두 번 도는 effect 에서도 정리 함수(stop)가 앞의 구독을 끊어 하나만 남는다.
  useEffect(() => startIndexSync(), []);

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

  // 창에 돌아오면 디스크를 다시 읽는다 — Obsidian 에서 손으로 고친 카테고리 · 제목 · 노트가 다음 계기
  // (저장 · 업무 전환)를 기다리지 않고 보이게. 신호는 OS 창의 포커스다: DOM 의 focus · visibility 는
  // HTML 뷰어의 iframe 으로 포커스가 들어갈 때도 흐려지고, Alt-Tab 사이에도 문서는 보인다(`lib/focus.ts`).
  //
  // 흐려지면 고치던 글을 내려쓴다(`beforeunload` 와 같다) — 다른 앱이 읽는 것이 디스크다. 돌아오면
  // 조금 기다렸다 다시 읽고, 그 사이에 다시 흐려지면 취소한다.
  useEffect(() => {
    // StrictMode 는 effect 를 두 번 돌린다. 구독은 비동기라 정리가 먼저 오면 아직 끊을 함수가 없다 —
    // 깃발을 보고 늦게 온 구독을 그 자리에서 끊는다.
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let blurredAt: number | null = null;
    let timer: number | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        const st = useStore.getState();
        if (!focused) {
          blurredAt = Date.now();
          window.clearTimeout(timer);
          void st.saveAll();
          return;
        }
        const away = blurredAt;
        blurredAt = null;
        if (!st.ready || st.bootError || !shouldReload(away, Date.now(), lastReloadAt())) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void useStore.getState().refreshFromDisk(), RELOAD_DELAY_MS);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  // Save on Ctrl+S and flush everything before the window closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // 저장 성공은 알리지 않는다 — 탭의 dirty 표시가 사라지고 헤더의 "스냅샷 HH:MM"
        // 이 갱신되므로(Workspace.tsx) 토스트는 같은 말을 한 번 더 하는 것뿐이다.
        void st.saveAll();
      } else if (e.ctrlKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        // 카테고리 관리(zIndex 74) 아래에 새 업무 창(60)이 열리면 보이지도 않고 닫을 수도 없다.
        if (st.catMgr) return;
        st.set({
          newOpen: true,
          nt: emptyNewTask(),
          ntRecs: [],
          recTag: {},
          ntRefs: [],
        });
      } else if (e.key === "Escape") {
        // 겹쳐 있는 레이어 중 **맨 위 하나만** 닫는다. 순서는 화면에 쌓인 순서
        // (각 모달의 zIndex)와 같아야 하고, 진행 중인 드래그가 가장 위다.
        if (e.defaultPrevented) return; // 네이티브 <select> 등이 이미 소비했다
        if (st.fileDrag) st.set({ fileDrag: null });
        else if (st.ctx) st.set({ ctx: null });
        else if (st.tabCtx) st.set({ tabCtx: null });
        else if (st.catCtx) st.set({ catCtx: null });
        else if (st.mk) st.set({ mk: null });
        else if (st.fileRen) st.set({ fileRen: null });
        else if (st.del) st.set({ del: null });
        else if (st.ow) st.set({ ow: null });
        else if (st.ren) st.set({ ren: null });
        else if (st.drop) st.set({ drop: null });
        else if (st.tplNew) st.set({ tplNew: null });
        // 폼이 열려 있으면 폼만 닫는다. 고르는 목록의 Esc 는 CategoryPicker 가 먼저 소비하므로
        // 목록 → 폼 → 대화상자 순서가 된다. 바꾸는 중에는 편입과 같은 까닭으로 닫지 않는다.
        else if (st.catMgr) {
          if (st.catMgr.busy) return;
          if (st.catMgr.edit) st.setCatEdit(null);
          else st.set({ catMgr: null });
        } else if (useIwms.getState().push) {
          // 정제 · 저장이 도는 중에는 닫지 않는다 — 실패 사유를 적을 자리가 사라진다.
          if (!useIwms.getState().pushBusy) useIwms.getState().closePush(false);
        } else if (st.dayLogOpen) st.set({ dayLogOpen: null });
        // 옮기기가 도는 중에는 닫지 않는다 — 대화상자를 치워도 이동은 멈추지 않고,
        // 실패 사유를 적을 자리만 사라진다.
        else if (st.absorb && !st.absorb.busy) st.set({ absorb: null });
        else if (st.split && !st.split.busy) st.set({ split: null });
        else if (st.merge) st.set({ merge: null });
        else if (st.newOpen) st.set({ newOpen: false });
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
    // 창을 가장자리까지 꽉 채운다. 설계 원본(design/ContextFlow.dc.html:33)의 바깥 여백과
    // 회색 그러데이션은 브라우저 목업에서 *데스크톱 바탕화면*을 흉내 내던 것이라, 실제
    // 창 안에서는 테두리를 한 겹 더 감싼 회색 띠로만 보인다. 창 이동은 TitleBar 의
    // data-tauri-drag-region 이, 가장자리 리사이즈는 undecorated 창이 유지하는 OS 리사이즈
    // 보더가 담당하므로 여백 없이도 둘 다 그대로 동작한다.
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        overflow: "hidden",
        scrollbarGutter: "auto",
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
              {s.screen === "wiki" && <Wiki />}
            </>
          )}
        </div>
      </div>

      <ContextMenu />
      <TabMenu />
      <CategoryMenu />
      <DeleteModal />
      <ImportModal />
      <OpenWithModal />
      <TemplateModal />
      <RenameTaskModal />
      <NewTaskModal />
      <AbsorbModal />
      <SplitModal />
      <CategoryModal />
      <MergeModal />
      <DayLogModal />
      <IwmsPushModal />
      <Toasts />
    </div>
  );
}
