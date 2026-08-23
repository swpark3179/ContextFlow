/**
 * `.bs.md` 의 브레인스토밍 화면. 캔버스 · 개요 · 결정 로그 세 가지 보기가 같은 문서를 본다.
 *
 * 문서는 마크다운 텍스트 그대로 `ui.docs[path]` 버퍼에 들어 있다. 노드를 고치면 트리를
 * 다시 직렬화해 `editDoc` 에 넘기므로, 900ms 자동 저장 · 미저장 점 · Ctrl+S · 스냅샷
 * 보존이 텍스트 에디터와 똑같이 따라온다. 저장 경로를 새로 만들지 않는다.
 *
 * 줌 · 팬 · 접힘 · 선택 · 지금 보는 화면은 문서가 아니라 **보기**라서 `.bs.md` 가 아니라
 * `.context_snapshot.json`(`ui.bsView`)에 남는다.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Box } from "../lib/ui";
import { inputFocus, inputStyle, labelStyle } from "../modals/Modal";
import { BS_BRANCH, BS_EVIDENCE, BS_STATUS, isImagePath } from "../lib/design";
import { joinPath, nowStamp } from "../lib/format";
import { useStore, type BsView, type BsViewKind } from "../store/useStore";
import { DecisionLog, Outline } from "./BrainstormViews";
import { DraftInput, DraftTextArea, StatusBadge } from "./BrainstormBits";
import {
  addChildAt,
  bstormName,
  EVIDENCE_KINDS,
  layout,
  mapAt,
  nodeAt,
  parentPath,
  parseBstorm,
  removeAt,
  serializeBstorm,
  setFm,
  STATUS_MARK,
  STATUS_ORDER,
  type BsNode,
  type EvidenceKind,
} from "../lib/bstorm";

const PAD = 28;

const DEFAULT_VIEW: BsView = {
  view: "canvas",
  zoom: 1,
  panX: PAD,
  panY: PAD,
  sel: "",
  collapsed: {},
};

/** 되돌리기 스택의 깊이. 설계와 같은 값이다. */
const UNDO_MAX = 40;

/** 빈 근거 칸이 스스로 무엇을 적는 자리인지 말한다. */
const EVIDENCE_HINT: Record<EvidenceKind, string> = {
  근거: "무엇이 이 생각을 뒷받침하나",
  리스크: "무엇이 어긋날 수 있나",
  질문: "무엇을 더 알아야 하나",
};

function branchColor(path: string): string {
  const parts = path.split(".");
  if (parts.length < 2) return "#b5afa2";
  return BS_BRANCH[Number(parts[1]) % BS_BRANCH.length];
}

/**
 * 보기 상태를 읽고 쓴다. 이 기능이 생기기 전에 쓰인 스냅샷에는 없는 필드가 있으므로
 * 언제나 기본값 위에 덮어쓴다 — 저장된 값 하나가 빠졌다고 화면이 깨지면 안 된다.
 */
function useBsView(path: string) {
  const s = useStore();
  const views = s.ui.bsView ?? {};
  const view: BsView = { ...DEFAULT_VIEW, ...(views[path] ?? {}) };
  const setView = (patch: Partial<BsView>) =>
    s.setUi({ bsView: { ...views, [path]: { ...view, ...patch } } });
  return { s, view, setView };
}

/** 머리띠 안에 들어가는 보기 전환. HTML 뷰어의 [스크립트 끄기] 스위치와 같은 자리다. */
export function BrainstormViewTabs({ path }: { path: string }) {
  const { view, setView } = useBsView(path);
  const tabs: [BsViewKind, string][] = [
    ["canvas", "캔버스"],
    ["outline", "개요"],
    ["decision", "결정 로그"],
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", borderRadius: 4, overflow: "hidden", border: "1px solid #e0dcd4" }}>
      {tabs.map(([k, label]) => {
        const on = view.view === k;
        return (
          <Box
            key={k}
            onClick={() => setView({ view: k })}
            style={{
              fontSize: 10.5,
              padding: "2px 8px",
              cursor: "pointer",
              color: on ? "#2f5cbb" : "#8a857c",
              background: on ? "#eef3fd" : "#fff",
              fontWeight: on ? 600 : 400,
            }}
            hover={{ background: on ? "#eef3fd" : "#f2efe9" }}
          >
            {label}
          </Box>
        );
      })}
    </div>
  );
}

