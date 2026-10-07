import { BusyLabel, Input } from "../lib/ui";
import { useStore } from "../store/useStore";
import { GhostButton, Modal, ModalFooter, PrimaryButton } from "./Modal";

/**
 * [업무 삭제] — 업무 폴더를 통째로 지운다. 파일 삭제(`DeleteModal`)와 같은 모양이고 같은
 * 안전장치를 쓴다: 휴지통이 없고, 확인은 업무 제목을 그대로 다시 입력하는 것 하나다.
 *
 * Esc 는 여기서 받지 않는다 — 맨 위 레이어 하나만 닫는 App 의 처리에 맡긴다. 입력칸에서도
 * 닫으면 같은 키가 그 아래 레이어까지 닫는다.
 */
export default function TaskDeleteModal() {
  const s = useStore();
  const del = s.taskDel;
  if (!del) return null;

  const task = s.tasks.find((t) => t.folder === del.folder);
  const ready = del.confirm.trim() === del.title.trim();
  const close = () => !del.busy && s.set({ taskDel: null });
  const counts =
    del.files === null
      ? "업무 폴더 안의 모든 파일이 함께 삭제됩니다"
      : `파일 ${del.files}개 · 폴더 ${del.dirs}개가 함께 삭제됩니다`;

  return (
    <Modal width={440} zIndex={82} onClose={close}>
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
          <span style={{ fontSize: 14, fontWeight: 600 }}>업무를 완전히 삭제할까요?</span>
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
          {task?.relFolder ?? del.folder}
        </div>
        <div style={{ fontSize: 11.5, color: "#a83c3c", marginTop: 6, lineHeight: 1.6 }}>
          {counts} · 휴지통을 거치지 않고 즉시 삭제되며 되돌릴 수 없습니다.
        </div>
        <div style={{ fontSize: 11.5, color: "#6a665e", marginTop: 6, lineHeight: 1.6 }}>
          오늘의 한일에 남은 기록은 지우지 않습니다. 끝낸 업무라면 삭제 대신 [완료]로 보관함에 넣어 두고
          나중에 다시 열 수 있습니다.
        </div>
      </div>
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11.5, color: "#6a665e", marginBottom: 6 }}>
            확인을 위해 업무 제목을 입력하세요 —{" "}
            <span style={{ color: "#23211e", fontWeight: 600 }}>{del.title}</span>
          </div>
          <Input
            autoFocus
            value={del.confirm}
            onChange={(e) => s.set({ taskDel: { ...del, confirm: e.target.value, error: "" } })}
            onKeyDown={(e) => {
              // 한글 조합 중의 Enter 는 글자를 확정하는 키다 — 삭제로 넘기지 않는다.
              if (e.key === "Enter" && !e.nativeEvent.isComposing && ready) void s.deleteTask();
            }}
            placeholder={del.title}
            // 막혀서 돌아오면 그 자리에서 다시 누르게 포커스를 지킨다(`disabled` 는 포커스를 버린다).
            readOnly={del.busy}
            style={{
              width: "100%",
              height: 29,
              border: "1px solid #ddd8cf",
              borderRadius: 5,
              padding: "0 9px",
              fontSize: 12.5,
              outline: "none",
            }}
            focusStyle={{ borderColor: "#c04a4a", boxShadow: "0 0 0 2px #fbe8e6" }}
          />
        </div>
        {!!del.error && (
          <div
            style={{
              border: "1px solid #f0d6d2",
              background: "#fdf2f1",
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 11.5,
              color: "#a83c3c",
              lineHeight: 1.6,
              wordBreak: "break-all",
            }}
          >
            삭제하지 못했습니다 · {del.error}
          </div>
        )}
      </div>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <GhostButton onClick={close}>취소</GhostButton>
        <PrimaryButton
          onClick={() => void s.deleteTask()}
          disabled={!ready}
          busy={del.busy}
          bg="#c04a4a"
          hoverBg="#a83c3c"
          minWidth={96}
        >
          <BusyLabel busy={del.busy} color="#fff" idle="완전 삭제">
            지우는 중
          </BusyLabel>
        </PrimaryButton>
      </ModalFooter>
    </Modal>
  );
}
