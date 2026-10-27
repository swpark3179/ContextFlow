import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Box, Collapse, EASE_OUT, HoldRing, reducedMotion } from "../lib/ui";
import { TEXT, extOf, extStyle } from "../lib/design";
import { dragCursor, dragKind } from "../lib/dragCursor";
import { useDropGuard, useLongPress } from "../lib/longPress";
import { dirname } from "../lib/format";
import { useStore, type FileDrag, type MkState, type TabMode } from "../store/useStore";
import { BSTORM_EXT } from "../lib/bstorm";
import {
  ancestorsOf,
  dirPaths,
  dropMode,
  freshEntry,
  ghostLook,
  ghostStatus,
  mkParentFor,
  nestTree,
  renameProblem,
  type DropMode,
  type TreeItem,
} from "../lib/explorerTree";

/** 고스트의 최대 폭(아래 `maxWidth`). 창 가장자리에 붙일 때 쓴다. */
const GHOST_W = 300;
/** 고스트의 높이(이름 · 상태 두 줄). 창 아래 가장자리에 붙일 때 쓴다. */
const GHOST_H = 46;
/** 드래그 중 접힌 폴더 위에 이만큼 머무르면 열린다(스프링 폴더). */
const SPRING_MS = 600;

const SEL_BG = "#e6eefc";
/** 누르고 있는 행 — 1초가 차는 동안 살짝 어두워진다. 고른 행이면 파랑을 한 단계 짙게. */
const HELD_BG = "#e9e5dd";
const SEL_HELD_BG = "#dbe5f8";
const HOVER_BG = "#efece6";
/** 행의 색 전환. 호버 · 선택은 `cf-hover` 와 같은 90ms, 드롭 대상 테두리 · 흐려짐은 140ms. */
const ROW_TRANSITION =
  "background-color var(--m-press), color var(--m-press), box-shadow var(--m-quick), opacity var(--m-quick)";

const MONO: CSSProperties = { fontFamily: "'Roboto Mono',monospace" };

/**
 * 트리에 붙는 확장자 배지. `.bs.md` 는 `extOf` 가 `md` 를 주지만 브레인스토밍
 * 문서라는 것이 한눈에 보여야 하므로 BS 로 가른다.
 */
function badgeFor(path: string): { label: string; fg: string; bg: string } {
  if (path.toLowerCase().endsWith(BSTORM_EXT)) return { label: "BS", fg: "#256b47", bg: "#e9f4ee" };
  const e = extOf(path);
  return { label: e.toUpperCase(), ...extStyle(e) };
}

/** 인라인 생성 행의 칩과 안내 문구. 만들 수 있는 종류마다 하나씩. */
const MK_CHIP: Record<MkState["kind"], { label: string; fg: string; bg: string; placeholder: string }> = {
  folder: { label: "DIR", fg: "#8f5d17", bg: "#fbf3e6", placeholder: "새 폴더 이름" },
  file: { label: "FILE", fg: "#2f5cbb", bg: "#eef3fd", placeholder: "새 파일 이름 (확장자 생략 시 .md)" },
  bstorm: {
    label: "BS",
    fg: "#256b47",
    bg: "#e9f4ee",
    placeholder: `새 브레인스토밍 이름 (${BSTORM_EXT})`,
  },
};

/** 확장자를 뺀 앞부분의 길이. 폴더와 확장자 없는 파일은 이름 전체가 앞부분이다. */
function stemLength(name: string, isDir: boolean): number {
  if (isDir) return name.length;
  if (name.toLowerCase().endsWith(BSTORM_EXT)) return name.length - BSTORM_EXT.length;
  const dot = name.lastIndexOf(".");
  // 맨 앞의 점은 확장자가 아니라 숨김 파일의 표시다.
  return dot > 0 ? dot : name.length;
}

/** 거절 — 받지 않는 이름. 클래스를 뗐다 다시 붙여야 같은 움직임이 다시 돈다. */
function shake(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove("cf-shake");
  void el.offsetWidth;
  el.classList.add("cf-shake");
}

/** 인라인 편집 행(만들기 · 이름 바꾸기)의 상자. 칩이 이웃 행의 칩과 같은 줄에 서도록 들여 쓴다. */
function editBox(pad: number, error: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 26,
    marginBottom: 1,
    paddingRight: 5,
    paddingLeft: pad + 14,
    border: `1px solid ${error ? "#c04a4a" : "#cddcf8"}`,
    borderRadius: 4,
    background: "#f7fafe",
    boxShadow: error ? "0 0 0 2px #fbe8e6" : "none",
    transition: "border-color var(--m-quick), box-shadow var(--m-quick)",
  };
}

