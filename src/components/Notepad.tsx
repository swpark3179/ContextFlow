import { useRef } from "react";
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
  /**
   * 메모를 **실제로 고쳤는지** 는 포커스가 떠날 때 들어온 값과 비교해서 안다.
   * 글자마다 오늘의 한일을 다시 쓰지 않으려는 것이고, 그냥 지나가며 클릭한 메모장이
   * 목록에 업무를 올리지 않게 하려는 것이다.
   */
  const entry = useRef("");

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
          onFocus={() => {
            entry.current = ui.notepad;
          }}
          onBlur={() => {
            if (ui.notepad !== entry.current) s.noteToday();
            void s.persistSnapshot();
          }}
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
