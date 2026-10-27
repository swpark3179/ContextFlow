import { useRef } from "react";
import { Box, BusyLabel, useExitSnapshot } from "../lib/ui";
import { BLUE } from "../lib/design";
import { useStore } from "../store/useStore";
import { useSubmit } from "./Modal";

/**
 * Folds a cluster of near-duplicate task notes into one representative node.
 * Sources are archived rather than deleted — the design promises noise
 * reduction, not data loss.
 *
 * 새 업무 추가 위에 뜬다. 바탕은 이미 한 번 어두우니 옅게만 한 겹 더 깔고 천천히 들인다 — 같은 진하기로
 * 한 번에 덮으면 뒤의 대화상자가 갑자기 꺼진 것처럼 보인다. 열고 닫히는 움직임은 `Modal` 과 같다.
 */
export default function MergeModal() {
  const open = useStore((s) => !!s.merge?.rec.cluster);
  return open ? <MergeView /> : null;
}

function MergeView() {
  const s = useStore();
  const root = useRef<HTMLDivElement | null>(null);
  useExitSnapshot(root, "modal");
  const [busy, submit] = useSubmit();
  const merge = s.merge;
  if (!merge?.rec.cluster) return null;
  /** 새 업무 추가 위에 겹쳐 떴다. */
  const over = s.newOpen;
  const close = () => !busy && s.set({ merge: null });

  const nodes = merge.rec.cluster;
  const selected = Object.values(merge.sel).filter(Boolean).length;
  const primary = nodes[merge.primary] ?? nodes[0];

  const preview: { text: string; fg: string; bg: string }[] = [
    { text: "---", fg: "#b5afa2", bg: "transparent" },
    { text: `title: ${primary.title.replace(" (대표)", "")}`, fg: "#3a3630", bg: "transparent" },
    { text: "status: in-progress", fg: "#3a3630", bg: "transparent" },
    { text: `merged_from: ${selected - 1} nodes`, fg: "#1f6b45", bg: "#eaf6ee" },
    { text: "---", fg: "#b5afa2", bg: "transparent" },
    { text: "", fg: "#3a3630", bg: "transparent" },
    { text: "## 실행 이력 (Run Log)", fg: "#3a3630", bg: "transparent" },
    ...nodes
      .filter((_, i) => merge.sel[i])
      .map((c) => ({
        text: `- ${c.date} · ${c.title.replace(" (대표)", "")}`,
        fg: "#1f6b45",
        bg: "#eaf6ee",
      })),
    { text: "", fg: "#3a3630", bg: "transparent" },
    ...nodes
      .filter((_, i) => merge.sel[i] && i !== merge.primary)
      .map((c) => ({
        text: `보관 처리됨: ${c.path}`,
        fg: "#a83c3c",
        bg: "#fceceb",
      })),
  ];

  return (
    <div
      ref={root}
      style={{
        position: "fixed",
        inset: 0,
        background: over ? "rgba(35,33,30,.16)" : "rgba(35,33,30,.34)",
        backdropFilter: over ? undefined : "blur(1.5px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 70,
        animation: over ? "cfFadeIn 200ms linear" : "cfFadeIn 140ms linear",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="유사 노드 병합"
        style={{
          width: 820,
          maxWidth: "94vw",
          height: 520,
          maxHeight: "90vh",
          background: "#fff",
          border: "1px solid #c6c1b6",
          borderRadius: 9,
          boxShadow: "0 30px 70px rgba(35,33,30,.3)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "cfPanelIn 220ms cubic-bezier(.2,.8,.2,1)",
        }}
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
          <span style={{ fontSize: 14, fontWeight: 600 }}>유사 노드 병합</span>
          <span style={{ fontSize: 11.5, color: "#6a665e" }}>
            파편화된 노드를 대표 업무 노드 1개로 통합하고 나머지는 Run Log로 접습니다
          </span>
          <div style={{ flex: 1 }} />
          <Box
            onClick={close}
            role="button"
            aria-label="닫기"
            title="닫기"
            style={{
              width: 24,
              height: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              cursor: "pointer",
              color: "#8a857c",
              fontSize: 13,
            }}
            hover={{ background: "#ece8e0" }}
          >
            ✕
          </Box>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div
            style={{
              flex: "0 0 52%",
              minWidth: 0,
              padding: 12,
              overflow: "auto",
              borderRight: "1px solid #e6e2da",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6a665e", marginBottom: 7 }}>
              통합 대상 노드 ({selected}/{nodes.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {nodes.map((n, i) => {
                const on = !!merge.sel[i];
                const pri = merge.primary === i;
                return (
                  <div
                    key={n.id}
                    style={{
                      // 대표는 고른 것(조작)이라 파랑 — 보라는 AI 가 일하는 동안만 쓴다.
                      border: `1px solid ${pri ? "#cddcf8" : on ? "#e6e2da" : "#efece6"}`,
                      background: pri ? "#f7fafe" : "#fff",
                      transition: "background-color 140ms, border-color 140ms",
                      borderRadius: 6,
                      padding: "8px 9px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div
                        onClick={() => !busy && s.set({ merge: { ...merge, sel: { ...merge.sel, [i]: !on } } })}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 3,
                          flex: "0 0 14px",
                          border: `1px solid ${on ? BLUE : "#cfcabf"}`,
                          background: on ? BLUE : "#fff",
                          color: "#fff",
                          fontSize: 11,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                        }}
                      >
                        {on ? "✓" : ""}
                      </div>
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
                        {n.title}
                      </span>
                      <span
                        style={{
                          fontFamily: "'Roboto Mono',monospace",
                          fontSize: 11.5,
                          color: "#6a665e",
                        }}
                      >
                        {n.date}
                      </span>
                    </div>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}
                    >
                      <Box
                        onClick={() =>
                          !busy &&
                          s.set({
                            merge: { ...merge, primary: i, sel: { ...merge.sel, [i]: true } },
                          })
                        }
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          cursor: "pointer",
                        }}
                      >
                        <div
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: "50%",
                            border: `1px solid ${pri ? BLUE : "#cfcabf"}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <div
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: pri ? BLUE : "transparent",
                            }}
                          />
                        </div>
                        <span
                          style={{
                            fontSize: 11.5,
                            color: pri ? "#2f5cbb" : "#6a665e",
                            fontWeight: pri ? 600 : 400,
                          }}
                        >
                          대표 노드로 지정
                        </span>
                      </Box>
                      <div style={{ flex: 1 }} />
                      <span
                        style={{
                          fontFamily: "'Roboto Mono',monospace",
                          fontSize: 11.5,
                          color: "#6a665e",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "60%",
                        }}
                        title={n.path}
                      >
                        {n.path}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              background: "#fbfaf7",
            }}
          >
            <div
              style={{
                flex: "0 0 30px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                borderBottom: "1px solid #e6e2da",
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "#4e4a43" }}>
                병합 결과 미리보기
              </span>
              <div style={{ flex: 1 }} />
              <span
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11.5,
                  color: "#6a665e",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "70%",
                }}
              >
                {primary.path}
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px" }}>
              {preview.map((l, i) => (
                <div
                  key={i}
                  style={{
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 11.5,
                    lineHeight: 1.75,
                    color: l.fg,
                    background: l.bg,
                    padding: "0 4px",
                    borderRadius: 2,
                    minHeight: 18,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                >
                  {l.text}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          style={{
            flex: "0 0 46px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 14px",
            borderTop: "1px solid #e6e2da",
            background: "#faf9f6",
          }}
        >
          <span style={{ fontSize: 11.5, color: "#6a665e", flex: 1, minWidth: 0 }}>
            {selected > 1
              ? `${selected - 1}개 노드가 대표 노드의 Run Log로 접히고 원본 폴더는 보관 처리됩니다.`
              : "대표 노드 외 1개 이상을 선택하세요."}
          </span>
          <Box
            onClick={close}
            style={{
              height: 29,
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              border: "1px solid #ddd8cf",
              borderRadius: 5,
              background: "#fff",
              fontSize: 12.5,
              cursor: "pointer",
            }}
            hover={{ background: "#f2efe9" }}
          >
            취소
          </Box>
          <Box
            role={busy ? "status" : "button"}
            onClick={() => selected > 1 && void submit(() => s.doMerge())}
            style={{
              height: 29,
              minWidth: 96,
              padding: "0 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 5,
              fontSize: 12.5,
              fontWeight: 600,
              whiteSpace: "nowrap",
              cursor: busy ? "progress" : selected > 1 ? "pointer" : "not-allowed",
              background: busy ? "#2f5cbb" : selected > 1 ? BLUE : "#e6e2da",
              color: busy || selected > 1 ? "#fff" : "#a09a8f",
            }}
            hover={selected > 1 && !busy ? { background: "#2f5cbb" } : undefined}
          >
            <BusyLabel busy={busy} color="#fff" idle="병합 실행">
              병합하는 중
            </BusyLabel>
          </Box>
        </div>
      </div>
    </div>
  );
}
