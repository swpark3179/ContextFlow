import { useEffect, useRef, useState } from "react";
import { Select } from "../../lib/ui";
import { AI_FEATURES, type ActiveChoice, type AiFeature, type ModelOption } from "../../lib/ai";
import * as api from "../../lib/api";
import { CANCELED, runOnce, type RunResult } from "../../lib/runOnce";
import { availableAgents, routeInfo, useAi } from "../../store/aiStore";
import { Btn, cardStyle, headStyle, hintStyle, inputMono } from "./shared";

/** 안정된 빈 목록. 렌더마다 새 배열을 만들면 아래 `useEffect` 가 매번 다시 돈다. */
const NO_MODELS: ModelOption[] = [];

const selectStyle = {
  ...inputMono,
  padding: "0 6px",
  minWidth: 0,
  flex: 1,
  cursor: "pointer",
} as const;

/**
 * 테스트 대화의 질문. 답이 짧고 모델마다 다르게 나오는 것을 고른다 — "OK" 만 돌려받으면
 * 정말 그 모델이 답했는지, 게이트웨이가 고정 문구를 돌려준 것인지 가려낼 수 없다.
 */
const TEST_PROMPT =
  "연결 확인용 질문입니다. 당신이 어떤 모델인지 한국어 한두 문장으로 소개해 주세요.";
const TEST_SYSTEM = "짧고 정확하게 답합니다.";

type Row = "default" | AiFeature;

interface TestState {
  row: Row;
  label: string;
  running: boolean;
  text: string;
  startedAt: number;
  result: RunResult | null;
}

/**
 * 선택이 유효하지 않게 되면(서비스가 사라졌거나 모델 목록이 바뀌었다) 조용히 맞춰 준다.
 * 죽은 선택을 남겨 두면 그 기능이 매번 실패하는데 화면은 연결된 것처럼 보인다.
 */
function useAutoFix(choice: ActiveChoice | undefined, save: (model: string) => void) {
  const ready = useAi((s) => s.ready);
  const agent = useAi((s) => (choice?.agentId ? (s.detected[choice.agentId] ?? null) : null));
  const models = agent?.models ?? NO_MODELS;
  useEffect(() => {
    if (!ready || !choice?.agentId) return;
    if (!agent?.available) return; // 일시적 미도달일 수 있어 선택을 지우지 않는다.
    if (models.length === 0) return;
    if (!models.some((m) => m.id === choice.model)) save(models[0]!.id);
    // `save` 는 렌더마다 새 함수라 의존성에서 뺀다 — 넣으면 매 렌더 다시 돈다.
  }, [ready, choice?.agentId, choice?.model, agent?.available, models]);
}

/**
 * 기능별 AI 연결 — 기본 연결(= 새 업무 추천) 하나와, 기능마다 따로 고를 수 있는 연결.
 *
 * 예전에는 "추천에 사용할 연결" 하나뿐이었다. 위키 반영처럼 입력이 길고 오래 쓰는 일과
 * 추천처럼 짧게 판단하는 일은 알맞은 모델이 다르므로 나눠 고르게 한다. 기능별 연결을
 * 고르지 않으면 기본 연결을 따른다.
 *
 * 각 행의 [테스트] 는 그 기능이 **실제로 쓰게 될** 연결로 짧은 질문을 보낸다. 모델 목록이
 * 뜨는 것(도달성)과 모델이 답하는 것(권한 · 모델 id · 출력 형식)은 다른 문제라서, 연결
 * 테스트만으로는 "목록은 되는데 대화는 403" 을 잡지 못한다.
 */
