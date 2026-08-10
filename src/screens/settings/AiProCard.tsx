import { useEffect, useState } from "react";
import { TextArea } from "../../lib/ui";
import { useAi } from "../../store/aiStore";
import * as api from "../../lib/api";
import { modelLines, parseMaxTokens, parseModelLines } from "../../lib/ai";
import {
  Btn,
  Card,
  Field,
  Models,
  ProbeLine,
  TextField,
  Toggle,
  hintStyle,
  inputFocus,
  inputMono,
  rowStyle,
} from "./shared";

const ID = "aipro";

/** 사내 기본값. 다른 게이트웨이를 쓰는 사람은 그대로 고쳐 쓴다. */
const DEFAULT_ENDPOINT = "https://aipro.sdsdev.co.kr/open/api/v1";

/**
 * AI Pro 카드 — OpenAI 호환 게이트웨이.
 *
 * 인증은 Bearer 키 하나. 모델은 `/models` 라이브 조회가 되면 그것을, 안 되면 내장
 * 카탈로그를 쓰고, 게이트웨이가 `/models` 를 아예 주지 않는 환경에서는 `모델 직접 지정`
 * 이 탈출구다(적어 두면 조회보다 우선한다).
 */
export default function AiProCard() {
  const agent = useAi((s) => s.detected[ID] ?? null);
  const loading = useAi((s) => !!s.loading[ID]);
  const error = useAi((s) => s.errors[ID]);
  const cfg = useAi((s) => s.settings?.aipro ?? null);
  const { detectOne, saveAiPro } = useAi.getState();

  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [custom, setCustom] = useState("");
  const [allowInvalid, setAllowInvalid] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 저장된 설정이 바뀌면 입력창을 맞춰 준다. 비어 있으면 기본 엔드포인트를 제안한다.
  useEffect(() => {
    setEndpoint(cfg?.endpointUrl ?? "");
    setApiKey(cfg?.apiKey ?? "");
    setMaxTokens(cfg?.maxOutputTokens ? String(cfg.maxOutputTokens) : "");
    setCustom(modelLines(cfg?.customModels));
    setAllowInvalid(cfg?.allowInvalidCerts ?? false);
  }, [cfg]);

  const save = () => {
    setProbe(null);
    const url = endpoint.trim();
    void saveAiPro(
      url
        ? {
            endpointUrl: url,
            apiKey: apiKey.trim() || null,
            // 저장할 때마다 화면의 토글 값을 그대로 실어 보낸다. 여기에 false 를 박아 두면
            // 사용자가 켜 둔 값이 저장할 때마다 조용히 꺼진다.
            allowInvalidCerts: allowInvalid,
            maxOutputTokens: parseMaxTokens(maxTokens),
            // `customModels` 는 프런트 소유다 — 빼고 보내면 백엔드가 비운 것으로 받는다.
            customModels: parseModelLines(custom),
          }
        : null,
    ).catch((e) => setProbe({ ok: false, msg: api.errMessage(e) }));
  };

  const test = () => {
    setBusy(true);
    setProbe(null);
    void api
      .probeAiPro()
      .then((msg) => setProbe({ ok: true, msg }))
      .catch((e) => setProbe({ ok: false, msg: api.errMessage(e) }))
      .finally(() => setBusy(false));
  };

  return (
    <Card name="AI Pro" kind="remote" agent={agent} loading={loading} error={error}>
      <TextField
        label="엔드포인트"
        value={endpoint}
        onChange={setEndpoint}
        placeholder={DEFAULT_ENDPOINT}
        note="비워 두고 저장하면 연결이 해제됩니다. /chat/completions 는 앱이 덧붙입니다."
      />
      <TextField
        label="API 키 (Authorization: Bearer)"
        value={apiKey}
        onChange={setApiKey}
        placeholder="선택 — 게이트웨이가 요구하는 경우"
        password
        note="키는 ~/.contextflow/ai.json 에 평문으로 저장됩니다. 읽기 전용 스코프 키를 권장합니다."
      />
      <TextField
        label="출력 토큰 상한 (선택)"
        value={maxTokens}
        onChange={setMaxTokens}
        placeholder="비우면 4,096 (추천 응답 기본값)"
        note="게이트웨이가 큰 값을 거부하면 낮추고, 응답이 잘리면 올리세요. 256 미만은 무시됩니다."
      />

      <Field
        label="모델 직접 지정 (선택)"
        note="한 줄에 하나. `id` 또는 `id | 표시이름`. 적어 두면 라이브 조회·내장 목록보다 우선합니다."
      >
        <TextArea
          rows={3}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={"glm-5.2\nqwen3.6-27b | Qwen 3.6"}
          style={{
            ...inputMono,
            height: "auto",
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 9px",
            lineHeight: 1.6,
            resize: "vertical",
          }}
          focusStyle={inputFocus}
        />
      </Field>

      <div style={{ ...rowStyle, padding: 0, borderBottom: "none" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>인증서 검증 건너뛰기</div>
          <div style={{ ...hintStyle, marginTop: 2 }}>
            사내 TLS 검사 프록시의 CA 가 OS 저장소에 없을 때만 켜세요.
          </div>
        </div>
        <Toggle on={allowInvalid} onClick={() => setAllowInvalid(!allowInvalid)} />
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Btn label="저장" primary onClick={save} />
        <Btn label={busy ? "확인 중…" : "연결 테스트"} onClick={test} disabled={busy} />
        <Btn label="모델 다시 조회" onClick={() => void detectOne(ID, true)} />
      </div>
      <ProbeLine probe={probe} />

      <Models agent={agent} />
    </Card>
  );
}
