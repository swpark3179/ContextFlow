import { useEffect, useMemo, useRef } from "react";
import { Box } from "../lib/ui";
import { appsFor, extOf, extStyle } from "../lib/design";
import { flatten } from "../lib/tree";
import { useStore } from "../store/useStore";

export default function Explorer() {
  const s = useStore();
  const { ui, files, activeFolder } = s;
  const mkInput = useRef<HTMLInputElement | null>(null);
  const task = s.tasks.find((t) => t.folder === activeFolder);

  const rows = useMemo(() => flatten(files, ui.treeOpen), [files, ui.treeOpen]);
  const openedModes = useMemo(() => {
    const m: Record<string, { md?: boolean; text?: boolean }> = {};
    ui.openTabs.forEach((t) => {
      m[t.path] = { ...m[t.path], [t.mode]: true };
    });
    return m;
  }, [ui.openTabs]);

  useEffect(() => {
    if (s.mk) mkInput.current?.focus();
  }, [s.mk]);

  const selMeta = ui.sel ? files.find((f) => f.p === ui.sel) : undefined;
  const selExt = ui.sel ? extOf(ui.sel) : "";
  const selEs = extStyle(selExt);
  const selIsMd = selExt === "md";
  const anyCollapsed = Object.values(ui.treeOpen).some((v) => v === false);

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
          <span style={{ fontSize: 8, color: "#8a857c" }}>◀</span>
          <span
            style={{
              writingMode: "vertical-rl",
              fontSize: 10.5,
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
              fontFamily: "'IBM Plex Mono',monospace",
              fontSize: 9.5,
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
    fontSize: 10,
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
            fontSize: 10.5,
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
            fontSize: 10,
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
            fontSize: 11,
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
            fontFamily: "'IBM Plex Mono',monospace",
            fontSize: 10,
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
            fontFamily: "'IBM Plex Mono',monospace",
            fontSize: 9.5,
            color: "#b5afa2",
            flex: "0 0 auto",
          }}
        >
          {files.length}개 파일
        </span>
      </div>

      <div
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
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 7.5,
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
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 11,
                  color: "#23211e",
                }}
              />
              <Box
                onClick={() => void s.commitMk()}
                style={{
                  flex: "0 0 auto",
                  fontSize: 10,
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
                  fontSize: 10,
                  color: "#a09a8f",
                  cursor: "pointer",
                  padding: "2px 4px",
                }}
              >
                취소
              </div>
            </div>
            <div style={{ fontSize: 9.5, color: "#a09a8f", margin: "-1px 0 6px 6px" }}>
              위치 · {task?.relFolder ?? ""}
              {s.mk.parent}
            </div>
          </>
        )}

        {rows.map((r) => {
          const pad = 6 + r.depth * 13;
          if (r.kind === "dir") {
            return (
              <Box
                key={`d${r.path}`}
                onClick={() =>
                  s.setUi({
                    treeOpen: { ...ui.treeOpen, [r.path]: ui.treeOpen[r.path] === false },
                  })
                }
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
                  background: "transparent",
                }}
                hover={{ background: "#efece6" }}
              >
                <span style={{ flex: "0 0 9px", fontSize: 7, color: "#a09a8f", textAlign: "center" }}>
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
                    fontSize: 11.5,
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
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 9,
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
              onClick={() => {
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
                background: on ? "#e6eefc" : "transparent",
              }}
              hover={{ background: on ? "#e6eefc" : "#efece6" }}
            >
              <span style={{ flex: "0 0 9px" }} />
              <span
                style={{
                  flex: "0 0 auto",
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 7.5,
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
                  fontSize: 11.5,
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
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 7.5,
                    color: "#5a44b4",
                    background: "#f2eefc",
                    borderRadius: 2,
                    padding: "1px 3px",
                  }}
                >
                  MD
                </span>
              )}
              {om.text && (
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 7.5,
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
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 8,
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
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 7.5,
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
            style={{ fontSize: 10.5, color: s.dragOver ? "#2f5cbb" : "#a09a8f", lineHeight: 1.6 }}
          >
            {s.dragOver
              ? "놓으면 이 업무 폴더로 가져옵니다"
              : "바탕화면에서 파일을 끌어다 놓기"}
          </div>
          <div style={{ fontSize: 9.5, color: "#b5afa2", marginTop: 2 }}>
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
                fontFamily: "'IBM Plex Mono',monospace",
                fontSize: 7.5,
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
                fontSize: 11.5,
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
                fontFamily: "'IBM Plex Mono',monospace",
                fontSize: 9.5,
                color: "#a09a8f",
                flex: "0 0 auto",
              }}
            >
              {selMeta?.size ?? "—"}
            </span>
          </div>
          <div
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: ".4px",
              color: "#a09a8f",
              marginBottom: 5,
            }}
          >
            열기 방식
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <Box
              onClick={() => void s.openFile(ui.sel, "text")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 27,
                padding: "0 8px",
                borderRadius: 5,
                border: "1px solid #ddd8cf",
                background: "#fff",
                cursor: "pointer",
              }}
              hover={{ borderColor: "#3a6fd8", background: "#f7fafe" }}
            >
              <span
                style={{
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 8,
                  fontWeight: 600,
                  color: "#2f5cbb",
                  background: "#eef3fd",
                  borderRadius: 2,
                  padding: "1px 4px",
                }}
              >
                TXT
              </span>
              <span style={{ fontSize: 11, color: "#3a3630", flex: 1 }}>텍스트 에디터로 열기</span>
              <span
                style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#b5afa2" }}
              >
                편집 가능
              </span>
            </Box>
            <Box
              onClick={() => {
                if (selIsMd) void s.openFile(ui.sel, "md");
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 27,
                padding: "0 8px",
                borderRadius: 5,
                cursor: selIsMd ? "pointer" : "not-allowed",
                border: `1px solid ${selIsMd ? "#ddd8cf" : "#eae6de"}`,
                background: selIsMd ? "#fff" : "#faf9f6",
                opacity: selIsMd ? 1 : 0.45,
              }}
              hover={selIsMd ? { borderColor: "#6a54c6" } : undefined}
            >
              <span
                style={{
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 8,
                  fontWeight: 600,
                  color: "#5a44b4",
                  background: "#f2eefc",
                  borderRadius: 2,
                  padding: "1px 4px",
                }}
              >
                MD
              </span>
              <span style={{ fontSize: 11, color: "#3a3630", flex: 1 }}>마크다운 뷰어로 열기</span>
              <span
                style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#b5afa2" }}
              >
                {selIsMd ? "읽기 전용" : ".md 전용"}
              </span>
            </Box>
            <Box
              onClick={() => s.openWith(ui.sel)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 27,
                padding: "0 8px",
                borderRadius: 5,
                border: "1px solid #ddd8cf",
                background: "#fff",
                cursor: "pointer",
              }}
              hover={{ borderColor: "#8a857c", background: "#faf9f6" }}
            >
              <span
                style={{
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 8,
                  fontWeight: 600,
                  color: "#6a665e",
                  background: "#f0ede7",
                  borderRadius: 2,
                  padding: "1px 4px",
                }}
              >
                ↗
              </span>
              <span style={{ fontSize: 11, color: "#3a3630", flex: 1 }}>연결 프로그램으로 열기</span>
              <span
                style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9, color: "#b5afa2" }}
              >
                {appsFor(selExt)[0]?.n ?? ""}
              </span>
            </Box>
          </div>
          <div style={{ fontSize: 9.5, color: "#b5afa2", marginTop: 7, lineHeight: 1.6 }}>
            더블클릭 = 기본 열기 · 우클릭 = 열기 방식 메뉴
          </div>
        </div>
      )}
    </div>
  );
}
