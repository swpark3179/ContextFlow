import { useEffect, useState } from "react";
import { useAi } from "../../store/aiStore";
import * as api from "../../lib/api";
import {
  HOOK_CAP,
  MAX_PACKS_PER_HOOK,
  PACK_CAP,
  PROMPT_HOOKS,
  composeHook,
  hooksOf,
  moveFile,
  type PromptHook,
} from "../../lib/promptPacks";
import { Box } from "../../lib/ui";
import { Btn, Chip, cardStyle, headStyle, hintStyle } from "./shared";

/** 순서 버튼. 행을 누르는 것(켜고 끄기)과 섞이지 않게 클릭 전파를 막는다. */
function Arrow({
  label,
  title,
  off,
  onClick,
}: {
  label: string;
  title: string;
  off: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (!off) onClick();
      }}
      style={{
        width: 20,
        height: 18,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid #ddd8cf",
        borderRadius: 4,
        fontSize: 11,
        color: off ? "#cfcabf" : "#6a665e",
        background: "#fff",
        cursor: off ? "default" : "pointer",
      }}
      hover={off ? undefined : { background: "#ece8e0" }}
    >
      {label}
    </Box>
  );
}

/**
 * 프롬프트 팩 카드.
 *
 * 사용자가 `~/.contextflow/prompts/*.md` 에 넣은 지침을 고른 요청(추천 순위 · 위키 반영 ·
 * 위키 질의 · 위키 점검)에 얹는다. 앱은 이 폴더에 쓰지 않는다 — 목록을 읽고 지점마다 어느
 * 것을 어떤 순서로 켤지만 기억한다.
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
  const [hookId, setHookId] = useState<PromptHook>("recommend.rank");

  useEffect(() => {
    void api
      .promptDirPath()
      .then(setDir)
      .catch((e) => setError(api.errMessage(e)));
  }, []);

  const hooks = hooksOf(settings);
  const hook = PROMPT_HOOKS.find((h) => h.id === hookId) ?? PROMPT_HOOKS[0]!;
  const enabled = hooks[hook.id] ?? [];
  const { dropped } = composeHook(hook.id, packs, hooks);
  const full = enabled.length >= MAX_PACKS_PER_HOOK;

  const save = (next: string[]) => {
    setError("");
    void savePromptHook(hook.id, next).catch((e) => setError(api.errMessage(e)));
  };

  const toggle = (file: string) => {
    if (enabled.includes(file)) return save(enabled.filter((f) => f !== file));
    // 백엔드는 상한을 넘는 것을 조용히 잘라 낸다 — 눌렀는데 켜지지 않는 것처럼 보이기 전에
    // 이유를 말한다.
    if (full) {
      setError(`한 지점에는 ${MAX_PACKS_PER_HOOK}개까지 켤 수 있습니다. 다른 팩을 먼저 끄세요.`);
      return;
    }
    save([...enabled, file]);
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
            이 폴더에 <code>.md</code> 파일을 넣고 아래에서 지점을 고른 뒤 켜면, 그 요청의 출력
            형식 앞에 내용이 붙습니다. 출력 형식과 충돌하면 형식이 우선합니다 — 지침으로 응답
            규격을 바꿀 수는 없습니다.
          </div>
        </div>

        <div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {PROMPT_HOOKS.map((h) => {
              const n = (hooks[h.id] ?? []).length;
              return (
                <Chip
                  key={h.id}
                  on={h.id === hook.id}
                  label={n ? `${h.label} · ${n}` : h.label}
                  onClick={() => {
                    setError("");
                    setHookId(h.id);
                  }}
                />
              );
            })}
          </div>
          <div style={{ ...hintStyle, marginTop: 6 }}>
            <b>{hook.label}</b> — {hook.note}. 켠 순서가 우선순위이고 최대 {MAX_PACKS_PER_HOOK}개,
            합쳐서 {HOOK_CAP.toLocaleString()}자까지 실립니다.
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
                <span style={{ marginLeft: "auto", fontSize: 11, color: "#6a665e" }}>
                  {p.chars.toLocaleString()}자
                </span>
                {on && enabled.length > 1 && (
                  <span style={{ display: "flex", gap: 3, alignSelf: "center" }}>
                    <Arrow
                      label="▲"
                      title="앞으로 (먼저 실림)"
                      off={order === 0}
                      onClick={() => save(moveFile(enabled, p.file, -1))}
                    />
                    <Arrow
                      label="▼"
                      title="뒤로"
                      off={order === enabled.length - 1}
                      onClick={() => save(moveFile(enabled, p.file, 1))}
                    />
                  </span>
                )}
              </div>
              {p.description && (
                <div style={{ ...hintStyle, marginTop: 3 }}>{p.description}</div>
              )}
              <div
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11.5,
                  color: "#6a665e",
                  marginTop: 3,
                }}
              >
                {p.file}
                {p.stage && p.stage !== hook.id && (
                  <span>
                    {" "}
                    · 팩이 권하는 지점:{" "}
                    {PROMPT_HOOKS.find((h) => h.id === p.stage)?.label ?? p.stage}
                  </span>
                )}
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
                  팩을 끄거나 ▲ 로 이 팩을 앞으로 옮기세요.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
