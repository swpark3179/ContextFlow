import { Input } from "../lib/ui";
import { useStore } from "../store/useStore";
import { GhostButton, Modal, ModalFooter } from "./Modal";
import { Box } from "../lib/ui";

/**
 * Permanent delete, exactly as designed: no recycle bin, and the only guard is
 * typing the name back. Kept deliberately blunt.
 */
export default function DeleteModal() {
  const s = useStore();
  const del = s.del;
  if (!del) return null;

  const task = s.tasks.find((t) => t.folder === s.activeFolder);
  const ready = del.confirm.trim() === del.name;

  return (
    <Modal width={420} zIndex={82} onClose={() => s.set({ del: null })}>
      <div style={{ padding: "14px 16px 12px 16px", borderBottom: "1px solid #f0ede7" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              flex: "0 0 18px",
              background: "#fceceb",
              color: "#a83c3c",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            !
          </div>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {del.isDir ? "폴더를 완전히 삭제할까요?" : "파일을 완전히 삭제할까요?"}
          </span>
        </div>
        <div
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 11.5,
            color: "#6a665e",
            marginTop: 8,
            wordBreak: "break-all",
          }}
        >
          {task?.relFolder ?? ""}
          {del.path}
        </div>
        <div style={{ fontSize: 11.5, color: "#a83c3c", marginTop: 6, lineHeight: 1.6 }}>
          {del.isDir
            ? `하위 파일 ${del.files}개 · 하위 폴더 ${del.dirs}개가 함께 삭제됩니다`
            : "이 파일이 삭제됩니다"}{" "}
          · 휴지통을 거치지 않고 즉시 삭제되며 되돌릴 수 없습니다.
        </div>
      </div>
      <div style={{ padding: "12px 16px" }}>
        <div style={{ fontSize: 11.5, color: "#6a665e", marginBottom: 6 }}>
          확인을 위해 이름을 입력하세요 —{" "}
          <span style={{ fontFamily: "'Roboto Mono',monospace", color: "#23211e" }}>
            {del.name}
          </span>
        </div>
        <Input
          autoFocus
          value={del.confirm}
          onChange={(e) => s.set({ del: { ...del, confirm: e.target.value } })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) void s.commitDelete();
            else if (e.key === "Escape") s.set({ del: null });
          }}
          placeholder={del.name}
          style={{
            width: "100%",
            height: 29,
            border: "1px solid #ddd8cf",
            borderRadius: 5,
            padding: "0 9px",
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 12.5,
            outline: "none",
          }}
          focusStyle={{ borderColor: "#c04a4a", boxShadow: "0 0 0 2px #fbe8e6" }}
        />
      </div>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <GhostButton onClick={() => s.set({ del: null })}>취소</GhostButton>
        <Box
          onClick={() => ready && void s.commitDelete()}
          style={{
            height: 28,
            padding: "0 15px",
            display: "flex",
            alignItems: "center",
            borderRadius: 5,
            fontSize: 12.5,
            fontWeight: 600,
            background: ready ? "#c04a4a" : "#f0dcd9",
            color: ready ? "#fff" : "#c9a7a2",
            cursor: ready ? "pointer" : "not-allowed",
          }}
          hover={ready ? { background: "#a83c3c" } : undefined}
        >
          완전 삭제
        </Box>
      </ModalFooter>
    </Modal>
  );
}
