import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Box } from "../lib/ui";
import { TEXT } from "../lib/design";
import type { TableAlign } from "../lib/markdown";
import {
  coverMap,
  deleteCols,
  deleteRows,
  hasMergeIn,
  insertCol,
  insertRow,
  mergeBlocker,
  mergeCells,
  normalize,
  parseClipboardGrid,
  pasteCells,
  rectOf,
  setAlign,
  setCell,
  tableSize,
  tableToMarkdown,
  unmergeCells,
  type TableModel,
} from "../lib/mdTable";
import { GhostButton, Modal, ModalFooter, PrimaryButton } from "./Modal";

type Pos = { r: number; c: number };
const keyOf = (p: Pos) => `${p.r}:${p.c}`;

const ALIGNS: { a: TableAlign; label: string; title: string }[] = [
  { a: "", label: "기본", title: "정렬 표시 없음 (---) — 보통 왼쪽으로 보입니다" },
  { a: "left", label: "왼쪽", title: "왼쪽 정렬 (:---)" },
  { a: "center", label: "가운데", title: "가운데 정렬 (:---:)" },
  { a: "right", label: "오른쪽", title: "오른쪽 정렬 (---:)" },
];

/** 칸 안의 글을 감싸는 서식. 뷰어(`mdSegs`)가 그리는 넷만 둔다 — 누르고도 안 보이는 단추는 없다. */
const MARKS: { pre: string; suf: string; label: ReactNode; title: string }[] = [
  { pre: "**", suf: "**", label: <b>B</b>, title: "굵게 (**글**)" },
  { pre: "~~", suf: "~~", label: <s>S</s>, title: "취소선 (~~글~~)" },
  {
    pre: "`",
    suf: "`",
    label: <span style={{ fontFamily: "'Roboto Mono',monospace" }}>{"</>"}</span>,
    title: "코드 (`글`)",
  },
  { pre: "[[", suf: "]]", label: "[[ ]]", title: "위키링크 ([[노트]])" },
];

