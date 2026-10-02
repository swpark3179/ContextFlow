import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Input, Span } from "../lib/ui";
import {
  categoryErrorMessage,
  categoryKey,
  knownCategories,
  label,
  MAX_DEPTH,
  normalizeCategory,
  segments,
  snapToExisting,
  UNCAT_LABEL,
} from "../lib/category";
import type { CategoryNode } from "../lib/category";
import { inputFocus, inputStyle } from "../modals/Modal";
import { useStore } from "../store/useStore";

/** 업무의 카테고리 표시. 없으면 고르러 가는 흐린 `＋ 카테고리`, 누를 수 있으면 `▾` 가 붙는다. */
export function CategoryChip({
  category,
  onClick,
}: {
  category: string | null;
  onClick?: () => void;
}) {
  const ghost = !category;
  return (
    <Span
      onClick={onClick}
      title={onClick ? "카테고리 바꾸기" : undefined}
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
      hover={onClick ? { borderColor: "#c5bfb3", color: "#3a3630" } : undefined}
    >
      {ghost ? "＋ 카테고리" : label(category)}
      {onClick && !ghost && <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.7 }}>▼</span>}
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
 */
export default function CategoryPicker({
  value,
  onChange,
  onCommit,
  onCancel,
  popover = false,
  autoFocus,
}: {
  value: string;
  onChange: (text: string) => void;
  /** 고른 값 — 정규화하고 아는 철자로 맞춘 경로. `null` = 미분류. */
  onCommit: (category: string | null) => void;
  onCancel?: () => void;
  popover?: boolean;
  autoFocus?: boolean;
}) {
  const tasks = useStore((s) => s.tasks);
  const nodes = useMemo(() => knownCategories(tasks), [tasks]);
  /** 처음 값 그대로면 거르지 않는다 — 지금 값이 들어 있어도 전체 목록에서 고르게. */
  const initial = useRef(value);
  const [focused, setFocused] = useState(false);
  /** 입력칸에서 Esc · 고르기로 접은 목록. 다시 치면 펼친다. */
  const [folded, setFolded] = useState(false);
  const [hi, setHi] = useState(-1);
  const listRef = useRef<HTMLDivElement | null>(null);

  const norm = normalizeCategory(value);
  const typed = norm.value && snapToExisting(norm.value, nodes);
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
    const out: Row[] = list.map((node) => ({
      kind: "node",
      node,
      indent: tree ? node.depth - 1 : 0,
      text: tree || /[/\\›]$/.test(q) ? node.name : label(node.path),
    }));
    if (q && typed && !nodes.some((n) => n.key === categoryKey(typed))) {
      out.unshift({ kind: "new", value: typed });
    }
    out.push({ kind: "none" });
    return out;
  }, [value, nodes, typed]);

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
      else if (!error) commit(typed);
    } else if (e.key === "Tab" && open) {
      // 강조한 줄(없으면 첫 줄)로 채우고 한 단계 내려간다.
      const row = rows[hi]?.kind === "node" ? rows[hi] : rows.find((r) => r.kind === "node");
      if (row?.kind !== "node") return;
      e.preventDefault();
      onChange(row.node.depth < MAX_DEPTH ? `${row.node.path}/` : row.node.path);
      setHi(-1);
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
          {(!error || hi >= 0) && (
            <div style={{ fontSize: 11, color: "#8a857c", marginTop: 4 }}>
              저장될 값: <span style={{ color: "#4e4a43" }}>{label(picked)}</span>
            </div>
          )}
          <div
            ref={listRef}
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
                // 입력칸이 포커스를 잃지 않게 한다 — 잃으면 입력칸 모드의 목록이 먼저 접힌다.
                onMouseDown={(e) => e.preventDefault()}
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
