import { useEffect, useMemo, useState } from "react";
import { useAi } from "../../store/aiStore";
import * as api from "../../lib/api";
import {
  modelLines,
  parseMaxTokens,
  parseModelLines,
  type FabrixApiStyle,
  type FabrixConfig,
} from "../../lib/ai";
import {
  Btn,
  Chip,
  ConnectionPanel,
  CustomModelsField,
  DirtyMark,
  Field,
  Models,
  ProbeLine,
  TextField,
  Toggle,
  hintStyle,
  rowStyle,
} from "./shared";

/** 두 칸 격자 — 짝을 이루는 입력(헤더 두 개 · 이메일과 상한)을 나란히 둬 탭 높이를 줄인다. */
const pair = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } as const;

const ID = "fabrix";

/**
 * 방식별 안내. 두 API 는 같은 헤더 이름을 쓰지만 기준 주소부터 다르다 — 게이트웨이 주소에
 * 네이티브 경로를 붙이면 404 이고, 그 반대도 마찬가지다. 입력 자리의 예시가 방식을 따라
 * 바뀌어야 사용자가 무엇을 적을지 안다.
 */
const STYLE_TEXT: Record<
  FabrixApiStyle,
  { label: string; desc: string; placeholder: string; note: string; token: string }
> = {
  chat: {
    label: "채팅 API",
    desc: "FabriX 네이티브 대화 API. /openapi/chat/v1/messages 로 묻고, 모델은 /openapi/chat/v1/all-models 에서 고릅니다.",
    placeholder: "https://fabrix.example.com",
    note: "비워 두고 저장하면 연결이 해제됩니다. /openapi/chat/v1/... 은 앱이 덧붙입니다.",
    token: "발급받은 토큰 그대로",
  },
  openai: {
    label: "LLM 게이트웨이 (OpenAI 호환)",
    desc: "FabriX LLM 게이트웨이(vLLM). /openapi/llm/chat/completions 로 묻고, 모델은 x-llm-model-id 헤더로 고릅니다. 바탕화면 FabrixSample 이 쓰는 방식입니다.",
    placeholder: "https://fabrix.example.com",
    note: "호스트 주소만 적으세요 — /openapi/llm 과 대화(/chat/completions) · 모델 목록(/v1/models) 경로는 앱이 덧붙입니다.",
    token: "Bearer … (빠져 있으면 앱이 붙입니다)",
  },
};

/** 화면 초안 → 저장 요청. 빈 엔드포인트는 "연결 해제" 다. */
function toConfig(d: Draft): FabrixConfig | null {
  const url = d.endpoint.trim();
  if (!url) return null;
  return {
    endpointUrl: url,
    apiStyle: d.style,
    client: d.client.trim() || null,
    openapiToken: d.token.trim() || null,
    userEmail: d.email.trim() || null,
    allowInvalidCerts: d.allowInvalid,
    maxOutputTokens: parseMaxTokens(d.maxTokens),
    // `customModels` 는 프런트 소유다 — 빼고 보내면 백엔드가 비운 것으로 받는다.
    customModels: parseModelLines(d.custom),
  };
}

interface Draft {
  endpoint: string;
  style: FabrixApiStyle;
  client: string;
  token: string;
  email: string;
  maxTokens: string;
  custom: string;
  allowInvalid: boolean;
}

function draftOf(cfg: FabrixConfig | null): Draft {
  return {
    endpoint: cfg?.endpointUrl ?? "",
    style: cfg?.apiStyle === "openai" ? "openai" : "chat",
    client: cfg?.client ?? "",
    token: cfg?.openapiToken ?? "",
    email: cfg?.userEmail ?? "",
    maxTokens: cfg?.maxOutputTokens ? String(cfg.maxOutputTokens) : "",
    custom: modelLines(cfg?.customModels),
    allowInvalid: cfg?.allowInvalidCerts ?? false,
  };
}

/**
 * FabriX 탭 — 사내 전용 API.
 *
 * 인증은 커스텀 헤더 두 개이고, API 가 둘이다(네이티브 채팅 API · LLM 게이트웨이). 모델 목록은 정적 카탈로그가 없어 조회 결과(또는 직접 지정)가
 * 곧 쓸 수 있는 모델이다.
 *
 * 입력은 초안으로 들고 있다가 [저장] 에서 한 번에 보낸다. 탭을 옮겨도 이 컴포넌트는 숨겨질
 * 뿐 살아 있어 초안이 남고, `onDirtyChange` 로 탭 머리에 "저장 안 됨" 을 띄운다.
 */
