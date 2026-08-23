/**
 * `.bs.md` 의 캔버스 뷰. 왼쪽은 생각 트리, 오른쪽은 고른 노드의 인스펙터다.
 *
 * 문서는 마크다운 텍스트 그대로 `ui.docs[path]` 버퍼에 들어 있다. 노드를 고치면
 * 트리를 다시 직렬화해 `editDoc` 에 넘기므로, 900ms 자동 저장 · 미저장 점 ·
 * Ctrl+S · 스냅샷 보존이 텍스트 에디터와 똑같이 따라온다. 저장 경로를 새로 만들지 않는다.
 *
 * 줌 · 팬 · 접힘 · 선택은 문서가 아니라 **보기**라서 `.bs.md` 가 아니라
 * `.context_snapshot.json`(`ui.bsView`)에 남는다.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Input, TextArea } from "../lib/ui";
import { inputFocus, inputStyle, labelStyle } from "../modals/Modal";
import { nowStamp } from "../lib/format";
import { useStore, type BsView } from "../store/useStore";
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
  STATUS_ORDER,
  type BsNode,
  type BsStatus,
  type EvidenceKind,
} from "../lib/bstorm";

/** 상태 다섯 가지의 표시. 설계(`design/Brainstorming.dc.html`)의 `ST` 표를 옮긴 것이다. */
const ST: Record<BsStatus, { label: string; dot: string; bg: string; fg: string; bd: string }> = {
  explore: { label: "탐색중", dot: "#8a857c", bg: "#f2efe9", fg: "#6a665e", bd: "#e0dcd4" },
  strong: { label: "유력", dot: "#6a54c6", bg: "#f4f0fd", fg: "#5a44b4", bd: "#e4dcf8" },
  adopted: { label: "채택", dot: "#2f7f57", bg: "#e9f4ee", fg: "#256b47", bd: "#c9e4d5" },
  hold: { label: "보류", dot: "#b07520", bg: "#fbf3e6", fg: "#8f5d17", bd: "#eeddc0" },
  dropped: { label: "폐기", dot: "#b5afa2", bg: "#f6f5f2", fg: "#8a857c", bd: "#e4e0d8" },
};

/** 가지마다 다른 색. 뿌리의 몇 번째 자식에서 갈라졌는지로 정한다. */
const BRANCH = ["#3a6fd8", "#6a54c6", "#2f7f57", "#b07520", "#3f8ea3", "#a3557c"];

const EV_STYLE: Record<EvidenceKind, { bg: string; fg: string; bd: string }> = {
  근거: { bg: "#e9f4ee", fg: "#256b47", bd: "#c9e4d5" },
  리스크: { bg: "#fbf3e6", fg: "#8f5d17", bd: "#eeddc0" },
  질문: { bg: "#eef3fd", fg: "#2f5cbb", bd: "#cddcf8" },
};

const PAD = 28;

const DEFAULT_VIEW: BsView = { zoom: 1, panX: PAD, panY: PAD, sel: "", collapsed: {} };

function branchColor(path: string): string {
  const parts = path.split(".");
  if (parts.length < 2) return "#b5afa2";
  return BRANCH[Number(parts[1]) % BRANCH.length];
}

