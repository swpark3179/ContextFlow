import { Input } from "../lib/ui";
import { sanitizeFolderName } from "../lib/vaultPaths";
import { useStore } from "../store/useStore";
import { GhostButton, Modal, ModalFooter, PrimaryButton, inputFocus, inputStyle } from "./Modal";

/**
 * 업무명 변경. 제목만 바꾸는 것이 아니라 디스크의 업무 폴더 이름까지 함께 바뀌므로,
 * 확정 전에 **어떤 폴더 이름이 될지** 그대로 보여 준다 — 새 업무 대화상자와 같은 규칙이다.
 */
export default function RenameTaskModal() {
  const s = useStore();
  const ren = s.ren;
  if (!ren) return null;

  const title = ren.title.trim();
  const task = s.tasks.find((t) => t.folder === ren.folder);
  const current = ren.folder.split("/").pop() ?? "";
  // 생성 월을 뜻하는 "[YYYY-MM] " 접두사는 이름이 바뀌어도 그대로 간다(vault::rename_task).
  const end = current.indexOf("] ");
  const prefix = current.startsWith("[") && end >= 0 ? current.slice(0, end + 2) : "";
  const nextFolder = `${prefix}${sanitizeFolderName(title) || "제목 없음"}`;
  const changed = !!title && title !== task?.title;

  const commit = () => {
    if (changed) void s.renameTask(ren.folder, title);
  };

  return (
    <Modal width={480} zIndex={76} onClose={() => s.set({ ren: null })}>
      <div
        style={{
          flex: "0 0 40px",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          borderBottom: "1px solid #e6e2da",
          background: "#faf9f6",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>업무명 변경</span>
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 11 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6a665e", marginBottom: 5 }}>
            새 업무 제목
          </div>
          <Input
            autoFocus
            value={ren.title}
            onChange={(e) => s.set({ ren: { ...ren, title: e.target.value } })}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") s.set({ ren: null });
            }}
            style={inputStyle}
            focusStyle={inputFocus}
          />
        </div>

        <div
          style={{
            border: "1px dashed #ddd8cf",
            borderRadius: 6,
            padding: "9px 10px",
            background: "#faf9f6",
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "#6a665e", marginBottom: 5 }}>
            바뀔 폴더 이름
          </div>
          <div
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11,
              lineHeight: 1.75,
              color: "#8a857c",
              wordBreak: "break-all",
            }}
          >
            {current}
            <br />
            <span style={{ color: changed ? "#2f5cbb" : "#c2bdb2" }}>→ {nextFolder}</span>
          </div>
          <div style={{ fontSize: 11, color: "#a09a8f", marginTop: 6, lineHeight: 1.6 }}>
            index.md의 title과 폴더 이름이 함께 바뀝니다. 다른 노트에서 이 폴더 경로로 걸어 둔
            링크는 끊길 수 있습니다.
          </div>
        </div>
      </div>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        <GhostButton onClick={() => s.set({ ren: null })}>취소</GhostButton>
        <PrimaryButton disabled={!changed} onClick={commit}>
          이름 변경
        </PrimaryButton>
      </ModalFooter>
    </Modal>
  );
}
