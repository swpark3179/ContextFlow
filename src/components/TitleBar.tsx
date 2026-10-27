import { getCurrentWindow } from "@tauri-apps/api/window";
import { Box } from "../lib/ui";
// 배포 워크플로가 빌드 전에 package.json 의 버전을 올린다 — 손으로 적은 "v0.3" 은 v1.6 이 되도록 그대로였다.
import { version } from "../../package.json";

/** Custom chrome — the Tauri window runs with `decorations: false`. */
export default function TitleBar({ title }: { title: string }) {
  const win = getCurrentWindow();
  const btn: React.CSSProperties = {
    width: 44,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#5d594f",
    fontSize: 13,
    cursor: "default",
  };

  return (
    <div
      style={{
        height: 34,
        flex: "0 0 34px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 0 0 11px",
        background: "linear-gradient(#f7f5f1,#f1eee9)",
        borderBottom: "1px solid #e0dcd4",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }} data-tauri-drag-region>
        <div
          style={{
            width: 13,
            height: 13,
            borderRadius: 4,
            background: "linear-gradient(140deg,#3a6fd8,#6a54c6)",
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.1px" }}>ContextFlow</span>
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 11.5,
            color: "#6a665e",
            border: "1px solid #ded9d0",
            borderRadius: 3,
            padding: "0 4px",
            lineHeight: "15px",
          }}
        >
          v{version}
        </span>
      </div>
      <div
        data-tauri-drag-region
        style={{
          flex: 1,
          textAlign: "center",
          fontSize: 12.5,
          color: "#8a857c",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          alignSelf: "stretch",
          lineHeight: "34px",
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", alignItems: "stretch", height: 34 }}>
        <Box
          style={btn}
          title="최소화"
          aria-label="최소화"
          hover={{ background: "#e6e2da" }}
          onClick={() => void win.minimize()}
        >
          –
        </Box>
        <Box
          style={{ ...btn, fontSize: 11 }}
          title="최대화"
          aria-label="최대화"
          hover={{ background: "#e6e2da" }}
          onClick={() => void win.toggleMaximize()}
        >
          ◻
        </Box>
        <Box
          style={{ ...btn, width: 46 }}
          title="닫기"
          aria-label="닫기"
          hover={{ background: "#d64545", color: "#fff" }}
          onClick={() => void win.close()}
        >
          ✕
        </Box>
      </div>
    </div>
  );
}
