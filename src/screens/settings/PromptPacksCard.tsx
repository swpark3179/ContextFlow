import { useEffect, useState } from "react";
import { useAi } from "../../store/aiStore";
import * as api from "../../lib/api";
import {
  HOOK_CAP,
  PACK_CAP,
  PROMPT_HOOKS,
  composeHook,
  hooksOf,
} from "../../lib/promptPacks";
import { Btn, cardStyle, headStyle, hintStyle } from "./shared";

/**
 * 프롬프트 팩 카드.
 *
 * 사용자가 `~/.contextflow/prompts/*.md` 에 넣은 지침을 추천 순위 요청에 얹는다. 앱은
 * 이 폴더에 쓰지 않는다 — 목록을 읽고 어느 것을 켤지만 기억한다.
 *
 * 켠 팩이 합성 상한을 넘겨 실리지 못하면 **경고로 알린다.** 조용히 빠뜨리면 사용자는
 * 켜 둔 지침이 실제로는 나가지 않는다는 사실을 알 방법이 없다.
 */
export default function PromptPacksCard() {
  const packs = useAi((s) => s.packs);
  const packError = useAi((s) => s.packError);
  const settings = useAi((s) => s.settings);
  const { loadPacks, savePromptHook } = useAi.getState();

  const [dir, setDir] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api
      .promptDirPath()
      .then(setDir)
      .catch((e) => setError(api.errMessage(e)));
  }, []);

  const hooks = hooksOf(settings);
  const hook = PROMPT_HOOKS[0]!;
  const enabled = hooks[hook.id] ?? [];
  const { dropped } = composeHook(hook.id, packs, hooks);

  const toggle = (file: string) => {
    const next = enabled.includes(file)
      ? enabled.filter((f) => f !== file)
      : [...enabled, file];
    setError("");
    void savePromptHook(hook.id, next).catch((e) => setError(api.errMessage(e)));
  };

  return (
    <div style={cardStyle}>
      <div style={headStyle}>프롬프트 팩 (사용자 지침)</div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11.5,
                color: "#4e4a43",
                wordBreak: "break-all",
              }}
            >
              {dir || "…"}
            </div>
            <Btn label="폴더 열기" onClick={() => void api.openPromptDir().catch(() => {})} />
            <Btn label="목록 갱신" onClick={() => void loadPacks()} />
          </div>
          <div style={{ ...hintStyle, marginTop: 6 }}>
            이 폴더에 <code>.md</code> 파일을 넣고 아래에서 켜면 <b>{hook.label}</b> 요청의{" "}
            {hook.note}에 그 내용이 붙습니다. 출력 형식과 충돌하면 형식이 우선합니다 — 지침으로
            펜스 규격을 바꿀 수는 없습니다.
          </div>
        </div>

        {packError && <div style={{ ...hintStyle, color: "#c04a4a" }}>{packError}</div>}
        {error && <div style={{ ...hintStyle, color: "#c04a4a" }}>{error}</div>}

        {packs.length === 0 && !packError && (
          <div style={hintStyle}>
            아직 팩이 없습니다. 폴더에 <code>.md</code> 파일을 만들고 맨 위에 다음처럼 적으면
            이름과 설명이 표시됩니다:
            <div
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11,
                background: "#f7f5f1",
                border: "1px solid #eae6de",
                borderRadius: 5,
                padding: "6px 8px",
                marginTop: 5,
                whiteSpace: "pre",
                lineHeight: 1.7,
              }}
            >
              {`---\nname: 재발 업무 우선\ndescription: 반복되는 정기 업무를 위로\nstage: ${hook.id}\n---\n\n- 분기·월 단위로 반복되는 업무를 더 높게 평가하세요.`}
            </div>
          </div>
        )}

        {packs.map((p) => {
          const on = enabled.includes(p.file);
          const order = enabled.indexOf(p.file);
          const isDropped = dropped.includes(p.file);
          return (
            <div
              key={p.file}
              onClick={() => !p.error && toggle(p.file)}
              style={{
                border: `1px solid ${on ? "#cddcf8" : "#e6e2da"}`,
                background: on ? "#f8fbff" : "#fff",
                borderRadius: 6,
                padding: "8px 10px",
                cursor: p.error ? "default" : "pointer",
                opacity: p.error ? 0.7 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: on ? 600 : 500,
                    color: on ? "#2f5cbb" : "#23211e",
                  }}
                >
                  {p.name}
                </span>
                {on && (
                  <span style={{ fontSize: 11, color: "#2f5cbb" }}>· 적용 {order + 1}번째</span>
                )}
                <span style={{ marginLeft: "auto", fontSize: 11, color: "#a09a8f" }}>
                  {p.chars.toLocaleString()}자
                </span>
              </div>
              {p.description && (
                <div style={{ ...hintStyle, marginTop: 3 }}>{p.description}</div>
              )}
              <div
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 10.5,
                  color: "#a09a8f",
                  marginTop: 3,
                }}
              >
                {p.file}
              </div>
              {p.error && (
                <div style={{ ...hintStyle, color: "#c04a4a", marginTop: 3 }}>{p.error}</div>
              )}
              {p.truncated && (
                <div style={{ ...hintStyle, color: "#a06a3b", marginTop: 3 }}>
                  본문이 {PACK_CAP.toLocaleString()}자에서 잘렸습니다 — 뒷부분은 실리지 않습니다.
                </div>
              )}
              {isDropped && (
                <div style={{ ...hintStyle, color: "#a06a3b", marginTop: 3 }}>
                  합성 상한({HOOK_CAP.toLocaleString()}자)을 넘겨 이 팩은 실리지 않습니다. 앞의
                  팩을 끄거나 순서를 바꾸세요.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