const chipStyle = (fg: string, bg: string): CSSProperties => ({
  flex: "0 0 auto",
  ...MONO,
  fontSize: 8.5,
  fontWeight: 600,
  color: fg,
  background: bg,
  borderRadius: 2,
  padding: "1px 3px",
});

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: "none",
  background: "transparent",
  ...MONO,
  fontSize: 12,
  color: TEXT.ink,
};

const okBtn: CSSProperties = {
  flex: "0 0 auto",
  fontSize: 11,
  fontWeight: 600,
  color: "#2f5cbb",
  cursor: "pointer",
  padding: "2px 5px",
  borderRadius: 3,
};

const cancelBtn: CSSProperties = {
  flex: "0 0 auto",
  fontSize: 11,
  color: TEXT.sub,
  cursor: "pointer",
  padding: "2px 4px",
};

/**
 * 새 파일 · 폴더 · 브레인스토밍을 만드는 행. 트리 맨 위가 아니라 **만들어질 폴더 안**의 맨 앞에
 * 선다 — 어디에 생기는지가 자리로 드러난다(이름 바꾸기와 같은 이유).
 */
function MkRow({ pad, onCommit }: { pad: number; onCommit: () => void }) {
  const s = useStore();
  const mk = s.mk;
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    // 접혀 있던 폴더가 열리는 중이면(`Collapse` 가 높이를 키우는 중) 지금 스크롤하면 그 상자가
    // 밀린다 — 포커스만 주고, 다 열린 뒤에 보이는 자리로 당긴다.
    el.focus({ preventScroll: true });
    const t = window.setTimeout(() => el.scrollIntoView({ block: "nearest" }), 220);
    return () => window.clearTimeout(t);
  }, []);

  if (!mk) return null;
  const chip = MK_CHIP[mk.kind];
  return (
    <div className="cf-enter" style={editBox(pad, false)}>
      <span style={chipStyle(chip.fg, chip.bg)}>{chip.label}</span>
      <input
        ref={input}
        aria-label={chip.placeholder}
        value={mk.name}
        onChange={(e) => s.set({ mk: { ...mk, name: e.target.value } })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) onCommit();
          else if (e.key === "Escape") s.set({ mk: null });
        }}
        placeholder={chip.placeholder}
        style={inputStyle}
      />
      <Box onClick={onCommit} style={okBtn} hover={{ background: "#e2ebfb" }}>
        만들기
      </Box>
      <div onClick={() => s.set({ mk: null })} style={cancelBtn}>
        취소
      </div>
    </div>
  );
}

/**
 * 트리 안에서 바로 이름을 고치는 행. 대화상자를 띄우지 않는 이유는 바꾸는 것이 **그
 * 자리에 보이는 이름 하나**여서다 — 새로 만들 때(`mk`)와 같은 모양을 쓴다.
 *
 * 열리는 순간 이름 전체를 채워 두고 **확장자를 뺀 앞부분만** 고른다. 전체를 채워야
 * 확장자가 실수로 날아가지 않고(이름을 적으면 `.md` 를 붙여 주는 새 파일 만들기와 달리
 * 이름 바꾸기는 적은 그대로 만든다), 앞부분만 골라 두어야 바로 타이핑해 갈아 끼울 수 있다.
 *
 * 확실히 거절될 이름(쓸 수 없는 글자 · 점으로 시작 · 같은 폴더의 같은 이름)은 보내기 전에
 * 여기서 돌려보낸다 — 행이 흔들리고 사유가 바로 아래에 남는다. 예전에는 입력칸이 닫히고 토스트만
 * 떠서 고치던 이름을 처음부터 다시 적어야 했다. 그 밖의 판정은 스토어 · 백엔드가 한다.
 */
