import { useLayoutEffect, useRef, useState } from "react";
import { Box, useExitSnapshot } from "../lib/ui";
import { appsFor, extStyle } from "../lib/design";
import { useStore, type CtxTarget } from "../store/useStore";
import { BSTORM_EXT } from "../lib/bstorm";
import * as api from "../lib/api";

interface Item {
  key: string;
  label: string;
  hint: string;
  badge: string;
  badgeFg: string;
  badgeBg: string;
  sep?: boolean;
  run: () => void;
}

/**
 * 탐색기 우클릭 메뉴. 메뉴 하나를 연 자리마다 따로 붙였다 떼어야(`key`) 열릴 때 커서 자리에서
 * 자라나고(`cf-menu`) 닫힐 때 잔상이 빠진다(`useExitSnapshot`) — 늘 붙어 있는 컴포넌트가 `null` 을
 * 그리면 닫힘은 한 프레임의 절단이다.
 */
export default function ContextMenu() {
  const ctx = useStore((s) => s.ctx);
  if (!ctx) return null;
  return <Menu key={`${ctx.path}|${ctx.x}|${ctx.y}`} ctx={ctx} />;
}

function Menu({ ctx }: { ctx: CtxTarget }) {
  const s = useStore();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useExitSnapshot(ref, "menu");

  // 크기를 안 뒤 화면 안으로 되접는다. 칠하기 전에 끝나므로 접히기 전 자리는 보이지 않는다.
  useLayoutEffect(() => {
    if (!ref.current) return;
    const M = 8;
    // `offset*` 로 잰다 — 여는 움직임(`cf-menu`)이 줄여 둔 크기가 아니라 다 자란 크기라야 한다.
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let x = ctx.x;
    let y = ctx.y;
    if (x + w > window.innerWidth - M) x = Math.max(M, window.innerWidth - M - w);
    if (y + h > window.innerHeight - M) y = Math.max(M, ctx.y - h);
    setPos({ x, y });
  }, [ctx]);

  // `.bs.md` 는 확장자가 `md` 라 배지도 MD 가 된다. 트리와 같게 BS 로 가른다.
  const isBs = !ctx.isDir && ctx.path.toLowerCase().endsWith(BSTORM_EXT);
  const es = ctx.isDir
    ? { fg: "#8f5d17", bg: "#fbf3e6" }
    : isBs
      ? { fg: "#256b47", bg: "#e9f4ee" }
      : extStyle(ctx.ext);
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

  // index.md 는 업무의 메타데이터 노트라 이름을 바꿀 수 없다(fsops::rename_path).
  // 눌러도 실패할 항목은 회색으로 남기지 않고 아예 빼 둔다 — 이 메뉴의 규칙이다.
  const canRename = ctx.path !== "index.md";

  const rename: Item = {
    key: "ren",
    label: "이름 바꾸기",
    hint: ctx.isDir ? "폴더" : "열린 탭도 함께",
    badge: "✎",
    badgeFg: "#2f5cbb",
    badgeBg: "#eef3fd",
    sep: true,
    run: () =>
      s.set({
        ctx: null,
        mk: null,
        fileRen: { path: ctx.path, name: ctx.name, isDir: ctx.isDir },
      }),
  };

  const del: Item = {
    key: "del",
    label: `${ctx.isDir ? "폴더" : "파일"} 삭제`,
    hint: "되돌릴 수 없음",
    badge: "✕",
    badgeFg: "#a83c3c",
    badgeBg: "#fceceb",
    // 이름 바꾸기와 한 무리다 — 둘 다 이 항목 자체를 건드리는 일이라 선은 위에 하나뿐이다.
    sep: !canRename,
    run: () => void s.askDelete(ctx),
  };

  /** 항목 자체를 바꾸는 일들. 메뉴의 맨 끝에 붙는다. */
  const editItems: Item[] = canRename ? [rename, del] : [del];

  // 드래그로 창 밖에 놓아도 같은 일을 하지만, 그쪽은 놓은 위치를 OS 에 물을 수 없어
  // 언제나 바탕화면으로 간다. 여기가 그 동작의 분명한 이름표다.
  const toDesktop: Item[] = [
    {
      key: "dk1",
      label: "바탕화면으로 복사",
      hint: "사본",
      badge: "⧉",
      badgeFg: "#6a665e",
      badgeBg: "#f0ede7",
      run: () => {
        s.set({ ctx: null });
        void s.exportToDesktop(ctx.path, "copy");
      },
    },
    {
      key: "dk2",
      label: "바탕화면에 링크 만들기",
      hint: "심볼릭 링크",
      badge: "⇢",
      // 링크는 고스트 · 커서 배지와 같은 청록이다 — 보라는 AI 전용.
      badgeFg: "#2f6f80",
      badgeBg: "#e8f3f5",
      run: () => {
        s.set({ ctx: null });
        void s.exportToDesktop(ctx.path, "link");
      },
    },
  ];

  const reveal: Item = {
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
  };

  /** `parent` 폴더(업무 폴더 기준, 최상위는 `""`) 안에 새로 만드는 일들. */
  const mkItems = (parent: string): Item[] => {
    const mk = (kind: "folder" | "file" | "bstorm") => {
      s.set({ ctx: null, mk: { kind, parent, name: "" } });
      if (parent) s.setUi({ treeOpen: { ...s.ui.treeOpen, [parent]: true } });
    };
    return [
      {
        key: "d2",
        label: parent ? "하위 폴더 만들기" : "새 폴더",
        hint: "",
        badge: "＋",
        badgeFg: "#8f5d17",
        badgeBg: "#fbf3e6",
        sep: true,
        run: () => mk("folder"),
      },
      {
        key: "d3",
        label: parent ? "이 폴더에 새 파일" : "새 파일",
        hint: "",
        badge: "＋",
        badgeFg: "#2f5cbb",
        badgeBg: "#eef3fd",
        run: () => mk("file"),
      },
      {
        key: "d4",
        label: "새 브레인스토밍",
        hint: BSTORM_EXT,
        badge: "BS",
        badgeFg: "#256b47",
        badgeBg: "#e9f4ee",
        run: () => mk("bstorm"),
      },
    ];
  };

  // 트리의 빈 자리 — 업무 폴더 최상위 자체다. 이름 바꾸기 · 삭제 · 바탕화면 내보내기는
  // 업무 하나를 통째로 건드리는 일이라 여기서는 빼 둔다.
  const rootItems: Item[] = [{ ...reveal, hint: "업무 폴더" }, ...mkItems(""), copyPath];

  const items: Item[] = ctx.root
    ? rootItems
    : ctx.isDir
    ? [reveal, ...mkItems(ctx.path), copyPath, ...toDesktop, ...editItems]
    : [
        // 쓸 수 없는 열기 방식은 회색으로 남기지 않고 **아예 빼 둔다** — 목록이 짧을수록
        // 이 파일로 무엇을 할 수 있는지가 한눈에 들어온다.
        ...(ctx.bin
          ? []
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
            ]),
        ...(!ctx.bin && ctx.path.toLowerCase().endsWith(BSTORM_EXT)
          ? [
              {
                key: "c0",
                label: "브레인스토밍으로 열기",
                hint: "캔버스",
                badge: "BS",
                badgeFg: "#256b47",
                badgeBg: "#e9f4ee",
                run: () => void s.openFile(ctx.path, "bstorm"),
              },
            ]
          : []),
        ...(!ctx.bin && ctx.ext === "md"
          ? [
              {
                key: "c2",
                label: "마크다운 뷰어로 열기",
                hint: "읽기",
                badge: "MD",
                badgeFg: "#2f6f80",
                badgeBg: "#e8f3f5",
                run: () => void s.openFile(ctx.path, "md"),
              },
            ]
          : []),
        ...(!ctx.bin && (ctx.ext === "html" || ctx.ext === "htm")
          ? [
              {
                key: "c2h",
                label: "HTML 뷰어로 열기",
                hint: "스크립트 실행",
                badge: "HTML",
                badgeFg: "#8f5d17",
                badgeBg: "#fbf3e6",
                run: () => void s.openFile(ctx.path, "html"),
              },
            ]
          : []),
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
        ...toDesktop,
        ...editItems,
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
        className="cf-menu"
        style={{
          position: "fixed",
          zIndex: 81,
          minWidth: 206,
          background: "#fff",
          border: "1px solid #d9d4ca",
          borderRadius: 6,
          boxShadow: "0 12px 30px rgba(35,33,30,.20)",
          padding: 4,
          left: pos?.x ?? ctx.x,
          top: pos?.y ?? ctx.y,
          // 누른 자리에서 자라난다 — 화면 끝에서 되접혔으면 그 모서리가 커서 쪽이다.
          transformOrigin: pos ? `${ctx.x - pos.x}px ${ctx.y - pos.y}px` : "0 0",
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
            {ctx.isDir ? "DIR" : isBs ? "BS" : ctx.ext.toUpperCase()}
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
              onClick={() => i.run()}
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
              <span style={{ fontSize: 11, color: "#6a665e" }}>{i.hint}</span>
            </Box>
          </div>
        ))}
      </div>
    </>
  );
}