export default function AiRoutesCard() {
  // 전체 스토어를 구독하고 파생값은 밖에서 만든다. `availableAgents` 를 셀렉터로 넘기면
  // 매 호출마다 새 배열이 나와 React 가 스냅샷이 불안정하다고 보고 렌더 루프에 빠진다.
  const ai = useAi();
  const { ready, detected, saveActive, saveRoute } = ai;
  const available = availableAgents(ai);
  const active = ai.settings?.active;
  const routes = ai.settings?.routes ?? {};

  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState | null>(null);
  const abort = useRef<AbortController | null>(null);

  // 화면을 떠나면 돌던 테스트도 끊는다 — 결과를 보여 줄 자리가 없다.
  useEffect(() => () => abort.current?.abort(), []);

  const guard = (p: Promise<void>) => {
    setError(null);
    void p.catch((e) => setError(api.errMessage(e)));
  };

  useAutoFix(active, (m) => guard(saveActive(active!.agentId, m)));
  useAutoFix(routes["wiki.ingest"], (m) =>
    guard(saveRoute("wiki.ingest", routes["wiki.ingest"]!.agentId, m)),
  );
  useAutoFix(routes["wiki.query"], (m) =>
    guard(saveRoute("wiki.query", routes["wiki.query"]!.agentId, m)),
  );

  const modelsOf = (agentId: string | undefined) =>
    agentId ? (detected[agentId]?.models ?? NO_MODELS) : NO_MODELS;

  const runTest = (row: Row, label: string, target: { agentId: string; model: string }) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const startedAt = Date.now();
    setTest({ row, label, running: true, text: "", startedAt, result: null });
    void runOnce(
      {
        agentId: target.agentId,
        model: target.model,
        prompt: TEST_PROMPT,
        systemPrompt: TEST_SYSTEM,
        maxTokens: 512,
        temperature: 0.2,
      },
      {
        signal: ctl.signal,
        onPartial: (text) =>
          setTest((t) => (t && t.startedAt === startedAt ? { ...t, text } : t)),
      },
    ).then((result) =>
      setTest((t) =>
        t && t.startedAt === startedAt
          ? { ...t, running: false, text: result.text, result }
          : t,
      ),
    );
  };

  /** 한 행 — 연결 선택 · 모델 선택 · [테스트] · 지금 무엇을 쓰는지 한 줄. */
  const row = (opts: {
    row: Row;
    label: string;
    note: string;
    choice: ActiveChoice | undefined;
    emptyLabel: string;
    onPick: (agentId: string, model: string) => void;
    status: string;
    target: { agentId: string; model: string } | null;
  }) => {
    const models = modelsOf(opts.choice?.agentId);
    return (
      <div
        key={opts.row}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          padding: "10px 12px",
          borderBottom: "1px solid #f4f1ec",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{opts.label}</span>
          <span style={{ ...hintStyle, fontSize: 11 }}>{opts.note}</span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Select
            value={opts.choice?.agentId ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              opts.onPick(id, id ? (detected[id]?.models[0]?.id ?? "") : "");
            }}
            style={selectStyle}
          >
            <option value="">{opts.emptyLabel}</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select
            value={opts.choice?.model ?? ""}
            onChange={(e) => opts.onPick(opts.choice?.agentId ?? "", e.target.value)}
            disabled={!opts.choice?.agentId || models.length === 0}
            style={{ ...selectStyle, opacity: opts.choice?.agentId ? 1 : 0.5 }}
          >
            {models.length === 0 && <option value="">모델 없음</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
          <Btn
            label="테스트"
            disabled={!opts.target || (test?.running ?? false)}
            onClick={() => opts.target && runTest(opts.row, opts.label, opts.target)}
          />
        </div>
        <div style={hintStyle}>{opts.status}</div>
      </div>
    );
  };

  const defaultAgent = active?.agentId ? (detected[active.agentId] ?? null) : null;
  const defaultStatus = !active?.agentId
    ? "로컬 유사도(한글 바이그램 기반)로만 추천합니다. 외부 통신이 없습니다."
    : defaultAgent?.available
      ? "새 업무를 추가할 때 이 연결로 과거 업무를 훑습니다. 실패하면 로컬 유사도로 자동 대체됩니다."
      : "선택한 연결이 지금 사용 불가 상태입니다 — 추천은 로컬 유사도로 대체됩니다.";

  return (
    <div style={cardStyle}>
      <div style={headStyle}>기능별 AI 연결</div>

      {row({
        row: "default",
        label: "기본 연결",
        note: "새 업무 추천 · 따로 고르지 않은 기능",
        choice: active,
        emptyLabel: "사용하지 않음 (로컬 유사도)",
        onPick: (id, m) => guard(saveActive(id, m)),
        status: defaultStatus,
        target:
          active?.agentId && defaultAgent?.available
            ? { agentId: active.agentId, model: active.model || "default" }
            : null,
      })}

      {AI_FEATURES.map((f) => {
        const info = routeInfo(ai, f.id);
        const status =
          info.via === "route"
            ? info.run
              ? `이 기능만 ${info.name} 을(를) 씁니다.`
              : `지정한 연결(${info.name})이 지금 사용 불가 상태입니다 — 기본 연결로 바꾸지 않고 이 기능을 멈춥니다.`
            : info.via === "default"
              ? info.run
                ? `기본 연결(${info.name})을 따릅니다.`
                : `기본 연결(${info.name})이 지금 사용 불가 상태라 이 기능은 돌지 않습니다.`
              : "기본 연결이 없어 이 기능은 돌지 않습니다. 연결을 고르세요.";
        return row({
          row: f.id,
          label: f.label,
          note: f.note,
          choice: routes[f.id],
          emptyLabel: "기본 연결 따름",
          onPick: (id, m) => guard(saveRoute(f.id, id, m)),
          status,
          target: info.run,
        });
      })}

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {error && <div style={{ ...hintStyle, color: "#c04a4a" }}>{error}</div>}
        {ready && available.length === 0 && (
          <div style={{ ...hintStyle, color: "#a06a3b" }}>
            사용 가능한 연결이 없습니다. 위 카드에서 CLI 경로를 지정하거나 원격 엔드포인트를
            저장하세요.
          </div>
        )}
        {test ? (
          <TestPanel test={test} onCancel={() => abort.current?.abort()} />
        ) : (
          <div style={hintStyle}>
            [테스트] 는 그 기능이 실제로 쓸 연결로 짧은 질문을 보내 답과 걸린 시간 · 토큰
            사용량을 보여 줍니다. 모델 목록이 뜨는 것과 모델이 실제로 답하는 것은 다른
            문제입니다(권한 · 모델 id).
          </div>
        )}
      </div>
    </div>
  );
}

