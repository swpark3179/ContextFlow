import { useEffect, useState } from "react";
import { Input } from "../../lib/ui";
import * as api from "../../lib/api";
import { useAi } from "../../store/aiStore";
import { Btn, Card, Field, Models, ReadOnlyRow, hintStyle, inputFocus, inputMono } from "./shared";
import { sourceLabel } from "../../lib/ai";

/**
 * 로컬 CLI 카드 (Claude Code · Codex CLI).
 *
 * 두 서비스가 같은 껍데기를 쓴다 — 탐지 경로(resolve → `--version`)와 설정 항목
 * (실행 파일 경로 하나)이 동일하기 때문이다. 다른 것은 이름과 검색할 바이너리뿐이고
 * 그건 Rust 레지스트리(`agents.rs`)가 안다.
 */
export default function LocalCliCard({ id }: { id: string }) {
  const infos = useAi((s) => s.infos);
  const agent = useAi((s) => s.detected[id] ?? null);
  const loading = useAi((s) => !!s.loading[id]);
  const error = useAi((s) => s.errors[id]);
  const saved = useAi((s) => s.settings?.agents?.[id]?.customBin ?? "");
  const { detectOne, saveAgentBin } = useAi.getState();

  const [draft, setDraft] = useState(saved);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 저장된 값이 바뀌면(저장 · 해제 · 최초 로드) 입력창을 맞춰 준다.
  useEffect(() => setDraft(saved), [saved]);

  const info = infos.find((i) => i.id === id);
  const name = info?.name ?? id;

  /** 저장 실패를 카드에 남긴다 — 예전에는 처리되지 않은 프라미스 거절로 조용히 사라졌다. */
  const guard = (p: Promise<void>) => {
    setSaveError(null);
    void p.catch((e) => setSaveError(api.errMessage(e)));
  };

  /**
   * 지정한 경로를 쓰지 못하면 백엔드는 조용히 PATH 검색으로 넘어간다(`resolve.rs`). 그
   * 사실을 출처 배지 하나로만 알리면 놓치기 쉬워서 한 줄로 적는다.
   */
  const ignored = !!saved && !!agent && agent.source !== "custom-path";

  const browse = () => {
    void (async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        title: `${name} 실행 파일 선택`,
        filters: [{ name: "실행 파일", extensions: ["exe", "cmd", "bat"] }],
      });
      if (typeof picked === "string") setDraft(picked);
    })();
  };

  return (
    <Card name={name} kind="local" agent={agent} loading={loading} error={error}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <ReadOnlyRow
          label="실행 파일"
          value={agent?.path ?? ""}
          badge={agent ? sourceLabel(agent.source) : null}
        />
        <ReadOnlyRow label="버전" value={agent?.version ?? ""} />
      </div>

      <Field
        label="실행 파일 직접 지정 (선택)"
        note={
          info?.envVar
            ? `비워 두면 PATH · npm · scoop · fnm 등에서 찾습니다. 환경변수 ${info.envVar} 로도 지정할 수 있습니다.`
            : "비워 두면 PATH 와 알려진 설치 위치에서 찾습니다."
        }
      >
        <div style={{ display: "flex", gap: 6 }}>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`C:\\Users\\me\\AppData\\Roaming\\npm\\${id}.cmd`}
            style={{ ...inputMono, flex: 1, minWidth: 0 }}
            focusStyle={inputFocus}
          />
          <Btn label="찾아보기" onClick={browse} />
        </div>
      </Field>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Btn
          label="저장하고 다시 탐지"
          primary
          onClick={() => guard(saveAgentBin(id, draft.trim() || null))}
        />
        {saved && <Btn label="지정 해제" onClick={() => guard(saveAgentBin(id, null))} />}
        <Btn label="다시 탐지" onClick={() => void detectOne(id, true)} />
      </div>
      {saveError && <div style={{ ...hintStyle, color: "#c04a4a" }}>{saveError}</div>}
      {ignored && (
        <div style={{ ...hintStyle, color: "#a06a3b" }}>
          지정한 경로를 쓰지 못해 다른 위치에서 찾았습니다. 절대 경로인지, 그 파일이 실제로
          있는지 확인하세요.
        </div>
      )}

      <Models agent={agent} />
      <div style={hintStyle}>
        추천 · 위키 반영 모두 도구 사용을 차단한 채 실행됩니다 — 파일을 읽거나 고치지 않고
        텍스트 답변만 받습니다(필요한 내용은 앱이 프롬프트에 실어 보냅니다).
      </div>
    </Card>
  );
}
