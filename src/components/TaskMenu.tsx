import { useLayoutEffect, useRef, useState } from "react";
import { Box, useExitSnapshot } from "../lib/ui";
import { MARK, normalizeStatus, statusOf, TEXT } from "../lib/design";
import { useStore, type TaskCtx } from "../store/useStore";

/**
 * 업무 리스트의 업무 행 우클릭 메뉴 — 강조 켜기 · 끄기.
 *
 * `CategoryMenu` 와 같은 껍데기다. 열고 닫는 것은 스토어의 `taskCtx` 하나라, Esc 는 App 의 사슬이 닫고
 * 화면을 바꾸면 `setScreen` 이 비운다. 연 자리에서 자라나고 닫힐 때 잔상이 짧게 나간다.
 *
 * **강조는 진행 중인 업무에만 켠다.** 끝낸 일 · 멈춘 일을 "지금 먼저" 로 칠할 수는 없다 — 그런 업무에서는
 * 켜기 항목 대신 까닭을 한 줄 적는다(눌러도 실패할 항목은 두지 않는다). 보류 중에 남아 있는 강조는
 * 칠하지 않을 뿐이라 끄기만 둔다 — 다시 진행하면 돌아오는 것을 원하지 않을 때의 길이다.
 */
export default function TaskMenu() {
  const ctx = useStore((s) => s.taskCtx);
  // 그 사이 목록에서 빠졌으면(보관 · 다시 읽기) 가리킬 것이 없다.
  const has = useStore((s) => !!s.taskCtx && s.tasks.some((t) => t.folder === s.taskCtx?.folder));
  if (!ctx || !has) return null;
  return <Panel key={`${ctx.x},${ctx.y},${ctx.folder}`} ctx={ctx} />;
}

function Panel({ ctx }: { ctx: TaskCtx }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useExitSnapshot(ref, "menu");
  const [pos, setPos] = useState<{ x: number; y: number; origin: string } | null>(null);
  const task = useStore((s) => s.tasks.find((t) => t.folder === ctx.folder));

  // 메뉴 크기를 알게 된 뒤 화면 안으로 되접는다 — `CategoryMenu` 와 같은 규칙이다.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const M = 8;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let x = ctx.x;
    let y = ctx.y;
    let ox = "left";
    let oy = "top";
    if (x + w > window.innerWidth - M) {
      x = Math.max(M, window.innerWidth - M - w);
      ox = "right";
    }
    if (y + h > window.innerHeight - M) {
      y = Math.max(M, ctx.y - h);
      oy = "bottom";
    }
    setPos({ x, y, origin: `${oy} ${ox}` });
  }, [ctx]);

  if (!task) return null;
  const { set, setHighlight } = useStore.getState();
  const close = () => set({ taskCtx: null });
  const st = statusOf(task.status);
  const live = normalizeStatus(task.status) === "in-progress";

  const item: { label: string; hint: string; on: boolean } | null = live
    ? task.highlight
      ? { label: "강조 해제", hint: "", on: false }
      : { label: "강조 표시", hint: "진행 중인 동안", on: true }
    : task.highlight
      ? { label: "강조 해제", hint: "보류 중 · 진행하면 다시 보임", on: false }
      : null;

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
        role="menu"
        className={pos ? "cf-menu" : undefined}
        style={{
          position: "fixed",
          zIndex: 81,
          // 자리를 재기 전 한 프레임은 감춘다 — 되접히기 전 자리에서 자라나기 시작하지 않게.
          visibility: pos ? "visible" : "hidden",
          transformOrigin: pos?.origin,
          minWidth: 196,
          maxWidth: 280,
          background: "#fff",
          border: "1px solid #d9d4ca",
          borderRadius: 6,
          boxShadow: "0 12px 30px rgba(35,33,30,.20)",
          padding: 4,
          left: pos?.x ?? ctx.x,
          top: pos?.y ?? ctx.y,
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
              flex: "0 0 auto",
              fontSize: 10,
              fontWeight: 600,
              borderRadius: 2,
              padding: "0 4px",
              lineHeight: "15px",
              color: st.fg,
              background: st.bg,
            }}
          >
            {st.label}
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
            title={task.title}
          >
            {task.title}
          </span>
        </div>
        {item ? (
          <Box
            role="menuitem"
            onClick={() => {
              close();
              void setHighlight(task.folder, item.on);
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
                color: item.on ? MARK.ink : "#6a665e",
                background: item.on ? MARK.soft : "#f0ede7",
              }}
            >
              !
            </span>
            <span style={{ fontSize: 12, color: "#3a3630", flex: 1 }}>{item.label}</span>
            {item.hint && <span style={{ fontSize: 11, color: TEXT.sub }}>{item.hint}</span>}
          </Box>
        ) : (
          <div style={{ padding: "6px 8px", fontSize: 11.5, color: TEXT.sub, lineHeight: 1.5 }}>
            진행 중인 업무만 강조할 수 있습니다
          </div>
        )}
      </div>
    </>
  );
}
