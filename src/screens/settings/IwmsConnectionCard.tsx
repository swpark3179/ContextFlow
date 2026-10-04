import { useEffect, useState } from "react";
import { AiSignal, Input } from "../../lib/ui";
import { GREEN, TEXT } from "../../lib/design";
import * as api from "../../lib/api";
import { settingUrl } from "../../lib/iwms/types";
import { useIwms } from "../../store/iwmsStore";
import { useStore } from "../../store/useStore";
import { Btn, cardStyle, headStyle, hintStyle, inputFocus, inputMono } from "./shared";

/**
 * i-WMS 연결 — 주소 · 연결 상태 · [연결].
 *
 * 비밀번호를 받지 않는다. [연결] 을 누르면 앱이 i-WMS 를 작은 창으로 열고, 사내 통합인증(SSO)이
 * 끝나면 그 창이 저절로 닫힌다. 세션 쿠키는 앱의 메모리에만 있어 앱을 끄면 사라진다.
 */
export default function IwmsConnectionCard() {
  const iw = useIwms();
  const settings = iw.settings;
  const [base, setBase] = useState(settings?.baseUrl ?? "");

  useEffect(() => {
    setBase(settings?.baseUrl ?? "");
  }, [settings?.baseUrl]);

  if (!settings) return null;

  const commitBase = async () => {
    const next = base.trim().replace(/\/+$/, "");
    if (!next || next === settings.baseUrl) return setBase(settings.baseUrl);
    try {
      await iw.saveSettings({ ...settings, baseUrl: next });
      // 다른 서버의 세션을 들고 있을 이유가 없다.
      if (iw.status?.connected) await iw.disconnect();
    } catch (e) {
      useStore.getState().fail(e, "i-WMS 주소를 저장하지 못했습니다");
    }
  };

  const st = iw.status;
  const ok = !!st?.connected;
  const who = st?.user ? `${st.user.userId} (${[st.user.userName, st.user.dept].filter(Boolean).join(" · ")})` : "";

  return (
    <div style={cardStyle}>
      <div style={headStyle}>i-WMS 연결</div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 5 }}>i-WMS 주소</div>
          <Input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            onBlur={() => void commitBase()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            style={{ ...inputMono, width: "100%", boxSizing: "border-box" }}
            focusStyle={inputFocus}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          {iw.connecting ? (
            <span style={{ width: 9, display: "flex", justifyContent: "center" }}>
              <AiSignal size={6} color="#8a857c" />
            </span>
          ) : (
            <span style={{ color: ok ? GREEN : "#b5afa2" }}>●</span>
          )}
          <span style={{ color: ok || iw.connecting ? "#3a3630" : TEXT.sub, minWidth: 0, flex: 1 }}>
            {iw.connecting
              ? "연결 중 — 열린 i-WMS 창에서 로그인이 끝나면 저절로 닫힙니다"
              : ok
                ? `연결됨 · ${who}`
                : (st?.message ?? "연결되지 않음")}
          </span>
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Btn
            primary
            label={ok ? "다시 확인" : "i-WMS 연결"}
            disabled={iw.connecting}
            onClick={() => void iw.connect()}
          />
          {ok && <Btn label="연결 해제" onClick={() => void iw.disconnect()} />}
          <Btn
            label="나의 MH 설정 열기 ↗"
            onClick={() => void api.openWebUrl(settingUrl(settings.baseUrl))}
          />
        </div>

        <div style={{ ...hintStyle, paddingTop: 6, borderTop: "1px dashed #eae6de" }}>
          사내 통합인증(SSO)으로 연결합니다. 비밀번호는 받지 않고, 세션은 앱의 메모리에만 있어 앱을 끄면
          사라집니다. 입력할 카테고리는 i-WMS 의 '나의 MH 설정' 에 등록된 것만 쓸 수 있습니다.
        </div>
      </div>
    </div>
  );
}
