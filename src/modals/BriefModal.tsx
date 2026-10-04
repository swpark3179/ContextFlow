import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { label as catLabel } from "../lib/category";
import { today } from "../lib/format";
import { mdParse } from "../lib/markdown";
import { injectionFor } from "../lib/promptPacks";
import { CANCELED } from "../lib/runOnce";
import { Box, Input, TextArea } from "../lib/ui";
import {
  BRIEF_ROUNDS,
  answerText,
  answered,
  briefMarkdown,
  briefRound,
  hasContent,
  mergeIntoIndex,
  renderBrief,
  type BriefAnswer,
  type BriefDraft,
  type BriefQa,
  type BriefQuestion,
} from "../lib/assist/brief";
import MarkdownView from "../components/MarkdownView";
import { applyToTaskFile, taskOverview, useAssist } from "../store/assistStore";
import { routeInfo, routeRun, useAi } from "../store/aiStore";
import { useStore } from "../store/useStore";
import { AssistHead, Notice, RouteLabel, chipStyle } from "./AssistParts";
import { GhostButton, Modal, ModalFooter, PrimaryButton, inputFocus, inputStyle, labelStyle } from "./Modal";

/**
 * 간략 입력 정리 — 한두 줄 요구사항을 개요 · 할 일 · 일정 · 관련 · 확인 필요로 정리해 index.md 에 넣는다.
 *
 * 바퀴마다 정리본 미리보기와 빠진 것을 묻는 질문을 함께 보인다. 답하고 [답 반영해 다시 정리] 를 되풀이하거나
 * (최대 `BRIEF_ROUNDS` 바퀴), 언제든 [index.md 에 넣기]. 답만 하고 다시 정리하지 않았으면 넣기 전에 한 바퀴를
 * 질문 없이 돌려 답을 반영한다. 끝까지 답하지 않은 질문은 "확인 필요" 에 남는다 — 모르는 것을 지어내지 않는다.
 */
export default function BriefModal() {
  const brief = useAssist((s) => s.brief);
  if (!brief) return null;
  return <BriefView key={brief.folder} folder={brief.folder} />;
}

type Phase = "input" | "thinking" | "review" | "saving";

const NO_ANSWER: BriefAnswer = { picks: [], text: "", unknown: false };
const OVERVIEW_CAP = 1_500;

