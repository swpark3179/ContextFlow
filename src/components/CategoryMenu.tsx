import { useLayoutEffect, useRef, useState } from "react";
import { Box } from "../lib/ui";
import { label } from "../lib/category";
import { emptyNewTask, openCategoryHub, useStore } from "../store/useStore";

/**
 * 업무 리스트의 카테고리 묶음 머리 우클릭 메뉴 — Obsidian 허브 · 새 업무 · 관리.
 *
 * `TabMenu` 와 같은 껍데기다. 탐색기의 `ContextMenu` 는 파일(`CtxTarget`)에 묶여 있어 다시 쓰지
 * 않는다. 열고 닫는 것은 스토어의 `catCtx` 하나라, Esc 는 App 의 사슬이 닫고 화면을 바꾸면
 * `setScreen` 이 비운다.
 *
 * 허브 · 관리에는 키(`keyOf`)를 넘긴다 — 파일 이름은 백엔드가 전체 업무로 정하므로 사이드바의
 * 표시 철자(진행 중 업무만으로 정한 것)를 믿지 않는다. 새 업무만 표시 철자로 연다. 사이드바의
 * ＋ 와 같은 값이라 새 업무가 이 묶음과 같은 철자로 붙는다.
 */
export default function CategoryMenu() {
  const ctx = useStore((s) => s.catCtx);
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // 메뉴 크기를 알게 된 뒤 화면 안으로 되접는다 — `ContextMenu` 와 같은 규칙이다.
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

  const { set } = useStore.getState();
  const close = () => set({ catCtx: null });
  const uncat = ctx.key === "";

  const items: {
    key: string;
    label: string;
    badge: string;
    badgeFg: string;
    badgeBg: string;
    sep?: boolean;
    run: () => void;
  }[] = [
    {
      key: "hub",
      label: "Obsidian에서 보기",
      badge: "↗",
      badgeFg: "#5a44b4",
      badgeBg: "#f4f0fd",
      run: () => void openCategoryHub(ctx.key),
    },
    // 미분류로 만드는 새 업무는 사이드바 아래 [새 업무 추가] 와 같다 — 머리 행의 ＋ 도 없다.
    ...(uncat
      ? []
      : [
          {
            key: "new",
            label: "이 카테고리로 새 업무",
            badge: "+",
            badgeFg: "#2f5cbb",
            badgeBg: "#eef3fd",
            run: () =>
              set({ newOpen: true, nt: emptyNewTask(ctx.path), ntRecs: [], recTag: {}, ntRefs: [] }),
          },
        ]),
    {
      key: "manage",
      label: "카테고리 관리…",
      badge: "⋯",
      badgeFg: "#6a665e",
      badgeBg: "#f0ede7",
      sep: true,
      run: () => useStore.getState().openCatMgr(ctx.key),
    },
  ];

  return (
    <>
      <div
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 80 }}
      />
      <div
        ref={ref}
        style={{
          position: "fixed",
          zIndex: 81,
          minWidth: 196,
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
              color: "#6a665e",
              background: "#f0ede7",
            }}
          >
            CAT
          </span>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: uncat ? "#8a857c" : "#3a3630",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 220,
            }}
            title={label(ctx.path)}
          >
            {label(ctx.path)}
          </span>
        </div>
        {items.map((i) => (
          <div key={i.key} style={{ display: "flex", flexDirection: "column" }}>
            {i.sep && <div style={{ height: 1, background: "#f0ede7", margin: "3px 0" }} />}
            <Box
              onClick={() => {
                close();
                i.run();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: "pointer",
              }}
              hover={{ background: "#f2efe9" }}
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
            </Box>
          </div>
        ))}
      </div>
    </>
  );
}
