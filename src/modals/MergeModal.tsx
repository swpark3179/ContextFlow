import { Box } from "../lib/ui";
import { VIOLET } from "../lib/design";
import { useStore } from "../store/useStore";

/**
 * Folds a cluster of near-duplicate task notes into one representative node.
 * Sources are archived rather than deleted — the design promises noise
 * reduction, not data loss.
 */
export default function MergeModal() {
  const s = useStore();
  const merge = s.merge;
  if (!merge?.rec.cluster) return null;

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
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(35,33,30,.34)",
        backdropFilter: "blur(1.5px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 70,
        animation: "fIn .12s ease-out",
      }}
    >
      <div
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
          animation: "pIn .15s ease-out",
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
          <span style={{ fontSize: 13, fontWeight: 600 }}>유사 노드 병합</span>
          <span style={{ fontSize: 10.5, color: "#8a857c" }}>
            파편화된 노드를 대표 업무 노드 1개로 통합하고 나머지는 Run Log로 접습니다
          </span>
          <div style={{ flex: 1 }} />
          <Box
            onClick={() => s.set({ merge: null })}
            style={{
              width: 24,
              height: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
              cursor: "pointer",
              color: "#8a857c",
              fontSize: 12,
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
            <div style={{ fontSize: 11, fontWeight: 600, color: "#6a665e", marginBottom: 7 }}>
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
                      border: `1px solid ${pri ? "#cfc0f4" : on ? "#e6e2da" : "#efece6"}`,
                      background: pri ? "#faf7ff" : "#fff",
                      borderRadius: 6,
                      padding: "8px 9px",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div
                        onClick={() => s.set({ merge: { ...merge, sel: { ...merge.sel, [i]: !on } } })}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 3,
                          flex: "0 0 14px",
                          border: `1px solid ${on ? VIOLET : "#cfcabf"}`,
                          background: on ? VIOLET : "#fff",
                          color: "#fff",
                          fontSize: 10,
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
                          fontSize: 11.5,
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
                          fontFamily: "'IBM Plex Mono',monospace",
                          fontSize: 9.5,
                          color: "#a09a8f",
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
                            border: `1px solid ${pri ? VIOLET : "#cfcabf"}`,
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
                              background: pri ? VIOLET : "transparent",
                            }}
                          />
                        </div>
                        <span
                          style={{
                            fontSize: 10.5,
                            color: pri ? "#5a44b4" : "#8a857c",
                            fontWeight: pri ? 600 : 400,
                          }}
                        >
                          대표 노드로 지정
                        </span>
                      </Box>
                      <div style={{ flex: 1 }} />
                      <span
                        style={{
                          fontFamily: "'IBM Plex Mono',monospace",
                          fontSize: 9.5,
                          color: "#b5afa2",
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
              <span style={{ fontSize: 10.5, fontWeight: 600, color: "#4e4a43" }}>
                병합 결과 미리보기
              </span>
              <div style={{ flex: 1 }} />
              <span
                style={{
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 9.5,
                  color: "#a09a8f",
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
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 10.5,
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
          <span style={{ fontSize: 10.5, color: "#8a857c", flex: 1, minWidth: 0 }}>
            {selected > 1
              ? `${selected - 1}개 노드가 대표 노드의 Run Log로 접히고 원본 폴더는 보관 처리됩니다.`
              : "대표 노드 외 1개 이상을 선택하세요."}
          </span>
          <Box
            onClick={() => s.set({ merge: null })}
            style={{
              height: 29,
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              border: "1px solid #ddd8cf",
              borderRadius: 5,
              background: "#fff",
              fontSize: 11.5,
              cursor: "pointer",
            }}
            hover={{ background: "#f2efe9" }}
          >
            취소
          </Box>
          <Box
            onClick={() => void s.doMerge()}
            style={{
              height: 29,
              padding: "0 16px",
              display: "flex",
              alignItems: "center",
              borderRadius: 5,
              fontSize: 11.5,
              fontWeight: 600,
              cursor: selected > 1 ? "pointer" : "not-allowed",
              background: selected > 1 ? VIOLET : "#e6e2da",
              color: selected > 1 ? "#fff" : "#a09a8f",
            }}
            hover={selected > 1 ? { background: "#5a44b4" } : undefined}
          >
            병합 실행
          </Box>
        </div>
      </div>
    </div>
  );
}
