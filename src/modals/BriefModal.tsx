import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { label as catLabel } from "../lib/category";
import { today } from "../lib/format";
import { mdParse } from "../lib/markdown";
import { injectionFor } from "../lib/promptPacks";
import { CANCELED } from "../lib/runOnce";
import { AiRail, AiWaitBar, Box, BusyLabel, Input, Skeleton, TextArea } from "../lib/ui";
import { TEXT, TOAST } from "../lib/design";
import {
  BRIEF_ROUNDS,
  INPUT_CAP,
  answerText,
  answered,
  blockKey,
  briefRound,
  hasContent,
  movePlan,
  planBrief,
  planFiles,
  planSize,
  withoutOff,
  type BriefAnswer,
  type BriefBlock,
  type BriefCheck,
  type BriefDraft,
  type BriefFile,
  type BriefPlace,
  type BriefPlan,
  type BriefQa,
  type BriefQuestion,
} from "../lib/assist/brief";
import { headingKey } from "../lib/assist/outline";
import MarkdownView from "../components/MarkdownView";
import { applyBrief, taskBriefFiles, taskOverview, useAssist } from "../store/assistStore";
import { routeInfo, routeRun, useAi } from "../store/aiStore";
import { useStore } from "../store/useStore";
import { AssistHead, Notice, RouteLabel, chipStyle, selectStyle } from "./AssistParts";
import { GhostButton, Modal, ModalFooter, PrimaryButton, inputFocus, inputStyle, labelStyle } from "./Modal";

/**
 * 간략 입력 정리 — 한두 줄로 적은 요구사항 · 끝낸 일 · 지금 상황을 정리해 업무 폴더의 알맞은 파일 · 섹션에 넣는다.
 *
 * 바퀴마다 쓸 내용 미리보기(파일별 — 체크할 할 일과 섹션마다 덧붙일 줄)와 빠진 것을 묻는 질문을 함께 보인다.
 * 쓸 곳은 AI 가 제안하고, 사람이 블록 · 체크마다 빼거나 다른 파일 · 섹션으로 옮길 수 있다. 답하고 [답 반영해 다시
 * 정리] 를 되풀이하거나(최대 `BRIEF_ROUNDS` 바퀴), 언제든 [쓰기]. 답만 하고 다시 정리하지 않았으면 쓰기 전에 한
 * 바퀴를 질문 없이 돌려 답을 반영한다. 끝까지 답하지 않은 질문은 "확인 필요" 에 남는다 — 모르는 것을 지어내지 않는다.
 */
export default function BriefModal() {
  const brief = useAssist((s) => s.brief);
  if (!brief) return null;
  return <BriefView key={brief.folder} folder={brief.folder} />;
}

type Phase = "input" | "thinking" | "review" | "saving";

const NO_ANSWER: BriefAnswer = { picks: [], text: "", unknown: false };
const OVERVIEW_CAP = 1_500;
const NO_PLAN: BriefPlan = { blocks: [], checks: [] };

