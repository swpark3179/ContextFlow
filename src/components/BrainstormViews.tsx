/**
 * 브레인스토밍의 읽는 화면 둘 — 개요와 결정 로그.
 *
 * 캔버스가 "지금 생각을 뻗는 곳"이라면 이 둘은 "쌓인 것을 보는 곳"이다. 그래서 캔버스에서
 * 접어 둔 가지도 여기서는 전부 보인다(`walkNodes`) — 무엇을 접었는지는 캔버스의 사정이지
 * 문서의 사정이 아니다.
 *
 * 마크다운 뷰어(`mdParse`)를 쓰지 않는다. 저 파서는 원본 텍스트를 블록으로 바꾸는데,
 * 여기서 보여 줄 것은 텍스트가 아니라 **상태가 붙은 생각의 트리**다.
 */
import { Box } from "../lib/ui";
import { BS_EVIDENCE, BS_STATUS } from "../lib/design";
import { StatusBadge } from "./BrainstormBits";
import { ancestorTitles, STATUS_MARK, walkNodes, type BsNode, type BsStatus } from "../lib/bstorm";

/** 결정 로그가 묶는 순서. 탐색중은 아직 결정이 아니라서 빠진다. */
const GROUPS: { key: BsStatus; title: string; note: string }[] = [
  { key: "adopted", title: "채택한 결정", note: "이대로 간다" },
  { key: "strong", title: "유력한 후보", note: "아직 고르는 중" },
  { key: "hold", title: "보류", note: "지금은 아니다" },
  { key: "dropped", title: "폐기 · 아이디어 묘지", note: "왜 접었는지 남아 있다" },
];