function RenameRow({ pad, onCommit }: { pad: number; onCommit: (path: string, isDir: boolean) => void }) {
  const s = useStore();
  const ren = s.fileRen;
  const input = useRef<HTMLInputElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const [err, setErr] = useState("");
  const current = (ren?.path ?? "").replace(/\/$/, "").split("/").pop() ?? "";

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, stemLength(current, !!ren?.isDir));
    // 이 행은 이름을 고치는 동안에만 붙어 있다 — 붙는 순간 한 번만 고르면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ren) return null;
  const es = ren.isDir ? { label: "DIR", fg: "#8f5d17", bg: "#fbf3e6" } : badgeFor(ren.path);

  const commit = () => {
    const problem = renameProblem(ren.name, ren.path, s.files);
    if (problem) {
      setErr(problem);
      shake(box.current);
      input.current?.focus();
      return;
    }
    onCommit(ren.path, ren.isDir);
  };

  return (
    <>
      <div ref={box} style={editBox(pad, !!err)}>
        <span style={chipStyle(es.fg, es.bg)}>{es.label}</span>
        <input
          ref={input}
          aria-label="새 이름"
          aria-invalid={err ? true : undefined}
          value={ren.name}
          onChange={(e) => {
            if (err) setErr("");
            s.set({ fileRen: { ...ren, name: e.target.value } });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) commit();
            else if (e.key === "Escape") s.set({ fileRen: null });
          }}
          style={inputStyle}
        />
        <Box onClick={commit} style={okBtn} hover={{ background: "#e2ebfb" }}>
          바꾸기
        </Box>
        <div onClick={() => s.set({ fileRen: null })} style={cancelBtn}>
          취소
        </div>
      </div>
      {err && (
        <div
          role="alert"
          className="cf-enter-down"
          style={{
            margin: "1px 0 4px",
            marginLeft: pad + 14,
            fontSize: 11,
            lineHeight: 1.5,
            color: "#9b4b42",
            background: "#fdf3f2",
            border: "1px solid #f2d6d2",
            borderRadius: 4,
            padding: "3px 7px",
          }}
        >
          {err}
        </div>
      )}
    </>
  );
}

/** 놓인 고스트가 갈 곳 — 옮긴 폴더 행 · 처음 자리(취소) · 창 밖(그 자리에서 줄어든다). */
type GhostFate = { kind: "land"; to: DOMRect | null } | { kind: "back" } | { kind: "out" };

/**
 * 사라지는 고스트를 복제해 `to` 행으로 줄어들며 날려 보낸다. 예전에는 놓는 순간 고스트가
 * 사라져 파일이 어디로 갔는지 눈으로 이을 수 없었다. 동작 줄이기면 그 자리에서 흐려지기만 한다.
 */
function flyOff(el: HTMLElement, to: DOMRect | "out" | null): void {
  if (typeof el.animate !== "function") return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const ghost = el.cloneNode(true) as HTMLElement;
  queueMicrotask(() => {
    // StrictMode 의 두 번 도는 effect — 원본이 아직 붙어 있으면 실제로 사라진 것이 아니다.
    if (el.isConnected) return;
    ghost.setAttribute("aria-hidden", "true");
    // 붙이는 순간 안쪽의 나타나기(`cf-fade`)가 다시 돌지 않게 뗀다.
    ghost.querySelectorAll("[class]").forEach((n) => n.removeAttribute("class"));
    Object.assign(ghost.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      margin: "0",
      transformOrigin: "0 0",
      animation: "none",
      transition: "none",
    });
    document.body.appendChild(ghost);
    const reduce = reducedMotion();
    const k = 0.55;
    // 갈 곳을 모르면(행을 못 찾음) 그 자리에서 흐려지기만 한다.
    let end: string;
    if (reduce || !to) end = "none";
    else if (to === "out") end = `translate(-10px, -10px) scale(${k})`;
    else {
      const dx = to.left + 24 - r.left;
      const dy = to.top + (Math.min(to.height, 23) - r.height * k) / 2 - r.top;
      end = `translate(${dx}px, ${dy}px) scale(${k})`;
    }
    const ms = reduce ? 120 : 200;
    ghost.animate(
      [{ opacity: 1, transform: "none" }, { opacity: 0.85, offset: 0.7 }, { opacity: 0, transform: end }],
      { duration: ms, easing: reduce ? "linear" : EASE_OUT, fill: "forwards" },
    );
    window.setTimeout(() => ghost.remove(), ms + 40);
  });
}

/**
 * 커서를 따라다니는 고스트. 창 밖으로 나가면 좌표가 화면 밖이라 그대로는 보이지
 * 않으므로 가장자리에 붙여 둔다 — 어떤 파일을 쥐고 있는지는 이름으로만 알 수 있다.
 *
 * 상태(옮기기 · 제자리 · 놓을 수 없음 · 복사 · 링크)가 바뀌면 바탕 · 테두리 · 기호가 140ms 에
 * 넘어간다. 나타날 때는 살짝 커지며, 사라질 때는 `flyOff` 가 갈 곳으로 데려간다.
 */
