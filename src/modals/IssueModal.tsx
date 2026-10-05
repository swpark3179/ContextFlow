import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { label as catLabel } from "../lib/category";
import { nowStamp, today } from "../lib/format";
import { mdParse } from "../lib/markdown";
import { injectionFor } from "../lib/promptPacks";
import { CANCELED } from "../lib/runOnce";
import { AiRail, AiWaitBar, Box, BusyLabel, Input, Skeleton, TextArea } from "../lib/ui";
import { TEXT, TOAST } from "../lib/design";
import {
  INPUT_CAP,
  ISSUE_DIR,
  ISSUE_INDEX_HEADING,
  ISSUE_KINDS,
  ISSUE_KIND_LABEL,
  OVERVIEW_CAP,
  entryLevel,
  hasIssueContent,
  issueIndexLine,
  issueName,
  issueRun,
  renderIssueEntry,
  renderIssueFile,
  safeStem,
  uniqueRel,
  type IssueDraft,
  type IssueFile,
  type IssueKind,
  type IssueTarget,
} from "../lib/assist/issue";
import MarkdownView from "../components/MarkdownView";
import { applyIssue, taskIssueFiles, taskOverview, useAssist, type IssuePlan } from "../store/assistStore";
import { routeInfo, routeRun, useAi } from "../store/aiStore";
import { useStore } from "../store/useStore";
import { AssistHead, Notice, RouteLabel, chipStyle } from "./AssistParts";
import {
  GhostButton,
  Modal,
  ModalFooter,
  OptionCard,
  PrimaryButton,
  inputFocus,
  inputStyle,
  labelStyle,
} from "./Modal";

/**
 * 이슈 추가 — 업무 중 새로 생긴 일 · 테스트 회신 · 문제를 짧게 적으면 정리해서, 그 이슈를 처리할 새 파일
 * (`이슈/…md`)을 만들거나 기존 파일의 알맞은 섹션에 한 건으로 넣고 그 탭을 연다.
 *
 * 한 번에 정리한다(되묻지 않는다 — 빠진 것은 "확인 필요"). AI 가 쓸 곳을 제안하고, 사람이 바꿀 수 있으며,
 * **[쓰고 열기]** 를 누른 뒤에만 쓴다. 대상이 index.md 가 아니면 index.md 의 `## 이슈` 에 한 줄을 남긴다.
 */
export default function IssueModal() {
  const issue = useAssist((s) => s.issue);
  if (!issue) return null;
  return <IssueView key={issue.folder} folder={issue.folder} />;
}

type Phase = "input" | "thinking" | "review" | "saving";

