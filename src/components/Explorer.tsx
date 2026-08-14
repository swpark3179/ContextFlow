import { useEffect, useMemo, useRef } from "react";
import { Box } from "../lib/ui";
import { extOf, extStyle } from "../lib/design";
import { dragCursor, dragKind } from "../lib/dragCursor";
import { flatten } from "../lib/tree";
import { useDropGuard, useLongPress } from "../lib/longPress";
import { dirname } from "../lib/format";
import { useStore } from "../store/useStore";

/** 고스트의 최대 폭(아래 `maxWidth`). 창 가장자리에 붙일 때 쓴다. */
const GHOST_W = 300;

export default function Explorer() {
  const s = useStore();
  const { ui, files, activeFolder } = s;
  const mkInput = useRef<HTMLInputElement | null>(null);
  const task = s.tasks.find((t) => t.folder === activeFolder);
  const { markDropped, justDropped } = useDropGuard();

  const rows = useMemo(() => flatten(files, ui.treeOpen), [files, ui.treeOpen]);
  const openedModes = useMemo(() => {
    const m: Record<string, { md?: boolean; text?: boolean; html?: boolean }> = {};
    ui.openTabs.forEach((t) => {
      m[t.path] = { ...m[t.path], [t.mode]: true };
    });
    return m;
  }, [ui.openTabs]);

  useEffect(() => {
    if (s.mk) mkInput.current?.focus();
  }, [s.mk]);

  /**
   * 드래그가 살아 있는 동안만 붙는 리스너. 스토어에서 상태를 직접 읽어 최신 값을 쓴다
   * — 리렌더마다 리스너를 갈아 끼우면 포인터 캡처가 끊긴다.
   */
  useEffect(() => {
    if (!s.fileDrag) return;
    const move = (e: PointerEvent) => {
      const d = useStore.getState().fileDrag;
      if (!d) return;
      const outside =
        e.clientX < 0 ||
        e.clientY < 0 ||
        e.clientX > window.innerWidth ||
        e.clientY > window.innerHeight;
      useStore.getState().set({
        fileDrag: {
          ...d,
          x: e.clientX,
          y: e.clientY,
          outside,
          alt: e.altKey,
          over: outside ? null : folderAt(e.clientX, e.clientY),
        },
      });
    };
    const up = (e: PointerEvent) => {
      const st = useStore.getState();
      const d = st.fileDrag;
      st.set({ fileDrag: null });
      markDropped();
      if (!d) return;
      if (d.outside) void st.exportToDesktop(d.path, e.altKey ? "link" : "copy");
      else if (d.over !== null) void st.moveFile(d.path, d.over);
    };
    // Alt 는 놓기 전에도 눌렀다 뗐다 할 수 있으므로 키 이벤트로 고스트를 갱신한다.
    const key = (e: KeyboardEvent) => {
      const d = useStore.getState().fileDrag;
      if (d && d.alt !== e.altKey) useStore.getState().set({ fileDrag: { ...d, alt: e.altKey } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
    };
    // 드래그의 시작/끝에만 반응하면 된다 — 좌표가 바뀔 때마다 다시 붙이면 그 사이
    // 이벤트가 새고, 잡아 둔 포인터도 놓친다.
  }, [!!s.fileDrag]);

  const selMeta = ui.sel ? files.find((f) => f.p === ui.sel) : undefined;
  const selExt = ui.sel ? extOf(ui.sel) : "";
  const selEs = extStyle(selExt);
  const anyCollapsed = Object.values(ui.treeOpen).some((v) => v === false);

  // -- 롱프레스 드래그 ------------------------------------------------------
  //
  // 감시 기계장치는 `lib/longPress.ts` 에 있고 업무 리스트의 순서 바꾸기와 함께 쓴다.
  // 여기 남은 것은 이 화면만의 판정 — 어느 폴더 위에 놓았는가다.

  /** 드롭 지점 아래의 행을 찾아 **넣을 폴더**의 상대 경로로 바꾼다. */
  const folderAt = (x: number, y: number): string | null => {
    const hit = document.elementFromPoint(x, y)?.closest("[data-tree-path]");
    const path = hit?.getAttribute("data-tree-path");
    if (path === null || path === undefined) return null;
    // 폴더 위면 그 안으로, 파일 위면 그 파일과 같은 폴더로.
    return path.endsWith("/") ? path : dirname(path);
  };

  const { startPress } = useLongPress<{ path: string; name: string; isDir: boolean }>(
    ({ path, name, isDir }, { x, y }) => {
      s.set({ fileDrag: { path, name, isDir, x, y, over: null, outside: false, alt: false } });
    },
  );

  const drag = s.fileDrag;

  const startMk = (kind: "file" | "folder", dir?: string) => {
    const parent =
      dir ?? (ui.sel ? ui.sel.split("/").slice(0, -1).join("/") : "");
    s.set({ mk: { kind, parent: parent ? parent.replace(/\/?$/, "/") : "", name: "" } });
    s.set({ explorerMin: false });
  };

  const collapseAll = () => {
    if (anyCollapsed) return s.setUi({ treeOpen: {} });
    const dirs: Record<string, boolean> = {};
    files.forEach((f) => {
      const parts = f.p.split("/");
      const n = f.dir ? parts.length - 1 : parts.length - 1;
      let pre = "";
      for (let i = 0; i < n; i++) {
        pre += parts[i] + "/";
        dirs[pre] = false;
      }
    });
    s.setUi({ treeOpen: dirs });
  };

  if (s.explorerMin) {
    return (
      <div
        style={{
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          background: "#faf9f6",
          borderLeft: "1px solid #e6e2da",
          flex: "0 0 34px",
        }}
      >
        <Box
          onClick={() => s.set({ explorerMin: false })}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 11,
            padding: "9px 0",
            cursor: "pointer",
          }}
          hover={{ background: "#efece6" }}
        >
          <span style={{ fontSize: 9, color: "#8a857c" }}>◀</span>
          <span
            style={{
              writingMode: "vertical-rl",
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: 1,
              color: "#6a665e",
            }}
          >
            탐색기
          </span>
          <span
            style={{
              writingMode: "vertical-rl",
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 10.5,
              color: "#b5afa2",
            }}
          >
            {files.length}개 파일
          </span>
        </Box>
      </div>
    );
  }

  const smallBtn: React.CSSProperties = {
    fontSize: 11,
    color: "#4e4a43",
    cursor: "pointer",
    padding: "2px 5px",
    borderRadius: 3,
    border: "1px solid #e0dcd4",
    background: "#fff",
    whiteSpace: "nowrap",
    flex: "0 0 auto",
  };

  return (
    <div
      style={{
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "#faf9f6",
        borderLeft: "1px solid #e6e2da",
        flex: "1 1 auto",
      }}
    >
      <div
        style={{
          flex: "0 0 26px",
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "0 6px 0 11px",
          background: "#f7f5f1",
          borderBottom: "1px solid #e6e2da",
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: ".4px",
            color: "#6a665e",
            whiteSpace: "nowrap",
            flex: "1 1 auto",
            minWidth: 0,
          }}
        >
          탐색기
        </span>
        <Box
          onClick={() => startMk("file")}
          style={smallBtn}
          hover={{ borderColor: "#3a6fd8", color: "#2f5cbb" }}
        >
          ＋ 파일
        </Box>
        <Box
          onClick={() => startMk("folder")}
          style={smallBtn}
          hover={{ borderColor: "#b07520", color: "#8f5d17" }}
        >
          ＋ 폴더
        </Box>
        <Box
          onClick={collapseAll}
          style={{
            fontSize: 11,
            color: "#8a857c",
            cursor: "pointer",
            padding: "2px 4px",
            borderRadius: 3,
            whiteSpace: "nowrap",
            flex: "0 0 auto",
          }}
          hover={{ background: "#e6e2da", color: "#4e4a43" }}
        >
          {anyCollapsed ? "모두 펼치기" : "모두 접기"}
        </Box>
        <Box
          onClick={() => s.set({ explorerMin: true, mk: null })}
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
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderBottom: "1px solid #eae6de",
          background: "#fdfcfa",
        }}
      >
        <div
          style={{
            width: 11,
            height: 9,
            borderRadius: "1.5px 2px 2px 2px",
            background: "#d9c78f",
            border: "1px solid #c5b073",
            flex: "0 0 11px",
          }}
        />
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 11,
            color: "#6a665e",
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={activeFolder}
        >
          {task?.relFolder ?? ""}
        </span>
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 10.5,
            color: "#b5afa2",
            flex: "0 0 auto",
          }}
        >
          {files.length}개 파일
        </span>
      </div>

      <div
        // 행 바깥의 빈 자리는 업무 폴더 최상위를 뜻한다 — `closest` 가 행을 먼저 찾으므로
        // 행 위에서는 이 값이 쓰이지 않는다.
        data-tree-path=""
        onDragOver={(e) => {
          e.preventDefault();
          if (!s.dragOver) s.set({ dragOver: true });
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          s.set({ dragOver: false });
        }}
        onDrop={(e) => e.preventDefault()}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "5px 6px 8px 6px",
          background: s.dragOver ? "#f4f8fe" : "transparent",
        }}
      >
        {s.mk && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: 26,
                marginBottom: 4,
                padding: "0 5px",
                border: "1px solid #cddcf8",
                borderRadius: 4,
                background: "#f7fafe",
              }}
            >
              <span
                style={{
                  flex: "0 0 auto",
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 8.5,
                  fontWeight: 600,
                  color: s.mk.kind === "folder" ? "#8f5d17" : "#2f5cbb",
                  background: s.mk.kind === "folder" ? "#fbf3e6" : "#eef3fd",
                  borderRadius: 2,
                  padding: "1px 3px",
                }}
              >
                {s.mk.kind === "folder" ? "DIR" : "FILE"}
              </span>
              <input
                ref={mkInput}
                value={s.mk.name}
                onChange={(e) => s.set({ mk: { ...s.mk!, name: e.target.value } })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void s.commitMk();
                  else if (e.key === "Escape") s.set({ mk: null });
                }}
                placeholder={
                  s.mk.kind === "folder" ? "새 폴더 이름" : "새 파일 이름 (확장자 생략 시 .md)"
                }
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 0,
                  outline: "none",
                  background: "transparent",
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 12,
                  color: "#23211e",
                }}
              />
              <Box
                onClick={() => void s.commitMk()}
                style={{
                  flex: "0 0 auto",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#2f5cbb",
                  cursor: "pointer",
                  padding: "2px 5px",
                  borderRadius: 3,
                }}
                hover={{ background: "#e2ebfb" }}
              >
                만들기
              </Box>
              <div
                onClick={() => s.set({ mk: null })}
                style={{
                  flex: "0 0 auto",
                  fontSize: 11,
                  color: "#a09a8f",
                  cursor: "pointer",
                  padding: "2px 4px",
                }}
              >
                취소
              </div>
            </div>
            <div style={{ fontSize: 10.5, color: "#a09a8f", margin: "-1px 0 6px 6px" }}>
              위치 · {task?.relFolder ?? ""}
              {s.mk.parent}
            </div>
          </>
        )}

        {rows.map((r) => {
          const pad = 6 + r.depth * 13;
          const dropInto = drag && (drag.over ?? "") === (r.kind === "dir" ? r.path : dirname(r.path));
          if (r.kind === "dir") {
            return (
              <Box
                key={`d${r.path}`}
                data-tree-path={r.path}
                onPointerDown={(e) => startPress(e, { path: r.path, name: r.name, isDir: true })}
                onClick={() => {
                  if (justDropped()) return;
                  s.setUi({
                    treeOpen: { ...ui.treeOpen, [r.path]: ui.treeOpen[r.path] === false },
                  });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  s.setUi({ sel: r.path });
                  s.set({
                    ctx: {
                      path: r.path,
                      name: r.name,
                      ext: "",
                      isDir: true,
                      bin: false,
                      count: r.count,
                      x: e.clientX,
                      y: e.clientY,
                    },
                  });
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  height: 23,
                  borderRadius: 4,
                  cursor: "default",
                  userSelect: "none",
                  paddingRight: 6,
                  paddingLeft: pad,
                  background: dropInto ? "#e6eefc" : "transparent",
                  outline: dropInto ? "1px solid #3a6fd8" : "none",
                }}
                hover={{ background: "#efece6" }}
              >
                <span style={{ flex: "0 0 9px", fontSize: 8, color: "#a09a8f", textAlign: "center" }}>
                  {r.open ? "▼" : "▶"}
                </span>
                <div
                  style={{
                    width: 11,
                    height: 9,
                    borderRadius: "1.5px 2px 2px 2px",
                    background: "#e2d6ae",
                    border: "1px solid #cbba86",
                    flex: "0 0 11px",
                  }}
                />
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: 500,
                    color: "#4e4a43",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.name}
                </span>
                <span
                  style={{
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 10,
                    color: "#b5afa2",
                    flex: "0 0 auto",
                  }}
                >
                  {r.count}
                </span>
              </Box>
            );
          }

          const ext = extOf(r.name);
          const es = extStyle(ext);
          const on = ui.sel === r.path;
          const om = openedModes[r.path] ?? {};
          return (
            <Box
              key={`f${r.path}`}
              data-tree-path={r.path}
              onPointerDown={(e) => startPress(e, { path: r.path, name: r.name, isDir: false })}
              onClick={() => {
                if (justDropped()) return;
                s.setUi({ sel: r.path });
                s.set({ ctx: null });
              }}
              onDoubleClick={() => void s.defaultOpen(r.path, r.bin)}
              onContextMenu={(e) => {
                e.preventDefault();
                s.setUi({ sel: r.path });
                s.set({
                  ctx: {
                    path: r.path,
                    name: r.name,
                    ext,
                    isDir: false,
                    bin: r.bin,
                    count: 0,
                    x: e.clientX,
                    y: e.clientY,
                  },
                });
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: 23,
                borderRadius: 4,
                cursor: "default",
                userSelect: "none",
                paddingRight: 6,
                paddingLeft: pad,
                background: on || dropInto ? "#e6eefc" : "transparent",
                opacity: drag?.path === r.path ? 0.4 : 1,
              }}
              hover={{ background: on ? "#e6eefc" : "#efece6" }}
            >
              <span style={{ flex: "0 0 9px" }} />
              <span
                style={{
                  flex: "0 0 auto",
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 8.5,
                  fontWeight: 600,
                  letterSpacing: ".2px",
                  borderRadius: 2,
                  padding: "1px 3px",
                  color: es.fg,
                  background: es.bg,
                }}
              >
                {ext.toUpperCase()}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  color: on ? "#23211e" : "#4e4a43",
                  fontWeight: on ? 600 : 400,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.name}
              </span>
              {om.md && (
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 8.5,
                    color: "#5a44b4",
                    background: "#f2eefc",
                    borderRadius: 2,
                    padding: "1px 3px",
                  }}
                >
                  MD
                </span>
              )}
              {om.html && (
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 8.5,
                    color: "#8f5d17",
                    background: "#fbf3e6",
                    borderRadius: 2,
                    padding: "1px 3px",
                  }}
                >
                  HTML
                </span>
              )}
              {om.text && (
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 8.5,
                    color: "#2f5cbb",
                    background: "#eef3fd",
                    borderRadius: 2,
                    padding: "1px 3px",
                  }}
                >
                  TXT
                </span>
              )}
              {ui.extOpened[r.path] && (
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 9,
                    color: "#8a857c",
                    background: "#efece6",
                    borderRadius: 2,
                    padding: "1px 3px",
                  }}
                >
                  ↗
                </span>
              )}
              {r.link && (
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 8.5,
                    fontWeight: 600,
                    color: "#8f5d17",
                    background: "#fbf3e6",
                    borderRadius: 2,
                    padding: "1px 3px",
                  }}
                  title={r.link}
                >
                  LNK
                </span>
              )}
            </Box>
          );
        })}

        <div
          style={{
            marginTop: 9,
            border: `1px dashed ${s.dragOver ? "#3a6fd8" : "#ddd8cf"}`,
            borderRadius: 6,
            padding: "10px 8px",
            textAlign: "center",
            background: s.dragOver ? "#eef3fd" : "transparent",
          }}
        >
          <div
            style={{ fontSize: 11.5, color: s.dragOver ? "#2f5cbb" : "#a09a8f", lineHeight: 1.6 }}
          >
            {s.dragOver
              ? "놓으면 이 업무 폴더로 가져옵니다"
              : "바탕화면에서 파일을 끌어다 놓기"}
          </div>
          <div style={{ fontSize: 10.5, color: "#b5afa2", marginTop: 2 }}>
            복사 또는 심볼릭 링크를 선택할 수 있습니다
          </div>
        </div>
      </div>

      {ui.sel && (
        <div
          style={{
            flex: "0 0 auto",
            borderTop: "1px solid #e0dcd4",
            background: "#fff",
            padding: "8px 10px 9px 10px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              marginBottom: 7,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 8.5,
                fontWeight: 600,
                borderRadius: 2,
                padding: "1px 3px",
                color: selEs.fg,
                background: selEs.bg,
                flex: "0 0 auto",
              }}
            >
              {ui.sel.endsWith("/") ? "DIR" : selExt.toUpperCase()}
            </span>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {ui.sel.replace(/\/$/, "").split("/").pop()}
            </span>
            <span
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 10.5,
                color: "#a09a8f",
                flex: "0 0 auto",
              }}
            >
              {selMeta?.size ?? "—"}
            </span>
          </div>
          <div style={{ fontSize: 10.5, color: "#b5afa2", marginTop: -1, lineHeight: 1.6 }}>
            더블클릭 = 기본 열기 · 우클릭 = 열기 방식 메뉴
            <br />
            길게 누르면 = 옮기기 · 창 밖으로 = 바탕화면 (Alt = 링크)
          </div>
        </div>
      )}

      {/*
        드래그 중의 커서. 창 밖에서는 고스트가 따라갈 수 없으므로(웹뷰 안에만 그릴 수
        있다) 커서 자체에 배지를 붙여 무엇을 쥐고 있는지 알린다 — 바탕화면으로 복사면 ＋,
        Alt 로 링크만이면 ↗. 포인터를 캡처하고 있는 동안은 창 밖에서도 이 커서가 유지된다.

        `*` 에 !important 로 거는 이유는 캡처 중 커서를 정하는 것이 캡처 대상 요소이고,
        그 요소(행)와 지나치는 요소들이 저마다 cursor 를 들고 있기 때문이다.
      */}
      {drag && (
        <style>
          {`html, body, body * { cursor: ${dragCursor(
            dragKind(drag.outside, drag.alt),
          )} !important; }`}
        </style>
      )}

      {/*
        커서를 따라다니는 고스트. 창 밖으로 나가면 좌표가 화면 밖이라 그대로는 보이지
        않으므로 가장자리에 붙여 둔다 — 어떤 파일을 쥐고 있는지는 이름으로만 알 수 있다.
      */}
      {drag && (
        <div
          style={{
            position: "fixed",
            left: Math.min(Math.max(6, drag.x + 12), window.innerWidth - GHOST_W - 6),
            top: Math.min(Math.max(6, drag.y + 12), window.innerHeight - 34),
            zIndex: 95,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            gap: 7,
            maxWidth: 300,
            padding: "5px 9px",
            borderRadius: 5,
            border: `1px solid ${drag.outside ? "#cddcf8" : "#d9d4ca"}`,
            background: drag.outside ? "#eef3fd" : "#fff",
            boxShadow: "0 8px 20px rgba(35,33,30,.22)",
          }}
        >
          <span
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11,
              color: drag.alt && drag.outside ? "#5a44b4" : "#6a665e",
            }}
          >
            {drag.outside ? (drag.alt ? "⇢" : "⧉") : "↳"}
          </span>
          <span
            style={{
              fontSize: 12,
              color: "#3a3630",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {drag.name}
          </span>
          <span style={{ fontSize: 10.5, color: "#8a857c", flex: "0 0 auto" }}>
            {drag.outside
              ? drag.alt
                ? "바탕화면에 링크"
                : "바탕화면으로 복사"
              : drag.over === null
                ? "여기엔 놓을 수 없음"
                : drag.over === dirname(drag.path)
                  ? "이미 이 폴더에 있음"
                  : `${drag.over || "업무 폴더 최상위"} 로 이동`}
          </span>
        </div>
      )}
    </div>
  );
}