function DragGhost({
  drag,
  mode,
  fate,
  origin,
}: {
  drag: FileDrag;
  mode: DropMode;
  fate: RefObject<GhostFate | null>;
  /** 처음 자리(끌기 시작한 행)의 위치 — Esc 로 취소하면 거기로 돌아간다. */
  origin: () => DOMRect | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const back = useRef(origin);
  back.current = origin;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.animate === "function") {
      el.animate(
        reducedMotion()
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: "scale(.9)" },
              { opacity: 1, transform: "none" },
            ],
        { duration: 140, easing: EASE_OUT },
      );
    }
    return () => {
      // 갈 곳을 정해 두지 않고 사라졌으면(App 의 Esc) 취소다 — 처음 자리로 돌아간다.
      const f = fate.current;
      fate.current = null;
      flyOff(el, f?.kind === "out" ? "out" : f?.kind === "land" ? f.to : back.current());
    };
  }, [fate]);

  const look = ghostLook(mode, drag.alt);
  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: Math.min(Math.max(6, drag.x + 12), window.innerWidth - GHOST_W - 6),
        top: Math.min(Math.max(6, drag.y + 12), window.innerHeight - GHOST_H - 6),
        zIndex: 95,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        gap: 8,
        maxWidth: GHOST_W,
        padding: "5px 9px",
        borderRadius: 5,
        border: `1px solid ${look.bd}`,
        background: look.bg,
        boxShadow: "0 8px 20px rgba(35,33,30,.22)",
        transformOrigin: "0 0",
        transition: "background-color var(--m-quick), border-color var(--m-quick)",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 16px",
          width: 16,
          height: 16,
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          lineHeight: 1,
          color: "#fff",
          background: look.badge,
          transition: "background-color var(--m-quick)",
        }}
      >
        <span key={look.glyph} className="cf-fade">
          {look.glyph}
        </span>
      </span>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: TEXT.ink,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {drag.name}
        </span>
        <span style={{ fontSize: 11, color: look.fg, whiteSpace: "nowrap", transition: "color var(--m-quick)" }}>
          {ghostStatus(mode, drag.over, drag.alt)}
        </span>
      </div>
    </div>
  );
}

