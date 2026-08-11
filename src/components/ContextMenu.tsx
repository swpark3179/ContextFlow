import { useLayoutEffect, useRef, useState } from "react";
import { Box } from "../lib/ui";
import { appsFor, extStyle } from "../lib/design";
import { useStore } from "../store/useStore";
import * as api from "../lib/api";

interface Item {
  key: string;
  label: string;
  hint: string;
  badge: string;
  badgeFg: string;
  badgeBg: string;
  sep?: boolean;
  disabled?: boolean;
  run: () => void;
}

export default function ContextMenu() {
  const s = useStore();
  const ctx = s.ctx;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // Flip the menu back inside the viewport once we know its size.
  useLayoutEffect(() => {
    if (!ctx || !ref.current) return;
    const M = 8;
    const r = ref.current.getBoundingClientRect();
    let x = ctx.x;
    let y = ctx.y;
    if (x + r.width > window.innerWidth - M) x = Math.max(M, window.innerWidth - M - r.width);
    if (y + r.height > window.innerHeight - M) y = Math.max(M, ctx.y - r.height);
    setPos({ x, y });
  }, [ctx]);

  if (!ctx) return null;

  const es = ctx.isDir ? { fg: "#8f5d17", bg: "#fbf3e6" } : extStyle(ctx.ext);
  const abs = `${s.activeFolder}/${ctx.path}`.replace(/\/+$/, "");

  const copyPath: Item = {
    key: "copy",
    label: "경로 복사",
    hint: "클립보드",
    badge: "⧉",
    badgeFg: "#6a665e",
    badgeBg: "#f0ede7",
    sep: true,
    run: () => {
      void navigator.clipboard.writeText(abs).catch(() => undefined);
      s.set({ ctx: null });
      s.toast("클립보드에 경로를 복사했습니다", abs, "#5fbf8d");
    },
  };

  const del: Item = {
    key: "del",
    label: `${ctx.isDir ? "폴더" : "파일"} 삭제`,
    hint: "되돌릴 수 없음",
    badge: "✕",
    badgeFg: "#a83c3c",
    badgeBg: "#fceceb",
    sep: true,
    run: () => void s.askDelete(ctx),
  };

  const items: Item[] = ctx.isDir
    ? [
        {
          key: "d1",
          label: "탐색기에서 열기",
          hint: "Windows",
          badge: "↗",
          badgeFg: "#6a665e",
          badgeBg: "#f0ede7",
          run: () => {
            // 탐색기 창이 뜨는 것이 곧 결과다 — 성공은 알리지 않는다.
            s.set({ ctx: null });
            void api.revealPath(abs).catch((e) => s.fail(e));
          },
        },
        {
          key: "d2",
          label: "하위 폴더 만들기",
          hint: "",
          badge: "＋",
          badgeFg: "#8f5d17",
          badgeBg: "#fbf3e6",
          sep: true,
          run: () => {
            s.set({ ctx: null, mk: { kind: "folder", parent: ctx.path, name: "" } });
            s.setUi({ treeOpen: { ...s.ui.treeOpen, [ctx.path]: true } });
          },
        },
        {
          key: "d3",
          label: "이 폴더에 새 파일",
          hint: "",
          badge: "＋",
          badgeFg: "#2f5cbb",
          badgeBg: "#eef3fd",
          run: () => {
            s.set({ ctx: null, mk: { kind: "file", parent: ctx.path, name: "" } });
            s.setUi({ treeOpen: { ...s.ui.treeOpen, [ctx.path]: true } });
          },
        },
        copyPath,
        del,
      ]
    : [
        {
          key: "c1",
          label: "텍스트 에디터로 열기",
          hint: "편집",
          badge: "TXT",
          badgeFg: "#2f5cbb",
          badgeBg: "#eef3fd",
          run: () => void s.openFile(ctx.path, "text"),
        },
        {
          key: "c2",
          label: "마크다운 뷰어로 열기",
          hint: ctx.ext === "md" ? "읽기" : ".md 전용",
          badge: "MD",
          badgeFg: "#5a44b4",
          badgeBg: "#f2eefc",
          disabled: ctx.ext !== "md",
          run: () => {
            if (ctx.ext === "md") void s.openFile(ctx.path, "md");
          },
        },
        {
          key: "c3",
          label: "연결 프로그램으로 열기…",
          hint: appsFor(ctx.ext)[0]?.n ?? "",
          badge: "↗",
          badgeFg: "#6a665e",
          badgeBg: "#f0ede7",
          run: () => s.openWith(ctx.path),
        },
        {
          key: "c4",
          label: "이 위치에 새 파일",
          hint: "",
          badge: "＋",
          badgeFg: "#2f5cbb",
          badgeBg: "#eef3fd",
          sep: true,
          run: () => {
            const parent = ctx.path.split("/").slice(0, -1).join("/");
            s.set({
              ctx: null,
              mk: { kind: "file", parent: parent ? parent + "/" : "", name: "" },
            });
          },
        },
        {
          key: "c5",
          label: "이 위치에 새 폴더",
          hint: "",
          badge: "＋",
          badgeFg: "#8f5d17",
          badgeBg: "#fbf3e6",
          run: () => {
            const parent = ctx.path.split("/").slice(0, -1).join("/");
            s.set({
              ctx: null,
              mk: { kind: "folder", parent: parent ? parent + "/" : "", name: "" },
            });
          },
        },
        copyPath,
        del,
      ];

  return (
    <>
      <div
        onClick={() => s.set({ ctx: null })}
        onContextMenu={(e) => {
          e.preventDefault();
          s.set({ ctx: null });
        }}
        style={{ position: "fixed", inset: 0, zIndex: 80 }}
      />
      <div
        ref={ref}
        style={{
          position: "fixed",
          zIndex: 81,
          minWidth: 206,
          background: "#fff",
          border: "1px solid #d9d4ca",
          borderRadius: 6,
          boxShadow: "0 12px 30px rgba(35,33,30,.20)",
          padding: 4,
          animation: "pIn .1s ease-out",
          left: pos.x || ctx.x,
          top: pos.y || ctx.y,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 8px 6px 8px",
            borderBottom: "1px solid #f0ede7",
            marginBottom: 3,
          }}
        >
          <span
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 8.5,
              fontWeight: 600,
              borderRadius: 2,
              padding: "1px 3px",
              color: es.fg,
              background: es.bg,
            }}
          >
            {ctx.isDir ? "DIR" : ctx.ext.toUpperCase()}
          </span>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: "#3a3630",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ctx.name}
          </span>
        </div>
        {items.map((i) => (
          <div key={i.key} style={{ display: "flex", flexDirection: "column" }}>
            {i.sep && <div style={{ height: 1, background: "#f0ede7", margin: "3px 0" }} />}
            <Box
              onClick={() => !i.disabled && i.run()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: i.disabled ? "not-allowed" : "pointer",
                opacity: i.disabled ? 0.42 : 1,
              }}
              hover={i.disabled ? undefined : { background: "#f2efe9" }}
            >
              <span
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 9,
                  fontWeight: 600,
                  borderRadius: 2,
                  padding: "1px 4px",
                  color: i.badgeFg,
                  background: i.badgeBg,
                }}
              >
                {i.badge}
              </span>
              <span style={{ fontSize: 12, color: "#3a3630", flex: 1 }}>{i.label}</span>
              <span style={{ fontSize: 10.5, color: "#b5afa2" }}>{i.hint}</span>
            </Box>
          </div>
        ))}
      </div>
    </>
  );
}
