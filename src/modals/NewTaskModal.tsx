import { useRef, type CSSProperties } from "react";
import {
  AiRail,
  AiSignal,
  AiStep,
  Box,
  BusyLabel,
  CheckMark,
  Input,
  Skeleton,
  TextArea,
  fmtSec,
  useElapsed,
  useExitSnapshot,
  useFlip,
  useTween,
} from "../lib/ui";
import { AI, BLUE, TEXT, VIOLET } from "../lib/design";
import { sanitizeFolderName } from "../lib/vaultPaths";
import { scheduleRecommend, useStore } from "../store/useStore";
import { activeRun, useAi } from "../store/aiStore";
import { label as categoryLabel, normalizeCategory, suggestCategory } from "../lib/category";
import CategoryPicker from "../components/CategoryPicker";
import { inputFocus } from "./Modal";
import { useEscGuard } from "./motion";

const TAG_STYLE: Record<string, { label: string; fg: string; bg: string }> = {
  ref: { label: "참조 중", fg: "#4e4a43", bg: "#f0ede7" },
  resume: { label: "이력 추가됨", fg: "#2f5cbb", bg: "#eef3fd" },
  merged: { label: "병합 완료", fg: "#2f5cbb", bg: "#eef3fd" },
};

/** AI 가 이 점수 밑으로 매긴 카드는 흐리게 — 남겨 두되 눈이 먼저 가지 않게. */
const LOW_SIM = 60;

/**
 * 추천 카드의 최소 높이. 로컬 계산 중의 빈 칸도 같은 높이라, 결과가 와도 목록이 튀지 않는다 — 예전에는 짧은
 * 스켈레톤 두 개가 카드 세 장으로 바뀌며 목록이 한 번 늘었다.
 */
const CARD_H = 104;
/** 빈 칸 수 — 화면에 내는 카드 수(로컬 엔진 · AI 추천의 기본값)와 같다. */
const SLOTS = 3;

/**
 * 새 업무 추가.
 *
 * 열리고 닫히는 움직임은 다른 대화상자(`Modal`)와 같다 — 이 대화상자만 머리 · 본문 · 꼬리를 손으로 그려서
 * 같은 키프레임과 닫히는 잔상(`useExitSnapshot`)을 직접 단다. 열려 있는 동안만 본문을 그려, 닫힐 때 잔상이
 * 남는다.
 */
export default function NewTaskModal() {
  const open = useStore((s) => s.newOpen);
  return open ? <NewTaskView /> : null;
}

