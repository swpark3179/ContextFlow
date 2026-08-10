import { Box } from "../lib/ui";
import { useStore } from "../store/useStore";

/**
 * Scratch memo. It is not a file in the vault — it lives in
 * `.context_snapshot.json`, which is exactly the promise the placeholder makes.
 */
export default function Notepad() {
  const s = useStore();
  const { ui } = s;
  const peek = (ui.notepad || "").split("\n")[0] || "비어 있음";

  return (
    <div
      style={{
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        flex: s.noteMin ? "0 0 26px" : "1 1 auto",
      }}
    >
      <div
        onClick={() => s.set({ noteMin: !s.noteMin })}
        style={{
          flex: "0 0 26px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 7px 0 11px",
          background: "#f7f5f1",
          borderBottom: "1px solid #e6e2da",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: ".4px",
            color: "#6a665e",
            whiteSpace: "nowrap",
            flex: "0 0 auto",
          }}
        >
          간단 메모장
        </span>
        {s.noteMin && (
          <span
            style={{
              fontSize: 11,
              color: "#a09a8f",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: "1 1 auto",
              minWidth: 0,
            }}
          >
            {peek}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }} />
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 10.5,
            color: "#a09a8f",
            whiteSpace: "nowrap",
            flex: "0 0 auto",
            overflow: "hidden",
          }}
        >
          자동 저장 {s.snapAt}
        </span>
        <Box
          style={{
            flex: "0 0 17px",
            width: 17,
            height: 17,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 3,
            color: "#8a857c",
            fontSize: 12,
            lineHeight: 1,
          }}
          hover={{ background: "#e6e2da", color: "#3a3630" }}
        >
          {s.noteMin ? "▲" : "–"}
        </Box>
      </div>
      {!s.noteMin && (
        <textarea
          value={ui.notepad}
          onChange={(e) => s.setUi({ notepad: e.target.value })}
          onBlur={() => void s.persistSnapshot()}
          spellCheck={false}
          placeholder="휘발성 메모 — 업무 전환 시 .context_snapshot.json에 그대로 보존됩니다."
          style={{
            flex: 1,
            minHeight: 0,
            width: "100%",
            border: 0,
            outline: "none",
            padding: "9px 12px",
            fontSize: 12.5,
            lineHeight: 1.7,
            color: "#3a3630",
            background: "#fffef9",
          }}
        />
      )}
    </div>
  );
}