function IssueView({ folder }: { folder: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.folder === folder));
  const taskFiles = useStore((s) => s.files);
  const ai = useAi();
  const info = routeInfo(ai, "task.issue");
  const close = useAssist((s) => s.close);
  const setBusy = useAssist((s) => s.setBusy);

  const [phase, setPhase] = useState<Phase>("input");
  const [input, setInput] = useState("");
  const [overview, setOverview] = useState<string | null>(null);
  const [files, setFiles] = useState<IssueFile[] | null>(null);

  const [draft, setDraft] = useState<IssueDraft | null>(null);
  const [suggested, setSuggested] = useState<IssueTarget | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<IssueKind>("other");
  const [mode, setMode] = useState<"new" | "existing">("new");
  /** 새 파일 이름(`이슈/` 뒤, 확장자 앞). */
  const [stem, setStem] = useState("");
  /** 사람이 파일 이름을 고쳤다 — 그 뒤로는 제목을 따라 바꾸지 않는다. */
  const [stemTouched, setStemTouched] = useState(false);
  const [path, setPath] = useState("index.md");
  /** 넣을 섹션의 제목 줄. 빈 문자열이면 파일 끝. */
  const [heading, setHeading] = useState("");
  const [withIndex, setWithIndex] = useState(true);

  const [dropped, setDropped] = useState(0);
  const [retargeted, setRetargeted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(0);
  const [thinkAt, setThinkAt] = useState<number | null>(null);
  const [thought, setThought] = useState(0);
  const [savingAt, setSavingAt] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    if (task) {
      void taskOverview(task, OVERVIEW_CAP)
        .then((o) => alive && setOverview(o))
        .catch(() => alive && setOverview(""));
    }
    void taskIssueFiles(folder)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
      abort.current?.abort();
    };
    // 열릴 때 한 번 읽는다. 다시 정리할 때 다시 읽지 않는다 — 팝업이 열린 동안 파일은 그대로다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const date = today();

  const run = async () => {
    if (!task || overview === null || files === null) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setPhase("thinking");
    setThinkAt(Date.now());
    setThought(0);
    setPartial(0);
    setError(null);
    const a = useAi.getState();
    const res = await issueRun(
      {
        run: routeRun(a, "task.issue"),
        task: { title: task.title, tags: task.tags, category: task.category, overview },
        input,
        files,
        today: date,
        inject: injectionFor("task.issue", a.packs, a.settings),
      },
      {
        signal: ctl.signal,
        onPartial: (t) => abort.current === ctl && setPartial(t.length),
        onThinking: (n) => abort.current === ctl && setThought(n),
      },
    );
    if (abort.current !== ctl) return;
    if (res.error === CANCELED || !res.draft || !res.target) {
      // 입력으로 돌아간다. 앞서 받은 정리본은 그대로 둔다 — [← 정리본으로] 로 돌아가거나 다시 시도한다.
      setError(res.error === CANCELED ? "취소했습니다" : res.error);
      setPhase("input");
      return;
    }
    const d = res.draft;
    const t = res.target;
    setDraft(d);
    setSuggested(t);
    setTitle(d.title);
    setKind(d.kind);
    setDropped(res.dropped);
    setRetargeted(res.retargeted);
    setError(res.error);
    setStemTouched(false);
    setStem(`${date} ${t.mode === "new" ? t.name : issueName("", d.title)}`);
    if (t.mode === "existing") {
      setMode("existing");
      setPath(t.path);
      setHeading(t.heading ?? "");
    } else {
      setMode("new");
      setPath(files[0]?.path ?? "index.md");
      setHeading("");
    }
    setPhase("review");
  };

  /** 사람이 고친 제목 · 종류를 얹은 정리본. */
  const edited = useMemo<IssueDraft | null>(
    () => (draft ? { ...draft, title: title.trim() || draft.title, kind } : null),
    [draft, title, kind],
  );

  /** 쓸 곳과 쓸 글. `stamp` 는 새 파일 머리의 시각 — 미리보기와 저장이 따로 찍는다. */
  const makePlan = (stamp: string): IssuePlan | null => {
    if (!edited) return null;
    if (mode === "new") {
      const name = safeStem(stem);
      if (!name) return null;
      const rel = uniqueRel(
        taskFiles.map((f) => f.p),
        `${ISSUE_DIR}/${name}.md`,
      );
      return {
        mode: "new",
        rel,
        body: renderIssueFile(edited, stamp),
        entry: renderIssueEntry(edited, date, 2),
        indexLine: withIndex ? issueIndexLine(edited, date, rel) : null,
      };
    }
    if (!path) return null;
    const h = heading || null;
    return {
      mode: "existing",
      rel: path,
      heading: h,
      entry: renderIssueEntry(edited, date, entryLevel(h)),
      indexLine: withIndex && path !== "index.md" ? issueIndexLine(edited, date, path) : null,
    };
  };
  const previewStamp = useMemo(() => nowStamp(), [draft]);
  const plan = makePlan(previewStamp);
  const previewText = plan ? (plan.mode === "new" ? plan.body : plan.entry) : "";
  const preview = useMemo(() => mdParse(previewText), [previewText]);

  const onTitle = (v: string) => {
    setTitle(v);
    if (!stemTouched) setStem(`${date} ${issueName(v, draft?.title ?? "")}`);
  };

  const save = async () => {
    if (phase !== "review") return;
    const p = makePlan(nowStamp());
    if (!p) return;
    setPhase("saving");
    setSavingAt(Date.now());
    setBusy(true);
    setError(null);
    try {
      const res = await applyIssue(folder, p);
      const st = useStore.getState();
      if (!res.placed) st.toast("고른 섹션을 찾지 못해 파일 끝에 넣었습니다", res.rel, TOAST.warn);
      if (res.indexError) st.toast("이슈는 썼지만 index.md 에 줄을 남기지 못했습니다", res.indexError, TOAST.warn);
      close();
    } catch (e) {
      setError(api.errMessage(e));
      setPhase("review");
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (phase === "saving") return;
    abort.current?.abort();
    close();
  };

  const loading = overview === null || files === null;
  const canStart = !!input.trim() && !!info.run && !loading;
  const canSave = !!edited && hasIssueContent(edited) && !!plan;
  const file = files?.find((f) => f.path === path);
  const aiNew = suggested?.mode === "new";
  const aiHere = suggested?.mode === "existing" && suggested.path === path;

  return (
    <Modal width={1000} zIndex={77} onClose={dismiss} panelStyle={{ height: 620, maxHeight: "90vh" }}>
      <AssistHead title="이슈 추가" task={task?.title ?? ""}>
        <RouteLabel info={info} />
      </AssistHead>
      {/* 진행선 — AI 가 정리하는 동안. */}
      <div style={{ flex: "0 0 2px", height: 2 }}>{phase === "thinking" && <AiRail />}</div>

      {(phase === "input" || phase === "thinking") && (
        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "12px 16px" }}>
          {!info.run && <Notice tone="error">{"AI 연결이 없습니다 — 설정 → AI 연결 → 기능별 연결에서 '이슈 추가' 연결을 고르세요"}</Notice>}
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
            {loading ? (
              // 개요 · 파일은 디스크에서 읽는다(AI 가 아니다) — 회색 스켈레톤으로 자리만.
              <span style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }} title="업무 파일을 읽는 중">
                <Skeleton width="92%" height={9} />
                <Skeleton width="64%" height={9} />
              </span>
            ) : (
              <div style={{ color: TEXT.sub }}>
                글 파일 {files.length}개 — {files.slice(0, 6).map((f) => f.path).join(" · ")}
                {files.length > 6 ? " …" : ""}
              </div>
            )}
          </div>

          <div style={{ ...labelStyle, marginTop: 14 }}>새 이슈 — 새로 생긴 일 · 테스트 회신 · 문제를 적거나 붙여 넣으세요</div>
          <TextArea
            autoFocus
            value={input}
            disabled={phase !== "input"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canStart) {
                e.preventDefault();
                void run();
              }
            }}
            placeholder="예: QA 회신 — B카드사 결제가 3DS 인증 뒤 실패함. 다른 카드사는 정상. 금요일 재테스트 예정"
            rows={7}
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
            적은 것과 업무 제목 · 카테고리 · 태그 · 개요, 업무 폴더 글 파일의 이름 · 제목 · 앞부분이 AI 연결로
            나갑니다. 적힌 사실만 정리하고 빠진 것은 "확인 필요" 로 남깁니다. 쓸 곳은 AI 가 제안하고, 쓰기 전에 고를 수
            있습니다. {input.length > INPUT_CAP ? `앞 ${INPUT_CAP.toLocaleString()}자만 보냅니다. ` : ""}Ctrl+Enter 로
            시작합니다.
          </div>
          {phase === "thinking" && (
            <AiWaitBar
              since={thinkAt}
              label={`${info.name ?? "AI"} 가 ${!partial && thought ? "생각하는 중" : "정리하는 중"}`}
              chars={partial}
              thinking={thought}
              onCancel={() => abort.current?.abort()}
              style={{ margin: "9px 0 0" }}
            />
          )}
        </div>
      )}

      {(phase === "review" || phase === "saving") && edited && (
        <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex" }}>
          {/* 왼쪽 — 제목 · 종류 · 쓸 곳 */}
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
                maxHeight: 110,
                overflowY: "auto",
              }}
            >
              {input}
            </div>

            <div style={{ ...labelStyle, marginTop: 12 }}>제목</div>
            <Input
              value={title}
              disabled={phase !== "review"}
              onChange={(e) => onTitle(e.target.value)}
              style={inputStyle}
              focusStyle={inputFocus}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
              {ISSUE_KINDS.map((k) => (
                <Box key={k} onClick={() => phase === "review" && setKind(k)} style={chipStyle(kind === k)}>
                  {ISSUE_KIND_LABEL[k]}
                </Box>
              ))}
            </div>

            <div style={{ ...labelStyle, marginTop: 14 }}>쓸 곳</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <OptionCard
                on={mode === "new"}
                label={`새 파일${aiNew ? " · AI 제안" : ""}`}
                desc={`${ISSUE_DIR}/ 폴더에 이 이슈를 처리할 파일을 만듭니다`}
                onClick={() => phase === "review" && setMode("new")}
              />
              {mode === "new" && (
                <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "0 2px 2px 24px" }}>
                  <span style={{ fontSize: 12, color: TEXT.sub, whiteSpace: "nowrap" }}>{ISSUE_DIR}/</span>
                  <Input
                    value={stem}
                    disabled={phase !== "review"}
                    onChange={(e) => {
                      setStem(e.target.value);
                      setStemTouched(true);
                    }}
                    style={{ ...inputStyle, flex: 1 }}
                    focusStyle={inputFocus}
                  />
                  <span style={{ fontSize: 12, color: TEXT.sub }}>.md</span>
                </div>
              )}
              <OptionCard
                on={mode === "existing"}
                label={`기존 파일에 넣기${suggested?.mode === "existing" ? " · AI 제안" : ""}`}
                desc="고른 섹션 끝에 날짜 머리와 함께 한 건으로 덧붙입니다"
                onClick={() => phase === "review" && files?.length && setMode("existing")}
              />
              {mode === "existing" && files && (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "0 2px 2px 24px" }}>
                  <select
                    value={path}
                    disabled={phase !== "review"}
                    onChange={(e) => {
                      setPath(e.target.value);
                      setHeading("");
                    }}
                    style={selectStyle}
                  >
                    {files.map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path}
                      </option>
                    ))}
                  </select>
                  <select
                    value={heading}
                    disabled={phase !== "review"}
                    onChange={(e) => setHeading(e.target.value)}
                    style={selectStyle}
                  >
                    <option value="">(파일 끝)</option>
                    {file?.headings.map((h) => (
                      <option key={h.id} value={h.raw}>
                        {`${"  ".repeat(h.level - 1)}${h.text}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            {suggested?.why && (
              <div style={{ fontSize: 11.5, color: "#6a665e", lineHeight: 1.6, marginTop: 7 }}>
                <span style={{ color: "#6a54c6", fontWeight: 600 }}>AI 제안</span>{" "}
                {suggested.mode === "new" ? "새 파일" : `${suggested.path}${suggested.heading ? ` › ${suggested.heading}` : ""}`}
                {" — "}
                {suggested.why}
                {mode === "existing" && suggested.mode === "existing" && !aiHere ? " (다른 곳을 골랐습니다)" : ""}
              </div>
            )}

            {!(mode === "existing" && path === "index.md") && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 12,
                  fontSize: 12,
                  color: "#3a3630",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={withIndex}
                  disabled={phase !== "review"}
                  onChange={(e) => setWithIndex(e.target.checked)}
                />
                index.md 의 “## {ISSUE_INDEX_HEADING}” 에 한 줄 남기기
              </label>
            )}
          </div>

          {/* 오른쪽 — 쓸 내용 미리보기 */}
          <div style={{ flex: "1 1 auto", minWidth: 0, overflowY: "auto", paddingBottom: 14 }}>
            {error && <Notice tone="error">{error}</Notice>}
            {retargeted && (
              <Notice tone="warn">AI 가 고른 파일이 이 업무 폴더에 없어 새 파일로 바꿨습니다</Notice>
            )}
            {dropped > 0 && (
              <Notice tone="warn">
                근거(적은 것 · 업무 · 파일)를 댈 수 없는 항목 {dropped}개를 뺐습니다 — 필요하면 입력을 고쳐 다시 정리하세요
              </Notice>
            )}
            {!hasIssueContent(edited) && (
              <Notice tone="muted">정리할 사실이 아직 없습니다 — 입력을 고쳐 다시 정리해 보세요</Notice>
            )}
            {plan && hasIssueContent(edited) && (
              <div style={{ padding: "10px 18px 0 18px" }}>
                <div style={{ ...labelStyle, marginBottom: 8 }}>
                  {plan.mode === "new"
                    ? `새 파일 ${plan.rel}`
                    : `${plan.rel}${plan.heading ? ` › ${plan.heading}` : ""} ${plan.heading ? "섹션 끝" : "끝"}에 덧붙임 — 이미 적힌 줄은 지우거나 바꾸지 않습니다`}
                </div>
                <MarkdownView blocks={preview} inline />
                {plan.indexLine && (
                  <div style={{ marginTop: 14 }}>
                    <div style={labelStyle}>
                      index.md › ## {ISSUE_INDEX_HEADING} 에 덧붙일 줄
                    </div>
                    <div
                      style={{
                        fontFamily: "'Roboto Mono',monospace",
                        fontSize: 11.5,
                        lineHeight: 1.6,
                        color: "#4a463f",
                        background: "#f7f5f1",
                        border: "1px solid #ece8e0",
                        borderRadius: 5,
                        padding: "6px 8px",
                        wordBreak: "break-all",
                      }}
                    >
                      {plan.indexLine}
                    </div>
                  </div>
                )}
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
            <PrimaryButton onClick={() => void run()} disabled={!canStart}>
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
            <span style={{ fontSize: 11.5, color: TEXT.sub }}>쓰고 나면 그 파일을 탭으로 열어 넣은 자리를 보여 줍니다</span>
            <div style={{ flex: 1 }} />
            <GhostButton onClick={dismiss}>닫기</GhostButton>
            <PrimaryButton onClick={() => void save()} disabled={!canSave} busy={phase === "saving"} minWidth={120}>
              <BusyLabel busy={phase === "saving"} since={savingAt} color="#fff" idle="쓰고 열기">
                쓰는 중
              </BusyLabel>
            </PrimaryButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

const selectStyle = {
  width: "100%",
  height: 28,
  border: "1px solid #ddd8cf",
  borderRadius: 5,
  padding: "0 6px",
  fontSize: 12,
  background: "#fff",
  outline: "none",
  color: "#23211e",
} as const;
