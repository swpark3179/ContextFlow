import { useLayoutEffect, useRef, useState } from "react";
import { Box } from "../lib/ui";
import { basename } from "../lib/format";
import { extStyle } from "../lib/design";
import { BSTORM_EXT } from "../lib/bstorm";
import { useStore } from "../store/useStore";
import { tabKey } from "../lib/tabs";

/**
 * 탭 우클릭 메뉴 — 닫기 세 가지.
 *
 * 탐색기의 `ContextMenu` 와 같은 껍데기를 쓰지만 별개의 컴포넌트다. 저쪽은 **파일**을
 * 가리키고(열기 방식 · 이름 · 삭제 · 바탕화면 반출) 이쪽은 **탭**을 가리킨다 — 같은
 * 메뉴에 섞으면 "삭제" 가 파일을 지우는지 탭을 닫는지가 흐려진다.
 *
 * 닫는 것은 화면에서 치우는 것뿐이다. 파일은 그대로 있고, 미저장 버퍼는 닫기 전에
 * 내려쓴다(`closeAllTabs` · `closeOtherTabs`).
 */
export default function TabMenu() {
  const s = useStore();
  const ctx = s.tabCtx;
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

  const tab = s.ui.openTabs.find((t) => tabKey(t) === ctx.key);
  // 탭이 그 사이에 닫혔으면(저장 실패 · 업무 전환) 가리킬 것이 없다.
  if (!tab) return null;

  const total = s.ui.openTabs.length;
  const others = total - 1;
  const es = tab.path.toLowerCase().endsWith(BSTORM_EXT)
    ? { fg: "#256b47", bg: "#e9f4ee" }
    : extStyle(tab.path.includes(".") ? (tab.path.split(".").pop() as string).toLowerCase() : "");

  const items: {
    key: string;
    label: string;
    hint: string;
    badge: string;
    badgeFg: string;
    badgeBg: string;
    sep?: boolean;
    off?: boolean;
    run: () => void;
  }[] = [
    {
      key: "one",
      label: "이 탭 닫기",
      hint: "",
      badge: "✕",
      badgeFg: "#6a665e",
      badgeBg: "#f0ede7",
      run: () => s.closeTab(ctx.key),
    },
    {
      key: "others",
      label: "이 탭 제외하고 전체 탭 닫기",
      hint: others ? `${others}개` : "",
      badge: "⇥",
      badgeFg: "#2f5cbb",
      badgeBg: "#eef3fd",
      off: others === 0,
      run: () => void s.closeOtherTabs(ctx.key),
    },
    {
      key: "all",
      label: "전체 탭 닫기",
      hint: `${total}개`,
      badge: "⨯",
      badgeFg: "#a83c3c",
      badgeBg: "#fceceb",
      sep: true,
      run: () => void s.closeAllTabs(),
    },
  ];

  return (
    <>
      <div
        onClick={() => s.set({ tabCtx: null })}
        onContextMenu={(e) => {
          e.preventDefault();
          s.set({ tabCtx: null });
        }}
        style={{ position: "fixed", inset: 0, zIndex: 80 }}
      />
      <div
        ref={ref}
        style={{
          position: "fixed",
          zIndex: 81,
          minWidth: 214,
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
            TAB
          </span>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: "#3a3630",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 200,
            }}
            title={tab.path}
          >
            {basename(tab.path)}
          </span>
        </div>
        {items.map((i) => (
          <div key={i.key} style={{ display: "flex", flexDirection: "column" }}>
            {i.sep && <div style={{ height: 1, background: "#f0ede7", margin: "3px 0" }} />}
            <Box
              onClick={() => {
                if (i.off) return;
                i.run();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 4,
                cursor: i.off ? "default" : "pointer",
                opacity: i.off ? 0.45 : 1,
              }}
              hover={i.off ? undefined : { background: "#f2efe9" }}
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