function BriefView({ folder }: { folder: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.folder === folder));
  const ai = useAi();
  const info = routeInfo(ai, "task.brief");
  const close = useAssist((s) => s.close);
  const setBusy = useAssist((s) => s.setBusy);

  const [phase, setPhase] = useState<Phase>("input");
  const [input, setInput] = useState("");
  const [overview, setOverview] = useState<string | null>(null);
  const [files, setFiles] = useState<BriefFile[] | null>(null);
  /** 끝낸 바퀴 수. */
  const [round, setRound] = useState(0);
  const [qa, setQa] = useState<BriefQa[]>([]);
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [questions, setQuestions] = useState<BriefQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, BriefAnswer>>({});
  /** "직접 입력" 칸을 연 질문. */
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [dropped, setDropped] = useState(0);
  const [unplaced, setUnplaced] = useState(0);
  /** 뺀 블록 · 체크의 열쇠. */
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  /** 옮긴 블록 — 원래 열쇠 → 새 자리. 다시 정리해도 같은 자리의 블록은 따라간다. */
  const [moved, setMoved] = useState<Record<string, BriefPlace>>({});
  /** 쓸 곳 고르기를 연 블록. */
  const [editing, setEditing] = useState<string | null>(null);
  const [savingAt, setSavingAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(0);
  /** 정리를 시작한 시각 · 받은 생각 글자 수 — 대기 띠와 단추가 쓴다. */
  const [thinkAt, setThinkAt] = useState<number | null>(null);
  const [thought, setThought] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    if (task) {
      void taskOverview(task, OVERVIEW_CAP)
        .then((o) => alive && setOverview(o))
        .catch(() => alive && setOverview(""));
    }
    void taskBriefFiles(folder)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
      abort.current?.abort();
    };
    // 열릴 때 한 번 읽는다. 바퀴마다 다시 읽지 않는다 — 정리하는 동안 개요 · 파일은 바뀌지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const date = today();
  const pendingQs = questions.filter((q) => !answered(answers[q.id]));
  const hasAnswers = questions.some((q) => answered(answers[q.id]));
  /** 보이는 계획 — AI 가 제안한 자리에 사람이 옮긴 것을 얹었다. 뺀 것도 보인다(다시 켤 수 있게). */
  const shown = useMemo(
    () => (draft ? movePlan(planBrief(draft, pendingQs.map((q) => q.ask), date), moved) : NO_PLAN),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, questions, answers, moved, date],
  );
  const final = withoutOff(shown, off);
  const groups = planFiles(shown);
  const finalFiles = planFiles(final).map((g) => g.path);
  const previews = useMemo(
    () => new Map(shown.blocks.map((b) => [b.key, mdParse(b.lines.join("\n"))])),
    [shown],
  );

  /**
   * 한 바퀴. 이번에 답한 질문을 문답(`aN`)으로 접어 보낸다. `thenSave` 면 질문 없이 돌리고 곧바로 넣는다 —
   * 그때 답하지 않은 질문은 "확인 필요" 로 간다.
   */
  const runRound = async (opts: { thenSave?: boolean } = {}) => {
    if (!task) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const before: Phase = draft ? "review" : "input";
    const newQa = [
      ...qa,
      ...questions
        .filter((q) => answered(answers[q.id]))
        .map((q, k) => {
          const a = answers[q.id]!;
          return { id: `a${qa.length + k + 1}`, ask: q.ask, answer: answerText(a), unknown: a.unknown };
        }),
    ];
    const left = questions.filter((q) => !answered(answers[q.id]));
    const next = round + 1;
    setPhase("thinking");
    setThinkAt(Date.now());
    setThought(0);
    setError(null);
    setPartial(0);
    const a = useAi.getState();
    const res = await briefRound(
      {
        run: routeRun(a, "task.brief"),
        task: { title: task.title, tags: task.tags, category: task.category, overview: overview ?? "" },
        input,
        qa: newQa,
        files: files ?? [],
        round: next,
        last: opts.thenSave ? true : undefined,
        today: today(),
        inject: injectionFor("task.brief", a.packs, a.settings),
      },
      {
        signal: ctl.signal,
        onPartial: (t) => abort.current === ctl && setPartial(t.length),
        onThinking: (n) => abort.current === ctl && setThought(n),
      },
    );
    if (abort.current !== ctl) return;
    if (res.error === CANCELED) {
      setError("취소했습니다");
      setPhase(before);
      return;
    }
    if (!res.draft) {
      // 앞 바퀴의 정리본과 답은 그대로 둔다 — 다시 시도하면 같은 답으로 묻는다.
      setError(res.error);
      setPhase("review");
      return;
    }
    setDraft(res.draft);
    setQuestions(res.questions);
    setAnswers({});
    setCustom({});
    setQa(newQa);
    setRound(next);
    setDropped(res.dropped);
    setUnplaced(res.unplaced);
    setError(res.error);
    if (opts.thenSave) await save(res.draft, left);
    else setPhase("review");
  };

  const save = async (d: BriefDraft, pending: BriefQuestion[]) => {
    const plan = withoutOff(movePlan(planBrief(d, pending.map((q) => q.ask), today()), moved), off);
    if (!planSize(plan)) {
      setError("쓸 내용이 없습니다 — 뺀 것을 다시 켜거나 입력을 고쳐 보세요");
      setPhase("review");
      return;
    }
    setPhase("saving");
    setSavingAt(Date.now());
    setBusy(true);
    try {
      const res = await applyBrief(folder, plan);
      const st = useStore.getState();
      if (res.missed) st.toast(`할 일 ${res.missed}개는 그 사이 바뀌어 체크하지 않았습니다`, "", TOAST.warn);
      if (res.fellBack) st.toast(`고른 섹션 ${res.fellBack}곳을 찾지 못해 기본 섹션에 넣었습니다`, "", TOAST.warn);
      close();
    } catch (e) {
      setError(api.errMessage(e));
      setPhase("review");
      setBusy(false);
    }
  };

  const onSave = () => {
    if (!draft || phase !== "review") return;
    if (hasAnswers) void runRound({ thenSave: true });
    else void save(draft, pendingQs);
  };

  const dismiss = () => {
    if (phase === "saving") return;
    abort.current?.abort();
    close();
  };

  const setAnswer = (id: string, patch: Partial<BriefAnswer>) =>
    setAnswers((prev) => ({ ...prev, [id]: { ...(prev[id] ?? NO_ANSWER), ...patch } }));

  const toggle = (key: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** 블록(과 그 블록으로 모인 원래 블록들)을 새 자리로 옮긴다. 고르기 칸은 옮긴 블록을 따라간다. */
  const move = (b: BriefBlock, to: BriefPlace) => {
    setMoved((prev) => ({ ...prev, ...Object.fromEntries(b.from.map((k) => [k, to])) }));
    setEditing(blockKey(to.path, to.heading ?? b.fallback));
  };

  const loading = overview === null || files === null;
  const canStart = !!input.trim() && !!info.run && !loading;
  const canSave = !!draft && (hasAnswers || planSize(final) > 0);
  const saveLabel = hasAnswers
    ? "답 반영 후 쓰기"
    : finalFiles.length > 1
      ? `파일 ${finalFiles.length}개에 쓰기`
      : finalFiles.length === 1
        ? `${finalFiles[0]} 에 쓰기`
        : "쓰기";
  const counts = draft
    ? [
        ["요구사항", draft.summary.length + draft.goals.length + draft.todos.length + draft.schedule.length],
        ["끝낸 일", draft.done.length],
        ["상황", draft.notes.length],
      ].filter(([, n]) => n)
    : [];

  return (
    <Modal width={1000} zIndex={77} onClose={dismiss} panelStyle={{ height: 620, maxHeight: "90vh" }}>
      <AssistHead title="간략 입력 정리" task={task?.title ?? ""}>
        <RouteLabel info={info} />
      </AssistHead>
      {/* 진행선 — AI 가 정리하는 동안. */}
      <div style={{ flex: "0 0 2px", height: 2 }}>{phase === "thinking" && <AiRail />}</div>

      {(phase === "input" || (phase === "thinking" && !draft)) && (
        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "12px 16px" }}>
          {!info.run && (
            <Notice tone="error">
              AI 연결이 없습니다 — 설정 → AI 연결 → 기능별 연결에서 '간략 입력 정리' 연결을 고르세요
            </Notice>
          )}
          {error && <Notice tone={error === "취소했습니다" ? "muted" : "error"}>{error}</Notice>}
          <div style={{ ...labelStyle, marginTop: 10 }}>지금 업무</div>
          <div
            style={{
              border: "1px dashed #ddd8cf",
              borderRadius: 6,
              padding: "8px 10px",
              background: "#faf9f6",
              fontSize: 12,
              lineHeight: 1.7,
              color: "#4a463f",
            }}
          >
            <div style={{ fontWeight: 600 }}>
              {task?.title}
              {task?.category && (
                <span style={{ fontWeight: 400, color: TEXT.sub }}> · {catLabel(task.category)}</span>
              )}
            </div>
            <div style={{ color: TEXT.sub, whiteSpace: "pre-wrap", maxHeight: 90, overflow: "hidden" }}>
              {loading ? (
                // 개요 · 파일은 디스크에서 읽는다(AI 가 아니다) — 회색 스켈레톤으로 자리만.
                <span style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }} title="업무 파일을 읽는 중">
                  <Skeleton width="92%" height={9} />
                  <Skeleton width="64%" height={9} />
                </span>
              ) : overview.trim() ? (
                overview.slice(0, 300)
              ) : (
                "(개요가 아직 비어 있습니다)"
              )}
            </div>
            {!loading && files.length > 0 && (
              <div style={{ color: TEXT.sub }}>
                글 파일 {files.length}개 — {files.slice(0, 6).map((f) => f.path).join(" · ")}
                {files.length > 6 ? " …" : ""}
              </div>
            )}
          </div>

          <div style={{ ...labelStyle, marginTop: 14 }}>적을 것 — 새 요구사항 · 끝낸 일 · 지금 상황, 한두 줄이면 됩니다</div>
          <TextArea
            autoFocus
            value={input}
            disabled={phase !== "input"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canStart) {
                e.preventDefault();
                void runRound();
              }
            }}
            placeholder={"예: QA팀 검증 끝남, 결제 실패 0건. PG사가 API 키 발급을 다음 주로 미룸\n예: 다음주 금요일까지 결제 PG사 교체, QA팀 검증 받아야 함"}
            rows={5}
            style={{
              ...inputStyle,
              height: "auto",
              padding: "8px 9px",
              lineHeight: 1.6,
              resize: "vertical",
              fontFamily: "inherit",
            }}
            focusStyle={inputFocus}
          />
          <div style={{ fontSize: 11, color: "#6a665e", lineHeight: 1.7, marginTop: 6 }}>
            적은 것과 업무 제목 · 카테고리 · 태그 · 지금 개요, 업무 폴더 글 파일의 이름 · 제목 · 열린 할 일 · 앞부분이 AI
            연결로 나갑니다. 적힌 사실만 정리해 알맞은 파일 · 섹션을 제안하고(끝낸 일은 맞는 할 일의 체크까지), 새
            요구사항에 빠진 것은 선택지나 입력으로 되묻습니다(최대 {BRIEF_ROUNDS}바퀴). 쓰기 전에 고를 수 있습니다.{" "}
            {input.length > INPUT_CAP ? `앞 ${INPUT_CAP.toLocaleString()}자만 보냅니다. ` : ""}Ctrl+Enter 로 시작합니다.
          </div>
          {phase === "thinking" && (
            <ThinkingLine
              name={info.name}
              since={thinkAt}
              partial={partial}
              thought={thought}
              margin="9px 0 0"
              onCancel={() => abort.current?.abort()}
            />
          )}
        </div>
      )}

      {(phase === "review" || phase === "saving" || (phase === "thinking" && draft)) && (
        <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex" }}>
          {/* 왼쪽 — 입력과 질문 */}
          <div
            style={{
              flex: "0 0 420px",
              minWidth: 0,
              overflowY: "auto",
              borderRight: "1px solid #efebe4",
              padding: "10px 14px 14px 14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 5 }}>
              <span style={{ ...labelStyle, marginBottom: 0 }}>적은 것</span>
              <div style={{ flex: 1 }} />
              {phase === "review" && (
                <Box
                  onClick={() => setPhase("input")}
                  style={{ fontSize: 11.5, color: "#3a6fd8", cursor: "pointer" }}
                  hover={{ textDecoration: "underline" }}
                >
                  입력 고치기
                </Box>
              )}
            </div>
            <div
              style={{
                fontSize: 12.5,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: "#f7f5f1",
                border: "1px solid #ece8e0",
                borderRadius: 6,
                padding: "7px 9px",
              }}
            >
              {input}
            </div>
            {counts.length > 0 && (
              <div style={{ fontSize: 11.5, color: TEXT.sub, marginTop: 5 }}>
                정리: {counts.map(([k, n]) => `${k} ${n}`).join(" · ")}
              </div>
            )}

            {qa.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={labelStyle}>앞서 답한 것</div>
                {qa.map((q) => (
                  <div key={q.id} style={{ fontSize: 11.5, lineHeight: 1.6, color: "#3a3630", marginBottom: 3 }}>
                    <span style={{ color: "#6a665e" }}>{q.ask}</span> → {q.unknown ? "모름" : q.answer}
                  </div>
                ))}
              </div>
            )}

            {questions.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={labelStyle}>더 알려 주세요 — 답하지 않은 것은 "확인 필요" 로 남습니다</div>
                {questions.map((q, n) => (
                  <QuestionCard
                    key={q.id}
                    n={n + 1}
                    q={q}
                    a={answers[q.id] ?? NO_ANSWER}
                    custom={!!custom[q.id]}
                    disabled={phase !== "review"}
                    onCustom={(on) => setCustom((p) => ({ ...p, [q.id]: on }))}
                    onChange={(patch) => setAnswer(q.id, patch)}
                  />
                ))}
              </div>
            )}
            {draft && !questions.length && (
              <div style={{ fontSize: 11.5, color: "#6a665e", lineHeight: 1.7, marginTop: 12 }}>
                {round >= BRIEF_ROUNDS
                  ? "보완은 여기까지입니다. 정해지지 않은 것은 “확인 필요” 에 남깁니다."
                  : "더 물을 것이 없습니다."}
              </div>
            )}
          </div>

          {/* 오른쪽 — 정리본 미리보기 */}
          <div style={{ flex: "1 1 auto", minWidth: 0, overflowY: "auto", paddingBottom: 14 }}>
            {phase === "thinking" && (
              <ThinkingLine
                name={info.name}
                since={thinkAt}
                partial={partial}
                thought={thought}
                margin="9px 14px 0"
                onCancel={() => abort.current?.abort()}
              />
            )}
            {error && <Notice tone={error === "취소했습니다" ? "muted" : draft ? "warn" : "error"}>{error}</Notice>}
            {dropped > 0 && (
              <Notice tone="warn">
                근거(적은 것 · 답)를 댈 수 없는 항목 {dropped}개를 뺐습니다 — 필요하면 직접 적거나 답으로 알려 주세요
              </Notice>
            )}
            {unplaced > 0 && (
              <Notice tone="warn">
                AI 가 고른 자리 {unplaced}곳이 이 업무 폴더에 없어 기본 자리(index.md)로 돌렸습니다
              </Notice>
            )}
            {draft && !hasContent(draft) && (
              <Notice tone="muted">정리할 사실이 아직 없습니다 — 질문에 답하거나 입력을 고쳐 보세요</Notice>
            )}
            {draft && hasContent(draft) && (
              <div style={{ padding: "10px 18px 0 18px" }}>
                <div style={{ ...labelStyle, marginBottom: 2 }}>
                  쓸 내용 — 섹션 끝에 없는 줄만 덧붙이고, 이미 적힌 줄은 지우거나 바꾸지 않습니다
                </div>
                {groups.map((g) => (
                  <div key={g.path} style={{ marginTop: 12 }}>
                    <div
                      style={{
                        fontFamily: "'Roboto Mono',monospace",
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: "#3a3630",
                        wordBreak: "break-all",
                      }}
                    >
                      {g.path}
                    </div>
                    {g.checks.map((c) => (
                      <CheckRow
                        key={c.key}
                        c={c}
                        on={!off.has(c.key)}
                        disabled={phase !== "review"}
                        onToggle={() => toggle(c.key)}
                      />
                    ))}
                    {g.blocks.map((b) => (
                      <BlockCard
                        key={b.key}
                        b={b}
                        on={!off.has(b.key)}
                        exists={sectionExists(files, b)}
                        files={files ?? []}
                        editing={editing === b.key}
                        disabled={phase !== "review"}
                        preview={previews.get(b.key) ?? []}
                        onToggle={() => toggle(b.key)}
                        onEdit={() => setEditing(editing === b.key ? null : b.key)}
                        onMove={(to) => move(b, to)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ModalFooter>
        {phase === "input" && (
          <>
            <div style={{ flex: 1 }} />
            {draft && <GhostButton onClick={() => setPhase("review")}>← 정리본으로</GhostButton>}
            <GhostButton onClick={dismiss}>닫기</GhostButton>
            <PrimaryButton onClick={() => void runRound()} disabled={!canStart}>
              {draft ? "다시 정리 →" : "정리 시작 →"}
            </PrimaryButton>
          </>
        )}
        {phase === "thinking" && (
          <>
            <div style={{ flex: 1 }} />
            <GhostButton onClick={dismiss}>닫기</GhostButton>
            <PrimaryButton onClick={() => undefined} busy minWidth={120}>
              <BusyLabel busy since={thinkAt} color="#fff" idle="">
                정리하는 중
              </BusyLabel>
            </PrimaryButton>
          </>
        )}
        {(phase === "review" || phase === "saving") && (
          <>
            <span style={{ fontSize: 11.5, color: TEXT.sub }}>
              보완 {Math.min(round, BRIEF_ROUNDS)}/{BRIEF_ROUNDS}
            </span>
            {!draft && phase === "review" && <GhostButton onClick={() => void runRound()}>다시 시도</GhostButton>}
            <div style={{ flex: 1 }} />
            <GhostButton onClick={dismiss}>닫기</GhostButton>
            {questions.length > 0 && round < BRIEF_ROUNDS && (
              <GhostButton onClick={() => phase === "review" && hasAnswers && void runRound()}>
                <span style={{ color: hasAnswers ? undefined : "#b5b0a6" }}>답 반영해 다시 정리</span>
              </GhostButton>
            )}
            <PrimaryButton onClick={onSave} disabled={!canSave} busy={phase === "saving"} minWidth={120}>
              <BusyLabel busy={phase === "saving"} since={savingAt} color="#fff" idle={saveLabel}>
                쓰는 중
              </BusyLabel>
            </PrimaryButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

/** 정리하는 동안의 안내 띠 — 생각만 하는 동안은 "생각하는 중" 과 생각 글자 수. */
function ThinkingLine({
  name,
  since,
  partial,
  thought,
  margin,
  onCancel,
}: {
  name: string | null;
  since: number | null;
  partial: number;
  thought: number;
  margin: string;
  onCancel: () => void;
}) {
  return (
    <AiWaitBar
      since={since}
      label={`${name ?? "AI"} 가 ${!partial && thought ? "생각하는 중" : "정리하는 중"}`}
      chars={partial}
      thinking={thought}
      onCancel={onCancel}
      style={{ margin }}
    />
  );
}

/** 그 블록의 섹션이 지금 파일에 있는가 — 모르면(후보 밖 파일) `null`. */
function sectionExists(files: BriefFile[] | null, b: BriefBlock): boolean | null {
  const f = files?.find((x) => x.path === b.path);
  if (!f) return null;
  const want = headingKey(b.heading);
  return f.headings.some((h) => headingKey(h.raw) === want);
}

/** 체크할 열린 할 일 한 줄 — 끄면 그 줄은 그대로 둔다. */
function CheckRow({
  c,
  on,
  disabled,
  onToggle,
}: {
  c: BriefCheck;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 7,
        marginTop: 7,
        padding: "6px 10px",
        borderRadius: 6,
        border: "1px solid #e3eadf",
        background: on ? "#f6faf3" : "#fff",
        fontSize: 12.5,
        lineHeight: 1.55,
        color: on ? "#23211e" : TEXT.off,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <input type="checkbox" checked={on} disabled={disabled} onChange={onToggle} style={{ marginTop: 3 }} />
      <span style={{ minWidth: 0, wordBreak: "break-word" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: on ? "#4f7a3a" : TEXT.off, marginRight: 6 }}>
          할 일 체크 [ ] → [x]
        </span>
        {c.text}
      </span>
    </label>
  );
}

/** 한 섹션에 덧붙일 줄 — 빼기 · 다른 파일 · 섹션으로 옮기기. */
function BlockCard({
  b,
  on,
  exists,
  files,
  editing,
  disabled,
  preview,
  onToggle,
  onEdit,
  onMove,
}: {
  b: BriefBlock;
  on: boolean;
  exists: boolean | null;
  files: BriefFile[];
  editing: boolean;
  disabled: boolean;
  preview: ReturnType<typeof mdParse>;
  onToggle: () => void;
  onEdit: () => void;
  onMove: (to: BriefPlace) => void;
}) {
  const file = files.find((f) => f.path === b.path);
  const paths = files.some((f) => f.path === b.path) ? files.map((f) => f.path) : [b.path, ...files.map((f) => f.path)];
  const where = exists === false ? "새로 만들어 넣음" : exists ? "끝에 덧붙임" : "끝에 덧붙임 (없으면 만듦)";
  return (
    <div
      style={{
        marginTop: 7,
        padding: "7px 10px 8px",
        borderRadius: 6,
        border: "1px solid #eae6de",
        background: "#fff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <input type="checkbox" checked={on} disabled={disabled} onChange={onToggle} />
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: on ? "#23211e" : TEXT.off,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={b.heading}
        >
          {b.heading}
        </span>
        <span style={{ fontSize: 11, color: TEXT.hint, whiteSpace: "nowrap" }}>{where}</span>
        <div style={{ flex: 1 }} />
        {!disabled && files.length > 0 && (
          <Box
            onClick={onEdit}
            style={{ fontSize: 11.5, color: "#3a6fd8", cursor: "pointer", whiteSpace: "nowrap" }}
            hover={{ textDecoration: "underline" }}
          >
            {editing ? "닫기" : "옮기기"}
          </Box>
        )}
      </div>
      {editing && !disabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5, margin: "7px 0 2px 21px" }}>
          <select value={b.path} onChange={(e) => onMove({ path: e.target.value, heading: null })} style={selectStyle}>
            {paths.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            value={headingKey(b.heading) === headingKey(b.fallback) ? "" : b.heading}
            onChange={(e) => onMove({ path: b.path, heading: e.target.value || null })}
            style={selectStyle}
          >
            <option value="">{`(기본 — ${b.fallback})`}</option>
            {file?.headings
              .filter((h) => headingKey(h.raw) !== headingKey(b.fallback))
              .map((h) => (
                <option key={h.id} value={h.raw}>
                  {`${"  ".repeat(h.level - 1)}${h.text}`}
                </option>
              ))}
          </select>
        </div>
      )}
      {on && (
        <div style={{ marginTop: 4, paddingLeft: 21 }}>
          <MarkdownView blocks={preview} inline />
        </div>
      )}
    </div>
  );
}

function QuestionCard({
  n,
  q,
  a,
  custom,
  disabled,
  onCustom,
  onChange,
}: {
  n: number;
  q: BriefQuestion;
  a: BriefAnswer;
  custom: boolean;
  disabled: boolean;
  onCustom: (on: boolean) => void;
  onChange: (patch: Partial<BriefAnswer>) => void;
}) {
  const showText = q.kind === "text" || custom || !!a.text;
  const pick = (opt: string) => {
    if (disabled) return;
    if (q.kind === "multi") {
      const picks = a.picks.includes(opt) ? a.picks.filter((p) => p !== opt) : [...a.picks, opt];
      onChange({ picks, unknown: false });
    } else {
      onChange({ picks: a.picks.includes(opt) ? [] : [opt], unknown: false });
    }
  };
  return (
    <div
      style={{
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: 6,
        border: `1px solid ${answered(a) ? "#cddcf8" : "#eae6de"}`,
        background: answered(a) ? "#f7fafe" : "#fff",
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#23211e", lineHeight: 1.5 }}>
        <span style={{ color: "#8a857c", marginRight: 5 }}>Q{n}</span>
        {q.ask}
        {q.kind === "multi" && <span style={{ fontWeight: 400, color: "#8a857c" }}> (여러 개)</span>}
      </div>
      {q.why && <div style={{ fontSize: 11, color: "#6a665e", marginTop: 2, lineHeight: 1.5 }}>{q.why}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
        {q.options.map((opt) => (
          <Box key={opt} title={opt} onClick={() => pick(opt)} style={chipStyle(a.picks.includes(opt))}>
            {opt}
          </Box>
        ))}
        {q.kind !== "text" && (
          <Box
            onClick={() => {
              if (disabled) return;
              onCustom(!custom);
              if (custom) onChange({ text: "" });
            }}
            style={chipStyle(custom || !!a.text)}
          >
            직접 입력
          </Box>
        )}
        <Box
          onClick={() => !disabled && onChange(a.unknown ? { unknown: false } : { picks: [], text: "", unknown: true })}
          style={chipStyle(a.unknown)}
          title="모르면 다시 묻지 않고 '확인 필요' 에 남깁니다"
        >
          모름
        </Box>
      </div>
      {showText && !a.unknown && (
        <Input
          value={a.text}
          disabled={disabled}
          autoFocus={custom && !a.text}
          onChange={(e) => onChange({ text: e.target.value, unknown: false })}
          placeholder={q.kind === "text" ? "답을 적어 주세요" : "선택지에 없으면 적어 주세요"}
          style={{ ...inputStyle, marginTop: 7 }}
          focusStyle={inputFocus}
        />
      )}
    </div>
  );
}
