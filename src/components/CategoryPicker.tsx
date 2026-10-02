import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Input, Span } from "../lib/ui";
import {
  categoryErrorMessage,
  categoryKey,
  knownCategories,
  label,
  normalizeCategory,
  segments,
  snapToExisting,
  tabTarget,
  UNCAT_LABEL,
} from "../lib/category";
import type { CategoryNode } from "../lib/category";
import type { TaskMeta } from "../lib/api";
import { inputFocus, inputStyle } from "../modals/Modal";
import { useStore } from "../store/useStore";

/**
 * 업무의 카테고리 표시. 없으면 고르러 가는 흐린 `＋ 카테고리`, 누를 수 있으면 `▼` 가 붙는다.
 * 기본은 바꾸기 칩이다 — 보관함처럼 눌러도 고르는 목록이 열리지 않는 곳은 `title` 을 주고
 * `caret` 을 끈다.
 */
export function CategoryChip({
  category,
  onClick,
  title,
  caret,
}: {
  category: string | null;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  caret?: boolean;
}) {
  const ghost = !category;
  return (
    <Span
      onClick={onClick}
      title={title ?? (onClick ? "카테고리 바꾸기" : undefined)}
      style={{
        flex: "0 1 auto",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: 10.5,
        color: ghost ? "#a09a8f" : "#6a665e",
        background: ghost ? "transparent" : "#f0ede7",
        border: `1px ${ghost ? "dashed #d9d4ca" : "solid #e4e0d8"}`,
        borderRadius: 3,
        padding: "0 5px",
        lineHeight: "16px",
        cursor: onClick ? "pointer" : "inherit",
      }}
      hover={onClick ? { borderColor: "#d9d4ca", color: "#3a3630" } : undefined}
    >
      {ghost ? "＋ 카테고리" : label(category)}
      {(caret ?? !!onClick) && !ghost && (
        <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.7 }}>▼</span>
      )}
    </Span>
  );
}

type Row =
  | { kind: "node"; node: CategoryNode; indent: number; text: string }
  | { kind: "new"; value: string }
  | { kind: "none" };

const rowValue = (r: Row): string | null =>
  r.kind === "node" ? r.node.path : r.kind === "new" ? r.value : null;

/**
 * 카테고리 입력 + 제안 목록. 목록은 입력칸 **아래에 끼워** 그린다 — 대화상자 패널이
 * `overflow: hidden` 이라 띄워 그린 드롭다운은 잘린다.
 *
 * 입력은 경로 그대로다(`프로젝트/ContextFlow`, `›` 를 붙여 넣어도 된다). 비어 있으면 아는
 * 카테고리 전부, 치면 경로의 부분 문자열로 거르고, `/` 로 끝나면 그 아래만 보여 준다.
 * Enter 는 강조한 줄을, 강조가 없으면 친 값을 고른다(“저장될 값” 이 그것이다).
 *
 * `popover` 는 헤더의 팝오버 — 목록이 늘 펼쳐져 있고 고르면 곧바로 적용된다. 아니면
 * 대화상자의 입력칸으로, 값은 부모가 들고 목록은 포커스가 있을 때만 펼친다.
 *
 * `exclude` 는 카테고리를 바꾸는 업무를 고른다. 아는 철자로 맞출 때 그 업무들의 값은 세지 않는다
 * — 세면 `proj` 를 `Proj` 로 고치려 해도 자기 철자로 되돌아온다(`setCategory` 와 같은 규칙).
 * `allowNone` 을 끄면 미분류를 고를 수 없다 — 경로 바꾸기는 빈 값을 받지 않는다. `hideNode` 는
 * 목록에서 뺄 카테고리다 — 경로 바꾸기는 자기 자신 · 자기 하위로 옮길 수 없다.
 */
