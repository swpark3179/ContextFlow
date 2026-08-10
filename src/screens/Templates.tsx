import { Box } from "../lib/ui";
import { GREEN, VIOLET } from "../lib/design";
import { useStore } from "../store/useStore";

const GRID = "1fr 92px 128px 108px";

export default function Templates() {
  const s = useStore();
  const { templates } = s;

  const stats = [
    {
      key: "a",
      value: templates.reduce((n, t) => n + t.uses, 0),
      label: "총 실행 회차",
      color: "#3a3630",
    },
    { key: "b", value: templates.length, label: "등록된 표준 패턴", color: VIOLET },
    {
      key: "c",
      value: templates.reduce((n, t) => n + t.saved, 0),
      label: "생성하지 않은 중복 노트",
      color: GREEN,
    },
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 22px", background: "#fdfcfa" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-.2px" }}>
            표준 패턴 · 실행 이력
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "#8a857c",
              marginTop: 3,
              lineHeight: 1.6,
              maxWidth: 680,
            }}
          >
            반복 업무는 새 노드를 양산하는 대신 대표 템플릿 하위에 회차별 Run Log로 누적됩니다.
            아래 숫자가 곧 “만들지 않은 중복 노트 수”입니다.
          </div>
        </div>
        <Box
          onClick={() =>
            s.set({
              tplNew: {
                name: "",
                desc: "",
                sections: "배경\n체크리스트\n실행 이력 (Run Log)",
                fromTask: false,
              },
            })
          }
          style={{
            flex: "0 0 auto",
            height: 29,
            padding: "0 13px",
            display: "flex",
            alignItems: "center",
            gap: 5,
            borderRadius: 5,
            background: "#3a6fd8",
            color: "#fff",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
          hover={{ background: "#2f5cbb" }}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>+</span> 템플릿 추가
        </Box>
      </div>

      <div style={{ display: "flex", gap: 8, margin: "14px 0 12px 0" }}>
        {stats.map((st) => (
          <div
            key={st.key}
            style={{
              flex: "0 0 auto",
              minWidth: 132,
              border: "1px solid #e6e2da",
              borderRadius: 6,
              padding: "9px 12px",
              background: "#fff",
            }}
          >
            <div
              style={{
                fontFamily: "'IBM Plex Mono',monospace",
                fontSize: 19,
                fontWeight: 600,
                color: st.color,
                lineHeight: 1.1,
              }}
            >
              {st.value}
            </div>
            <div style={{ fontSize: 10.5, color: "#8a857c", marginTop: 3 }}>{st.label}</div>
          </div>
        ))}
      </div>

      <div
        style={{ border: "1px solid #e6e2da", borderRadius: 7, overflow: "hidden", background: "#fff" }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
            background: "#f7f5f1",
            borderBottom: "1px solid #e6e2da",
            fontSize: 10.5,
            fontWeight: 600,
            color: "#8a857c",
          }}
        >
          <div style={{ padding: "7px 12px" }}>템플릿 / 대표 노드</div>
          <div style={{ padding: "7px 12px", textAlign: "right" }}>실행 횟수</div>
          <div style={{ padding: "7px 12px", textAlign: "right" }}>최근 실행</div>
          <div style={{ padding: "7px 12px", textAlign: "right" }}>절감 노트</div>
        </div>

        {templates.length === 0 && (
          <div
            style={{
              padding: "36px 16px",
              textAlign: "center",
              fontSize: 11.5,
              color: "#a09a8f",
              lineHeight: 1.8,
            }}
          >
            아직 등록된 표준 패턴이 없습니다.
            <br />
            반복되는 업무의 골격을 템플릿으로 등록하면 회차 로그로 누적됩니다.
          </div>
        )}

        {templates.map((tp) => {
          const open = !!s.openTpl[tp.id];
          return (
            <div key={tp.id} style={{ borderBottom: "1px solid #f0ede7" }}>
              <Box
                onClick={() => s.set({ openTpl: { ...s.openTpl, [tp.id]: !open } })}
                style={{
                  display: "grid",
                  gridTemplateColumns: GRID,
                  cursor: "pointer",
                  background: open ? "#faf9f6" : "#fff",
                }}
                hover={{ background: "#faf9f6" }}
              >
                <div
                  style={{
                    padding: "9px 12px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minWidth: 0,
                  }}
                >
                  <span style={{ fontSize: 8, color: "#a09a8f" }}>{open ? "▼" : "▶"}</span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tp.name}
                    </div>
                    <div
                      style={{
                        fontFamily: "'IBM Plex Mono',monospace",
                        fontSize: 9.5,
                        color: "#a09a8f",
                        marginTop: 2,
                      }}
                    >
                      {tp.relPath}
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    padding: "9px 12px",
                    textAlign: "right",
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 11.5,
                    color: "#3a3630",
                  }}
                >
                  {tp.uses}
                </div>
                <div
                  style={{
                    padding: "9px 12px",
                    textAlign: "right",
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 11,
                    color: "#8a857c",
                  }}
                >
                  {tp.last}
                </div>
                <div
                  style={{
                    padding: "9px 12px",
                    textAlign: "right",
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 11.5,
                    color: GREEN,
                  }}
                >
                  −{tp.saved}
                </div>
              </Box>
              {open && (
                <div
                  style={{
                    background: "#faf9f6",
                    borderTop: "1px solid #f0ede7",
                    padding: "8px 12px 10px 32px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: "#8a857c",
                      letterSpacing: ".4px",
                      marginBottom: 5,
                    }}
                  >
                    RUN LOG
                  </div>
                  {tp.runs.length === 0 && (
                    <div style={{ fontSize: 11, color: "#a09a8f" }}>
                      아직 이 템플릿을 사용한 업무가 없습니다.
                    </div>
                  )}
                  {tp.runs.map((run, i) => (
                    <div
                      key={`${tp.id}${i}`}
                      style={{
                        display: "flex",
                        gap: 10,
                        padding: "3px 0",
                        borderBottom: "1px dotted #eae6de",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "'IBM Plex Mono',monospace",
                          fontSize: 10,
                          color: "#a09a8f",
                          flex: "0 0 108px",
                        }}
                      >
                        {run.date}
                      </span>
                      <span style={{ fontSize: 11, color: "#4e4a43", flex: 1 }}>{run.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
