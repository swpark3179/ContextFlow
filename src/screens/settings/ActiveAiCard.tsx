import { useEffect } from "react";
import { Select } from "../../lib/ui";
import type { ModelOption } from "../../lib/ai";
import { availableAgents, useAi } from "../../store/aiStore";
import { cardStyle, headStyle, hintStyle, inputMono } from "./shared";

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
 * 추천에 쓸 연결 · 모델.
 *
 * Multi-Aspect 는 1단계 위저드에서 골랐지만 ContextFlow 에는 위저드가 없어 설정이 갖는다.
 * 아무것도 고르지 않으면 로컬 유사도만 쓴다 — 그것이 기본값이고 외부 통신이 없다.
 */
export default function ActiveAiCard() {
  // 전체 스토어를 구독하고 파생값은 밖에서 만든다. `availableAgents` 를 셀렉터로 넘기면
  // 매 호출마다 새 배열이 나와 React 가 스냅샷이 불안정하다고 보고 렌더 루프에 빠진다.
  const ai = useAi();
  const { ready, detected, saveActive } = ai;
  const active = ai.settings?.active ?? null;
  const available = availableAgents(ai);

  const agent = active?.agentId ? (detected[active.agentId] ?? null) : null;
  const models = agent?.models ?? NO_MODELS;

  /**
   * 선택이 유효하지 않게 되면(서비스가 사라졌거나 모델 목록이 바뀌었다) 조용히 맞춰 준다.
   * 죽은 선택을 남겨 두면 추천이 매번 폴백하는데 화면은 연결된 것처럼 보인다.
   */
  useEffect(() => {
    if (!ready || !active?.agentId) return;
    if (!agent?.available) return; // 일시적 미도달일 수 있어 선택을 지우지 않는다.
    if (models.length === 0) return;
    if (!models.some((m) => m.id === active.model)) {
      void saveActive(active.agentId, models[0]!.id);
    }
  }, [ready, active?.agentId, active?.model, agent?.available, models, saveActive]);

  return (
    <div style={cardStyle}>
      <div style={headStyle}>추천에 사용할 연결</div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <Select
            value={active?.agentId ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              const first = id ? (detected[id]?.models[0]?.id ?? "") : "";
              void saveActive(id, first);
            }}
            style={selectStyle}
          >
            <option value="">사용하지 않음 (로컬 유사도)</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select
            value={active?.model ?? ""}
            onChange={(e) => void saveActive(active?.agentId ?? "", e.target.value)}
            disabled={!active?.agentId || models.length === 0}
            style={{ ...selectStyle, opacity: active?.agentId ? 1 : 0.5 }}
          >
            {models.length === 0 && <option value="">모델 없음</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>

        <div style={hintStyle}>
          {!active?.agentId
            ? "로컬 유사도(한글 바이그램 기반)로만 추천합니다. 외부 통신이 없습니다."
            : agent?.available
              ? "새 업무를 추가할 때 이 연결로 과거 업무를 훑습니다. 실패하면 로컬 유사도로 자동 대체되므로 업무 추가가 막히지는 않습니다."
              : "선택한 연결이 지금 사용 불가 상태입니다 — 추천은 로컬 유사도로 대체됩니다."}
        </div>

        {ready && available.length === 0 && (
          <div style={{ ...hintStyle, color: "#a06a3b" }}>
            사용 가능한 연결이 없습니다. 위 카드에서 CLI 경로를 지정하거나 원격 엔드포인트를
            저장하세요.
          </div>
        )}
      </div>
    </div>
  );
}
