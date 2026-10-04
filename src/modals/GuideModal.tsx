import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { nowStamp } from "../lib/format";
import { mdParse } from "../lib/markdown";
import { CANCELED } from "../lib/runOnce";
import { Box } from "../lib/ui";
import { KIND_LABEL } from "../lib/wiki/prompts";
import { resolveLink } from "../lib/wiki/links";
import {
  GUIDE_FILE,
  OVERVIEW_CAP,
  appendGuide,
  guideEntry,
  makeGuide,
  type GuideResult,
} from "../lib/assist/guide";
import MarkdownView, { WikiLinkContext, type WikiLinks } from "../components/MarkdownView";
import { applyToTaskFile, taskOverview, useAssist } from "../store/assistStore";
import { routeInfo, routeRun, useAi } from "../store/aiStore";
import { useStore } from "../store/useStore";
import { AssistHead, Notice, RouteLabel, chipStyle } from "./AssistParts";
import { GhostButton, Modal, ModalFooter, PrimaryButton } from "./Modal";

/**
 * 위키 가이드 — 지금 업무에 맞춰 위키에서 진행 순서 · 주의할 점 · 확인할 것을 뽑아 보여 준다.
 *
 * 받은 가이드는 둘 중 하나다: **[AI 가이드.md 에 저장]**(업무 폴더의 그 파일에 날짜 머리로 덧붙이고 탭으로 연다)
 * 또는 **[읽고 닫기]**(버린다). 닫기 · Esc 는 생성 중이면 끊는다 — 저장하는 동안만 막는다.
 */
export default function GuideModal() {
  const guide = useAssist((s) => s.guide);
  if (!guide) return null;
  return <GuideView key={guide.folder} folder={guide.folder} />;
}

type Phase = "running" | "done" | "empty" | "failed" | "saving";

