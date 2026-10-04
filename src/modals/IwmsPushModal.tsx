import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, TextArea } from "../lib/ui";
import * as api from "../lib/api";
import * as iwmsApi from "../lib/iwms/api";
import { problemsOf, rowsOf } from "../lib/iwms/check";
import { SAME, duplicateOf, type Duplicate } from "../lib/iwms/duplicates";
import { collectMaterial } from "../lib/iwms/material";
import { targetsOf, type Target } from "../lib/iwms/marks";
import { mergeDrafts, type Draft } from "../lib/iwms/parse";
import { NOTE_MAX, type CodeTable } from "../lib/iwms/prompts";
import { refine, refit, remainingOf } from "../lib/iwms/refine";
import {
  PRICE_LABEL,
  categoryKey,
  registUrl,
  type CommitOut,
  type IwmsCategory,
  type IwmsDay,
  type IwmsPreview,
  type IwmsSettings,
  type PreviewOut,
  type UndoOut,
} from "../lib/iwms/types";
import { injectionFor } from "../lib/promptPacks";
import { routeInfo, routeRun, useAi } from "../store/aiStore";
import { useIwms } from "../store/iwmsStore";
import { useStore } from "../store/useStore";
import { GhostButton, Modal, ModalFooter, PrimaryButton, inputFocus } from "./Modal";

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 학습 — 최근에 확정한 행을 정제의 예시로 싣는다. */
const EXAMPLES = 30;

/**
 * i-WMS 업무량 입력 — 오늘의 한일에서 대가 구분을 고른 줄을 AI 가 정제하고 사람이 검토한다.
 *
 * 흐름: 그날 기록 · 대가 선택 · 입력 이력을 읽고 → i-WMS 의 그날 현황을 읽고(세션이 없으면 연결) →
 * 업무 폴더에서 재료를 모아 AI 에 묻는다. 결과는 줄마다 고칠 수 있는 초안이다 — 카테고리 · 분 · 상세내용.
 * 분은 남은 시간(기준 − 이미 입력)에 맞게 앱이 맞추고, 사람이 고친 분은 그대로 둔다.
 *
 * 이미 i-WMS 에 넣은 줄은 기본으로 뺀다 — 다시 넣으면 같은 일이 두 번 들어간다.
 */
export default function IwmsPushModal() {
  const push = useIwms((s) => s.push);
  if (!push) return null;
  return <PushView key={push.day} day={push.day} />;
}

/**
 * `review` 에서 고치고 → `preview`(i-WMS 에 쓰지 않는 미리보기)에서 확인하고 → [최종 확정] → `done`(결과 ·
 * 되돌리기). `-ing` 단계는 기다리는 중이라 닫지 않는다.
 */
type Phase = "loading" | "refining" | "review" | "previewing" | "preview" | "saving" | "done" | "undoing";

const BUSY: Phase[] = ["loading", "refining", "previewing", "saving", "undoing"];