function TestPanel({ test, onCancel }: { test: TestState; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!test.running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [test.running]);

  const r = test.result;
  const elapsed = ((r ? Date.now() : now) - test.startedAt) / 1000;
  const failed = r && !r.ok;
  const canceled = r?.error === CANCELED;
  const facts: string[] = [];
  if (r) facts.push(`${elapsed.toFixed(1)}초`);
  if (r?.usage?.inputTokens != null || r?.usage?.outputTokens != null) {
    facts.push(`입력 ${r.usage?.inputTokens ?? "?"} · 출력 ${r.usage?.outputTokens ?? "?"} 토큰`);
  }
  if (r?.thinking) facts.push(`추론 ${r.thinking.length.toLocaleString()}자`);
  if (r?.truncated) facts.push("출력 상한에서 잘림");

  return (
    <div
      style={{
        border: `1px solid ${failed && !canceled ? "#f0d2d2" : "#e6e2da"}`,
        borderRadius: 6,
        background: "#fdfcfa",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#4e4a43" }}>
          테스트 대화 · {test.label}
        </span>
        <span style={{ ...hintStyle, fontSize: 11 }}>
          {test.running
            ? `응답 기다리는 중… ${elapsed.toFixed(0)}초`
            : canceled
              ? "취소했습니다"
              : failed
                ? "실패"
                : "성공"}
        </span>
        {test.running && (
          <span style={{ marginLeft: "auto" }}>
            <Btn label="취소" onClick={onCancel} />
          </span>
        )}
      </div>
      {test.text && (
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.65,
            color: "#23211e",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {test.text}
        </div>
      )}
      {failed && !canceled && (
        <div style={{ ...hintStyle, color: "#c04a4a", whiteSpace: "pre-wrap" }}>{r?.error}</div>
      )}
      {r && r.ok && !r.text.trim() && (
        <div style={{ ...hintStyle, color: "#a06a3b" }}>
          {r.thinking
            ? "추론만 하고 답을 내지 못했습니다 — 출력 토큰 상한을 올려 보세요."
            : "답이 비어 있습니다."}
        </div>
      )}
      {facts.length > 0 && <div style={{ ...hintStyle, fontSize: 11 }}>{facts.join(" · ")}</div>}
    </div>
  );
}
