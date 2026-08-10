import { Box, Input, TextArea } from "../lib/ui";
import { BLUE, VIOLET } from "../lib/design";
import { sanitizeFolderName } from "../lib/vaultPaths";
import { scheduleRecommend, useStore } from "../store/useStore";
import { activeRun, useAi } from "../store/aiStore";
import { inputFocus } from "./Modal";

const TAG_STYLE: Record<string, { label: string; fg: string; bg: string }> = {
  ref: { label: "참조 중", fg: "#4e4a43", bg: "#f0ede7" },
  resume: { label: "이력 추가됨", fg: "#2f5cbb", bg: "#eef3fd" },
  merged: { label: "병합 완료", fg: "#5a44b4", bg: "#f4f0fd" },
};

export default function NewTaskModal() {
  const s = useStore();
  // 전체 구독 — 파생 배열을 셀렉터에서 만들면 스냅샷이 불안정해진다(`ActiveAiCard` 참고).
  const ai = useAi();
  if (!s.newOpen) return null;

  const { nt, ntRecs, ntLoading, ntEngine, settings } = s;
  const title = nt.title.trim();
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const folderPreview = `${settings.vault.split("/").pop()}/Tasks/[${monthPrefix}] ${
    sanitizeFolderName(title) || "새 업무"
  }/`;

  const agentName = (id: string) => ai.infos.find((i) => i.id === id)?.name ?? id;

  // 실제로 점수를 낸 엔진. `ntEngine` 은 `"local"` 이거나 AI 에이전트 id 다.
  const engineName = ntEngine === "local" ? null : agentName(ntEngine);
  // 아직 한 번도 안 돌렸을 때 안내할 대상은 **설정에서 고른** 연결이다 — `ntEngine` 의
  // 초기값은 `"local"` 이라 그것으로는 AI 를 켜 둔 사용자에게 거짓말을 하게 된다.
  const activeName = activeRun(ai) ? agentName(ai.settings!.active.agentId) : null;

  const status = ntLoading
    ? engineName
      ? `${engineName} 분석 중`
      : "로컬 유사도 분석 중"
    : ntRecs.length
      ? `${ntRecs.length}건 검색됨`
      : "대기 중";

  const label = { fontSize: 12, fontWeight: 600, color: "#6a665e", marginBottom: 5 } as const;

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
        zIndex: 60,
        animation: "fIn .12s ease-out",
      }}
    >
      <div
        style={{
          width: 900,
          maxWidth: "94vw",
          height: 560,
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
          <span style={{ fontSize: 14, fontWeight: 600 }}>새 업무 추가</span>
          <span style={{ fontSize: 11.5, color: "#8a857c" }}>
            제목을 입력하면 과거 Vault 노드와의 유사도를 계산합니다
          </span>
          <div style={{ flex: 1 }} />
          <Box
            onClick={() => s.set({ newOpen: false })}
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
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 11,
              overflow: "auto",
              borderRight: "1px solid #e6e2da",
            }}
          >
            <div>
              <div style={label}>업무 제목</div>
              <Input
                autoFocus
                value={nt.title}
                onChange={(e) => {
                  s.set({ nt: { ...nt, title: e.target.value }, ntLoading: e.target.value.trim().length > 1 });
                  scheduleRecommend();
                }}
                placeholder="예: Tauri 2.0 마이그레이션"
                style={{
                  width: "100%",
                  height: 30,
                  border: "1px solid #ddd8cf",
                  borderRadius: 5,
                  padding: "0 9px",
                  fontSize: 13.5,
                  outline: "none",
                }}
                focusStyle={inputFocus}
              />
            </div>
            <div>
              <div style={label}>개요</div>
              <TextArea
                value={nt.summary}
                onChange={(e) => s.set({ nt: { ...nt, summary: e.target.value } })}
                placeholder="한두 줄로 목적과 범위를 적어두면 추천 정확도가 올라갑니다."
                style={{
                  width: "100%",
                  height: 74,
                  border: "1px solid #ddd8cf",
                  borderRadius: 5,
                  padding: "8px 9px",
                  fontSize: 12.5,
                  lineHeight: 1.65,
                  outline: "none",
                }}
                focusStyle={inputFocus}
              />
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              <div style={{ flex: 1 }}>
                <div style={label}>태그</div>
                <Input
                  value={nt.tags}
                  onChange={(e) => s.set({ nt: { ...nt, tags: e.target.value } })}
                  placeholder="dev, tauri, rust"
                  style={{
                    width: "100%",
                    height: 28,
                    border: "1px solid #ddd8cf",
                    borderRadius: 5,
                    padding: "0 9px",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 12,
                    outline: "none",
                  }}
                  focusStyle={inputFocus}
                />
              </div>
              <div style={{ flex: 1 }}>
                <div style={label}>표준 템플릿</div>
                <select
                  value={nt.template}
                  onChange={(e) => s.set({ nt: { ...nt, template: e.target.value } })}
                  style={{
                    width: "100%",
                    height: 28,
                    border: "1px solid #ddd8cf",
                    borderRadius: 5,
                    padding: "0 6px",
                    fontSize: 12.5,
                    background: "#fff",
                    outline: "none",
                  }}
                >
                  {["(없음)", ...s.templates.map((t) => t.id)].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div
              style={{
                border: "1px dashed #ddd8cf",
                borderRadius: 6,
                padding: "9px 10px",
                background: "#faf9f6",
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: 600, color: "#6a665e", marginBottom: 5 }}>
                생성될 폴더 구조
              </div>
              <div
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11,
                  lineHeight: 1.75,
                  color: "#8a857c",
                  wordBreak: "break-all",
                }}
              >
                {folderPreview}
                <br />
                &nbsp;&nbsp;├── index.md
                <br />
                &nbsp;&nbsp;├── notes.md
                <br />
                &nbsp;&nbsp;└── attachments/
              </div>
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
                gap: 7,
                padding: "0 12px",
                borderBottom: "1px solid #e6e2da",
              }}
            >
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: VIOLET }} />
              <span
                style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".4px", color: "#4e4a43" }}
              >
                시작 전 유사 업무 추천
              </span>
              <div style={{ flex: 1 }} />
              {ntLoading && (
                <div
                  style={{
                    width: 11,
                    height: 11,
                    border: "2px solid #ddd8cf",
                    borderTopColor: VIOLET,
                    borderRadius: "50%",
                    animation: "spin .7s linear infinite",
                  }}
                />
              )}
              <span style={{ fontSize: 11, color: "#a09a8f" }}>{status}</span>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 9 }}>
              {!ntLoading && ntRecs.length === 0 && (
                <div
                  style={{
                    padding: "40px 18px",
                    textAlign: "center",
                    fontSize: 12.5,
                    color: "#a09a8f",
                    lineHeight: 1.8,
                  }}
                >
                  제목을 입력하면
                  <br />
                  과거 업무와의 의미론적 유사도를 계산합니다.
                </div>
              )}

              {ntRecs.map((r) => {
                const isCluster = !!r.cluster && r.cluster.length > 1;
                const tg = s.recTag[r.id];
                const tag = tg ? TAG_STYLE[tg] : null;
                const simColor = r.sim >= settings.threshold ? VIOLET : r.sim >= 75 ? BLUE : "#8a857c";
                return (
                  <div
                    key={r.id}
                    style={{
                      border: `1px solid ${tg ? "#dcd6f0" : "#e6e2da"}`,
                      borderRadius: 6,
                      background: "#fff",
                      padding: 9,
                      marginBottom: 6,
                      animation: "pIn .18s ease-out",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span
                        style={{
                          fontFamily: "'Roboto Mono',monospace",
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: simColor,
                        }}
                      >
                        {r.sim}%
                      </span>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {r.title}
                      </span>
                      {tag && (
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 600,
                            color: tag.fg,
                            background: tag.bg,
                            borderRadius: 3,
                            padding: "1px 5px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {tag.label}
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: "'Roboto Mono',monospace",
                        fontSize: 10.5,
                        color: "#a09a8f",
                        marginTop: 3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.path}
                    </div>

                    {isCluster && (
                      <div
                        onClick={() =>
                          s.set({ expanded: { ...s.expanded, [r.id]: !s.expanded[r.id] } })
                        }
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          marginTop: 5,
                          fontSize: 11,
                          color: VIOLET,
                          background: "#f2eefc",
                          border: "1px solid #e4dcf8",
                          borderRadius: 4,
                          padding: "2px 7px",
                          cursor: "pointer",
                        }}
                      >
                        <span style={{ fontSize: 9 }}>{s.expanded[r.id] ? "▼" : "▶"}</span>
                        <span>동일 패턴 {r.cluster!.length}건 접힘</span>
                      </div>
                    )}

                    {isCluster && s.expanded[r.id] && (
                      <div
                        style={{
                          marginTop: 6,
                          borderLeft: "2px solid #e4dcf8",
                          paddingLeft: 9,
                          display: "flex",
                          flexDirection: "column",
                          gap: 3,
                        }}
                      >
                        {r.cluster!.map((c) => (
                          <div
                            key={c.id}
                            style={{ display: "flex", gap: 7, alignItems: "center" }}
                          >
                            <span
                              style={{
                                fontFamily: "'Roboto Mono',monospace",
                                fontSize: 10.5,
                                color: "#a09a8f",
                              }}
                            >
                              {c.date}
                            </span>
                            <span style={{ fontSize: 11.5, color: "#5d594f" }}>{c.title}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: "flex", gap: 5, marginTop: 8, flexWrap: "wrap" }}>
                      <Box
                        onClick={() => {
                          s.set({ recTag: { ...s.recTag, [r.id]: "ref" } });
                          s.toast("참조로 연결 (읽기 전용)", r.path, "#a8a29a");
                        }}
                        style={{
                          fontSize: 11.5,
                          padding: "3px 8px",
                          borderRadius: 4,
                          border: "1px solid #ddd8cf",
                          background: "#fff",
                          color: "#4e4a43",
                          cursor: "pointer",
                        }}
                        hover={{ background: "#f2efe9" }}
                      >
                        참고만 하기
                      </Box>
                      <Box
                        onClick={() => {
                          const note = `${title || "새 요청"} — 기존 업무 기반으로 재개`;
                          void (async () => {
                            try {
                              await s.set({ recTag: { ...s.recTag, [r.id]: "resume" } });
                              const { appendTaskRun } = await import("../lib/api");
                              await appendTaskRun(settings.vault, r.id, note);
                              s.set({ newOpen: false });
                              await s.reloadVault(false);
                              await s.selectTask(r.id, true);
                              await s.reloadTemplates();
                              s.toast(
                                "기존 노드에 회차 로그 추가",
                                `"${r.title}" · 새 노트를 만들지 않았습니다`,
                                "#6a9ff0",
                              );
                            } catch (e) {
                              s.fail(e, "이력을 추가하지 못했습니다");
                            }
                          })();
                        }}
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          padding: "3px 8px",
                          borderRadius: 4,
                          border: "1px solid #cddcf8",
                          background: "#eef3fd",
                          color: "#2f5cbb",
                          cursor: "pointer",
                        }}
                        hover={{ background: "#e2ebfb" }}
                      >
                        기반 재개 · 이력 추가
                      </Box>
                      {isCluster && (
                        <Box
                          onClick={() =>
                            s.set({
                              merge: {
                                rec: r,
                                primary: 0,
                                sel: Object.fromEntries(r.cluster!.map((_, i) => [i, true])),
                              },
                            })
                          }
                          style={{
                            fontSize: 11.5,
                            fontWeight: 600,
                            padding: "3px 8px",
                            borderRadius: 4,
                            border: "1px solid #e0d6f8",
                            background: "#f4f0fd",
                            color: "#5a44b4",
                            cursor: "pointer",
                          }}
                          hover={{ background: "#ece5fb" }}
                        >
                          병합
                        </Box>
                      )}
                    </div>
                  </div>
                );
              })}
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
          <span
            style={{
              fontSize: 11.5,
              color: "#8a857c",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ntRecs.length
              ? "추천 카드에서 [기반 재개]를 고르면 새 노트를 만들지 않고 기존 노드에 회차만 추가합니다."
              : s.ntNote ||
                (activeName
                  ? `제목을 입력하면 ${activeName}로 과거 업무를 훑습니다. 실패하면 로컬 유사도로 대체됩니다.`
                  : "모든 분석은 로컬에서 수행됩니다 (외부 통신 없음).")}
          </span>
          <Box
            onClick={() => s.set({ newOpen: false })}
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
            onClick={() => title && void s.createTask()}
            style={{
              height: 29,
              padding: "0 16px",
              display: "flex",
              alignItems: "center",
              borderRadius: 5,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: title ? "pointer" : "not-allowed",
              background: title ? BLUE : "#e6e2da",
              color: title ? "#fff" : "#a09a8f",
            }}
            hover={title ? { background: "#2f5cbb" } : undefined}
          >
            업무 생성
          </Box>
        </div>
      </div>
    </div>
  );
}