export default function CategoryPicker({
  value,
  onChange,
  onCommit,
  onCancel,
  popover = false,
  autoFocus,
  exclude,
  allowNone = true,
  hideNode,
}: {
  value: string;
  onChange: (text: string) => void;
  /** 고른 값 — 정규화하고 아는 철자로 맞춘 경로. `null` = 미분류. */
  onCommit: (category: string | null) => void;
  onCancel?: () => void;
  popover?: boolean;
  autoFocus?: boolean;
  exclude?: (t: TaskMeta) => boolean;
  allowNone?: boolean;
  hideNode?: (n: CategoryNode) => boolean;
}) {
  const tasks = useStore((s) => s.tasks);
  const nodes = useMemo(() => knownCategories(tasks), [tasks]);
  /** 맞출 철자 — 바꾸는 업무 자신의 값은 뺀다. */
  const others = useMemo(
    () => (exclude ? knownCategories(tasks.filter((t) => !exclude(t))) : nodes),
    [tasks, exclude, nodes],
  );
  /** 처음 값 그대로면 거르지 않는다 — 지금 값이 들어 있어도 전체 목록에서 고르게. */
  const initial = useRef(value);
  const [focused, setFocused] = useState(false);
  /** 입력칸에서 Esc · 고르기로 접은 목록. 다시 치면 펼친다. */
  const [folded, setFolded] = useState(false);
  const [hi, setHi] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);

  const norm = normalizeCategory(value);
  const typed = norm.value && snapToExisting(norm.value, others);
  const error = norm.error ? categoryErrorMessage(norm.error) : null;
  const open = popover || (focused && !folded);

  const rows = useMemo<Row[]>(() => {
    const q = value === initial.current ? "" : value.trim();
    let list: CategoryNode[];
    let tree = false;
    if (!q) {
      list = nodes;
      tree = true;
    } else if (/[/\\›]$/.test(q)) {
      const parent = normalizeCategory(q).value;
      const depth = segments(parent).length + 1;
      const prefix = parent ? `${categoryKey(parent)}/` : "";
      list = nodes.filter((n) => n.depth === depth && n.key.startsWith(prefix));
    } else {
      const needle = (normalizeCategory(q).value ?? q).toLowerCase();
      list = nodes.filter((n) => n.key.includes(needle));
    }
    if (hideNode) list = list.filter((n) => !hideNode(n));
    const out: Row[] = list.map((node) => ({
      kind: "node",
      node,
      indent: tree ? node.depth - 1 : 0,
      text: tree || /[/\\›]$/.test(q) ? node.name : label(node.path),
    }));
    // 다른 업무가 쓰지 않는 카테고리면 새로 만드는 것이다 — 지금 값을 그대로 친 것은 빼고.
    const fresh = typed && !others.some((n) => n.key === categoryKey(typed));
    if (q && fresh && !nodes.some((n) => n.path === typed)) out.unshift({ kind: "new", value: typed });
    if (allowNone) out.push({ kind: "none" });
    return out;
  }, [value, nodes, others, typed, allowNone, hideNode]);

  useEffect(() => {
    if (hi >= 0) listRef.current?.querySelector(`[data-row="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const picked = hi >= 0 && hi < rows.length ? rowValue(rows[hi]) : typed;

  const commit = (v: string | null) => {
    onCommit(v);
    setHi(-1);
    setFolded(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setFolded(false);
      const down = e.key === "ArrowDown";
      setHi((h) => (down ? Math.min(rows.length - 1, h + 1) : Math.max(-1, h - 1)));
    } else if (e.key === "Enter") {
      // 한글 조합을 닫는 Enter 는 위에서 걸렀다. 대화상자의 Enter(만들기 · 분할)로 번지지 않게 막는다.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (hi >= 0 && open) commit(picked);
      else if (!error && (typed !== null || allowNone)) commit(typed);
    } else if (e.key === "Tab") {
      // 강조한 줄로 채우고 한 단계 내려간다. 그 밖의 Tab(Shift+Tab · 강조 없음 · 내려갈 곳
      // 없음)은 대화상자에서는 막지 않는다 — 포커스가 다음 칸으로 옮겨 간다.
      const next =
        !e.shiftKey && open && hi >= 0 && hi < rows.length ? tabTarget(rowValue(rows[hi]), value) : null;
      if (next !== null) {
        e.preventDefault();
        onChange(next);
        setHi(-1);
      } else if (popover) {
        // 상자에는 입력 칸 하나뿐이다. 포커스가 뒤 화면으로 빠지면 상자는 열린 채 Esc 도 닿지 않는다.
        e.preventDefault();
      }
    } else if (e.key === "Escape") {
      // 막아 두면 App 의 전역 Esc 체인이 대화상자까지 닫지 않는다(`defaultPrevented`).
      if (popover) {
        e.preventDefault();
        onCancel?.();
      } else if (open) {
        e.preventDefault();
        setFolded(true);
      }
    }
  };

  const rowStyle = (i: number): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 12,
    cursor: "pointer",
    background: i === hi ? "#eef3fd" : "transparent",
  });

  return (
    <div>
      <Input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setHi(-1);
          setFolded(false);
        }}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          setFocused(true);
          if (popover) e.currentTarget.select();
        }}
        onBlur={() => setFocused(false)}
        placeholder="예: 프로젝트/ContextFlow"
        style={inputStyle}
        focusStyle={inputFocus}
      />
      {error && (
        <div style={{ fontSize: 11, color: "#a83c3c", marginTop: 4, lineHeight: 1.5 }}>{error}</div>
      )}
      {open && (
        <>
          {(!error || hi >= 0) && (picked !== null || allowNone) && (
            <div style={{ fontSize: 11, color: "#8a857c", marginTop: 4 }}>
              저장될 값: <span style={{ color: "#4e4a43" }}>{label(picked)}</span>
            </div>
          )}
          <div
            ref={listRef}
            // 입력칸이 포커스를 잃지 않게 한다 — 잃으면 입력칸 모드의 목록이 먼저 접힌다. 줄 사이
            // 여백 · 스크롤 막대를 눌러도 같다.
            onMouseDown={(e) => e.preventDefault()}
            style={{
              marginTop: 5,
              maxHeight: popover ? 220 : 148,
              overflowY: "auto",
              border: "1px solid #eae6de",
              borderRadius: 5,
              padding: 3,
              background: "#fff",
            }}
          >
            {rows.map((r, i) => (
              <Box
                key={r.kind === "node" ? r.node.key : r.kind}
                data-row={i}
                onClick={() => commit(rowValue(r))}
                style={{
                  ...rowStyle(i),
                  ...(r.kind === "none" && { borderTop: "1px solid #f0ede7", marginTop: 2 }),
                }}
                hover={i === hi ? undefined : { background: "#f2efe9" }}
              >
                {r.kind === "node" && (
                  <>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        paddingLeft: r.indent * 12,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "#3a3630",
                        fontWeight: typed && r.node.key === categoryKey(typed) ? 600 : 400,
                      }}
                    >
                      {r.text}
                    </span>
                    <span style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 10.5, color: "#a09a8f" }}>
                      {r.node.count}
                    </span>
                  </>
                )}
                {r.kind === "new" && (
                  <span style={{ color: "#2f5cbb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    ＋ ‘{label(r.value)}’ 새로 만들기
                  </span>
                )}
                {r.kind === "none" && (
                  <span style={{ color: "#8a857c" }}>{UNCAT_LABEL} (카테고리 없음)</span>
                )}
              </Box>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