function GuideView({ folder }: { folder: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.folder === folder));
  const ai = useAi();
  const info = routeInfo(ai, "task.guide");
  const close = useAssist((s) => s.close);
  const setBusy = useAssist((s) => s.setBusy);

  const [phase, setPhase] = useState<Phase>("running");
  const [text, setText] = useState("");
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GuideResult | null>(null);
  const [used, setUsed] = useState<api.WikiPageMeta[]>([]);
  const abort = useRef<AbortController | null>(null);

  const run = async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const mine = () => abort.current === ctl;
    setPhase("running");
    setText("");
    setStep("");
    setError(null);
    setResult(null);
    setUsed([]);
    try {
      const st = useStore.getState();
      const t = st.tasks.find((x) => x.folder === folder);
      if (!t) throw new Error("업무를 찾지 못했습니다");
      const overview = await taskOverview(t, OVERVIEW_CAP);
      const files = st.activeFolder === folder ? st.files.filter((f) => !f.p.includes("/") || /^[^/]+\/$/.test(f.p)) : [];
      const a = useAi.getState();
      const res = await makeGuide({
        root: st.settings.vault,
        task: {
          id: t.id,
          title: t.title,
          tags: t.tags,
          category: t.category,
          overview,
          files: files.map((f) => f.name).filter((n) => n !== "index.md"),
        },
        tasks: st.tasks,
        route: routeRun(a, "task.guide"),
        ai: { packs: a.packs, settings: a.settings },
        signal: ctl.signal,
        onPartial: (t) => mine() && setText(t),
        onStep: (s) => mine() && setStep(s),
        onPages: (p) => mine() && setUsed(p),
      });
      if (!mine()) return;
      setResult(res);
      if (res.kind === "empty") {
        setPhase("empty");
      } else {
        setText(res.text);
        setUsed(res.used);
        setPhase("done");
      }
    } catch (e) {
      if (!mine()) return;
      const msg = api.errMessage(e);
      setError(msg === CANCELED ? "취소했습니다" : msg);
      setPhase("failed");
    }
  };

  useEffect(() => {
    void run();
    return () => abort.current?.abort();
    // 열릴 때 한 번 — 다시 만들기는 단추로 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (result?.kind !== "done" || phase !== "done") return;
    setPhase("saving");
    setBusy(true);
    setError(null);
    try {
      const entry = guideEntry({
        text: result.text,
        basis: result.cited.length ? result.cited : result.used,
        pages: result.pages,
        stamp: nowStamp(),
      });
      await applyToTaskFile(folder, GUIDE_FILE, (old) => appendGuide(old, entry), { create: true });
      close();
    } catch (e) {
      setError(api.errMessage(e));
      setPhase("done");
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (phase === "saving") return;
    abort.current?.abort();
    close();
  };

  const blocks = useMemo(() => mdParse(text), [text]);
  const pages = result?.kind === "done" ? result.pages : used;
  // 위키링크는 제목으로만 보인다 — 누르면 위키 화면으로 가야 하는데, 그러면 저장하지 않은 가이드가 사라진다.
  const links: WikiLinks = useMemo(
    () => ({ open: () => undefined, label: (t) => resolveLink(t, pages)?.title ?? null }),
    [pages],
  );
  const cited = result?.kind === "done" ? new Set(result.cited.map((p) => p.path)) : new Set<string>();

  return (
    <Modal width={880} zIndex={77} onClose={dismiss} panelStyle={{ height: 620, maxHeight: "90vh" }}>
      <AssistHead title="위키 가이드" task={task?.title ?? ""}>
        <RouteLabel info={info} />
      </AssistHead>

      {used.length > 0 && (
        <div
          style={{
            flex: "0 0 auto",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 5,
            padding: "8px 14px",
            borderBottom: "1px solid #efebe4",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 600, color: "#a09a8f", marginRight: 3 }}>근거 위키</span>
          {used.map((p) => (
            <span
              key={p.path}
              title={`${p.path}${p.summary ? `\n${p.summary}` : ""}`}
              style={{ ...chipStyle(cited.has(p.path)), cursor: "default" }}
            >
              <span style={{ fontSize: 10, color: "#a09a8f" }}>{KIND_LABEL[p.kind] ?? p.kind}</span>
              {p.title}
            </span>
          ))}
        </div>
      )}

      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingBottom: 14 }}>
        {error && (
          <Notice tone={error === "취소했습니다" ? "muted" : phase === "failed" ? "error" : "warn"}>{error}</Notice>
        )}
        {result?.kind === "done" && result.warning && <Notice tone="warn">{result.warning}</Notice>}
        {result?.kind === "empty" && (
          <Notice tone="muted">
            {result.reason}
            {result.query ? `\n찾아본 말: ${result.query.slice(0, 160)}${result.query.length > 160 ? "…" : ""}` : ""}
          </Notice>
        )}
        {phase === "running" && (
          <Notice tone="muted">
            {step || "준비하는 중…"} {text ? `(${text.length.toLocaleString()}자)` : ""}{" "}
            <Box
              onClick={() => abort.current?.abort()}
              style={{ display: "inline", color: "#3a6fd8", cursor: "pointer" }}
            >
              취소
            </Box>
          </Notice>
        )}
        {text && (
          <div style={{ padding: "10px 18px 0 18px" }}>
            <WikiLinkContext.Provider value={links}>
              <MarkdownView blocks={blocks} inline />
            </WikiLinkContext.Provider>
          </div>
        )}
      </div>

      <ModalFooter>
        {phase !== "running" && phase !== "saving" && <GhostButton onClick={() => void run()}>다시 만들기</GhostButton>}
        {phase === "done" && (
          <span style={{ fontSize: 11, color: "#a09a8f" }}>
            저장하면 업무 폴더의 {GUIDE_FILE} 아래에 날짜와 함께 덧붙습니다
          </span>
        )}
        <div style={{ flex: 1 }} />
        {phase === "done" || phase === "saving" ? (
          <>
            <GhostButton onClick={dismiss}>읽고 닫기</GhostButton>
            <PrimaryButton onClick={() => void save()} disabled={phase === "saving"}>
              {phase === "saving" ? "저장하는 중…" : `${GUIDE_FILE} 에 저장`}
            </PrimaryButton>
          </>
        ) : (
          <GhostButton onClick={dismiss}>닫기</GhostButton>
        )}
      </ModalFooter>
    </Modal>
  );
}
