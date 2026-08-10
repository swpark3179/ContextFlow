import { useEffect, useState } from "react";
import { useAi } from "../../store/aiStore";
import * as api from "../../lib/api";
import { parseMaxTokens } from "../../lib/ai";
import {
  Btn,
  Card,
  Models,
  ProbeLine,
  TextField,
  Toggle,
  hintStyle,
  rowStyle,
} from "./shared";

const ID = "fabrix";

/**
 * FabriX 카드 — 사내 전용 API.
 *
 * AI Pro 와 다른 점은 인증이 커스텀 헤더 두 개라는 것과, 모델 목록이 곧 도달성이라는
 * 것이다(정적 카탈로그가 없어 조회에 실패하면 쓸 수 없다).
 */
export default function FabrixCard() {
  const agent = useAi((s) => s.detected[ID] ?? null);
  const loading = useAi((s) => !!s.loading[ID]);
  const error = useAi((s) => s.errors[ID]);
  const cfg = useAi((s) => s.settings?.fabrix ?? null);
  const { detectOne, saveFabrix } = useAi.getState();

  const [endpoint, setEndpoint] = useState("");
  const [client, setClient] = useState("");
  const [token, setToken] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [allowInvalid, setAllowInvalid] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEndpoint(cfg?.endpointUrl ?? "");
    setClient(cfg?.client ?? "");
    setToken(cfg?.openapiToken ?? "");
    setMaxTokens(cfg?.maxOutputTokens ? String(cfg.maxOutputTokens) : "");
    setAllowInvalid(cfg?.allowInvalidCerts ?? false);
  }, [cfg]);

  const save = () => {
    setProbe(null);
    const url = endpoint.trim();
    void saveFabrix(
      url
        ? {
            endpointUrl: url,
            client: client.trim() || null,
            openapiToken: token.trim() || null,
            allowInvalidCerts: allowInvalid,
            maxOutputTokens: parseMaxTokens(maxTokens),
          }
        : null,
    ).catch((e) => setProbe({ ok: false, msg: api.errMessage(e) }));
  };

  const test = () => {
    setBusy(true);
    setProbe(null);
    void api
      .probeFabrix()
      .then((msg) => setProbe({ ok: true, msg }))
      .catch((e) => setProbe({ ok: false, msg: api.errMessage(e) }))
      .finally(() => setBusy(false));
  };

  return (
    <Card name="FabriX" kind="remote" agent={agent} loading={loading} error={error}>
      <TextField
        label="엔드포인트"
        value={endpoint}
        onChange={setEndpoint}
        placeholder="https://fabrix.example.com"
        note="비워 두고 저장하면 연결이 해제됩니다. /openapi/chat/v1/... 은 앱이 덧붙입니다."
      />
      <TextField
        label="x-fabrix-client"
        value={client}
        onChange={setClient}
        placeholder="발급받은 클라이언트 값"
        password
      />
      <TextField
        label="x-openapi-token"
        value={token}
        onChange={setToken}
        placeholder="발급받은 토큰"
        password
        note="두 값 모두 ~/.contextflow/ai.json 에 평문으로 저장됩니다."
      />
      <TextField
        label="출력 토큰 상한 (선택)"
        value={maxTokens}
        onChange={setMaxTokens}
        placeholder="비우면 4,096 (추천 응답 기본값)"
        note="FabriX 는 응답이 잘렸다는 신호를 주지 않아, 앱이 모양으로 판단합니다."
      />

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