export default function BrainstormPane({ path }: { path: string }) {
  const { s, view, setView } = useBsView(path);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const fittedRef = useRef("");
  /** 삭제는 두 번 눌러야 한다. 되돌리기가 있어도 한 번의 실수는 막는 편이 낫다. */
  const [armedDelete, setArmedDelete] = useState("");
  const [picking, setPicking] = useState(false);
  /** 방금 만든 근거 칸("<노드경로>|<번째>"). 만들자마자 커서가 거기 들어가야 한다. */
  const [freshEv, setFreshEv] = useState("");
  const [undo, setUndo] = useState<string[]>([]);

  const text = s.ui.docs[path]?.text ?? "";
  const doc = useMemo(() => parseBstorm(text), [text]);
  const lay = useMemo(() => layout(doc.roots, view.collapsed), [doc.roots, view.collapsed]);
  const placedBy = useMemo(() => new Map(lay.placed.map((p) => [p.path, p])), [lay.placed]);

  // 되돌리기 스택은 파일마다 따로다. 다른 문서의 상태로 되돌아가면 안 된다.
  useEffect(() => {
    setUndo([]);
    setArmedDelete("");
    setPicking(false);
  }, [path]);

  /** 트리를 고쳐 다시 직렬화한다. frontmatter 가 있는 문서만 `updated` 를 갱신한다. */
  const commit = (roots: BsNode[]) => {
    const fmLines = doc.fmLines.length ? setFm(doc.fmLines, "updated", nowStamp()) : doc.fmLines;
    setUndo((u) => [...u, text].slice(-UNDO_MAX));
    s.editDoc(path, serializeBstorm({ ...doc, fmLines, roots }));
  };

  const undoOnce = () => {
    if (!undo.length) return;
    const prev = undo[undo.length - 1];
    setUndo((u) => u.slice(0, -1));
    s.editDoc(path, prev);
  };

  const sel = view.sel;
  const node = nodeAt(doc.roots, sel);
  const patchNode = (p: Partial<BsNode>) => {
    if (!node) return;
    commit(mapAt(doc.roots, sel, (n) => ({ ...n, ...p })));
  };

  const addChild = (at: string) => {
    const next = addChildAt(doc.roots, at);
    commit(next.roots);
    setView({ sel: next.path, collapsed: { ...view.collapsed, [at]: false } });
  };

  const dropNode = (at: string) => {
    commit(removeAt(doc.roots, at));
    setView({ sel: parentPath(at) });
    setArmedDelete("");
  };

  /** 업무 폴더 안의 그림 파일. 탐색기로 끌어다 놓은 것이 여기 나타난다. */
  const images = useMemo(
    () => s.files.filter((f) => !f.dir && isImagePath(f.p)).map((f) => f.p),
    [s.files],
  );
  const srcOf = (rel: string) => convertFileSrc(joinPath(s.activeFolder, rel));

  const onCanvas = view.view === "canvas";

  // 파일을 처음 열 때 한 번만 전체 가지에 맞춘다. 이후의 줌·팬은 사용자 것이다.
  useLayoutEffect(() => {
    if (!onCanvas || fittedRef.current === path) return;
    const el = boxRef.current;
    if (!el || !lay.placed.length) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    fittedRef.current = path;
    const z = Math.max(
      0.4,
      Math.min(1, (r.width - PAD * 2) / lay.width, (r.height - PAD * 2) / lay.height),
    );
    setView({ zoom: z, panX: PAD, panY: Math.max(PAD, (r.height - lay.height * z) / 2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, onCanvas, lay.width, lay.height]);

  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    panRef.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
    const move = (ev: MouseEvent) => {
      const d = panRef.current;
      if (!d) return;
      setView({ panX: d.panX + (ev.clientX - d.x), panY: d.panY + (ev.clientY - d.y) });
    };
    const up = (ev: MouseEvent) => {
      const d = panRef.current;
      panRef.current = null;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      // 끌지 않고 빈 곳을 눌렀으면 선택을 푼다.
      if (d && Math.abs(ev.clientX - d.x) < 3 && Math.abs(ev.clientY - d.y) < 3) setView({ sel: "" });
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const zoomTo = (z: number) => setView({ zoom: Math.max(0.4, Math.min(1.6, z)) });

  const fit = () => {
    const el = boxRef.current;
    if (!el || !lay.placed.length) return;
    const r = el.getBoundingClientRect();
    const z = Math.max(
      0.4,
      Math.min(1, (r.width - PAD * 2) / lay.width, (r.height - PAD * 2) / lay.height),
    );
    setView({ zoom: z, panX: PAD, panY: Math.max(PAD, (r.height - lay.height * z) / 2) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undoOnce();
    } else if (e.key === "Tab") {
      e.preventDefault();
      addChild(sel);
    } else if (e.key === "Enter" && sel) {
      e.preventDefault();
      addChild(parentPath(sel));
    } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
      e.preventDefault();
      dropNode(sel);
    }
  };

  const jump = (to: string) => setView({ view: "canvas", sel: to });

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      {view.view === "outline" && (
        <Outline
          roots={doc.roots}
          sel={sel}
          onSelect={(p) => setView({ sel: p })}
          onAddChild={addChild}
        />
      )}

      {view.view === "decision" && <DecisionLog roots={doc.roots} onJump={jump} />}

      {onCanvas && (
        <div
          ref={boxRef}
          tabIndex={0}
          onMouseDown={startPan}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            minWidth: 0,
            position: "relative",
            overflow: "hidden",
            outline: "none",
            cursor: "default",
            background: "#fbfaf7",
            backgroundImage: "radial-gradient(#e2ded6 1px,transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        >
          {!lay.placed.length && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13, color: "#8a857c" }}>아직 생각이 없습니다.</div>
              <Box
                onClick={() => addChild("")}
                style={{
                  fontSize: 12,
                  color: "#2f5cbb",
                  border: "1px solid #cddcf8",
                  background: "#fff",
                  borderRadius: 5,
                  padding: "5px 10px",
                  cursor: "pointer",
                }}
                hover={{ background: "#eef3fd" }}
              >
                ＋ 중심 생각 만들기
              </Box>
            </div>
          )}

          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              transformOrigin: "0 0",
              transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`,
            }}
          >
            <svg
              width={Math.max(1, lay.width)}
              height={Math.max(1, lay.height)}
              style={{ position: "absolute", top: 0, left: 0, overflow: "visible" }}
            >
              {lay.placed
                .filter((p) => p.parent)
                .map((p) => {
                  const from = placedBy.get(p.parent);
                  if (!from) return null;
                  const x1 = from.x + from.w;
                  const y1 = from.y + from.h / 2;
                  const x2 = p.x;
                  const y2 = p.y + p.h / 2;
                  const dropped = p.node.status === "dropped";
                  const adopted = p.node.status === "adopted" && from.node.status === "adopted";
                  return (
                    <path
                      key={p.path}
                      d={`M ${x1},${y1} C ${x1 + 46},${y1} ${x2 - 46},${y2} ${x2},${y2}`}
                      fill="none"
                      stroke={dropped ? "#d5d0c6" : adopted ? "#2f7f57" : branchColor(p.path)}
                      strokeWidth={adopted ? 2.2 : 1.3}
                      strokeDasharray={dropped ? "4 4" : undefined}
                      opacity={dropped ? 0.7 : 1}
                    />
                  );
                })}
            </svg>

            {lay.placed.map((p) => {
              const st = BS_STATUS[p.node.status];
              const on = p.path === sel;
              const dropped = p.node.status === "dropped";
              /**
               * 정해진 것과 아직인 것. 탐색중은 흰 카드에 실선 한 겹으로 조용히 두고,
               * 나머지 넷은 배지 · 바탕 · 테두리 세 가지를 한꺼번에 바꾼다 — 색 하나만
               * 다르게 하면 축소한 캔버스에서 채택과 유력이 갈리지 않는다.
               */
              const decided = p.node.status !== "explore";
              const kids = p.node.children.length;
              const folded = !!view.collapsed[p.path];
              return (
                <div
                  key={p.path}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setView({ sel: p.path });
                    setArmedDelete("");
                  }}
                  style={{
                    position: "absolute",
                    left: p.x,
                    top: p.y,
                    width: p.w,
                    minHeight: p.h,
                    boxSizing: "border-box",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    padding: "7px 9px",
                    borderRadius: 7,
                    background: st.card,
                    border: `${decided ? 1.5 : 1}px ${st.dash ? "dashed" : "solid"} ${
                      on ? "#3a6fd8" : st.line
                    }`,
                    // 왼쪽 굵은 띠는 탐색중일 때만 가지 색이다. 상태가 정해지면 그 자리를
                    // 상태에 내준다 — 어느 가지에서 나왔는지는 잇는 선이 이미 말해 준다.
                    borderLeft: `4px solid ${decided ? st.dot : branchColor(p.path)}`,
                    boxShadow: on
                      ? "0 0 0 2px #dce7fb, 0 4px 14px rgba(35,33,30,.12)"
                      : "0 1px 3px rgba(35,33,30,.08)",
                    opacity: dropped ? 0.72 : 1,
                    cursor: "pointer",
                  }}
                >
                  {decided && (
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <StatusBadge status={p.node.status} />
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {!decided && (
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          flex: "0 0 7px",
                          background: st.dot,
                        }}
                      />
                    )}
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12.5,
                        lineHeight: 1.36,
                        fontWeight: p.node.status === "adopted" ? 700 : 500,
                        color: dropped ? "#8a857c" : "#23211e",
                        textDecoration: dropped ? "line-through" : "none",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {p.node.title || <span style={{ color: "#b5afa2" }}>이름 없는 생각</span>}
                    </span>
                    <Box
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        addChild(p.path);
                      }}
                      style={{
                        flex: "0 0 auto",
                        fontSize: 12,
                        lineHeight: "16px",
                        width: 16,
                        textAlign: "center",
                        borderRadius: 3,
                        color: "#8a857c",
                        cursor: "pointer",
                      }}
                      hover={{ background: "#eef3fd", color: "#2f5cbb" }}
                    >
                      ＋
                    </Box>
                  </div>

                  {!!p.node.images.length && (
                    <div style={{ display: "flex", gap: 4, overflow: "hidden" }}>
                      {p.node.images.slice(0, 3).map((rel) => (
                        <img
                          key={rel}
                          src={srcOf(rel)}
                          alt=""
                          style={{
                            width: 52,
                            height: 34,
                            objectFit: "cover",
                            borderRadius: 4,
                            border: "1px solid #e6e2da",
                            background:
                              "repeating-linear-gradient(45deg,#f3f0ea 0 5px,#eae6de 5px 10px)",
                          }}
                        />
                      ))}
                      {p.node.images.length > 3 && (
                        <span
                          style={{
                            alignSelf: "center",
                            fontFamily: "'Roboto Mono',monospace",
                            fontSize: 9.5,
                            color: "#a09a8f",
                          }}
                        >
                          +{p.node.images.length - 3}
                        </span>
                      )}
                    </div>
                  )}

                  {!!p.node.detail.trim() && (
                    <div
                      style={{
                        fontSize: 11,
                        lineHeight: 1.5,
                        color: "#8a857c",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.node.detail.replace(/\n/g, " ")}
                    </div>
                  )}

                  {(p.node.evidence.length > 0 || !!p.node.reason.trim()) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {p.node.evidence.map((e, i) => {
                        // 아직 비어 있는 칸은 점선으로 둔다. 채운 것과 같아 보이면
                        // 카드가 "근거가 있다"고 거짓말을 한다.
                        const empty = !e.text.trim();
                        return (
                          <span
                            key={`${p.path}e${i}`}
                            style={{
                              fontSize: 9,
                              fontWeight: 600,
                              padding: "1px 4px",
                              borderRadius: 3,
                              color: BS_EVIDENCE[e.kind].fg,
                              background: empty ? "transparent" : BS_EVIDENCE[e.kind].bg,
                              border: `1px ${empty ? "dashed" : "solid"} ${BS_EVIDENCE[e.kind].bd}`,
                              opacity: empty ? 0.75 : 1,
                            }}
                          >
                            {e.kind}
                          </span>
                        );
                      })}
                      {!!p.node.reason.trim() && (
                        <span style={{ fontSize: 9.5, color: "#a09a8f" }}>폐기 이유 있음</span>
                      )}
                    </div>
                  )}

                  {kids > 0 && (
                    <Box
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setView({ collapsed: { ...view.collapsed, [p.path]: !folded } });
                      }}
                      style={{
                        position: "absolute",
                        right: -11,
                        top: "50%",
                        marginTop: -8,
                        height: 16,
                        minWidth: 16,
                        padding: "0 4px",
                        borderRadius: 8,
                        border: "1px solid #ddd8cf",
                        background: "#fff",
                        fontFamily: "'Roboto Mono',monospace",
                        fontSize: 9,
                        lineHeight: "14px",
                        textAlign: "center",
                        color: "#8a857c",
                        cursor: "pointer",
                      }}
                      hover={{ borderColor: "#3a6fd8", color: "#2f5cbb" }}
                    >
                      {folded ? `▸${kids}` : "▾"}
                    </Box>
                  )}
                </div>
              );
            })}
          </div>

          <div
            style={{
              position: "absolute",
              right: 10,
              bottom: 10,
              display: "flex",
              alignItems: "center",
              gap: 2,
              padding: 3,
              borderRadius: 12,
              background: "#fff",
              border: "1px solid #e0dcd4",
              boxShadow: "0 2px 8px rgba(35,33,30,.10)",
            }}
          >
            <Box
              onMouseDown={(e) => {
                e.stopPropagation();
                undoOnce();
              }}
              style={{
                fontSize: 10.5,
                padding: "0 7px",
                height: 18,
                lineHeight: "18px",
                borderRadius: 9,
                color: undo.length ? "#4e4a43" : "#cfcabf",
                cursor: undo.length ? "pointer" : "default",
              }}
              hover={undo.length ? { background: "#f2efe9" } : {}}
              title="되돌리기 (Ctrl+Z)"
            >
              ↶ 되돌리기
            </Box>
            <span style={{ width: 1, height: 12, background: "#e6e2da" }} />
            {([["－", () => zoomTo(view.zoom - 0.15)], ["＋", () => zoomTo(view.zoom + 0.15)]] as [
              string,
              () => void,
            ][]).map(([label, run]) => (
              <Box
                key={label}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  run();
                }}
                style={{
                  width: 20,
                  height: 18,
                  borderRadius: 9,
                  fontSize: 11,
                  lineHeight: "18px",
                  textAlign: "center",
                  color: "#6a665e",
                  cursor: "pointer",
                }}
                hover={{ background: "#f2efe9" }}
              >
                {label}
              </Box>
            ))}
            <span
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 10,
                color: "#8a857c",
                padding: "0 4px",
              }}
            >
              {Math.round(view.zoom * 100)}%
            </span>
            <Box
              onMouseDown={(e) => {
                e.stopPropagation();
                fit();
              }}
              style={{
                fontSize: 10.5,
                padding: "0 7px",
                height: 18,
                lineHeight: "18px",
                borderRadius: 9,
                color: "#2f5cbb",
                cursor: "pointer",
              }}
              hover={{ background: "#eef3fd" }}
            >
              맞춤
            </Box>
          </div>
        </div>
      )}

      {view.view !== "decision" && (
        <div
          style={{
            flex: "0 0 300px",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            background: "#fff",
            borderLeft: "1px solid #e6e2da",
          }}
        >
          <div
            style={{
              flex: "0 0 26px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              background: "#f7f5f1",
              borderBottom: "1px solid #e6e2da",
            }}
          >
            <span
              style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".4px", color: "#6a665e" }}
            >
              생각
            </span>
            <div style={{ flex: 1 }} />
            <span
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 10,
                color: "#a09a8f",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {bstormName(path)}
            </span>
          </div>

          {!node && (
            <div style={{ padding: "16px 12px", fontSize: 11.5, lineHeight: 1.7, color: "#a09a8f" }}>
              노드를 고르면 여기서 자세히 적을 수 있습니다.
              <div style={{ marginTop: 8, color: "#b5afa2" }}>
                Tab 하위 생각 · Enter 형제 · Delete 삭제 · Ctrl+Z 되돌리기
              </div>
            </div>
          )}

          {node && (
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px 16px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <div style={{ ...labelStyle, marginBottom: 0 }}>제목</div>
                <div style={{ flex: 1 }} />
                <StatusBadge status={node.status} big />
              </div>
              <DraftInput
                key={`${path}|${sel}|title`}
                value={node.title}
                onCommit={(v) => patchNode({ title: v })}
                placeholder="한 문장으로"
                style={{ ...inputStyle, width: "100%", marginBottom: 10 }}
                focusStyle={inputFocus}
              />

              <div style={labelStyle}>상태</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "4px 0 10px 0" }}>
                {STATUS_ORDER.map((k) => {
                  const on = node.status === k;
                  const stk = BS_STATUS[k];
                  return (
                    <Box
                      key={k}
                      onClick={() => patchNode({ status: k })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 11,
                        padding: "3px 8px",
                        borderRadius: 3,
                        cursor: "pointer",
                        color: on ? stk.fg : "#8a857c",
                        background: on ? stk.bg : "#fff",
                        // 고른 것은 테두리를 두 겹으로 두른다. 옅은 배경색만으로는
                        // 지금 이 생각이 채택인지 유력인지 한눈에 들어오지 않았다.
                        border: `1px ${stk.dash ? "dashed" : "solid"} ${on ? stk.line : "#e6e2da"}`,
                        boxShadow: on ? `inset 0 0 0 1px ${stk.bd}` : "none",
                        fontWeight: on ? 700 : 400,
                      }}
                      hover={{ borderColor: stk.line }}
                    >
                      {STATUS_MARK[k] ? (
                        <span style={{ fontSize: 9 }}>{STATUS_MARK[k]}</span>
                      ) : (
                        <span
                          style={{ width: 6, height: 6, borderRadius: "50%", background: stk.dot }}
                        />
                      )}
                      {stk.label}
                    </Box>
                  );
                })}
              </div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <div style={labelStyle}>상세</div>
                <span style={{ fontSize: 10, color: "#b5afa2" }}>Enter 로 줄바꿈</span>
              </div>
              <DraftTextArea
                key={`${path}|${sel}|detail`}
                value={node.detail}
                onCommit={(v) => patchNode({ detail: v })}
                placeholder={"왜 이 생각인지, 무엇을 확인해야 하는지\n여러 줄로 적어도 됩니다"}
                rows={4}
                style={{
                  ...inputStyle,
                  width: "100%",
                  height: "auto",
                  minHeight: 66,
                  padding: "6px 8px",
                  lineHeight: 1.6,
                  marginBottom: 10,
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
                focusStyle={inputFocus}
              />

              {node.status === "dropped" && (
                <>
                  <div style={labelStyle}>폐기 이유</div>
                  <DraftInput
                    key={`${path}|${sel}|reason`}
                    value={node.reason}
                    onCommit={(v) => patchNode({ reason: v })}
                    placeholder="왜 접었는지 남겨 둡니다"
                    style={{ ...inputStyle, width: "100%", marginBottom: 10 }}
                    focusStyle={inputFocus}
                  />
                </>
              )}

              <div style={labelStyle}>그림 · 다이어그램</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "4px 0 6px 0" }}>
                {node.images.map((rel) => (
                  <div key={rel} style={{ position: "relative" }}>
                    <img
                      src={srcOf(rel)}
                      alt={rel}
                      title={rel}
                      style={{
                        width: 78,
                        height: 52,
                        objectFit: "cover",
                        borderRadius: 5,
                        border: "1px solid #e6e2da",
                        background:
                          "repeating-linear-gradient(45deg,#f3f0ea 0 5px,#eae6de 5px 10px)",
                      }}
                    />
                    <Box
                      onClick={() => patchNode({ images: node.images.filter((x) => x !== rel) })}
                      style={{
                        position: "absolute",
                        top: -5,
                        right: -5,
                        width: 15,
                        height: 15,
                        borderRadius: "50%",
                        background: "#fff",
                        border: "1px solid #e0dcd4",
                        fontSize: 9,
                        lineHeight: "13px",
                        textAlign: "center",
                        color: "#8a857c",
                        cursor: "pointer",
                      }}
                      hover={{ color: "#a55a4c", borderColor: "#eddad4" }}
                    >
                      ✕
                    </Box>
                  </div>
                ))}
              </div>

              {!picking && (
                <Box
                  onClick={() => setPicking(true)}
                  style={{
                    display: "inline-block",
                    fontSize: 10.5,
                    padding: "3px 7px",
                    borderRadius: 3,
                    marginBottom: 12,
                    cursor: "pointer",
                    color: "#6a665e",
                    background: "#fff",
                    border: "1px dashed #ddd8cf",
                  }}
                  hover={{ borderColor: "#3a6fd8", color: "#2f5cbb" }}
                >
                  ＋ 그림 붙이기
                </Box>
              )}

              {picking && (
                <div
                  style={{
                    border: "1px solid #e0dcd4",
                    borderRadius: 5,
                    background: "#faf9f6",
                    padding: 6,
                    marginBottom: 12,
                  }}
                >
                  {!images.length && (
                    <div style={{ fontSize: 10.5, lineHeight: 1.7, color: "#8a857c" }}>
                      업무 폴더에 그림이 없습니다.
                      <div style={{ color: "#a09a8f" }}>
                        탐색기로 끌어다 놓으면 여기에 나타납니다.
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 152, overflow: "auto" }}>
                    {images.map((rel) => {
                      const already = node.images.includes(rel);
                      return (
                        <Box
                          key={rel}
                          onClick={() => {
                            if (!already) patchNode({ images: [...node.images, rel] });
                            setPicking(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "3px 5px",
                            borderRadius: 4,
                            cursor: already ? "default" : "pointer",
                            opacity: already ? 0.45 : 1,
                          }}
                          hover={already ? {} : { background: "#efece6" }}
                        >
                          <img
                            src={srcOf(rel)}
                            alt=""
                            style={{
                              width: 26,
                              height: 18,
                              objectFit: "cover",
                              borderRadius: 2,
                              border: "1px solid #e6e2da",
                            }}
                          />
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontFamily: "'Roboto Mono',monospace",
                              fontSize: 10,
                              color: "#4e4a43",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {rel}
                          </span>
                          {already && <span style={{ fontSize: 9.5, color: "#a09a8f" }}>붙어 있음</span>}
                        </Box>
                      );
                    })}
                  </div>
                  <Box
                    onClick={() => setPicking(false)}
                    style={{
                      marginTop: 4,
                      fontSize: 10.5,
                      color: "#8a857c",
                      cursor: "pointer",
                      textAlign: "right",
                    }}
                    hover={{ color: "#4e4a43" }}
                  >
                    닫기
                  </Box>
                </div>
              )}

              <div style={labelStyle}>근거 · 리스크 · 질문</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "4px 0 6px 0" }}>
                {node.evidence.map((e, i) => (
                  <div key={`ev${i}`} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span
                      style={{
                        flex: "0 0 auto",
                        fontSize: 9.5,
                        fontWeight: 600,
                        padding: "2px 5px",
                        borderRadius: 3,
                        color: BS_EVIDENCE[e.kind].fg,
                        background: BS_EVIDENCE[e.kind].bg,
                        border: `1px solid ${BS_EVIDENCE[e.kind].bd}`,
                      }}
                    >
                      {e.kind}
                    </span>
                    <DraftInput
                      key={`${path}|${sel}|ev${i}`}
                      value={e.text}
                      onCommit={(v) =>
                        patchNode({
                          evidence: node.evidence.map((x, k) => (k === i ? { ...x, text: v } : x)),
                        })
                      }
                      autoFocus={freshEv === `${sel}|${i}`}
                      placeholder={EVIDENCE_HINT[e.kind]}
                      style={{ ...inputStyle, flex: 1, minWidth: 0, height: 24, fontSize: 11.5 }}
                      focusStyle={inputFocus}
                    />
                    <Box
                      onClick={() => patchNode({ evidence: node.evidence.filter((_, k) => k !== i) })}
                      style={{
                        flex: "0 0 auto",
                        fontSize: 10,
                        color: "#b5afa2",
                        cursor: "pointer",
                        padding: "0 3px",
                      }}
                      hover={{ color: "#a55a4c" }}
                      title="이 줄 지우기"
                    >
                      ✕
                    </Box>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
                {EVIDENCE_KINDS.map((k) => (
                  <Box
                    key={k}
                    onClick={() => {
                      // 빈 줄 하나를 만들고 거기로 커서를 옮긴다. 빈 줄이 문서에도 남기
                      // 때문에(`serializeBstorm`) 화면과 파일이 같은 것을 본다.
                      setFreshEv(`${sel}|${node.evidence.length}`);
                      patchNode({ evidence: [...node.evidence, { kind: k, text: "" }] });
                    }}
                    style={{
                      fontSize: 10.5,
                      padding: "3px 7px",
                      borderRadius: 3,
                      cursor: "pointer",
                      color: BS_EVIDENCE[k].fg,
                      background: "#fff",
                      border: `1px dashed ${BS_EVIDENCE[k].bd}`,
                    }}
                    hover={{ background: BS_EVIDENCE[k].bg }}
                  >
                    ＋ {k}
                  </Box>
                ))}
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingTop: 10,
                  borderTop: "1px solid #f0ede7",
                }}
              >
                <Box
                  onClick={() => addChild(sel)}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 9px",
                    borderRadius: 5,
                    cursor: "pointer",
                    color: "#2f5cbb",
                    background: "#fff",
                    border: "1px solid #cddcf8",
                  }}
                  hover={{ background: "#eef3fd" }}
                >
                  ＋ 하위 생각
                </Box>
                <div style={{ flex: 1 }} />
                <Box
                  onClick={() => (armedDelete === sel ? dropNode(sel) : setArmedDelete(sel))}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 9px",
                    borderRadius: 5,
                    cursor: "pointer",
                    color: "#a83c3c",
                    background: armedDelete === sel ? "#fceceb" : "#fff",
                    border: "1px solid #eddad4",
                  }}
                  hover={{ background: "#fceceb" }}
                >
                  {armedDelete === sel
                    ? node.children.length
                      ? `하위 ${node.children.length}개까지 삭제`
                      : "한 번 더 눌러 삭제"
                    : "삭제"}
                </Box>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