/** 열 머리의 이름 — A, B, … Z, AA, AB, … */
function colName(c: number): string {
  let n = c + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * 정렬 모양 — 세 줄을 왼쪽 · 가운데 · 오른쪽에 붙인다. `overflow: visible` 이 없으면
 * `global.css` 의 `scrollbar-gutter: stable` 이 스크롤바 자리를 잡아 그림이 가려진다.
 */
function AlignIcon({ a }: { a: TableAlign }) {
  const widths = [12, 7, 10];
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden style={{ display: "block", overflow: "visible" }}>
      {widths.map((w, i) => (
        <rect
          key={i}
          x={a === "right" ? 12 - w : a === "center" ? (12 - w) / 2 : 0}
          y={i * 4 + 0.4}
          width={w}
          height={1.6}
          rx={0.8}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

function Tool({
  onClick,
  disabled,
  title,
  on,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  on?: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      // 칸의 커서 · 고른 글을 지킨다 — 눌러도 초점이 단추로 옮겨 가지 않는다.
      onMouseDown={(e) => e.preventDefault()}
      onClick={disabled ? undefined : onClick}
      title={title}
      aria-disabled={disabled || undefined}
      style={{
        height: 24,
        padding: "0 8px",
        display: "flex",
        alignItems: "center",
        gap: 5,
        borderRadius: 4,
        border: `1px solid ${on ? "#cddcf8" : "#e4e0d8"}`,
        background: on ? "#eef3fd" : "#fff",
        color: disabled ? TEXT.off : on ? "#2f5cbb" : "#3a3630",
        fontSize: 11.5,
        fontWeight: on ? 600 : 500,
        cursor: disabled ? "not-allowed" : "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
      hover={disabled ? undefined : { background: on ? "#e2ebfb" : "#f2efe9" }}
    >
      {children}
    </Box>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: ".3px",
          color: TEXT.hint,
          marginRight: 3,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * 표 만들기 · 고치기 팝업. 칸마다 글을 적는 격자에 행 · 열 넣기와 지우기, 칸 병합, 열 정렬,
 * 칸 안의 서식을 둔다. [표 넣기] 를 누를 때까지 문서는 그대로다 — [취소] 는 아무 일도 없었던
 * 것처럼 닫는다.
 *
 * 격자는 스프레드시트처럼 움직인다: Tab 은 다음 칸(마지막 칸이면 행을 하나 늘린다), Enter 는
 * 아래 칸(마지막 행이면 늘린다), Shift+Enter 는 칸 안의 줄바꿈, 화살표는 칸 끝에서 옆 칸으로
 * 넘어간다. 한글 입력 중(조합 중)의 Enter 는 글자를 마무리하는 것이라 건드리지 않는다.
 * 엑셀에서 복사한 칸이나 마크다운 표를 붙여넣으면 그 칸부터 채운다.
 */
export default function TableModal({
  initial,
  editing,
  onConfirm,
  onCancel,
}: {
  initial: TableModel;
  /** 이미 있는 표를 고치는 중인지. 확정 단추의 이름과, 바뀐 것이 없을 때의 동작이 갈린다. */
  editing: boolean;
  onConfirm: (t: TableModel) => void;
  onCancel: () => void;
}) {
  const [t, setT] = useState(initial);
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 0 });
  const [end, setEnd] = useState<Pos>({ r: 0, c: 0 });
  const [showSrc, setShowSrc] = useState(false);
  const [escArmed, setEscArmed] = useState(false);
  const boxes = useRef(new Map<string, HTMLTextAreaElement>());
  /** 다음 그리기 뒤에 초점을 줄 칸. 행을 넣은 직후처럼 그 칸이 아직 없을 때를 위한 것이다. */
  const want = useRef<{ p: Pos; caret: "end" | "start" | "keep" } | null>({
    p: { r: 0, c: 0 },
    caret: "end",
  });
  const dragging = useRef(false);
  const escTimer = useRef<number | undefined>(undefined);
  const gridEl = useRef<HTMLTableElement | null>(null);
  /**
   * 방금 넣은 행 · 열(포함 범위). 다음 그리기 뒤에 그 칸들이 한 번 빛난다 — 큰 표에서 단추를 누른 뒤
   * 어디에 줄이 생겼는지 눈으로 찾지 않아도 된다.
   */
  const fresh = useRef<{ rows: [number, number] | null; cols: [number, number] | null } | null>(null);

  const { rows, cols } = tableSize(t);
  const cover = useMemo(() => coverMap(t), [t]);
  const md = useMemo(() => tableToMarkdown(t), [t]);
  const html = t.merges.length > 0;
  const dirty = useMemo(() => JSON.stringify(t) !== JSON.stringify(initial), [t, initial]);

  const clamp = (p: Pos): Pos => ({
    r: Math.min(Math.max(0, p.r), rows - 1),
    c: Math.min(Math.max(0, p.c), cols - 1),
  });
  /** 합친 칸 안의 자리는 그 칸의 왼쪽 위 자리로 모은다 — 글을 들고 있는 것은 거기뿐이다. */
  const top = (p: Pos): Pos => {
    const m = cover[p.r]?.[p.c];
    return m ? { r: m.r, c: m.c } : p;
  };
  const active = top(clamp(anchor));
  const sel = rectOf(t, clamp(anchor), clamp(end));
  const multi = !(
    sel.r0 === active.r &&
    sel.c0 === active.c &&
    sel.r1 === active.r + (cover[active.r]?.[active.c]?.rs ?? 1) - 1 &&
    sel.c1 === active.c + (cover[active.r]?.[active.c]?.cs ?? 1) - 1
  );
  const inSel = (r: number, c: number) => r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;

  /** 칸 순서(읽는 순서). 덮인 칸은 건너뛴다. Tab 이 이 순서로 움직인다. */
  const order = useMemo(() => {
    const out: Pos[] = [];
    cover.forEach((row, r) =>
      row.forEach((m, c) => {
        if (!m || (m.r === r && m.c === c)) out.push({ r, c });
      }),
    );
    return out;
  }, [cover]);

  useLayoutEffect(() => {
    const w = want.current;
    if (!w) return;
    want.current = null;
    const p = top(clamp(w.p));
    const el = boxes.current.get(keyOf(p));
    if (!el) return;
    el.focus();
    if (w.caret !== "keep") {
      const at = w.caret === "start" ? 0 : el.value.length;
      el.setSelectionRange(at, at);
    }
    el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  useLayoutEffect(() => {
    const f = fresh.current;
    if (!f) return;
    fresh.current = null;
    const box = gridEl.current;
    if (!box || typeof Element.prototype.animate !== "function") return;
    const inRange = (v: number, rg: [number, number] | null) => !!rg && v >= rg[0] && v <= rg[1];
    box.querySelectorAll<HTMLElement>("td[data-cell]").forEach((td) => {
      const [r, c] = (td.dataset.cell as string).split(":").map(Number);
      if (!inRange(r, f.rows) && !inRange(c, f.cols)) return;
      // 칸마다 바탕이 다르다(머리 · 고른 칸) — 제 바탕에서 파랗게 빛났다가 제 바탕으로 돌아온다.
      const base = getComputedStyle(td).backgroundColor;
      td.animate(
        [{ backgroundColor: base }, { backgroundColor: "#dfe9fb", offset: 0.2 }, { backgroundColor: base }],
        { duration: 900, easing: "ease-out" },
      );
    });
  });

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mouseup", up);
      window.clearTimeout(escTimer.current);
    };
  }, []);

  const go = (p: Pos, caret: "end" | "start" | "keep" = "end") => {
    setAnchor(p);
    setEnd(p);
    want.current = { p, caret };
  };

  const confirm = () => {
    if (editing && !dirty) onCancel();
    else onConfirm(normalize(t));
  };

  /** 바뀐 것이 있으면 Esc 를 두 번 눌러야 닫는다 — 큰 표를 채우다 한 번 잘못 누른 Esc 에 다 잃지 않게. */
  const tryCancel = () => {
    if (!dirty || escArmed) {
      onCancel();
      return;
    }
    setEscArmed(true);
    window.clearTimeout(escTimer.current);
    escTimer.current = window.setTimeout(() => setEscArmed(false), 2400);
  };

  // --- 칸 사이 움직이기 ----------------------------------------------------

  const step = (dir: 1 | -1) => {
    const i = order.findIndex((p) => p.r === active.r && p.c === active.c);
    const j = i + dir;
    if (j >= 0 && j < order.length) go(order[j]);
    else if (dir > 0) {
      setT((x) => insertRow(x, x.cells.length));
      fresh.current = { rows: [rows, rows], cols: null };
      go({ r: rows, c: 0 });
    }
  };

  const vertical = (dir: 1 | -1, grow: boolean): boolean => {
    const m = cover[active.r]?.[active.c];
    const r = dir > 0 ? active.r + (m ? m.rs : 1) : active.r - 1;
    if (r < 0) return false;
    if (r >= rows) {
      if (!grow) return false;
      setT((x) => insertRow(x, x.cells.length));
      fresh.current = { rows: [rows, rows], cols: null };
      go({ r: rows, c: active.c });
      return true;
    }
    go({ r, c: active.c });
    return true;
  };

  const horizontal = (dir: 1 | -1): boolean => {
    const m = cover[active.r]?.[active.c];
    const c = dir > 0 ? active.c + (m ? m.cs : 1) : active.c - 1;
    if (c < 0 || c >= cols) return false;
    go({ r: active.r, c }, dir > 0 ? "start" : "end");
    return true;
  };

  const onCellKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Enter" && mod) {
      e.preventDefault();
      confirm();
      return;
    }
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
      return;
    }
    if (mod || e.altKey || e.shiftKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      vertical(1, true);
      return;
    }
    const el = e.currentTarget;
    const a = el.selectionStart ?? 0;
    if (a !== (el.selectionEnd ?? a)) return;
    const v = el.value;
    const moved =
      e.key === "ArrowUp" && !v.slice(0, a).includes("\n")
        ? vertical(-1, false)
        : e.key === "ArrowDown" && !v.slice(a).includes("\n")
          ? vertical(1, false)
          : e.key === "ArrowLeft" && a === 0
            ? horizontal(-1)
            : e.key === "ArrowRight" && a === v.length
              ? horizontal(1)
              : false;
    if (moved) e.preventDefault();
  };

  // --- 고르기 ------------------------------------------------------------

  const onCellDown = (e: React.MouseEvent, p: Pos) => {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      // 초점은 처음 고른 칸에 둔 채 구간만 늘린다.
      e.preventDefault();
      setEnd(p);
      return;
    }
    dragging.current = true;
    setAnchor(p);
    setEnd(p);
    // 칸의 빈 자리(글 아래)를 눌렀다 — 글상자로 초점을 옮겨 준다.
    if (!(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      want.current = { p, caret: "end" };
    }
  };

  /**
   * 머리 띠(열 이름 · 행 번호)를 눌러 줄 전체를 고른다. Shift 를 누르고 있으면 지금 고른 줄부터
   * 누른 줄까지 넓힌다(여러 열의 정렬을 한 번에 바꿀 때).
   */
  const pick = (e: React.MouseEvent, kind: "col" | "row" | "all", at = 0) => {
    e.preventDefault();
    let a: Pos = { r: 0, c: 0 };
    let b: Pos = { r: rows - 1, c: cols - 1 };
    if (kind === "col") {
      a = { r: 0, c: e.shiftKey ? anchor.c : at };
      b = { r: rows - 1, c: at };
    } else if (kind === "row") {
      a = { r: e.shiftKey ? anchor.r : at, c: 0 };
      b = { r: at, c: cols - 1 };
    }
    setAnchor(a);
    setEnd(b);
    want.current = { p: a, caret: "keep" };
  };

  // --- 고치기 ------------------------------------------------------------

  const apply = (next: TableModel | null, p?: Pos) => {
    if (!next) return;
    setT(next);
    if (p) go(p);
    else want.current = { p: active, caret: "keep" };
  };

  /** 행 · 열 넣기. 넣은 줄(`row` 또는 `col` 번째)이 한 번 빛난다. */
  const insert = (next: TableModel, p: Pos, at: { row?: number; col?: number }) => {
    fresh.current = {
      rows: at.row !== undefined ? [at.row, at.row] : null,
      cols: at.col !== undefined ? [at.col, at.col] : null,
    };
    apply(next, p);
  };

  const blocker = mergeBlocker(sel);
  const canUnmerge = hasMergeIn(t, sel);
  const allRows = sel.r0 === 0 && sel.r1 === rows - 1;
  const allCols = sel.c0 === 0 && sel.c1 === cols - 1;
  const alignNow = t.align[active.c] ?? "";

  const wrap = (pre: string, suf: string) => {
    const el = boxes.current.get(keyOf(active));
    if (!el) return;
    const a = el.selectionStart ?? el.value.length;
    const z = el.selectionEnd ?? a;
    const v = el.value;
    const inner = v.slice(a, z);
    el.focus();
    el.setSelectionRange(a, z);
    // 웹뷰에 맡기면 칸 안의 되돌리기(Ctrl+Z)가 그대로 남는다. 값은 onChange 로 따라온다.
    let native = false;
    try {
      native = document.execCommand("insertText", false, pre + inner + suf);
    } catch {
      native = false;
    }
    const { r, c } = active;
    if (!native) setT((x) => setCell(x, r, c, v.slice(0, a) + pre + inner + suf + v.slice(z)));
    requestAnimationFrame(() => el.setSelectionRange(a + pre.length, a + pre.length + inner.length));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>, p: Pos) => {
    const grid = parseClipboardGrid(e.clipboardData.getData("text/plain"));
    if (!grid || (grid.length === 1 && grid[0].length <= 1)) return;
    e.preventDefault();
    setT((x) => pasteCells(x, p.r, p.c, grid));
    const r1 = p.r + grid.length - 1;
    const c1 = p.c + Math.max(...grid.map((g) => g.length)) - 1;
    // 모자라서 늘어난 행 · 열만 빛난다.
    if (r1 >= rows || c1 >= cols) {
      fresh.current = { rows: r1 >= rows ? [rows, r1] : null, cols: c1 >= cols ? [cols, c1] : null };
    }
    setAnchor(p);
    setEnd({ r: r1, c: c1 });
  };

  // --- 그리기 ------------------------------------------------------------

  const stripBase: CSSProperties = {
    border: "1px solid #e4e0d8",
    background: "#f7f5f1",
    fontFamily: "'Roboto Mono',monospace",
    fontSize: 10.5,
    fontWeight: 500,
    color: TEXT.hint,
    userSelect: "none",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
  const stripOn: CSSProperties = { background: "#e6eefc", color: "#2f5cbb" };

  return (
    <Modal
      width={900}
      zIndex={79}
      // 바깥을 눌러 닫는 것은 바뀐 것이 없을 때만 — 채우던 표를 한 번의 헛손질로 잃지 않게.
      onClose={() => !dirty && onCancel()}
      panelStyle={{ maxHeight: "88vh" }}
    >
      <div
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // 앱의 Esc(맨 위 레이어 닫기)까지 가지 않게 여기서 끝낸다.
          e.preventDefault();
          e.stopPropagation();
          if (!e.nativeEvent.isComposing) tryCancel();
        }}
        style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
      >
        <div
          style={{
            flex: "0 0 40px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            borderBottom: "1px solid #e6e2da",
            background: "#faf9f6",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>{editing ? "표 편집" : "표 만들기"}</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: TEXT.sub }}>
            Tab 다음 칸 · Enter 아래 칸 · Shift+Enter 칸 안 줄바꿈 · Ctrl+Enter 확정
          </span>
        </div>

        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "6px 14px",
            padding: "8px 14px",
            borderBottom: "1px solid #eeebe5",
          }}
        >
          <Group label="행">
            <Tool
              onClick={() => insert(insertRow(t, sel.r0), { r: sel.r0, c: active.c }, { row: sel.r0 })}
              title="고른 행 위에 빈 행을 넣습니다"
            >
              ↑ 위에 추가
            </Tool>
            <Tool
              onClick={() => insert(insertRow(t, sel.r1 + 1), { r: sel.r1 + 1, c: active.c }, { row: sel.r1 + 1 })}
              title="고른 행 아래에 빈 행을 넣습니다"
            >
              ↓ 아래에 추가
            </Tool>
            <Tool
              disabled={allRows}
              onClick={() => {
                const n = deleteRows(t, sel.r0, sel.r1);
                if (n) apply(n, { r: Math.min(sel.r0, n.cells.length - 1), c: active.c });
              }}
              title={allRows ? "표에는 행이 하나는 있어야 합니다" : "고른 행을 지웁니다"}
            >
              행 삭제
            </Tool>
          </Group>
          <Group label="열">
            <Tool
              onClick={() => insert(insertCol(t, sel.c0), { r: active.r, c: sel.c0 }, { col: sel.c0 })}
              title="고른 열 왼쪽에 빈 열을 넣습니다"
            >
              ← 왼쪽에 추가
            </Tool>
            <Tool
              onClick={() => insert(insertCol(t, sel.c1 + 1), { r: active.r, c: sel.c1 + 1 }, { col: sel.c1 + 1 })}
              title="고른 열 오른쪽에 빈 열을 넣습니다"
            >
              → 오른쪽에 추가
            </Tool>
            <Tool
              disabled={allCols}
              onClick={() => {
                const n = deleteCols(t, sel.c0, sel.c1);
                if (n) apply(n, { r: active.r, c: Math.min(sel.c0, n.cells[0].length - 1) });
              }}
              title={allCols ? "표에는 열이 하나는 있어야 합니다" : "고른 열을 지웁니다"}
            >
              열 삭제
            </Tool>
          </Group>
          <Group label="칸">
            <Tool
              disabled={!!blocker}
              onClick={() => apply(mergeCells(t, sel), { r: sel.r0, c: sel.c0 })}
              title={blocker ?? "고른 칸을 하나로 합칩니다 — 글은 줄을 바꿔 이어 붙입니다"}
            >
              병합
            </Tool>
            <Tool
              disabled={!canUnmerge}
              onClick={() => apply(unmergeCells(t, sel))}
              title={canUnmerge ? "합친 칸을 원래 칸으로 나눕니다" : "고른 자리에 합친 칸이 없습니다"}
            >
              병합 해제
            </Tool>
          </Group>
          <Group label="정렬">
            {ALIGNS.map((x) => (
              <Tool
                key={x.label}
                on={alignNow === x.a}
                onClick={() => setT(setAlign(t, sel.c0, sel.c1, x.a))}
                title={`${x.title} — 고른 열에 적용합니다`}
              >
                {x.a ? <AlignIcon a={x.a} /> : null}
                {x.label}
              </Tool>
            ))}
          </Group>
          <Group label="서식">
            {MARKS.map((x) => (
              <Tool key={x.pre} onClick={() => wrap(x.pre, x.suf)} title={`${x.title} — 칸에서 고른 글을 감쌉니다`}>
                {x.label}
              </Tool>
            ))}
          </Group>
        </div>

        <div style={{ flex: 1, minHeight: 170, overflow: "auto", padding: "12px 14px 10px", background: "#fdfcfa" }}>
          <table ref={gridEl} style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th
                  onMouseDown={(e) => pick(e, "all")}
                  title="표 전체를 고릅니다"
                  style={{ ...stripBase, width: 34, height: 20 }}
                />
                {Array.from({ length: cols }, (_, c) => {
                  const on = c >= sel.c0 && c <= sel.c1 && (multi || allRows);
                  return (
                    <th
                      key={c}
                      onMouseDown={(e) => pick(e, "col", c)}
                      title={`${colName(c)}열 전체를 고릅니다 (Shift+클릭으로 여러 열)`}
                      style={{ ...stripBase, height: 20, padding: "0 6px", ...(on && stripOn) }}
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        {colName(c)}
                        {t.align[c] && <AlignIcon a={t.align[c]} />}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {t.cells.map((row, r) => {
                const rowOn = r >= sel.r0 && r <= sel.r1 && (multi || allCols);
                return (
                  <tr key={r}>
                    <td
                      onMouseDown={(e) => pick(e, "row", r)}
                      title={r === 0 ? "머리 행 — 마크다운 표의 첫 줄은 언제나 머리 행입니다" : `${r}행 전체를 고릅니다 (Shift+클릭으로 여러 행)`}
                      style={{
                        ...stripBase,
                        width: 34,
                        textAlign: "center",
                        verticalAlign: "middle",
                        ...(r === 0 && { fontFamily: "inherit", fontWeight: 600 }),
                        ...(rowOn && stripOn),
                      }}
                    >
                      {r === 0 ? "머리" : r}
                    </td>
                    {row.map((text, c) => {
                      const m = cover[r][c];
                      if (m && (m.r !== r || m.c !== c)) return null;
                      const p = { r, c };
                      const head = r === 0;
                      const isActive = active.r === r && active.c === c;
                      const picked = multi && inSel(r, c);
                      const font: CSSProperties = {
                        gridArea: "1 / 1",
                        margin: 0,
                        padding: "5px 8px",
                        boxSizing: "border-box",
                        fontFamily: "inherit",
                        fontSize: 12.5,
                        lineHeight: "19px",
                        fontWeight: head ? 600 : 400,
                        textAlign: (t.align[c] || "left") as CSSProperties["textAlign"],
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      };
                      return (
                        <td
                          key={c}
                          data-cell={`${r}:${c}`}
                          colSpan={m && m.cs > 1 ? m.cs : undefined}
                          rowSpan={m && m.rs > 1 ? m.rs : undefined}
                          onMouseDown={(e) => onCellDown(e, p)}
                          onMouseEnter={() => {
                            if (dragging.current) setEnd(p);
                          }}
                          style={{
                            padding: 0,
                            border: "1px solid #ddd8cf",
                            verticalAlign: "top",
                            background: picked ? (head ? "#dfe8f8" : "#eef3fd") : head ? "#f4f2ed" : "#fff",
                            boxShadow: isActive ? "inset 0 0 0 2px #3a6fd8" : undefined,
                            cursor: "text",
                          }}
                        >
                          {/*
                            글상자는 제 글만큼 자라야 한다(넓은 칸 · 여러 줄). 같은 글을 담은 보이지
                            않는 span 을 같은 자리에 겹쳐 그 크기를 빌린다 — `field-sizing` 은 모든
                            웹뷰에 있지 않다.
                          */}
                          <div style={{ display: "grid", minWidth: 88, maxWidth: 300 }}>
                            <span aria-hidden style={{ ...font, visibility: "hidden" }}>
                              {`${text} `}
                            </span>
                            <textarea
                              ref={(el) => {
                                const k = keyOf(p);
                                if (el) boxes.current.set(k, el);
                                else boxes.current.delete(k);
                              }}
                              value={text}
                              rows={1}
                              cols={1}
                              spellCheck={false}
                              aria-label={`${colName(c)}${head ? " 머리" : r}`}
                              onChange={(e) => {
                                const v = e.target.value;
                                setT((x) => setCell(x, r, c, v));
                              }}
                              onFocus={() => {
                                if (active.r !== r || active.c !== c) {
                                  setAnchor(p);
                                  setEnd(p);
                                }
                              }}
                              onKeyDown={onCellKey}
                              onPaste={(e) => onPaste(e, p)}
                              style={{
                                ...font,
                                width: "100%",
                                height: "100%",
                                minWidth: 0,
                                resize: "none",
                                overflow: "hidden",
                                border: 0,
                                outline: "none",
                                background: "transparent",
                                color: head ? "#23211e" : "#3a3630",
                              }}
                            />
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 8, fontSize: 11, color: TEXT.hint, lineHeight: 1.6 }}>
            칸을 끌거나 Shift+클릭으로 여러 칸을 고릅니다 · 엑셀 · 구글 시트에서 복사한 칸이나 마크다운 표를
            붙여넣으면 그 칸부터 채웁니다
          </div>
        </div>

        {showSrc && (
          <pre
            style={{
              flex: "0 0 auto",
              margin: 0,
              maxHeight: 170,
              overflow: "auto",
              padding: "8px 14px",
              borderTop: "1px solid #e6e2da",
              background: "#faf9f6",
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              lineHeight: 1.6,
              color: "#4e4a43",
              whiteSpace: "pre",
            }}
          >
            {md}
          </pre>
        )}

        <ModalFooter>
          {/* 크기 줄은 늘 남는다 — Esc 경고가 떠도 지금 표가 몇 칸인지는 그대로 보여야 한다. */}
          <span style={{ fontSize: 11.5, color: TEXT.sub, whiteSpace: "nowrap" }}>
            {cols}열 × {rows}행 · 첫 줄은 머리 행
          </span>
          {escArmed ? (
            <span className="cf-fade" role="status" style={{ fontSize: 11.5, color: TEXT.warn }}>
              바뀐 내용이 있습니다 — Esc 를 한 번 더 누르면 버리고 닫습니다
            </span>
          ) : (
            <>
              {html && (
                <span
                  title="마크다운 표에는 칸을 합치는 문법이 없어 HTML <table> 로 적습니다. Obsidian · GitHub 와 이 뷰어에서 그대로 보입니다."
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: TEXT.warn,
                    background: "#fbf3e6",
                    border: "1px solid #eeddc0",
                    borderRadius: 3,
                    padding: "1px 6px",
                  }}
                >
                  병합한 칸이 있어 HTML 표로 저장됩니다
                </span>
              )}
              <Box
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShowSrc((v) => !v)}
                style={{ fontSize: 11.5, color: "#3a6fd8", cursor: "pointer", userSelect: "none" }}
                hover={{ textDecoration: "underline" }}
              >
                {showSrc ? "원본 숨기기" : "원본 보기"}
              </Box>
            </>
          )}
          <div style={{ flex: 1 }} />
          <GhostButton onClick={onCancel}>취소</GhostButton>
          <PrimaryButton onClick={confirm}>{editing ? "표 고치기" : "표 넣기"}</PrimaryButton>
        </ModalFooter>
      </div>
    </Modal>
  );
}
