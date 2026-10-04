import { useState } from "react";
import { Box } from "../../lib/ui";
import type { AgentInfo } from "../../lib/ai";
import { useAi } from "../../store/aiStore";
import FabrixCard from "./FabrixCard";
import LocalCliCard from "./LocalCliCard";
import { cardStyle, statusColor } from "./shared";

/**
 * 레지스트리를 아직 못 읽었을 때 그릴 탭 — `agents.rs` 의 `AGENT_DEFS` 와 같은 순서.
 * 비워 두면 앱을 연 직후 한순간 설정 화면의 AI 연결 칸이 통째로 사라졌다 나타난다.
 */
const FALLBACK: AgentInfo[] = [
  { id: "fabrix", name: "FabriX", kind: "remote", envVar: null },
  { id: "claude", name: "Claude Code", kind: "local", envVar: "CLAUDE_BIN" },
  { id: "codex", name: "Codex CLI", kind: "local", envVar: "CODEX_BIN" },
];

/**
 * AI 연결 — 서비스마다 탭 하나.
 *
 * 예전에는 서비스마다 카드를 세로로 쌓아 설정 화면의 절반이 연결 카드였다. 한 번에 하나만
 * 고치므로 탭으로 접는다. 순서는 레지스트리 순서(FabriX 먼저)를 그대로 따른다.
 *
 * **안 보이는 탭도 그려 둔다**(`display: none`). 원격 탭은 입력을 초안으로 들고 있다가
 * [저장] 에서 한 번에 보내므로, 탭을 옮길 때 컴포넌트를 내리면 고쳐 놓은 값이 말없이
 * 사라진다. 저장 안 한 초안이 있는 탭에는 머리에 표시가 붙는다.
 */
export default function AiConnectionsCard() {
  const loaded = useAi((s) => s.infos);
  const infos = loaded.length ? loaded : FALLBACK;
  const [picked, setPicked] = useState(infos[0]!.id);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const current = infos.some((i) => i.id === picked) ? picked : infos[0]!.id;

  return (
    <div style={cardStyle}>
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 2,
          padding: "4px 6px 0",
          background: "#f7f5f1",
          borderBottom: "1px solid #e6e2da",
        }}
      >
        {infos.map((i) => (
          <Tab
            key={i.id}
            info={i}
            on={i.id === current}
            dirty={!!dirty[i.id]}
            onClick={() => setPicked(i.id)}
          />
        ))}
      </div>
      {infos.map((i) => (
        <div key={i.id} role="tabpanel" style={{ display: i.id === current ? "block" : "none" }}>
          {i.id === "fabrix" ? (
            <FabrixCard onDirtyChange={(v) => setDirty((d) => (d[i.id] === v ? d : { ...d, [i.id]: v }))} />
          ) : (
            <LocalCliCard id={i.id} />
          )}
        </div>
      ))}
    </div>
  );
}

function Tab({
  info,
  on,
  dirty,
  onClick,
}: {
  info: AgentInfo;
  on: boolean;
  dirty: boolean;
  onClick: () => void;
}) {
  const agent = useAi((s) => s.detected[info.id] ?? null);
  const loading = useAi((s) => !!s.loading[info.id]);
  return (
    <Box
      role="tab"
      aria-selected={on}
      title={dirty ? "저장하지 않은 변경이 있습니다" : undefined}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "6px 12px 7px",
        marginBottom: -1,
        borderRadius: "5px 5px 0 0",
        // 테두리는 변마다 따로 적는다 — 줄임형(`border`)과 섞으면 React 가 다시 그릴 때 경고한다.
        borderTop: `1px solid ${on ? "#e6e2da" : "transparent"}`,
        borderLeft: `1px solid ${on ? "#e6e2da" : "transparent"}`,
        borderRight: `1px solid ${on ? "#e6e2da" : "transparent"}`,
        borderBottom: `1px solid ${on ? "#fff" : "transparent"}`,
        background: on ? "#fff" : "transparent",
        fontSize: 12,
        fontWeight: on ? 600 : 500,
        color: on ? "#23211e" : "#6a665e",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
      hover={on ? undefined : { background: "#efebe4" }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          flex: "0 0 6px",
          background: statusColor(agent, loading),
        }}
      />
      {info.name}
      {dirty && <span style={{ color: "#8f5d17", fontSize: 12 }}>●</span>}
    </Box>
  );
}