function BriefView({ folder }: { folder: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.folder === folder));
  const ai = useAi();
  const info = routeInfo(ai, "task.brief");
  const close = useAssist((s) => s.close);
  const setBusy = useAssist((s) => s.setBusy);

  const [phase, setPhase] = useState<Phase>("input");
  const [input, setInput] = useState("");
  const [overview, setOverview] = useState<string | null>(null);
  /** 끝낸 바퀴 수. */
  const [round, setRound] = useState(0);
  const [qa, setQa] = useState<BriefQa[]>([]);
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [questions, setQuestions] = useState<BriefQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, BriefAnswer>>({});
  /** "직접 입력" 칸을 연 질문. */
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    if (task) {
      void taskOverview(task, OVERVIEW_CAP)
        .then((o) => alive && setOverview(o))
        .catch(() => alive && setOverview(""));
    }
    return () => {
      alive = false;
      abort.current?.abort();
    };
    // 열릴 때 한 번 읽는다. 바퀴마다 다시 읽지 않는다 — 정리하는 동안 개요는 바뀌지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingQs = questions.filter((q) => !answered(answers[q.id]));
  const hasAnswers = questions.some((q) => answered(answers[q.id]));
  const sections = useMemo(
    () => (draft ? renderBrief(draft, pendingQs.map((q) => q.ask)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, questions, answers],
  );
  const preview = useMemo(() => mdParse(briefMarkdown(sections)), [sections]);

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
    setError(null);
    setPartial(0);
    const a = useAi.getState();
    const res = await briefRound(
      {
        run: routeRun(a, "task.brief"),
        task: { title: task.title, tags: task.tags, category: task.category, overview: overview ?? "" },
        input,
        qa: newQa,
        round: next,
        last: opts.thenSave ? true : undefined,
        today: today(),
        inject: injectionFor("task.brief", a.packs, a.settings),
      },
      { signal: ctl.signal, onPartial: (t) => abort.current === ctl && setPartial(t.length) },
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
    setError(res.error);
    if (opts.thenSave) await save(res.draft, left);
    else setPhase("review");
  };

  const save = async (d: BriefDraft, pending: BriefQuestion[]) => {
    setPhase("saving");
    setBusy(true);
    try {
      const secs = renderBrief(d, pending.map((q) => q.ask));
      await applyToTaskFile(folder, "index.md", (old) => mergeIntoIndex(old, secs));
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

  const canStart = !!input.trim() && !!info.run && overview !== null;
  const canSave = !!draft && hasContent(draft);

  return (
    <Modal width={1000} zIndex={77} onClose={dismiss} panelStyle={{ height: 620, maxHeight: "90vh" }}>
      <AssistHead title="간략 입력 정리" task={task?.title ?? ""}>
        <RouteLabel info={info} />
      </AssistHead>

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
                <span style={{ fontWeight: 400, color: "#8a857c" }}> · {catLabel(task.category)}</span>
              )}
            </div>
            <div style={{ color: "#8a857c", whiteSpace: "pre-wrap", maxHeight: 90, overflow: "hidden" }}>
              {overview === null ? "개요를 읽는 중…" : overview.trim() ? overview.slice(0, 300) : "(개요가 아직 비어 있습니다)"}
            </div>
          </div>

          <div style={{ ...labelStyle, marginTop: 14 }}>요구사항 — 한두 줄이면 됩니다</div>
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
            placeholder="예: 다음주 금요일까지 결제 PG사 교체, QA팀 검증 받아야 함"
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
          <div style={{ fontSize: 11, color: "#8a857c", lineHeight: 1.7, marginTop: 6 }}>
            적은 것과 업무 제목 · 카테고리 · 태그 · 지금 개요가 AI 연결로 나갑니다. 적힌 사실만 정리하고, 빠진 것은
            선택지나 입력으로 되묻습니다(최대 {BRIEF_ROUNDS}바퀴). Ctrl+Enter 로 시작합니다.
          </div>
          {phase === "thinking" && <ThinkingLine name={info.name} partial={partial} onCancel={() => abort.current?.abort()} />}
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

            {qa.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={labelStyle}>앞서 답한 것</div>
                {qa.map((q) => (
                  <div key={q.id} style={{ fontSize: 11.5, lineHeight: 1.6, color: "#6a665e", marginBottom: 3 }}>
                    <span style={{ color: "#a09a8f" }}>{q.ask}</span> → {q.unknown ? "모름" : q.answer}
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
              <div style={{ fontSize: 11.5, color: "#8a857c", lineHeight: 1.7, marginTop: 12 }}>
                {round >= BRIEF_ROUNDS
                  ? "보완은 여기까지입니다. 정해지지 않은 것은 “확인 필요” 에 남깁니다."
                  : "더 물을 것이 없습니다."}
              </div>
            )}
          </div>

          {/* 오른쪽 — 정리본 미리보기 */}
          <div style={{ flex: "1 1 auto", minWidth: 0, overflowY: "auto", paddingBottom: 14 }}>
            {phase === "thinking" && (
              <ThinkingLine name={info.name} partial={partial} onCancel={() => abort.current?.abort()} />
            )}
            {error && <Notice tone={error === "취소했습니다" ? "muted" : draft ? "warn" : "error"}>{error}</Notice>}
            {dropped > 0 && (
              <Notice tone="warn">
                근거(적은 것 · 답)를 댈 수 없는 항목 {dropped}개를 뺐습니다 — 필요하면 직접 적거나 답으로 알려 주세요
              </Notice>
            )}
            {draft && !hasContent(draft) && (
              <Notice tone="muted">정리할 사실이 아직 없습니다 — 질문에 답하거나 입력을 고쳐 보세요</Notice>
            )}
            {draft && hasContent(draft) && (
              <div style={{ padding: "10px 18px 0 18px" }}>
                <div style={{ ...labelStyle, marginBottom: 8 }}>
                  index.md 에 넣을 내용 — 섹션별로 덧붙이고, 이미 적힌 줄은 지우거나 바꾸지 않습니다
                </div>
                <MarkdownView blocks={preview} inline />
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
            <PrimaryButton onClick={() => undefined} disabled>
              정리하는 중…
            </PrimaryButton>
          </>
        )}
        {(phase === "review" || phase === "saving") && (
          <>
            <span style={{ fontSize: 11, color: "#a09a8f" }}>
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
            <PrimaryButton onClick={onSave} disabled={!canSave || phase === "saving"}>
              {phase === "saving" ? "넣는 중…" : hasAnswers ? "답 반영 후 index.md 에 넣기" : "index.md 에 넣기"}
            </PrimaryButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

function ThinkingLine({ name, partial, onCancel }: { name: string | null; partial: number; onCancel: () => void }) {
  return (
    <Notice tone="muted">
      {name ?? "AI"} 가 정리하는 중… {partial ? `(${partial.toLocaleString()}자)` : ""}{" "}
      <Box onClick={onCancel} style={{ display: "inline", color: "#3a6fd8", cursor: "pointer" }}>
        취소
      </Box>
    </Notice>
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
        <span style={{ color: "#a09a8f", marginRight: 5 }}>Q{n}</span>
        {q.ask}
        {q.kind === "multi" && <span style={{ fontWeight: 400, color: "#a09a8f" }}> (여러 개)</span>}
      </div>
      {q.why && <div style={{ fontSize: 11, color: "#8a857c", marginTop: 2, lineHeight: 1.5 }}>{q.why}</div>}
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
