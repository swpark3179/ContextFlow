import { AiRail, AiSignal, AiStep, Box, BusyLabel, Input, Skeleton, TextArea, fmtSec, useElapsed } from "../lib/ui";
import { AI, BLUE, TEXT, VIOLET } from "../lib/design";
import { sanitizeFolderName } from "../lib/vaultPaths";
import { scheduleRecommend, useStore } from "../store/useStore";
import { activeRun, useAi } from "../store/aiStore";
import { label as categoryLabel, normalizeCategory, suggestCategory } from "../lib/category";
import CategoryPicker from "../components/CategoryPicker";
import { inputFocus } from "./Modal";

const TAG_STYLE: Record<string, { label: string; fg: string; bg: string }> = {
  ref: { label: "참조 중", fg: "#4e4a43", bg: "#f0ede7" },
  resume: { label: "이력 추가됨", fg: "#2f5cbb", bg: "#eef3fd" },
  merged: { label: "병합 완료", fg: "#2f5cbb", bg: "#eef3fd" },
};

/** AI 가 이 점수 밑으로 매긴 카드는 흐리게 — 남겨 두되 눈이 먼저 가지 않게. */
const LOW_SIM = 60;

export default function NewTaskModal() {
  const s = useStore();
  // 전체 구독 — 파생 배열을 셀렉터에서 만들면 스냅샷이 불안정해진다(`ActiveAiCard` 참고).
  const ai = useAi();
  // 훅은 이른 반환보다 앞에 — AI 추천이 도는 동안 1초마다 경과를 올린다.
  const aiMs = useElapsed(s.newOpen ? s.ntAiAt : null);
  if (!s.newOpen) return null;

  const { nt, ntRecs, ntLoading, ntEngine, ntRefs, settings } = s;
  const title = nt.title.trim();
  /** 제목이 있고, 앞선 생성이 아직 돌고 있지 않을 때만. */
  const canCreate = !!title && !s.ntBusy;
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const folderPreview = `${settings.vault.split("/").pop()}/Tasks/[${monthPrefix}] ${
    sanitizeFolderName(title) || "새 업무"
  }/`;

  const agentName = (id: string) => ai.infos.find((i) => i.id === id)?.name ?? id;

  // 추천된 유사 업무들이 같은 카테고리에 모여 있으면 한 번에 고르게 한다.
  const suggested = nt.category.trim() ? null : suggestCategory(ntRecs.map((r) => r.id), s.tasks);
  const category = normalizeCategory(nt.category).value;

  // 폴더 템플릿을 고르면 그 안의 파일이 실제로 복사되므로 미리 알려 준다.
  const tplFolder = s.templates.some((t) => t.id === nt.template && t.kind === "folder");

  // 실제로 점수를 낸 엔진. `ntEngine` 은 `"local"` 이거나 AI 에이전트 id 다.
  const engineName = ntEngine === "local" ? null : agentName(ntEngine);
  // 아직 한 번도 안 돌렸을 때 안내할 대상은 **설정에서 고른** 연결이다 — `ntEngine` 의
  // 초기값은 `"local"` 이라 그것으로는 AI 를 켜 둔 사용자에게 거짓말을 하게 된다.
  const activeName = activeRun(ai) ? agentName(ai.settings!.active.agentId) : null;

  /**
   * 추천의 세 갈래 — 로컬 계산 중 · 로컬 결과를 띄워 두고 AI 가 읽는 중 · AI 가 다시 매김.
   * 로컬 결과는 AI 결과로 말없이 바뀌면 안 된다: 읽던 카드가 아래로 내려간다. 그래서 AI 가
   * 도는 동안에는 ‘로컬 추정’ 이라고 적고, 끝나면 무엇이 바뀌었는지 알린다.
   */
  const aiRunning = ntLoading && s.ntAiAt !== null;
  const localLoading = ntLoading && !aiRunning;
  const aiDone = !ntLoading && s.ntLocal !== null && ntRecs.length > 0;
  const lowCount = aiDone ? ntRecs.filter((r) => r.sim < LOW_SIM).length : 0;

  const status = localLoading
    ? "로컬 유사도 계산 중"
    : aiRunning
      ? `로컬 ${ntRecs.length}건 · AI 확인 중`
      : ntRecs.length
        ? aiDone
          ? `${ntRecs.length}건 · AI 순서`
          : `${ntRecs.length}건 검색됨`
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
                onKeyDown={(e) => {
                  // 한글 조합을 확정하는 Enter 도 keydown 을 낸다(keyCode 229). 그것까지 받으면
                  // "마이그레이션" 을 치고 조합을 닫는 순간 업무가 만들어진다.
                  if (e.key !== "Enter" || e.repeat || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (canCreate) void s.createTask();
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
                  // 템플릿의 기본 카테고리로 카테고리 칸을 맞춘다 — 손으로 고친 값은 그대로 둔다.
                  onChange={(e) => s.setNtTemplate(e.target.value)}
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
                {tplFolder && (
                  <div style={{ fontSize: 11, color: "#5a44b4", marginTop: 4, lineHeight: 1.5 }}>
                    이 템플릿의 파일이 새 업무 폴더로 복사됩니다.
                  </div>
                )}
              </div>
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, minWidth: 0 }}>
                <span style={{ ...label, marginBottom: 0, flex: "0 0 auto" }}>카테고리</span>
                <div style={{ flex: 1 }} />
                {suggested && (
                  <Box
                    onClick={() => s.set({ nt: { ...nt, category: suggested } })}
                    title="추천된 유사 업무들이 쓰는 카테고리입니다"
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      color: "#5a44b4",
                      background: "#f4f0fd",
                      border: "1px solid #e0d6f8",
                      borderRadius: 4,
                      padding: "1px 7px",
                      cursor: "pointer",
                    }}
                    hover={{ background: "#ece5fb" }}
                  >
                    유사 업무의 카테고리 · {categoryLabel(suggested)}
                  </Box>
                )}
              </div>
              <CategoryPicker
                value={nt.category}
                onChange={(v) => s.set({ nt: { ...nt, category: v } })}
                onCommit={(v) => s.set({ nt: { ...nt, category: v ?? "" } })}
              />
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
                {/* 만들어지는 것은 index.md 하나뿐이다 — 빈 attachments/ 를 미리 파 두지
                    않는다. 파일이 들어오는 순간 그 폴더가 생긴다. */}
                &nbsp;&nbsp;{tplFolder || ntRefs.length ? "├" : "└"}── index.md
                {tplFolder && (
                  <>
                    <br />
                    &nbsp;&nbsp;{ntRefs.length ? "├" : "└"}── ({nt.template} 템플릿 파일)
                  </>
                )}
                {ntRefs.map((f, i) => (
                  <span key={f}>
                    <br />
                    &nbsp;&nbsp;{i === ntRefs.length - 1 ? "└" : "├"}── reference/
                    {sanitizeFolderName(s.tasks.find((t) => t.folder === f)?.title ?? "참조")}/
                  </span>
                ))}
              </div>
              {category && (
                <div style={{ fontSize: 11, color: "#a09a8f", marginTop: 5, lineHeight: 1.5 }}>
                  카테고리는 index.md 에만 적힙니다 — 폴더는 그대로 Tasks/ 바로 아래에 생깁니다.
                </div>
              )}
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
              }}
            >
              <span style={{ width: 12, display: "flex", justifyContent: "center" }}>
                {aiRunning ? (
                  <AiSignal />
                ) : (
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: VIOLET }} />
                )}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: TEXT.ink }}>시작 전 유사 업무 추천</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: TEXT.body, whiteSpace: "nowrap" }}>{status}</span>
            </div>
            {/* 진행선 — 로컬은 회색 대기라 띄우지 않고, AI 가 읽는 동안만. */}
            <div style={{ flex: "0 0 auto", height: 2, borderBottom: "1px solid #e6e2da", boxSizing: "content-box" }}>
              {aiRunning && <AiRail />}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 9 }}>
              {localLoading && ntRecs.length === 0 &&
                [0, 1].map((i) => (
                  <div
                    key={i}
                    style={{
                      border: "1px solid #ece8e0",
                      borderRadius: 6,
                      background: "#fff",
                      padding: 11,
                      marginBottom: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 7,
                    }}
                  >
                    <Skeleton width="62%" height={11} />
                    <Skeleton width="88%" height={9} />
                  </div>
                ))}

              {aiRunning && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    fontWeight: 500,
                    padding: "6px 8px",
                    marginBottom: 6,
                    borderRadius: 6,
                    background: AI.soft,
                    border: `1px solid ${AI.softBd}`,
                  }}
                >
                  <span style={{ width: 14, display: "flex", justifyContent: "center" }}>
                    <AiSignal />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <AiStep>
                      {engineName ?? "AI"} 가 후보 {ntRecs.length}건을 다시 읽는 중
                    </AiStep>
                  </span>
                  <span style={{ flex: "0 0 auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, color: AI.fg }}>
                    {fmtSec(aiMs)}
                  </span>
                </div>
              )}

              {aiDone && (
                <div
                  className="cf-up"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    padding: "6px 8px",
                    marginBottom: 6,
                    borderRadius: 6,
                    background: "#f1faf5",
                    border: "1px solid #c9e4d5",
                    color: "#256b47",
                  }}
                >
                  <span style={{ width: 14, textAlign: "center", fontWeight: 700 }}>✓</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {s.ntReordered ? "AI가 다시 매긴 순서입니다" : "AI가 점수를 확인했습니다 · 순서 그대로"}
                    {lowCount > 0 && ` · ${lowCount}건은 관련이 낮아 흐리게`}
                  </span>
                  {s.ntAiMs !== null && (
                    <span style={{ flex: "0 0 auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11.5 }}>
                      {fmtSec(s.ntAiMs, true)}
                    </span>
                  )}
                </div>
              )}

              {!ntLoading && ntRecs.length === 0 && (
                <div
                  style={{
                    padding: "40px 18px",
                    textAlign: "center",
                    fontSize: 12.5,
                    color: TEXT.hint,
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
                const refOn = ntRefs.includes(r.id);
                const tg = s.recTag[r.id];
                const tag = tg ? TAG_STYLE[tg] : null;
                // AI 가 확인하는 동안의 로컬 점수는 추정이라 색을 빼 둔다.
                const simColor = aiRunning
                  ? TEXT.sub
                  : r.sim >= settings.threshold
                    ? VIOLET
                    : r.sim >= 75
                      ? BLUE
                      : TEXT.sub;
                const was = aiDone ? s.ntLocal?.[r.id] : undefined;
                const src = aiRunning
                  ? { label: "로컬 추정", fg: TEXT.body, bg: "#efece6" }
                  : aiDone
                    ? { label: "AI", fg: AI.fg, bg: AI.bg }
                    : null;
                return (
                  <div
                    key={r.id}
                    style={{
                      border: `1px solid ${tg ? "#d6dcea" : "#e6e2da"}`,
                      borderRadius: 6,
                      background: "#fff",
                      padding: "9px 10px",
                      marginBottom: 6,
                      animation: "pIn .18s ease-out",
                      opacity: aiDone && r.sim < LOW_SIM ? 0.5 : 1,
                      transition: "opacity .3s",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <span
                        style={{
                          fontFamily: "'Roboto Mono',monospace",
                          fontSize: 14,
                          fontWeight: 600,
                          color: simColor,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.sim}%
                      </span>
                      {src && (
                        <span
                          style={{
                            flex: "0 0 auto",
                            fontSize: 11,
                            fontWeight: 600,
                            color: src.fg,
                            background: src.bg,
                            borderRadius: 3,
                            padding: "0 5px",
                            lineHeight: "17px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {src.label}
                        </span>
                      )}
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
                      {was !== undefined && was !== r.sim && (
                        <span
                          title="AI 가 다시 매기기 전의 로컬 유사도"
                          style={{ flex: "0 0 auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11, color: TEXT.sub }}
                        >
                          로컬 {was}
                        </span>
                      )}
                      {tag && (
                        <span
                          style={{
                            fontSize: 11,
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
                        fontSize: 11,
                        color: TEXT.sub,
                        marginTop: 3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.path}
                    </div>

                    {/* 근거 — AI 가 읽는 동안은 그 자리만 비워 두고, 끝나면 한 줄로. */}
                    {aiRunning && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7, minHeight: 18 }}>
                        <span style={{ fontSize: 11, color: TEXT.sub, flex: "0 0 auto" }}>근거 확인 중</span>
                        <span style={{ flex: 1 }}>
                          <Skeleton height={9} />
                        </span>
                      </div>
                    )}
                    {aiDone && r.reason && (
                      <div className="cf-up" style={{ fontSize: 12, lineHeight: 1.55, color: TEXT.body, marginTop: 7 }}>
                        <span style={{ color: AI.fg, fontWeight: 600 }}>근거 </span>
                        {r.reason}
                      </div>
                    )}

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
                          color: "#2f5cbb",
                          background: "#eef3fd",
                          border: "1px solid #cddcf8",
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
                          borderLeft: "2px solid #cddcf8",
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
                                fontSize: 11,
                                color: TEXT.sub,
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
                          // 토글. 고른 업무의 파일은 [업무 생성] 때 새 업무의
                          // reference/<업무명>/ 아래로 복사된다(useStore.createTask).
                          const on = ntRefs.includes(r.id);
                          const rest = { ...s.recTag };
                          if (on) delete rest[r.id];
                          s.set({
                            ntRefs: on ? ntRefs.filter((f) => f !== r.id) : [...ntRefs, r.id],
                            recTag: on ? rest : { ...s.recTag, [r.id]: "ref" },
                          });
                        }}
                        style={{
                          fontSize: 11.5,
                          fontWeight: refOn ? 600 : 400,
                          padding: "3px 8px",
                          borderRadius: 4,
                          border: `1px solid ${refOn ? "#cfcabf" : "#ddd8cf"}`,
                          background: refOn ? "#f0ede7" : "#fff",
                          color: refOn ? TEXT.ink : TEXT.body,
                          cursor: "pointer",
                        }}
                        hover={{ background: refOn ? "#e8e4dc" : "#f2efe9" }}
                      >
                        {refOn ? "✓ 참조로 복사됨" : "참고만 하기"}
                      </Box>
                      <Box
                        onClick={() => {
                          const note = `${title || "새 요청"} — 기존 업무 기반으로 재개`;
                          void (async () => {
                            try {
                              await s.set({ recTag: { ...s.recTag, [r.id]: "resume" } });
                              // 열린 업무면 고치던 글을 먼저 내려쓴다 — Run Log 는 본문에 붙는데, 고치던
                              // 버퍼는 디스크에 맞출 때 본문을 지켜서 그 줄이 다음 저장에 지워진다.
                              if (r.id === s.activeFolder) await s.saveAll();
                              const { appendTaskRun } = await import("../lib/api");
                              await appendTaskRun(settings.vault, r.id, note);
                              // Run Log 는 index.md 에 붙는다 — 열어 둔 버퍼가 지우지 않게.
                              await s.resyncIndexDocs([r.id]);
                              // 회차 로그가 붙은 것은 그 업무를 손댄 것이다.
                              s.noteToday(r.id, r.title);
                              s.set({ newOpen: false });
                              await s.reloadVault("list");
                              await s.selectTask(r.id);
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
                            border: "1px solid #cddcf8",
                            background: "#eef3fd",
                            color: "#2f5cbb",
                            cursor: "pointer",
                          }}
                          hover={{ background: "#e2ebfb" }}
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
            {ntRefs.length
              ? `참조 ${ntRefs.length}건의 파일이 새 업무의 reference/ 아래로 복사됩니다.`
              : ntRecs.length
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
            onClick={() => canCreate && void s.createTask()}
            style={{
              height: 29,
              minWidth: 118,
              padding: "0 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 5,
              fontSize: 12.5,
              fontWeight: 600,
              whiteSpace: "nowrap",
              cursor: canCreate ? "pointer" : s.ntBusy ? "progress" : "not-allowed",
              background: s.ntBusy ? "#2f5cbb" : canCreate ? BLUE : "#e6e2da",
              color: canCreate || s.ntBusy ? "#fff" : "#a09a8f",
            }}
            hover={canCreate ? { background: "#2f5cbb" } : undefined}
          >
            {/* AI 가 아닌 작업이라 흰 점. 폭은 minWidth 로 고정해 글자가 바뀌어도 흔들리지 않는다. */}
            <BusyLabel busy={s.ntBusy} color="#fff" idle="업무 생성">
              만드는 중
            </BusyLabel>
          </Box>
        </div>
      </div>
    </div>
  );
}