function NewTaskView() {
  const s = useStore();
  // 전체 구독 — 파생 배열을 셀렉터에서 만들면 스냅샷이 불안정해진다(`ActiveAiCard` 참고).
  const ai = useAi();
  // AI 추천이 도는 동안 1초마다 경과를 올린다.
  const aiMs = useElapsed(s.ntAiAt);
  const root = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useExitSnapshot(root, "modal");

  const { nt, ntRecs, ntLoading, ntEngine, ntRefs, settings } = s;
  // AI 가 다시 매기면 카드가 새 순서로 미끄러진다 — 읽던 카드가 말없이 다른 자리로 순간이동하지 않게.
  useFlip(list, ntRecs.map((r) => r.id).join("\n"), { ms: 300 });

  /**
   * 쓰던 것이 있으면(개요 · 태그 · 고른 참조) 첫 Esc 는 경고만 한다. 제목만 친 것은 다시 치면 그만이라 막지
   * 않는다. 위에 병합 대화상자가 떠 있으면 Esc 는 그쪽 것이다.
   */
  const dirty = !!(nt.summary.trim() || nt.tags.trim() || ntRefs.length);
  const guard = useEscGuard(panel, dirty && !s.merge);

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
  /** AI 를 켜 두었는데 로컬 결과로 끝났다 — 실패해 대체했다. 사유는 `ntNote` 에 있다. */
  const aiFailed = !ntLoading && !aiDone && ntRecs.length > 0 && !!activeName && ntEngine === "local";
  const lowCount = aiDone ? ntRecs.filter((r) => r.sim < LOW_SIM).length : 0;
  /**
   * AI 대기 띠 · 결과 줄이 함께 쓰는 자리. AI 를 켜 두었으면 로컬 계산 때부터 잡아 둔다 — 띠가 생기고
   * 사라질 때 카드가 밀리지 않게.
   */
  const slot = !!activeName && (ntLoading || ntRecs.length > 0);

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
  const close = () => s.set({ newOpen: false });

  return (
    <div
      ref={root}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(35,33,30,.34)",
        backdropFilter: "blur(1.5px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        animation: "cfFadeIn 140ms linear",
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="새 업무 추가"
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
          <span style={{ fontSize: 14, fontWeight: 600 }}>새 업무 추가</span>
          <span style={{ fontSize: 11.5, color: "#6a665e" }}>
            제목을 입력하면 과거 Vault 노드와의 유사도를 계산합니다
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
                onChange={(e) => {
                  guard.disarm();
                  s.set({ nt: { ...nt, summary: e.target.value } });
                }}
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
                  onChange={(e) => {
                    guard.disarm();
                    s.set({ nt: { ...nt, tags: e.target.value } });
                  }}
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
                  <div className="cf-enter" style={{ fontSize: 11, color: "#2f5cbb", marginTop: 4, lineHeight: 1.5 }}>
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
                    className="cf-enter"
                    onClick={() => s.set({ nt: { ...nt, category: suggested } })}
                    title="추천된 유사 업무들이 쓰는 카테고리입니다"
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      color: "#2f5cbb",
                      background: "#eef3fd",
                      border: "1px solid #cddcf8",
                      borderRadius: 4,
                      padding: "1px 7px",
                      cursor: "pointer",
                    }}
                    hover={{ background: "#e2ebfb" }}
                  >
                    유사 업무의 카테고리 · {categoryLabel(suggested)} <b>적용</b>
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
                  color: "#6a665e",
                  wordBreak: "break-all",
                }}
              >
                <div>{folderPreview}</div>
                {/* 만들어지는 것은 index.md 하나뿐이다 — 빈 attachments/ 를 미리 파 두지
                    않는다. 파일이 들어오는 순간 그 폴더가 생긴다. */}
                <div>
                  &nbsp;&nbsp;{tplFolder || ntRefs.length ? "├" : "└"}── index.md
                </div>
                {tplFolder && (
                  <div>
                    &nbsp;&nbsp;{ntRefs.length ? "├" : "└"}── ({nt.template} 템플릿 파일)
                  </div>
                )}
                {/* 고른 참조는 줄째 들어오며 한 번 빛난다 — 무엇이 어디에 생기는지 그 자리에서 보인다. */}
                {ntRefs.map((f, i) => (
                  <div
                    key={f}
                    style={{
                      color: "#2f5cbb",
                      borderRadius: 3,
                      animation: "cfEnter 200ms var(--e-out) backwards, cfFlash 900ms ease-out",
                    }}
                  >
                    &nbsp;&nbsp;{i === ntRefs.length - 1 ? "└" : "├"}── reference/
                    {sanitizeFolderName(s.tasks.find((t) => t.folder === f)?.title ?? "참조")}/
                  </div>
                ))}
              </div>
              {category && (
                <div style={{ fontSize: 11, color: "#6a665e", marginTop: 5, lineHeight: 1.5 }}>
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
                  // 보라는 AI 가 일하는 동안만 — 쉬는 동안은 회색 점.
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#cfcabf" }} />
                )}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: TEXT.ink }}>시작 전 유사 업무 추천</span>
              <div style={{ flex: 1 }} />
              <span key={status} className="cf-fade" style={{ fontSize: 11.5, color: TEXT.body, whiteSpace: "nowrap" }}>
                {status}
              </span>
            </div>
            {/* 진행선 — 로컬은 회색 대기라 띄우지 않고, AI 가 읽는 동안만. */}
            <div style={{ flex: "0 0 auto", height: 2, borderBottom: "1px solid #e6e2da", boxSizing: "content-box" }}>
              {aiRunning && <AiRail />}
            </div>

            <div ref={list} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 9 }}>
              {slot && (
                <div style={{ position: "relative", height: 32, marginBottom: 6 }}>
                  {aiRunning && (
                    <div
                      role="status"
                      className="cf-fade"
                      style={{ ...slotLine, fontWeight: 500, background: AI.soft, border: `1px solid ${AI.softBd}` }}
                    >
                      <span style={{ width: 14, display: "flex", justifyContent: "center" }}>
                        <AiSignal />
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <AiStep>
                          {engineName ?? "AI"} 가 후보 {ntRecs.length}건을 다시 읽는 중
                        </AiStep>
                      </span>
                      <span
                        style={{ flex: "0 0 auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, color: AI.fg }}
                      >
                        {fmtSec(aiMs)}
                      </span>
                      {/* 몇 초씩 걸린다 — 기다리지 않고 로컬 순서로 고르고 싶을 때. */}
                      <Box
                        role="button"
                        tabIndex={0}
                        onClick={() => s.cancelRecommend()}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          s.cancelRecommend();
                        }}
                        title="AI 확인을 멈추고 로컬 순서를 씁니다"
                        style={{
                          flex: "0 0 auto",
                          fontSize: 11.5,
                          fontWeight: 500,
                          color: TEXT.body,
                          border: "1px solid #ddd8cf",
                          background: "#fff",
                          borderRadius: 4,
                          padding: "1px 7px",
                          cursor: "pointer",
                        }}
                        hover={{ background: "#f2efe9" }}
                      >
                        취소
                      </Box>
                    </div>
                  )}
                  {aiDone && (
                    <div
                      role="status"
                      className="cf-enter"
                      style={{ ...slotLine, background: "#f1faf5", border: "1px solid #c9e4d5", color: "#256b47" }}
                    >
                      <span style={{ width: 14, display: "flex", justifyContent: "center" }}>
                        <CheckMark size={11} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
                  {aiFailed && (
                    <div
                      role="status"
                      className="cf-enter"
                      title={s.ntNote}
                      style={{ ...slotLine, background: "#f4f2ee", border: "1px solid #e6e2da", color: TEXT.body }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.ntNote.startsWith("AI 확인을 취소") ? (
                          s.ntNote
                        ) : (
                          <>
                            AI 확인에 실패해 로컬 순서 그대로입니다
                            {s.ntNote.includes(" — ") ? ` · ${s.ntNote.split(" — ").slice(1).join(" — ")}` : ""}
                          </>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* 로컬 계산 중 — 카드가 설 자리를 카드 높이 그대로 먼저 잡는다. */}
              {localLoading &&
                ntRecs.length === 0 &&
                Array.from({ length: SLOTS }, (_, i) => (
                  <div
                    key={i}
                    aria-hidden
                    style={{
                      height: CARD_H,
                      border: "1px solid #ece8e0",
                      borderRadius: 6,
                      background: "#fff",
                      padding: "11px 10px",
                      marginBottom: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 9,
                    }}
                  >
                    <Skeleton width="58%" height={12} />
                    <Skeleton width="82%" height={9} />
                    <Skeleton width="40%" height={9} />
                  </div>
                ))}

              {!ntLoading && ntRecs.length === 0 && (
                <div
                  className="cf-fade"
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

              {ntRecs.map((r, i) => {
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
                  // 자리 옮기기(FLIP)는 바깥 상자가, 처음 들어오기는 안쪽 카드가 맡는다 — 같은 요소에 두면
                  // 두 움직임의 transform 이 부딪힌다.
                  <div key={r.id} data-flip={r.id} style={{ marginBottom: 6 }}>
                    <div
                      className="cf-enter"
                      style={{
                        minHeight: CARD_H,
                        display: "flex",
                        flexDirection: "column",
                        border: `1px solid ${tg ? "#d6dcea" : "#e6e2da"}`,
                        borderRadius: 6,
                        background: "#fff",
                        padding: "9px 10px",
                        animationDelay: `${Math.min(i, 5) * 30}ms`,
                        opacity: aiDone && r.sim < LOW_SIM ? 0.5 : 1,
                        transition: "opacity 200ms, border-color 160ms",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <Score value={r.sim} color={simColor} />
                        {src && (
                          <span
                            key={src.label}
                            className="cf-fade"
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
                            className="cf-enter"
                            title="AI 가 다시 매기기 전의 로컬 유사도"
                            style={{ flex: "0 0 auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11, color: TEXT.sub }}
                          >
                            로컬 {was}
                          </span>
                        )}
                        {tag && (
                          <span
                            className="cf-fade"
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
                        <div
                          className="cf-enter"
                          title={r.reason}
                          style={{
                            fontSize: 12,
                            lineHeight: 1.55,
                            color: TEXT.body,
                            marginTop: 7,
                            minHeight: 18,
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          <span style={{ color: AI.fg, fontWeight: 600 }}>근거 </span>
                          {r.reason}
                        </div>
                      )}

                      {isCluster && (
                        <div
                          onClick={() => s.set({ expanded: { ...s.expanded, [r.id]: !s.expanded[r.id] } })}
                          style={{
                            display: "inline-flex",
                            alignSelf: "flex-start",
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
                          className="cf-enter"
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
                            <div key={c.id} style={{ display: "flex", gap: 7, alignItems: "center" }}>
                              <span style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 11, color: TEXT.sub }}>
                                {c.date}
                              </span>
                              <span style={{ fontSize: 11.5, color: "#5d594f" }}>{c.title}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div style={{ display: "flex", gap: 5, marginTop: "auto", paddingTop: 8, flexWrap: "wrap" }}>
                        <Box
                          role="button"
                          aria-pressed={refOn}
                          onClick={() => {
                            // 토글. 고른 업무의 파일은 [업무 생성] 때 새 업무의
                            // reference/<업무명>/ 아래로 복사된다(useStore.createTask).
                            const on = ntRefs.includes(r.id);
                            const rest = { ...s.recTag };
                            if (on) delete rest[r.id];
                            guard.disarm();
                            s.set({
                              ntRefs: on ? ntRefs.filter((f) => f !== r.id) : [...ntRefs, r.id],
                              recTag: on ? rest : { ...s.recTag, [r.id]: "ref" },
                            });
                          }}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            fontSize: 11.5,
                            fontWeight: refOn ? 600 : 400,
                            padding: "3px 8px",
                            borderRadius: 4,
                            border: `1px solid ${refOn ? "#cddcf8" : "#ddd8cf"}`,
                            background: refOn ? "#eef3fd" : "#fff",
                            color: refOn ? "#2f5cbb" : TEXT.body,
                            cursor: "pointer",
                          }}
                          hover={{ background: refOn ? "#e2ebfb" : "#f2efe9" }}
                        >
                          {refOn && <CheckMark size={9} />}
                          {refOn ? "참조로 복사됨" : "참고만 하기"}
                        </Box>
                        <Box
                          role="button"
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
                            role="button"
                            onClick={() =>
                              s.set({
                                merge: {
                                  rec: r,
                                  primary: 0,
                                  sel: Object.fromEntries(r.cluster!.map((_, k) => [k, true])),
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
            key={guard.armed ? "armed" : "note"}
            role={guard.armed ? "alert" : undefined}
            className={guard.armed ? "cf-enter" : undefined}
            style={{
              fontSize: 11.5,
              color: guard.armed ? TEXT.warn : "#6a665e",
              fontWeight: guard.armed ? 600 : 400,
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {guard.armed
              ? "작성 중인 내용이 있습니다 — Esc 를 한 번 더 누르면 버리고 닫습니다"
              : ntRefs.length
                ? `참조 ${ntRefs.length}건의 파일이 새 업무의 reference/ 아래로 복사됩니다.`
                : ntRecs.length
                  ? "추천 카드에서 [기반 재개]를 고르면 새 노트를 만들지 않고 기존 노드에 회차만 추가합니다."
                  : s.ntNote ||
                    (activeName
                      ? `제목을 입력하면 ${activeName}로 과거 업무를 훑습니다. 실패하면 로컬 유사도로 대체됩니다.`
                      : "모든 분석은 로컬에서 수행됩니다 (외부 통신 없음).")}
          </span>
          <Box
            role="button"
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
            role={s.ntBusy ? "status" : "button"}
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

/** 대기 띠 · 결과 줄의 공통 모양 — 한 자리(`slot`)를 겹쳐 쓴다. */
const slotLine: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12.5,
  padding: "0 8px",
  borderRadius: 6,
};

/** 유사도 — AI 가 다시 매기면 로컬 값에서 새 값으로 흘러간다. 폭을 잡아 두어 자릿수가 바뀌어도 제목이 밀리지 않는다. */
function Score({ value, color }: { value: number; color: string }) {
  const v = useTween(value, 420);
  return (
    <span
      style={{
        flex: "0 0 auto",
        minWidth: 36,
        fontFamily: "'Roboto Mono',monospace",
        fontSize: 14,
        fontWeight: 600,
        color,
        whiteSpace: "nowrap",
        transition: "color 200ms",
      }}
    >
      {Math.round(v)}%
    </span>
  );
}
