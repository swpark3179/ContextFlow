import { Box } from "../lib/ui";
import { appsFor, extStyle } from "../lib/design";
import { useStore } from "../store/useStore";
import { GhostButton, Modal, ModalFooter, PrimaryButton } from "./Modal";

/**
 * Mirrors the design's app chooser. The listed apps are the conventional
 * handlers for the extension; picking one hands off to the OS association
 * (Windows decides which binary actually runs), and "항상 이 앱으로" opens the
 * real Windows chooser where that preference can be set for good.
 */
export default function OpenWithModal() {
  const s = useStore();
  const ow = s.ow;
  if (!ow) return null;

  const apps = appsFor(ow.ext);
  const es = extStyle(ow.ext);
  const task = s.tasks.find((t) => t.folder === s.activeFolder);

  return (
    <Modal width={430} zIndex={79} onClose={() => s.set({ ow: null })}>
      <div style={{ padding: "14px 16px 12px 16px", borderBottom: "1px solid #f0ede7" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>이 파일을 열 방법 선택</div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 7 }}>
          <span
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 8.5,
              fontWeight: 600,
              borderRadius: 2,
              padding: "1px 3px",
              color: es.fg,
              background: es.bg,
              flex: "0 0 auto",
            }}
          >
            {ow.ext.toUpperCase() || "—"}
          </span>
          <span
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              color: "#6a665e",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {task?.relFolder ?? ""}
            {ow.path}
          </span>
        </div>
      </div>

      <div
        style={{
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          maxHeight: 220,
          overflow: "auto",
        }}
      >
        {apps.map((p, i) => {
          const on = i === ow.pick;
          return (
            <Box
              key={p.n}
              onClick={() => s.set({ ow: { ...ow, pick: i } })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 9px",
                borderRadius: 6,
                cursor: "pointer",
                border: `1px solid ${on ? "#cddcf8" : "#eae6de"}`,
                background: on ? "#f7fafe" : "#fff",
              }}
              hover={{ borderColor: "#c9dbf7" }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 5,
                  flex: "0 0 26px",
                  background: p.c,
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {p.n.slice(0, 1)}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: on ? 600 : 500, color: "#23211e" }}>
                  {p.n}
                </div>
                <div style={{ fontSize: 11, color: "#8a857c", marginTop: 1 }}>{p.d}</div>
              </div>
              <div
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  flex: "0 0 13px",
                  border: `1px solid ${on ? "#3a6fd8" : "#cfcabf"}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: on ? "#3a6fd8" : "transparent",
                  }}
                />
              </div>
            </Box>
          );
        })}
      </div>

      <Box
        onClick={() => s.set({ ow: { ...ow, always: !ow.always } })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "2px 16px 12px 16px",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            flex: "0 0 14px",
            border: `1px solid ${ow.always ? "#3a6fd8" : "#cfcabf"}`,
            background: ow.always ? "#3a6fd8" : "#fff",
            color: "#fff",
            fontSize: 11,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {ow.always ? "✓" : ""}
        </div>
        <span style={{ fontSize: 12, color: "#4e4a43" }}>
          항상 이 앱으로 .{ow.ext} 파일 열기
        </span>
      </Box>

      <ModalFooter>
        <span style={{ fontSize: 10.5, color: "#a09a8f", flex: 1 }}>
          OS 연결 프로그램으로 실행됩니다
        </span>
        <GhostButton onClick={() => s.set({ ow: null })}>취소</GhostButton>
        <PrimaryButton onClick={() => void s.confirmOpenWith()}>열기</PrimaryButton>
      </ModalFooter>
    </Modal>
  );
}