export default function BrainstormPane({ path }: { path: string }) {
  const s = useStore();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const fittedRef = useRef("");
  /** 삭제는 두 번 눌러야 한다. 1차에서는 되돌리기가 없으므로 한 번의 실수를 막는다. */
  const [armedDelete, setArmedDelete] = useState("");

  const text = s.ui.docs[path]?.text ?? "";
  const doc = useMemo(() => parseBstorm(text), [text]);
  // 이 기능이 생기기 전에 쓰인 스냅샷에는 `bsView` 가 없다.
  const views = s.ui.bsView ?? {};
  const view = views[path] ?? DEFAULT_VIEW;
  const lay = useMemo(() => layout(doc.roots, view.collapsed), [doc.roots, view.collapsed]);
  const placedBy = useMemo(() => new Map(lay.placed.map((p) => [p.path, p])), [lay.placed]);

  const setView = (patch: Partial<BsView>) => {
    s.setUi({ bsView: { ...views, [path]: { ...view, ...patch } } });
  };

  /** 트리를 고쳐 다시 직렬화한다. frontmatter 가 있는 문서만 `updated` 를 갱신한다. */
  const commit = (roots: BsNode[]) => {
    const fmLines = doc.fmLines.length ? setFm(doc.fmLines, "updated", nowStamp()) : doc.fmLines;
    s.editDoc(path, serializeBstorm({ ...doc, fmLines, roots }));
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

  // 파일을 처음 열 때 한 번만 전체 가지에 맞춘다. 이후의 줌·팬은 사용자 것이다.
  useLayoutEffect(() => {
    if (fittedRef.current === path) return;
    const el = boxRef.current;
    if (!el || !lay.placed.length) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    fittedRef.current = path;
    const z = Math.max(
      0.4,
      Math.min(1, (r.width - PAD * 2) / lay.width, (r.height - PAD * 2) / lay.height),
    );
    s.setUi({
      bsView: {
        ...views,
        [path]: {
          ...(views[path] ?? DEFAULT_VIEW),
          zoom: z,
          panX: PAD,
          panY: Math.max(PAD, (r.height - lay.height * z) / 2),
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, lay.width, lay.height]);

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
    if (e.key === "Tab") {
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

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
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
            const st = ST[p.node.status];
            const on = p.path === sel;
            const dropped = p.node.status === "dropped";
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
                  background: "#fff",
                  border: `1px solid ${on ? "#3a6fd8" : st.bd}`,
                  borderLeft: `3px solid ${dropped ? "#d5d0c6" : branchColor(p.path)}`,
                  boxShadow: on
                    ? "0 0 0 2px #dce7fb, 0 4px 14px rgba(35,33,30,.12)"
                    : "0 1px 3px rgba(35,33,30,.08)",
                  opacity: dropped ? 0.62 : 1,
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      flex: "0 0 7px",
                      background: st.dot,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      lineHeight: 1.36,
                      fontWeight: 500,
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
                    {p.node.evidence.map((e, i) => (
                      <span
                        key={`${p.path}e${i}`}
                        style={{
                          fontSize: 9,
                          fontWeight: 600,
                          padding: "1px 4px",
                          borderRadius: 3,
                          color: EV_STYLE[e.kind].fg,
                          background: EV_STYLE[e.kind].bg,
                          border: `1px solid ${EV_STYLE[e.kind].bd}`,
                        }}
                      >
                        {e.kind}
                      </span>
                    ))}
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
          {[
            ["－", () => zoomTo(view.zoom - 0.15)],
            ["＋", () => zoomTo(view.zoom + 0.15)],
          ].map(([label, run]) => (
            <Box
              key={label as string}
              onMouseDown={(e) => {
                e.stopPropagation();
                (run as () => void)();
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
              {label as string}
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
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".4px", color: "#6a665e" }}>
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
              Tab 하위 생각 · Enter 형제 · Delete 삭제
            </div>
          </div>
        )}

        {node && (
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px 16px 12px" }}>
            <div style={labelStyle}>제목</div>
            <Input
              value={node.title}
              onChange={(e) => patchNode({ title: e.target.value })}
              placeholder="한 문장으로"
              style={{ ...inputStyle, width: "100%", marginBottom: 10 }}
              focusStyle={inputFocus}
            />

            <div style={labelStyle}>상태</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "4px 0 10px 0" }}>
              {STATUS_ORDER.map((k) => {
                const on = node.status === k;
                return (
                  <Box
                    key={k}
                    onClick={() => patchNode({ status: k })}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 11,
                      padding: "3px 7px",
                      borderRadius: 3,
                      cursor: "pointer",
                      color: on ? ST[k].fg : "#8a857c",
                      background: on ? ST[k].bg : "#fff",
                      border: `1px solid ${on ? ST[k].bd : "#e6e2da"}`,
                      fontWeight: on ? 600 : 400,
                    }}
                    hover={{ borderColor: ST[k].bd }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: ST[k].dot,
                      }}
                    />
                    {ST[k].label}
                  </Box>
                );
              })}
            </div>

            <div style={labelStyle}>상세</div>
            <TextArea
              value={node.detail}
              onChange={(e) => patchNode({ detail: e.target.value })}
              placeholder="왜 이 생각인지, 무엇을 확인해야 하는지"
              rows={4}
              style={{
                ...inputStyle,
                width: "100%",
                height: "auto",
                padding: "6px 8px",
                lineHeight: 1.6,
                marginBottom: 10,
              }}
              focusStyle={inputFocus}
            />

            {node.status === "dropped" && (
              <>
                <div style={labelStyle}>폐기 이유</div>
                <Input
                  value={node.reason}
                  onChange={(e) => patchNode({ reason: e.target.value })}
                  placeholder="왜 접었는지 남겨 둡니다"
                  style={{ ...inputStyle, width: "100%", marginBottom: 10 }}
                  focusStyle={inputFocus}
                />
              </>
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
                      color: EV_STYLE[e.kind].fg,
                      background: EV_STYLE[e.kind].bg,
                      border: `1px solid ${EV_STYLE[e.kind].bd}`,
                    }}
                  >
                    {e.kind}
                  </span>
                  <Input
                    value={e.text}
                    onChange={(ev) =>
                      patchNode({
                        evidence: node.evidence.map((x, k) =>
                          k === i ? { ...x, text: ev.target.value } : x,
                        ),
                      })
                    }
                    style={{ ...inputStyle, flex: 1, minWidth: 0, height: 24, fontSize: 11.5 }}
                    focusStyle={inputFocus}
                  />
                  <Box
                    onClick={() =>
                      patchNode({ evidence: node.evidence.filter((_, k) => k !== i) })
                    }
                    style={{
                      flex: "0 0 auto",
                      fontSize: 10,
                      color: "#b5afa2",
                      cursor: "pointer",
                      padding: "0 3px",
                    }}
                    hover={{ color: "#a55a4c" }}
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
                  onClick={() =>
                    patchNode({ evidence: [...node.evidence, { kind: k, text: "" }] })
                  }
                  style={{
                    fontSize: 10.5,
                    padding: "3px 7px",
                    borderRadius: 3,
                    cursor: "pointer",
                    color: EV_STYLE[k].fg,
                    background: "#fff",
                    border: `1px dashed ${EV_STYLE[k].bd}`,
                  }}
                  hover={{ background: EV_STYLE[k].bg }}
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
    </div>
  );
}