function EvidenceRow({ node }: { node: BsNode }) {
  // 인스펙터에서 만들어 두고 아직 안 채운 칸은 읽는 화면에 내보내지 않는다.
  const rows = node.evidence.filter((e) => e.text.trim());
  if (!rows.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
      {rows.map((e, i) => (
        <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 5 }}>
          <span
            style={{
              flex: "0 0 auto",
              fontSize: 9,
              fontWeight: 600,
              padding: "1px 4px",
              borderRadius: 3,
              marginTop: 1,
              color: BS_EVIDENCE[e.kind].fg,
              background: BS_EVIDENCE[e.kind].bg,
              border: `1px solid ${BS_EVIDENCE[e.kind].bd}`,
            }}
          >
            {e.kind}
          </span>
          <span style={{ fontSize: 11, lineHeight: 1.55, color: "#6a665e", overflowWrap: "anywhere" }}>
            {e.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 여러 줄 상세를 줄 그대로 보여 준다. 한 줄로 이으면 사용자가 나눈 뜻이 사라진다. */
function DetailBlock({ text, size }: { text: string; size: number }) {
  return (
    <div
      style={{
        fontSize: size,
        lineHeight: 1.65,
        color: "#6a665e",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {text}
    </div>
  );
}

export function Outline({
  roots,
  sel,
  onSelect,
  onAddChild,
}: {
  roots: BsNode[];
  sel: string;
  onSelect: (path: string) => void;
  onAddChild: (path: string) => void;
}) {
  const rows = walkNodes(roots);

  if (!rows.length) {
    return (
      <div style={{ flex: 1, minWidth: 0, display: "grid", placeItems: "center", background: "#fff" }}>
        <span style={{ fontSize: 12, color: "#a09a8f" }}>아직 생각이 없습니다.</span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: "auto", background: "#fff", padding: "10px 14px 20px 14px" }}>
      {rows.map((r) => {
        const on = r.path === sel;
        const st = BS_STATUS[r.node.status];
        const dropped = r.node.status === "dropped";
        const decided = r.node.status !== "explore";
        return (
          <Box
            key={r.path}
            onClick={() => onSelect(r.path)}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              padding: "5px 8px",
              marginLeft: r.depth * 22,
              marginBottom: 2,
              borderRadius: 6,
              cursor: "pointer",
              /**
               * 왼쪽 띠는 상태의 자리다. 고른 줄은 배경과 안쪽 테두리로 말한다 —
               * 예전에는 둘 다 이 띠 하나를 놓고 다퉈서, 고르는 순간 상태가 사라졌다.
               */
              borderLeft: `3px solid ${decided ? st.dot : "transparent"}`,
              background: on ? "#f7fafe" : decided ? st.card : "transparent",
              boxShadow: on ? "inset 0 0 0 1px #cddcf8" : "none",
              opacity: dropped ? 0.8 : 1,
            }}
            hover={{ background: on ? "#f7fafe" : "#f8f7f4" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <StatusBadge status={r.node.status} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  fontWeight: r.node.status === "adopted" ? 700 : r.depth === 0 ? 600 : 400,
                  color: dropped ? "#8a857c" : "#23211e",
                  textDecoration: dropped ? "line-through" : "none",
                  overflowWrap: "anywhere",
                }}
              >
                {r.node.title || <span style={{ color: "#b5afa2" }}>이름 없는 생각</span>}
              </span>
              {!!r.node.images.length && (
                <span
                  style={{
                    flex: "0 0 auto",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 9,
                    color: "#8a857c",
                  }}
                >
                  🖼 {r.node.images.length}
                </span>
              )}
              <Box
                onClick={(e) => {
                  e.stopPropagation();
                  onAddChild(r.path);
                }}
                style={{
                  flex: "0 0 auto",
                  fontSize: 10.5,
                  color: "#a09a8f",
                  padding: "1px 5px",
                  borderRadius: 3,
                  cursor: "pointer",
                }}
                hover={{ background: "#eef3fd", color: "#2f5cbb" }}
              >
                ＋ 하위
              </Box>
            </div>

            {!!r.node.detail.trim() && <DetailBlock text={r.node.detail} size={11.5} />}
            {!!r.node.reason.trim() && (
              <div style={{ fontSize: 11, lineHeight: 1.6, color: "#8f5d17" }}>
                폐기 이유 · {r.node.reason}
              </div>
            )}
            <EvidenceRow node={r.node} />
          </Box>
        );
      })}
    </div>
  );
}

export function DecisionLog({
  roots,
  onJump,
}: {
  roots: BsNode[];
  onJump: (path: string) => void;
}) {
  const all = walkNodes(roots);
  const groups = GROUPS.map((g) => ({ ...g, rows: all.filter((r) => r.node.status === g.key) }));
  const decided = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: "auto", background: "#fdfcfa", padding: "12px 16px 24px 16px" }}>
      {!decided && (
        <div style={{ padding: "28px 0", textAlign: "center", fontSize: 12, color: "#a09a8f", lineHeight: 1.8 }}>
          아직 정해진 것이 없습니다.
          <div style={{ fontSize: 11, color: "#b5afa2" }}>
            생각에 채택 · 유력 · 보류 · 폐기를 달면 여기에 모입니다.
          </div>
        </div>
      )}

      {groups.map((g) => {
        if (!g.rows.length) return null;
        const st = BS_STATUS[g.key];
        return (
          <div key={g.key} style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 7,
                paddingBottom: 5,
                borderBottom: `1px solid ${st.bd}`,
              }}
            >
              <span style={{ fontSize: 11 }}>{STATUS_MARK[g.key]}</span>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "#23211e" }}>{g.title}</span>
              <span
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "0 5px",
                  borderRadius: 8,
                  color: st.fg,
                  background: st.bg,
                  border: `1px solid ${st.bd}`,
                }}
              >
                {g.rows.length}
              </span>
              <span style={{ fontSize: 11, color: "#b5afa2" }}>{g.note}</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {g.rows.map((r) => {
                const trail = ancestorTitles(roots, r.path).filter(Boolean);
                return (
                  <Box
                    key={r.path}
                    onClick={() => onJump(r.path)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                      padding: "8px 10px",
                      borderRadius: 6,
                      cursor: "pointer",
                      background: st.card,
                      border: `1px ${st.dash ? "dashed" : "solid"} ${st.line}`,
                      borderLeft: `4px solid ${st.dot}`,
                    }}
                    hover={{ borderColor: "#3a6fd8" }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <StatusBadge status={g.key} />
                      {!!trail.length && (
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 10,
                            color: "#a09a8f",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {trail.join("  ›  ")}
                        </div>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        fontWeight: g.key === "adopted" ? 700 : 500,
                        color: g.key === "dropped" ? "#8a857c" : "#23211e",
                        textDecoration: g.key === "dropped" ? "line-through" : "none",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {r.node.title || "이름 없는 생각"}
                    </div>
                    {!!r.node.detail.trim() && <DetailBlock text={r.node.detail} size={11.5} />}
                    {!!r.node.reason.trim() && (
                      <div
                        style={{
                          fontSize: 11,
                          lineHeight: 1.6,
                          color: "#8f5d17",
                          background: "#fdf9f1",
                          border: "1px solid #f0e4cd",
                          borderRadius: 4,
                          padding: "4px 7px",
                          marginTop: 2,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {r.node.reason}
                      </div>
                    )}
                    <EvidenceRow node={r.node} />
                  </Box>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