function PushView({ day }: { day: string }) {
  const vault = useStore((s) => s.settings.vault);
  const iw = useIwms();
  const settings = iw.settings;

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [aiError, setAiError] = useState("");
  const [iday, setIday] = useState<IwmsDay | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [table, setTable] = useState<CodeTable | null>(null);
  const [partial, setPartial] = useState(0);
  const [preview, setPreview] = useState<PreviewOut | null>(null);
  const [result, setResult] = useState<CommitOut | null>(null);
  const [undone, setUndone] = useState<UndoOut | null>(null);
  const abort = useRef<AbortController | null>(null);

  const busy = BUSY.includes(phase);
  useEffect(() => {
    useIwms.setState({ pushBusy: busy });
  }, [busy]);
  useEffect(() => () => abort.current?.abort(), []);

  const runRefine = useCallback(
    async (d: IwmsDay, s: IwmsSettings, picked: Target[], prev: Draft[]) => {
      setPhase("refining");
      setAiError("");
      setPartial(0);
      const ctl = new AbortController();
      abort.current = ctl;
      try {
        const [items, examples] = await Promise.all([
          collectMaterial(picked, useStore.getState().tasks, s.categories, day, api.readTextFile),
          iwmsApi.iwmsRecentPushes(EXAMPLES).catch(() => []),
        ]);
        const ai = useAi.getState();
        const res = await refine(
          {
            run: routeRun(ai, "iwms.refine"),
            day: d,
            items,
            settings: s,
            examples,
            inject: injectionFor("iwms.refine", ai.packs, ai.settings),
          },
          { signal: ctl.signal, onPartial: (t) => setPartial(t.length) },
        );
        if (ctl.signal.aborted) return;
        setTable(res.table);
        setDrafts(refit(mergeDrafts(prev, res.drafts), remainingOf(d), s));
        setAiError(res.error ?? "");
      } catch (e) {
        setAiError(api.errMessage(e));
      } finally {
        if (abort.current === ctl) abort.current = null;
        setPhase("review");
      }
    },
    [day],
  );

  // 열릴 때 한 번 — 기록 · 선택 · 이력 · i-WMS 현황을 읽고 정제까지.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!useIwms.getState().settings) await useIwms.getState().load();
        const s = useIwms.getState().settings;
        if (!s) throw new Error(useIwms.getState().error || "i-WMS 설정을 읽지 못했습니다");
        const [entries, marks, pushes] = await Promise.all([
          api.dayEntries(vault, day),
          iwmsApi.iwmsMarks(vault, day),
          iwmsApi.iwmsPushes(day),
        ]);
        const t = targetsOf(entries, marks, pushes);
        const d = await useIwms.getState().day(day);
        if (!alive) return;
        // 이 앱으로 넣었거나, 손으로 이미 넣은 것과 같아 보이는 줄은 기본으로 뺀다 — 같은 일이 두 번 잡힌다.
        const picked = t.filter((x) => !x.pushed.length && (duplicateOf(x.entry.title, d)?.score ?? 0) < SAME);
        setTargets(t);
        setIncluded(new Set(picked.map((x) => x.entry.id)));
        setIday(d);
        if (!picked.length) {
          setPhase("review");
          return;
        }
        await runRefine(d, s, picked, []);
      } catch (e) {
        if (!alive) return;
        setError(api.errMessage(e));
        setPhase("review");
      }
    })();
    return () => {
      alive = false;
    };
  }, [vault, day, runRefine]);

  if (!settings) return null;

  const back = () => {
    abort.current?.abort();
    iw.closePush(true);
  };

  const remaining = iday ? remainingOf(iday) : 0;
  const rows = targets.filter((t) => included.has(t.entry.id));
  const draftOf = (id: number) => drafts.find((d) => d.entryId === id);
  const thisRun = rows.reduce((n, t) => n + (draftOf(t.entry.id)?.minutes ?? 0), 0);

  const update = (id: number, patch: Partial<Draft>, refitAfter = false) => {
    setDrafts((prev) => {
      const next = prev.map((d) =>
        d.entryId === id ? { ...d, ...patch, edited: { ...d.edited, ...patch.edited } } : d,
      );
      return refitAfter && iday ? refit(next, remainingOf(iday), settings) : next;
    });
  };

  const setIncluding = (t: Target, on: boolean) => {
    const next = new Set(included);
    if (on) next.add(t.entry.id);
    else next.delete(t.entry.id);
    setIncluded(next);
    // 새로 넣은 줄에 초안이 없으면 AI 없이 빈 초안을 만든다 — [다시 정제] 로 채울 수 있다.
    if (on && iday && table && !draftOf(t.entry.id)) {
      const blank: Draft = {
        entryId: t.entry.id,
        title: t.entry.title,
        price: t.price,
        category: null,
        minutes: 0,
        note: t.entry.body.trim() || t.entry.title,
        confidence: null,
        alternatives: [],
        fixed: false,
        edited: {},
        issues: ["정제하지 않은 줄입니다 — [다시 정제] 를 누르거나 직접 채우세요"],
      };
      setDrafts((prev) => refit([...prev, blank], remainingOf(iday), settings));
    }
  };

  const reRefine = () => {
    if (!iday) return;
    void runRefine(iday, settings, rows, drafts.filter((d) => included.has(d.entryId)));
  };

  const live = rows.map((t) => draftOf(t.entry.id)).filter((d): d is Draft => !!d);
  const problems = problemsOf(live, iday);

  const doPreview = async () => {
    setPhase("previewing");
    setError("");
    try {
      setPreview(await iw.call(() => iwmsApi.iwmsPreview(day, rowsOf(live))));
      setPhase("preview");
    } catch (e) {
      setError(api.errMessage(e));
      setPhase("review");
    }
  };

  /** 토큰은 한 번만 쓰인다 — 실패하면 검토로 돌아가 다시 미리본다. */
  const doCommit = async () => {
    if (!preview) return;
    setPhase("saving");
    setError("");
    try {
      setResult(await iwmsApi.iwmsCommit(preview.token));
      setPhase("done");
    } catch (e) {
      const again = api.errKind(e) === "iwms_session" ? " — 다시 연결한 뒤 [미리보기] 부터 다시 하세요" : "";
      setError(`${api.errMessage(e)}${again}`);
      setPreview(null);
      setPhase("review");
    }
  };

  const doUndo = async () => {
    if (!result) return;
    setPhase("undoing");
    setError("");
    try {
      setUndone(await iw.call(() => iwmsApi.iwmsUndo(result.commitId)));
    } catch (e) {
      setError(api.errMessage(e));
    } finally {
      setPhase("done");
    }
  };

  const ai = routeInfo(useAi.getState(), "iwms.refine");
  const wd = WEEKDAY[new Date(`${day}T12:00:00`).getDay()] ?? "";

  return (
    <Modal width={1040} zIndex={73} onClose={() => !busy && iw.closePush(false)} panelStyle={{ height: 640 }}>
      {/* 머리 ------------------------------------------------------------- */}
      <div
        style={{
          flex: "0 0 40px",
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 14px",
          borderBottom: "1px solid #e6e2da",
          background: "#faf9f6",
        }}
      >
        <Box
          onClick={back}
          style={{ fontSize: 12, color: "#6a665e", cursor: "pointer", padding: "2px 6px", borderRadius: 4 }}
          hover={{ background: "#ece8e0" }}
          title="오늘의 한일로 돌아갑니다"
        >
          ← 오늘의 한일
        </Box>
        <span style={{ fontSize: 14, fontWeight: 600 }}>i-WMS 업무량 입력</span>
        <span style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, color: "#8a857c" }}>
          {day} ({wd})
        </span>
        <div style={{ flex: 1 }} />
        {iw.status?.connected && iday && (
          <Box
            onClick={() => void api.openWebUrl(registUrl(settings.baseUrl, iday.userId, day))}
            style={{ fontSize: 11.5, color: "#3a6fd8", cursor: "pointer" }}
            hover={{ textDecoration: "underline" }}
          >
            i-WMS 에서 보기 ↗
          </Box>
        )}
        <span style={{ fontSize: 11, color: iw.status?.connected ? "#2f7f57" : "#a09a8f" }}>
          {iw.connecting ? "i-WMS 연결 중…" : iw.status?.connected ? `● ${iw.status.user?.userId}` : "○ 연결 안 됨"}
        </span>
      </div>

      {/* 그날 현황 --------------------------------------------------------- */}
      {iday && <DayBar day={iday} thisRun={thisRun} remaining={remaining} settings={settings} table={table} />}

      {/* 본문 ------------------------------------------------------------- */}
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}>
        {error && <Notice tone="error">{error}</Notice>}
        {aiError && <Notice tone="warn">{aiError}</Notice>}
        {phase === "loading" && <Notice tone="muted">기록과 i-WMS 현황을 읽는 중…</Notice>}
        {phase === "refining" && (
          <Notice tone="muted">
            {ai.name ?? "AI"} 가 정제하는 중… {partial ? `(${partial.toLocaleString()}자)` : ""}{" "}
            <Box
              onClick={() => abort.current?.abort()}
              style={{ display: "inline", color: "#3a6fd8", cursor: "pointer" }}
            >
              취소
            </Box>
          </Notice>
        )}
        {phase !== "loading" && !error && !targets.length && (
          <Notice tone="muted">
            이 날짜에는 대가 구분을 고른 줄이 없습니다. 오늘의 한일에서 줄마다 [포함] · [미포함] 을 고르세요.
          </Notice>
        )}

        {(phase === "preview" || phase === "saving") && preview && <PreviewPane p={preview.preview} />}
        {(phase === "done" || phase === "undoing") && result && <ResultPane r={result} undone={undone} />}

        {["loading", "refining", "review", "previewing"].includes(phase) &&
          targets.map((t) => {
            const d = draftOf(t.entry.id);
            const on = included.has(t.entry.id);
            const dup = iday ? duplicateOf(t.entry.title, iday) : null;
            if (!on || !d) {
              return <ExcludedRow key={t.entry.id} t={t} dup={dup} onInclude={() => setIncluding(t, true)} />;
            }
            return (
              <DraftRow
                key={t.entry.id}
                t={t}
                d={d}
                dup={dup}
                options={table?.groups.find((g) => g.price === t.price)?.list ?? []}
                disabled={busy}
                onCategory={(c) => update(d.entryId, { category: c, edited: { category: true } })}
                onMinutes={(m) => update(d.entryId, { minutes: m, edited: { minutes: true } })}
                onMinutesDone={() => update(d.entryId, {}, true)}
                onNote={(n) => update(d.entryId, { note: n, edited: { note: true } })}
                onExclude={() => setIncluding(t, false)}
              />
            );
          })}
        {phase === "review" && live.length > 0 && problems.length > 0 && (
          <Notice tone="warn">
            미리보기 전에 고칠 것
            {problems.map((m) => (
              <div key={m}>· {m}</div>
            ))}
          </Notice>
        )}
      </div>

      <ModalFooter>
        {["loading", "refining", "review", "previewing"].includes(phase) && (
          <>
            <GhostButton onClick={reRefine}>다시 정제</GhostButton>
            <GhostButton
              onClick={() =>
                iday &&
                setDrafts((prev) =>
                  refit(
                    prev.map((d) => ({ ...d, edited: { ...d.edited, minutes: false } })),
                    remainingOf(iday),
                    settings,
                  ),
                )
              }
            >
              분 다시 나누기
            </GhostButton>
            <span style={{ fontSize: 11, color: "#a09a8f" }}>
              {ai.run ? `${ai.name} · ${ai.modelLabel ?? "기본 모델"}` : "AI 연결 없음"}
              {ai.via === "default" ? " (기본 연결)" : ""}
            </span>
            <div style={{ flex: 1 }} />
            <GhostButton onClick={() => !busy && iw.closePush(false)}>닫기</GhostButton>
            <PrimaryButton onClick={() => void doPreview()} disabled={busy || problems.length > 0}>
              {phase === "previewing" ? "미리보는 중…" : "미리보기 →"}
            </PrimaryButton>
          </>
        )}
        {(phase === "preview" || phase === "saving") && (
          <>
            <GhostButton onClick={() => phase === "preview" && setPhase("review")}>← 고치기</GhostButton>
            <span style={{ fontSize: 11, color: "#a09a8f" }}>
              아직 i-WMS 에 쓰지 않았습니다 · 확정하면 그날 그 카테고리에 덧붙입니다(이미 있는 행은 그대로)
            </span>
            <div style={{ flex: 1 }} />
            <PrimaryButton onClick={() => void doCommit()} disabled={phase === "saving"} bg="#2f7f57" hoverBg="#26694a">
              {phase === "saving" ? "저장하는 중…" : "최종 확정"}
            </PrimaryButton>
          </>
        )}
        {(phase === "done" || phase === "undoing") && (
          <>
            {!undone?.verified && (
              <GhostButton onClick={() => phase === "done" && void doUndo()}>
                {phase === "undoing" ? "되돌리는 중…" : "되돌리기"}
              </GhostButton>
            )}
            <div style={{ flex: 1 }} />
            <GhostButton onClick={() => phase === "done" && iw.closePush(false)}>닫기</GhostButton>
            <PrimaryButton onClick={back} disabled={phase === "undoing"}>
              오늘의 한일로
            </PrimaryButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function DayBar({
  day,
  thisRun,
  remaining,
  settings,
  table,
}: {
  day: IwmsDay;
  thisRun: number;
  remaining: number;
  settings: IwmsSettings;
  table: CodeTable | null;
}) {
  const after = day.totalMinutes + thisRun;
  const diff = after - day.standardMinutes;
  const blockedTabs = day.tabs.filter((t) => t.blocked);
  const fallback = table?.groups.filter((g) => g.fallback).map((g) => PRICE_LABEL[g.price]) ?? [];
  return (
    <div
      style={{
        flex: "0 0 auto",
        padding: "7px 14px",
        borderBottom: "1px solid #efece5",
        fontSize: 11.5,
        color: "#6a665e",
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 14px",
      }}
    >
      <span>기준 {day.standardMinutes}분</span>
      <span>이미 입력 {day.totalMinutes}분</span>
      <span>남은 시간 {remaining}분</span>
      <span style={{ fontWeight: 600, color: "#3a3630" }}>이번 입력 {thisRun}분</span>
      <span style={{ color: diff === 0 ? "#2f7f57" : "#b07520" }}>
        합계 {after}분{diff === 0 ? " ✓" : diff > 0 ? ` (기준보다 ${diff}분 많음)` : ` (기준보다 ${-diff}분 적음)`}
      </span>
      {!settings.fillToStandard && <span style={{ color: "#a09a8f" }}>남은 시간을 채우지 않는 설정</span>}
      {day.approved && <span style={{ color: "#9b4b42" }}>결재가 끝난 날이라 입력할 수 없습니다</span>}
      {blockedTabs.map((t) => (
        <span key={t.ciKey} style={{ color: "#b07520" }}>
          {t.ciName}: {t.blocked}
        </span>
      ))}
      {fallback.length > 0 && (
        <span style={{ color: "#a09a8f" }}>
          {fallback.join(" · ")}: 지정한 카테고리가 없어 그날 전체에서 고릅니다
        </span>
      )}
    </div>
  );
}

const rowLine = { display: "flex", gap: 8, fontSize: 12, lineHeight: 1.6, padding: "1px 0" } as const;

function NoteText({ text }: { text: string }) {
  return <span style={{ whiteSpace: "pre-wrap", minWidth: 0, flex: 1 }}>{text}</span>;
}

/** 저장 전 미리보기 — 카테고리별로 남는 행과 덧붙는 행. i-WMS 에 아직 쓰지 않았다. */
function PreviewPane({ p }: { p: IwmsPreview }) {
  const diff = p.afterMinutes - p.standardMinutes;
  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 12.5, color: "#3a3630" }}>
        저장 뒤 하루 합계 <b>{p.afterMinutes}분</b>
        <span style={{ color: "#8a857c" }}>
          {" "}
          (지금 {p.beforeMinutes}분 · 기준 {p.standardMinutes}분
          {diff === 0 ? " ✓" : diff > 0 ? ` · ${diff}분 많음` : ` · ${-diff}분 적음`})
        </span>
      </div>
      {p.warnings.map((w) => (
        <div key={w} style={{ fontSize: 11.5, color: "#b07520" }}>
          {w}
        </div>
      ))}
      {p.diffs.map((d) => {
        const kept = d.before;
        const added = d.after.slice(d.before.length);
        return (
          <div key={`${d.ciKey}|${d.wbsid}`} style={{ border: "1px solid #ece8e0", borderRadius: 6, padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              {(d.priceType === "O" || d.priceType === "N") && <PriceTag price={d.priceType} />}
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                {d.ciName} › {d.task}
              </span>
            </div>
            {kept.map((r) => (
              <div key={`k${r.rowSeq}`} style={{ ...rowLine, color: "#a09a8f" }}>
                <span style={{ flex: "0 0 34px" }}>유지</span>
                <span style={{ flex: "0 0 44px", fontFamily: "'Roboto Mono',monospace" }}>{r.minutes}분</span>
                <NoteText text={r.note} />
              </div>
            ))}
            {added.map((r) => (
              <div key={`a${r.rowSeq}`} style={{ ...rowLine, color: "#2f7f57" }}>
                <span style={{ flex: "0 0 34px", fontWeight: 600 }}>＋</span>
                <span style={{ flex: "0 0 44px", fontFamily: "'Roboto Mono',monospace" }}>{r.minutes}분</span>
                <NoteText text={r.note} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** 확정 결과 — 다시 조회한 대조와 되돌리기. */
function ResultPane({ r, undone }: { r: CommitOut; undone: UndoOut | null }) {
  return (
    <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      {undone ? (
        undone.verified ? (
          <Notice tone="muted">되돌렸습니다 — 이번에 넣은 행만 i-WMS 에서 지웠고, 다시 조회해 확인했습니다 ✓</Notice>
        ) : (
          <Notice tone="warn">
            되돌린 뒤 대조가 어긋났습니다 — i-WMS 화면에서 확인하세요
            {undone.mismatches.map((m) => (
              <div key={m}>· {m}</div>
            ))}
          </Notice>
        )
      ) : r.verified ? (
        <Notice tone="muted">
          i-WMS 에 저장하고 다시 조회해 확인했습니다 ✓ · 하루 합계 {r.preview.afterMinutes}분
        </Notice>
      ) : (
        <Notice tone="warn">
          저장은 됐지만 다시 조회한 값이 기대와 다릅니다 — i-WMS 화면에서 확인하세요. 이력은 남겼으므로 되돌릴 수 있습니다.
          {r.mismatches.map((m) => (
            <div key={m}>· {m}</div>
          ))}
        </Notice>
      )}
      {r.pushes.map((p) => (
        <div key={p.id} style={{ display: "flex", gap: 10, fontSize: 12, borderBottom: "1px solid #f4f1ec", padding: "5px 0" }}>
          <PriceTag price={p.price} />
          <span style={{ flex: "0 0 200px", color: "#3a3630" }}>{p.title}</span>
          <span style={{ flex: "0 0 220px", color: "#6a665e" }}>
            {p.ciName} › {p.task}
          </span>
          <span style={{ flex: "0 0 44px", fontFamily: "'Roboto Mono',monospace" }}>{p.minutes}분</span>
          <NoteText text={p.note} />
        </div>
      ))}
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "warn" | "muted"; children: ReactNode }) {
  const c =
    tone === "error"
      ? { bg: "#fdf3f2", bd: "#f2d6d2", fg: "#9b4b42" }
      : tone === "warn"
        ? { bg: "#fdf8ee", bd: "#f1e2c2", fg: "#8a6420" }
        : { bg: "transparent", bd: "transparent", fg: "#8a857c" };
  return (
    <div
      style={{
        margin: "9px 14px 0 14px",
        padding: "7px 9px",
        borderRadius: 5,
        background: c.bg,
        border: `1px solid ${c.bd}`,
        fontSize: 11.5,
        color: c.fg,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

function PriceTag({ price }: { price: "O" | "N" }) {
  return (
    <span
      style={{
        fontSize: 9.5,
        borderRadius: 3,
        padding: "0 4px",
        lineHeight: "15px",
        whiteSpace: "nowrap",
        color: price === "O" ? "#2f5cbb" : "#6a54c6",
        background: price === "O" ? "#e6eefc" : "#efebfb",
      }}
    >
      {PRICE_LABEL[price]}
    </span>
  );
}

/** 이미 i-WMS 에 있는 것과 닮았다는 한 줄. */
function dupText(dup: Duplicate): string {
  const first = dup.row.note.split("\n")[0] ?? "";
  return `i-WMS 에 ${dup.score >= SAME ? "이미 있음" : "비슷한 행"}: ${dup.category.ciName} › ${dup.category.task} · ${dup.row.minutes}분 "${first}"`;
}

function ExcludedRow({ t, dup, onInclude }: { t: Target; dup: Duplicate | null; onInclude: () => void }) {
  const pushed = t.pushed.reduce((n, p) => n + p.minutes, 0);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 14px",
        borderBottom: "1px solid #f4f1ec",
        fontSize: 12,
        color: "#a09a8f",
      }}
    >
      <PriceTag price={t.price} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t.entry.title}
      </span>
      {t.pushed.length > 0 ? (
        <span>이 앱으로 입력함 · {pushed}분</span>
      ) : (
        dup && (
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 460 }}>
            {dupText(dup)}
          </span>
        )
      )}
      <Box onClick={onInclude} style={{ color: "#3a6fd8", cursor: "pointer", flex: "0 0 auto" }} hover={{ textDecoration: "underline" }}>
        {t.pushed.length || dup ? "그래도 넣기" : "넣기"}
      </Box>
    </div>
  );
}

const cellInput = {
  border: "1px solid #ddd8cf",
  borderRadius: 4,
  fontSize: 12,
  outline: "none",
  background: "#fff",
  color: "#23211e",
} as const;

function DraftRow({
  t,
  d,
  dup,
  options,
  disabled,
  onCategory,
  onMinutes,
  onMinutesDone,
  onNote,
  onExclude,
}: {
  t: Target;
  d: Draft;
  dup: Duplicate | null;
  options: IwmsCategory[];
  disabled: boolean;
  onCategory: (c: IwmsCategory | null) => void;
  onMinutes: (m: number) => void;
  onMinutesDone: () => void;
  onNote: (n: string) => void;
  onExclude: () => void;
}) {
  // 대안을 위로 — AI 가 고민한 후보를 먼저 보인다.
  const alt = new Set(d.alternatives.map(categoryKey));
  const sorted = [...options.filter((c) => alt.has(categoryKey(c))), ...options.filter((c) => !alt.has(categoryKey(c)))];
  const over = d.note.length > NOTE_MAX;
  return (
    <div style={{ display: "flex", gap: 10, padding: "9px 14px", borderBottom: "1px solid #f0ede7" }}>
      <div style={{ flex: "0 0 230px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <PriceTag price={t.price} />
          {t.pushed.length > 0 && <span style={{ fontSize: 10, color: "#b07520" }}>이미 입력함 — 중복 주의</span>}
        </div>
        <div style={{ fontSize: 12.5, color: "#3a3630", lineHeight: 1.5, wordBreak: "break-all" }}>{t.entry.title}</div>
        {dup && <div style={{ fontSize: 10.5, color: "#b07520", lineHeight: 1.5 }}>{dupText(dup)} — 중복 주의</div>}
        {d.issues.map((m) => (
          <div key={m} style={{ fontSize: 10.5, color: "#b07520", lineHeight: 1.5 }}>
            {m}
          </div>
        ))}
        <Box onClick={onExclude} style={{ fontSize: 10.5, color: "#a09a8f", cursor: "pointer", alignSelf: "flex-start" }} hover={{ color: "#4e4a43" }}>
          이번엔 빼기
        </Box>
      </div>

      <div style={{ flex: "0 0 260px", display: "flex", flexDirection: "column", gap: 4 }}>
        <select
          value={d.category ? categoryKey(d.category) : ""}
          disabled={disabled}
          onChange={(e) => onCategory(options.find((c) => categoryKey(c) === e.target.value) ?? null)}
          style={{ ...cellInput, height: 28, padding: "0 4px", width: "100%" }}
        >
          <option value="">— 카테고리 선택 —</option>
          {sorted.map((c) => (
            <option key={categoryKey(c)} value={categoryKey(c)}>
              {alt.has(categoryKey(c)) ? "★ " : ""}
              {c.ciName} · {c.task}
            </option>
          ))}
        </select>
        {d.category && (
          <div style={{ fontSize: 10.5, color: "#a09a8f", lineHeight: 1.5 }}>
            {d.fixed ? "📌 매핑으로 고정 · " : ""}
            {d.category.path}
          </div>
        )}
        {d.confidence !== null && !d.fixed && (
          <div style={{ fontSize: 10.5, color: d.confidence >= 70 ? "#2f7f57" : "#b07520" }}>
            확신도 {d.confidence}
          </div>
        )}
      </div>

      <div style={{ flex: "0 0 74px", display: "flex", flexDirection: "column", gap: 3 }}>
        <input
          type="number"
          min={0}
          max={1440}
          step={10}
          value={d.minutes}
          disabled={disabled}
          onChange={(e) => onMinutes(Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0))))}
          onBlur={onMinutesDone}
          style={{ ...cellInput, height: 28, width: "100%", padding: "0 6px", fontFamily: "'Roboto Mono',monospace" }}
        />
        <span style={{ fontSize: 10, color: "#a09a8f" }}>{d.edited.minutes ? "분 · 고정" : "분"}</span>
      </div>

      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <TextArea
          value={d.note}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onNote(e.target.value)}
          style={{ ...cellInput, width: "100%", minHeight: 58, padding: "5px 7px", lineHeight: 1.6, resize: "vertical", boxSizing: "border-box" }}
          focusStyle={inputFocus}
        />
        <span style={{ fontSize: 10, color: over ? "#9b4b42" : "#a09a8f", alignSelf: "flex-end" }}>
          {d.note.length}/{NOTE_MAX}
        </span>
      </div>
    </div>
  );
}