export default function FabrixCard({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const agent = useAi((s) => s.detected[ID] ?? null);
  const loading = useAi((s) => !!s.loading[ID]);
  const error = useAi((s) => s.errors[ID]);
  const cfg = useAi((s) => s.settings?.fabrix ?? null);
  const { detectOne, saveFabrix, probeOne } = useAi.getState();

  const [d, setD] = useState<Draft>(() => draftOf(cfg));
  const [probe, setProbe] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }));

  // 저장된 설정이 바뀌면 입력창을 맞춰 준다.
  useEffect(() => setD(draftOf(cfg)), [cfg]);

  const saved = useMemo(() => JSON.stringify(draftOf(cfg)), [cfg]);
  const dirty = JSON.stringify(d) !== saved;
  const text = STYLE_TEXT[d.style];
  useEffect(() => onDirtyChange?.(dirty), [dirty]);

  const save = () => {
    setProbe(null);
    void saveFabrix(toConfig(d)).catch((e) => setProbe({ ok: false, msg: api.errMessage(e) }));
  };

  const test = () => {
    setBusy(true);
    setProbe(null);
    void probeOne(ID)
      .then((msg) => setProbe({ ok: true, msg }))
      .catch((e) => setProbe({ ok: false, msg: api.errMessage(e) }))
      .finally(() => setBusy(false));
  };

  return (
    <ConnectionPanel kind="remote" agent={agent} loading={loading} error={error}>
      <Field label="API 방식" note={text.desc}>
        <div style={{ display: "flex", gap: 4 }}>
          {(["chat", "openai"] as const).map((k) => (
            <Chip
              key={k}
              on={d.style === k}
              label={STYLE_TEXT[k].label}
              onClick={() => patch({ style: k })}
            />
          ))}
        </div>
      </Field>
      <TextField
        label="엔드포인트"
        value={d.endpoint}
        onChange={(v) => patch({ endpoint: v })}
        placeholder={text.placeholder}
        note={text.note}
      />
      <div>
        <div style={pair}>
          <TextField
            label="x-fabrix-client"
            value={d.client}
            onChange={(v) => patch({ client: v })}
            placeholder="발급받은 클라이언트 값"
            password
          />
          <TextField
            label="x-openapi-token"
            value={d.token}
            onChange={(v) => patch({ token: v })}
            placeholder={text.token}
            password
          />
        </div>
        <div style={{ ...hintStyle, marginTop: 5 }}>
          두 값 모두 ~/.contextflow/ai.json 에 평문으로 저장됩니다.
        </div>
      </div>
      <div style={pair}>
        <TextField
          label="사용자 이메일 (선택)"
          value={d.email}
          onChange={(v) => patch({ email: v })}
          placeholder="name@company.com"
          note="적으면 x-generative-ai-user-email 헤더로 함께 보냅니다(사용량 집계용)."
        />
        <TextField
          label="출력 토큰 상한 (선택)"
          value={d.maxTokens}
          onChange={(v) => patch({ maxTokens: v })}
          placeholder="비우면 기능별 값"
          note="적으면 모든 호출이 이 값을 씁니다(기본: 추천 4,096 · 위키 반영 최대 16,384). 잘리면 올리고 거부되면 낮추세요."
        />
      </div>
      <CustomModelsField
        value={d.custom}
        onChange={(v) => patch({ custom: v })}
        placeholder={
          d.style === "openai"
            ? "16 | gpt-oss-120b\n70"
            : "019f23a1-46aa-7fa5-a6ab-391127fea7e6 | Glm 5.2"
        }
        note={
          d.style === "openai"
            ? "모델 목록 조회가 막혀 있을 때 쓰세요. 게이트웨이의 모델 id 는 숫자입니다(x-llm-model-id). 적어 두면 조회 결과보다 우선합니다."
            : "모델 목록 조회가 막혀 있을 때 쓰세요. 채팅 API 의 모델 id 는 UUID 입니다 — 이름만 적으면 조회된 목록에서 같은 이름의 id 로 바꿔 씁니다. 적어 두면 조회 결과보다 우선합니다."
        }
      />

      <div style={{ ...rowStyle, padding: 0, borderBottom: "none" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>인증서 검증 건너뛰기</div>
          <div style={{ ...hintStyle, marginTop: 2 }}>
            사내 TLS 검사 프록시의 CA 가 OS 저장소에 없을 때만 켜세요.
          </div>
        </div>
        <Toggle on={d.allowInvalid} onClick={() => patch({ allowInvalid: !d.allowInvalid })} />
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Btn label="저장" primary onClick={save} />
        <Btn
          label="연결 테스트"
          busy={busy}
          busyLabel="응답 기다리는 중"
          ai
          onClick={test}
          disabled={dirty}
        />
        <Btn label="모델 다시 조회" onClick={() => void detectOne(ID, true)} disabled={dirty} />
        <DirtyMark dirty={dirty} />
      </div>
      {dirty && (
        <div style={hintStyle}>연결 테스트는 저장된 설정으로 합니다 — 먼저 저장하세요.</div>
      )}
      <ProbeLine probe={probe} />

      <Models agent={agent} />
    </ConnectionPanel>
  );
}