/** 접힌 폴더의 자식은 `Collapse` 가 그릴 때만 만든다 — 닫힌 폴더마다 행을 미리 짓지 않는다. */
function Lazy({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

type DirItem = Extract<TreeItem, { kind: "dir" }>;
type FileItem = Extract<TreeItem, { kind: "file" }>;

export default function Explorer() {
  const s = useStore();
  const { ui, files, activeFolder } = s;
  const task = s.tasks.find((t) => t.folder === activeFolder);
  const { markDropped, justDropped } = useDropGuard();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const ghostFate = useRef<GhostFate | null>(null);
  /** 마지막으로 누른 곳이 탐색기 안인가 — F2 는 그때만 이름 바꾸기다. */
  const downInside = useRef(false);

  const tree = useMemo(() => nestTree(files), [files]);
  const dirs = useMemo(() => dirPaths(tree), [tree]);
  const openedModes = useMemo(() => {
    const m: Record<string, Partial<Record<TabMode, boolean>>> = {};
    ui.openTabs.forEach((t) => {
      m[t.path] = { ...m[t.path], [t.mode]: true };
    });
    return m;
  }, [ui.openTabs]);

  // -- 방금 바뀐 행 ------------------------------------------------------------
  //
  // 옮긴 · 만든 · 이름을 바꾼 행은 새 자리에서 한 번 반짝이고, 받은 폴더의 개수가 튄다. 목록을
  // 다시 읽은 뒤에야 새 경로를 알 수 있으므로 조작 전후의 목록을 견준다(`freshEntry`).
  const seq = useRef(0);
  const [flash, setFlash] = useState<{ path: string; n: number } | null>(null);
  const [bump, setBump] = useState<{ path: string; n: number } | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const pulse = (path: string, bumpDir?: string) => {
    const n = ++seq.current;
    setFlash({ path, n });
    if (bumpDir) setBump({ path: bumpDir, n });
    // 반짝임이 끝나면 걷는다 — 남겨 두면 폴더를 접었다 펼 때 다시 반짝인다.
    timers.current.push(
      window.setTimeout(() => {
        setFlash((v) => (v?.n === n ? null : v));
        setBump((v) => (v?.n === n ? null : v));
      }, 1000),
    );
  };

  const landed = async (run: () => Promise<void>, parent: string, isDir: boolean, bumpDir?: string) => {
    const before = useStore.getState();
    const seen = new Set(before.files.map((x) => x.p));
    await run();
    const after = useStore.getState();
    if (after.activeFolder !== before.activeFolder) return;
    const p = freshEntry(seen, after.files, parent, isDir);
    if (p) pulse(p, bumpDir);
  };

  /** 트리 안의 행. 최상위(`""`)는 트리 상자 자체다. */
  const rowEl = (path: string): HTMLElement | null => {
    const box = treeRef.current;
    if (!box) return null;
    if (path === "") return box;
    return (
      Array.from(box.querySelectorAll<HTMLElement>("[data-tree-path]")).find(
        (el) => el.getAttribute("data-tree-path") === path,
      ) ?? null
    );
  };
  const landingRect = (path: string): DOMRect | null => {
    const el = rowEl(path);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // 최상위로 놓으면 트리 맨 위 행 자리로 내려앉는다.
    return path === "" ? new DOMRect(r.left + 6, r.top + 5, r.width - 12, 23) : r;
  };

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
      markDropped();
      if (!d) return;
      const m = dropMode(d);
      // 고스트가 사라지기 전에 갈 곳부터 정한다 — 상태를 비우는 순간 고스트가 떨어져 나간다.
      ghostFate.current =
        m === "move"
          ? { kind: "land", to: landingRect(d.over ?? "") }
          : m === "out"
            ? { kind: "out" }
            : { kind: "back" };
      st.set({ fileDrag: null });
      if (d.outside) void st.exportToDesktop(d.path, e.altKey ? "link" : "copy");
      else if (m === "move" && d.over !== null) {
        const over = d.over;
        void landed(() => st.moveFile(d.path, over), over, d.isDir, over || undefined);
      }
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

  const drag = s.fileDrag;
  const mode = drag ? dropMode(drag) : null;

  // 스프링 폴더 — 옮길 수 있는 접힌 폴더 위에 600ms 머무르면 연다. 그동안 행 아래로 막대가 찬다.
  const spring =
    drag && mode === "move" && drag.over && ui.treeOpen[drag.over] === false ? drag.over : null;
  useEffect(() => {
    if (!spring) return;
    const t = window.setTimeout(() => {
      const st = useStore.getState();
      if (st.fileDrag?.over !== spring) return;
      st.setUi({ treeOpen: { ...st.ui.treeOpen, [spring]: true } });
    }, SPRING_MS);
    return () => window.clearTimeout(t);
  }, [spring]);

  // 새로 만들 폴더가 접혀 있으면 연다 — 입력칸이 접힌 폴더 안에 숨어 버린다. 메뉴 · 단추 ·
  // 메뉴 막대 어디서 열었든 같다.
  const mkParent = s.mk?.parent ?? null;
  useEffect(() => {
    if (!mkParent) return;
    const st = useStore.getState();
    const shut = ancestorsOf(mkParent).filter((p) => st.ui.treeOpen[p] === false);
    if (!shut.length) return;
    st.setUi({ treeOpen: { ...st.ui.treeOpen, ...Object.fromEntries(shut.map((p) => [p, true])) } });
  }, [mkParent]);

  // F2 = 이름 바꾸기 — 우클릭 메뉴의 항목과 같은 인라인 편집이다. 마지막으로 누른 곳이 탐색기이고
  // 글을 쓰는 칸에 있지 않을 때만 — 편집기에서 누른 F2 가 트리의 파일 이름을 바꾸면 안 된다.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      downInside.current = !!rootRef.current?.contains(e.target as Node);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "F2" || e.defaultPrevented || !downInside.current) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== document.body && !rootRef.current?.contains(a)) return;
      if (a?.closest("input, textarea, select, [contenteditable='true']")) return;
      const st = useStore.getState();
      const path = st.ui.sel;
      // index.md 는 업무의 메타데이터 노트라 바꿀 수 없다 — 메뉴에서 항목을 빼 둔 것과 같다.
      if (!path || path === "index.md" || st.fileDrag || st.fileRen || st.explorerMin) return;
      if (!st.files.some((x) => x.p === path) && !path.endsWith("/")) return;
      e.preventDefault();
      st.set({
        ctx: null,
        mk: null,
        fileRen: {
          path,
          name: path.replace(/\/$/, "").split("/").pop() ?? path,
          isDir: path.endsWith("/"),
        },
      });
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, []);

  const selMeta = ui.sel ? files.find((f) => f.p === ui.sel) : undefined;
  const selEs = badgeFor(ui.sel);
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

  // 누르고 있는 행(`holding`)은 왼쪽 칸에 1초 링을 그린다 — 길게 누르면 된다는 것이 보인다.
  const { startPress, holding } = useLongPress<{ path: string; name: string; isDir: boolean }>(
    ({ path, name, isDir }, { x, y }) => {
      ghostFate.current = null;
      s.set({ fileDrag: { path, name, isDir, x, y, over: null, outside: false, alt: false } });
    },
  );

  const startMk = (kind: "file" | "folder") => {
    s.set({ mk: { kind, parent: mkParentFor(ui.sel), name: "" } });
    // 인라인 편집기는 한 번에 하나다 — 만들기를 열면 고치던 이름은 접는다.
    s.set({ explorerMin: false, fileRen: null });
  };

  const commitMk = () => {
    const mk = useStore.getState().mk;
    if (!mk) return;
    void landed(() => useStore.getState().commitMk(), mk.parent, mk.kind === "folder");
  };

  const commitRename = (path: string, isDir: boolean) => {
    void landed(() => useStore.getState().commitFileRename(), dirname(path), isDir);
  };

  const collapseAll = () => {
    if (anyCollapsed) return s.setUi({ treeOpen: {} });
    const shut: Record<string, boolean> = {};
    files.forEach((f) => {
      const parts = f.p.split("/");
      const n = f.dir ? parts.length - 1 : parts.length - 1;
      let pre = "";
      for (let i = 0; i < n; i++) {
        pre += parts[i] + "/";
        shut[pre] = false;
      }
    });
    s.setUi({ treeOpen: shut });
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
          <span style={{ fontSize: 9, color: "#6a665e" }}>◀</span>
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
              fontSize: 11.5,
              color: "#6a665e",
            }}
          >
            {files.length}개 파일
          </span>
        </Box>
      </div>
    );
  }

  const smallBtn: CSSProperties = {
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

  // 드롭 대상은 **옮길 수 있을 때만** 파랗게 한다. 예전에는 트리 밖(`over === null`)도 `?? ""` 로
  // 최상위와 같게 봐서, "여기엔 놓을 수 없음" 이라면서 최상위 파일 행이 파랗게 됐다.
  const rootTarget = mode === "move" && drag?.over === "";
  const mkAt = s.mk ? (s.mk.parent === "" || dirs.has(s.mk.parent) ? s.mk.parent : "") : null;

  const rowBg = (on: boolean, held: boolean, target: boolean) =>
    target ? SEL_BG : on ? (held ? SEL_HELD_BG : SEL_BG) : held ? HELD_BG : "transparent";
  const rowHover = (on: boolean, held: boolean, target: boolean) =>
    target || on ? rowBg(on, held, target) : held ? HELD_BG : HOVER_BG;

  /** 행 왼쪽 9px 칸 — 폴더는 화살표, 누르고 있으면 그 위에 1초 링. */
  const slot = (path: string, chevron: boolean, open = false) => (
    <span
      style={{
        position: "relative",
        flex: "0 0 9px",
        width: 9,
        height: 12,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {chevron && (
        <svg
          aria-hidden
          className="cf-mv"
          width="9"
          height="9"
          viewBox="0 0 10 10"
          style={{
            transform: `rotate(${open ? 0 : -90}deg)`,
            transition: `transform var(--m-base) ${EASE_OUT}`,
          }}
        >
          <path
            d="M2.5 3.8 5 6.3l2.5-2.5"
            fill="none"
            stroke="#6a665e"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {holding?.path === path && <HoldRing size={14} style={{ left: -2.5, top: -1 }} />}
    </span>
  );

  const flashOf = (path: string) =>
    flash && flash.path === path ? (
      <span
        key={flash.n}
        aria-hidden
        className="cf-flash"
        style={{ position: "absolute", inset: 0, borderRadius: 4, pointerEvents: "none" }}
      />
    ) : null;

  const rowBase = (pad: number): CSSProperties => ({
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 23,
    borderRadius: 4,
    cursor: "default",
    userSelect: "none",
    paddingRight: 6,
    paddingLeft: pad,
    transition: ROW_TRANSITION,
  });

  const dirRow = (r: DirItem, pad: number) => {
    const open = ui.treeOpen[r.path] !== false;
    const on = ui.sel === r.path;
    const held = holding?.path === r.path;
    const target = mode === "move" && drag?.over === r.path;
    const bumped = bump?.path === r.path;
    return (
      <Box
        data-tree-path={r.path}
        onPointerDown={(e) => startPress(e, { path: r.path, name: r.name, isDir: true })}
        onClick={() => {
          if (justDropped()) return;
          // 다른 행을 누르면 고치던 이름은 접는다 — 접힌 폴더 안에 입력칸만
          // 남아 보이지 않게 되는 것을 막는다.
          if (s.fileRen) s.set({ fileRen: null });
          // 폴더도 고른다 — ＋ 파일 · ＋ 폴더가 그 안에 만들고, F2 가 그 폴더 이름을 바꾼다.
          s.setUi({ sel: r.path, treeOpen: { ...ui.treeOpen, [r.path]: !open } });
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
          ...rowBase(pad),
          background: rowBg(on, held, target),
          boxShadow: target ? "inset 0 0 0 1px #3a6fd8" : "none",
          opacity: drag?.path === r.path ? 0.4 : 1,
        }}
        hover={{ background: rowHover(on, held, target) }}
      >
        {slot(r.path, true, open)}
        <div
          style={{
            width: 11,
            height: 9,
            borderRadius: "1.5px 2px 2px 2px",
            background: target ? "#f0e3b6" : "#e2d6ae",
            border: "1px solid #cbba86",
            flex: "0 0 11px",
            transition: "background-color var(--m-quick)",
          }}
        />
        <span
          style={{
            fontSize: 12.5,
            fontWeight: on ? 600 : 500,
            color: on ? TEXT.ink : TEXT.body,
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
          key={bump && bumped ? bump.n : "n"}
          className={bumped ? "cf-bump" : undefined}
          style={{
            display: "inline-block",
            ...MONO,
            fontSize: 11.5,
            color: TEXT.sub,
            flex: "0 0 auto",
          }}
        >
          {r.count}
        </span>
        {spring === r.path && (
          <span
            aria-hidden
            className="cf-sweep"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 2,
              borderRadius: 1,
              background: "#3a6fd8",
              pointerEvents: "none",
              animationDuration: `${SPRING_MS}ms`,
            }}
          />
        )}
        {flashOf(r.path)}
      </Box>
    );
  };

  const modeChip = (label: string, fg: string, bg: string, extra?: CSSProperties, title?: string) => (
    <span
      title={title}
      style={{
        flex: "0 0 auto",
        ...MONO,
        fontSize: 8.5,
        color: fg,
        background: bg,
        borderRadius: 2,
        padding: "1px 3px",
        ...extra,
      }}
    >
      {label}
    </span>
  );

  const fileRow = (r: FileItem, pad: number) => {
    const ext = extOf(r.name);
    const es = badgeFor(r.path);
    const on = ui.sel === r.path;
    const held = holding?.path === r.path;
    const om = openedModes[r.path] ?? {};
    return (
      <Box
        key={`f${r.path}`}
        data-tree-path={r.path}
        onPointerDown={(e) => startPress(e, { path: r.path, name: r.name, isDir: false })}
        onClick={() => {
          if (justDropped()) return;
          s.setUi({ sel: r.path });
          s.set({ ctx: null, fileRen: null });
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
          ...rowBase(pad),
          background: rowBg(on, held, false),
          opacity: drag?.path === r.path ? 0.4 : 1,
        }}
        hover={{ background: rowHover(on, held, false) }}
      >
        {slot(r.path, false)}
        {modeChip(es.label, es.fg, es.bg, { fontWeight: 600, letterSpacing: ".2px" })}
        <span
          style={{
            fontSize: 12.5,
            color: on ? TEXT.ink : TEXT.body,
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
        {om.bstorm && modeChip("BS", "#256b47", "#e9f4ee")}
        {/* 탭의 MD 배지와 같은 청록 — 보라는 AI 전용이다. */}
        {om.md && modeChip("MD", "#2f6f80", "#e8f3f5")}
        {om.html && modeChip("HTML", "#8f5d17", "#fbf3e6")}
        {om.text && modeChip("TXT", "#2f5cbb", "#eef3fd")}
        {ui.extOpened[r.path] && modeChip("↗", "#6a665e", "#efece6", { fontSize: 9 })}
        {r.link && modeChip("LNK", "#8f5d17", "#fbf3e6", { fontWeight: 600 }, r.link)}
        {flashOf(r.path)}
      </Box>
    );
  };

  /**
   * 한 폴더의 자식들. 폴더마다 자식을 `Collapse` 로 감싸 높이째 여닫는다 — 예전에는 한 프레임에
   * 생기고 사라져 아래 행이 통째로 튀었다. 새로 만드는 행은 그 폴더의 맨 앞에 선다.
   */
  const level = (items: TreeItem[], parent: string, depth: number): ReactNode => {
    const pad = 6 + depth * 13;
    return (
      <>
        {mkAt === parent && <MkRow key={`mk${parent}`} pad={pad} onCommit={commitMk} />}
        {items.map((r) => {
          // 이름을 고치는 중이면 그 행 자리에 입력칸이 들어선다 — 어느 항목을 고치고
          // 있는지가 트리 안의 자리로 그대로 드러난다.
          const renaming = s.fileRen?.path === r.path;
          if (r.kind === "file") {
            return renaming ? <RenameRow key={`r${r.path}`} pad={pad} onCommit={commitRename} /> : fileRow(r, pad);
          }
          return (
            <Fragment key={`d${r.path}`}>
              {renaming ? <RenameRow pad={pad} onCommit={commitRename} /> : dirRow(r, pad)}
              <Collapse open={ui.treeOpen[r.path] !== false}>
                <Lazy render={() => level(r.kids, r.path, depth + 1)} />
              </Collapse>
            </Fragment>
          );
        })}
      </>
    );
  };

  return (
    <div
      ref={rootRef}
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
            color: "#6a665e",
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
            fontSize: 11.5,
            color: "#6a665e",
            flex: "0 0 auto",
          }}
        >
          {files.length}개 파일
        </span>
      </div>

      <div
        ref={treeRef}
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
        onContextMenu={(e) => {
          // 행 위의 우클릭은 행이 처리한다. 입력칸(새로 만들기 · 이름 바꾸기)은 웹뷰 기본
          // 메뉴(붙여넣기 등)를 그대로 둔다.
          if (e.defaultPrevented) return;
          const t = e.target as HTMLElement;
          if (t.closest("input, textarea")) return;
          if (t.closest("[data-tree-path]") !== e.currentTarget) return;
          e.preventDefault();
          if (!activeFolder) return;
          const base = activeFolder.split(/[\\/]/).filter(Boolean).pop();
          s.set({
            ctx: {
              root: true,
              path: "",
              name: task?.relFolder || base || activeFolder,
              ext: "",
              isDir: true,
              bin: false,
              count: files.length,
              x: e.clientX,
              y: e.clientY,
            },
          });
        }}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "5px 6px 8px 6px",
          background: s.dragOver || rootTarget ? "#f4f8fe" : "transparent",
          boxShadow: rootTarget ? "inset 0 0 0 1px #cddcf8" : "none",
          transition: "background-color var(--m-quick), box-shadow var(--m-quick)",
        }}
      >
        {level(tree, "", 0)}

        {!tree.length && !s.mk && (
          <div className="cf-fade" style={{ padding: "6px 6px 0", fontSize: 12, lineHeight: 1.6, color: TEXT.sub }}>
            아직 파일이 없습니다 — ＋ 파일 · ＋ 폴더, 또는 바탕화면에서 끌어다 놓으세요
          </div>
        )}

        <div
          style={{
            marginTop: 9,
            border: `1px dashed ${s.dragOver ? "#3a6fd8" : "#ddd8cf"}`,
            borderRadius: 6,
            padding: "10px 8px",
            textAlign: "center",
            background: s.dragOver ? "#eef3fd" : "transparent",
            transition: "background-color var(--m-quick), border-color var(--m-quick)",
          }}
        >
          <div
            style={{ fontSize: 11.5, color: s.dragOver ? "#2f5cbb" : "#6a665e", lineHeight: 1.6 }}
          >
            {s.dragOver
              ? "놓으면 이 업무 폴더로 가져옵니다"
              : "바탕화면에서 파일을 끌어다 놓기"}
          </div>
          <div style={{ fontSize: 11, color: "#6a665e", marginTop: 2 }}>
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
                color: ui.sel.endsWith("/") ? "#8f5d17" : selEs.fg,
                background: ui.sel.endsWith("/") ? "#fbf3e6" : selEs.bg,
                flex: "0 0 auto",
              }}
            >
              {ui.sel.endsWith("/") ? "DIR" : selEs.label}
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
                fontSize: 11.5,
                color: "#6a665e",
                flex: "0 0 auto",
              }}
            >
              {selMeta?.size || "—"}
            </span>
          </div>
          <div style={{ fontSize: 11, color: TEXT.sub, marginTop: -1, lineHeight: 1.6 }}>
            더블클릭 = 열기 · <span style={MONO}>F2</span> = 이름 바꾸기 · 우클릭 = 열기 방식
            <br />
            1초 길게 눌러 옮기기 · 창 밖으로 = 바탕화면 (<span style={MONO}>Alt</span> = 링크)
          </div>
        </div>
      )}

      {/*
        드래그 중의 커서. 창 밖에서는 고스트가 따라갈 수 없으므로(웹뷰 안에만 그릴 수
        있다) 커서 자체에 배지를 붙여 무엇을 쥐고 있는지 알린다 — 바탕화면으로 복사면 ＋,
        Alt 로 링크만이면 ↗, 놓을 수 없는 자리면 ⦸. 포인터를 캡처하고 있는 동안은 창 밖에서도
        이 커서가 유지된다.

        `*` 에 !important 로 거는 이유는 캡처 중 커서를 정하는 것이 캡처 대상 요소이고,
        그 요소(행)와 지나치는 요소들이 저마다 cursor 를 들고 있기 때문이다.
      */}
      {drag && (
        <style>
          {`html, body, body * { cursor: ${dragCursor(
            dragKind(drag.outside, drag.alt, mode === "no"),
          )} !important; }`}
        </style>
      )}

      {drag && mode && (
        <DragGhost
          drag={drag}
          mode={mode}
          fate={ghostFate}
          origin={() => rowEl(drag.path)?.getBoundingClientRect() ?? null}
        />
      )}
    </div>
  );
}
