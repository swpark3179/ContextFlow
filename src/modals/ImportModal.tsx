import { useMemo } from "react";
import { extOf, extStyle } from "../lib/design";
import { dirsOf } from "../lib/tree";
import { useStore } from "../store/useStore";
import { GhostButton, Modal, ModalFooter, OptionCard, PrimaryButton, labelStyle } from "./Modal";

const MODES: [("copy" | "link"), string, string][] = [
  [
    "copy",
    "Vault 안으로 복사",
    "원본과 분리된 사본을 업무 폴더에 저장합니다. 원본을 옮기거나 지워도 안전합니다.",
  ],
  [
    "link",
    "심볼릭 링크로 연결",
    "원본 위치를 그대로 참조합니다. 대용량 파일이나 공용 자료에 적합합니다. Windows에서는 개발자 모드나 관리자 권한이 필요하며, 실패하면 자동으로 복사합니다.",
  ],
];

export default function ImportModal() {
  const s = useStore();
  const drop = s.drop;
  const folders = useMemo(() => dirsOf(s.files), [s.files]);
  if (!drop) return null;

  const task = s.tasks.find((t) => t.folder === s.activeFolder);

  return (
    <Modal width={460} zIndex={76} onClose={() => s.set({ drop: null })}>
      <div style={{ padding: "14px 16px 12px 16px", borderBottom: "1px solid #f0ede7" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>외부 파일을 업무 폴더로 가져오기</div>
        <div style={{ fontSize: 11.5, color: "#8a857c", marginTop: 4 }}>
          {drop.names.length}개 항목 · 창 밖에서 끌어온 항목
        </div>
      </div>

      <div
        style={{
          padding: "9px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 3,
          maxHeight: 132,
          overflow: "auto",
          borderBottom: "1px solid #f0ede7",
        }}
      >
        {drop.names.map((n, i) => {
          const es = extStyle(extOf(n));
          const src = drop.paths[i]?.replace(/\\/g, "/").split("/").slice(-2, -1)[0] ?? "";
          return (
            <div
              key={`${n}${i}`}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 4px" }}
            >
              <span
                style={{
                  flex: "0 0 auto",
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 8.5,
                  fontWeight: 600,
                  borderRadius: 2,
                  padding: "1px 3px",
                  color: es.fg,
                  background: es.bg,
                }}
              >
                {extOf(n).toUpperCase() || "—"}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  color: "#3a3630",
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {n}
              </span>
              <span
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 10.5,
                  color: "#b5afa2",
                  flex: "0 0 auto",
                }}
              >
                {src}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={labelStyle}>가져오는 방식</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {MODES.map(([k, label, desc]) => (
              <OptionCard
                key={k}
                on={drop.mode === k}
                label={label}
                desc={desc}
                onClick={() => s.set({ drop: { ...drop, mode: k } })}
              />
            ))}
          </div>
        </div>
        <div>
          <div style={labelStyle}>대상 폴더</div>
          <select
            value={drop.target}
            onChange={(e) => s.set({ drop: { ...drop, target: e.target.value } })}
            style={{
              width: "100%",
              height: 28,
              border: "1px solid #ddd8cf",
              borderRadius: 5,
              padding: "0 6px",
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              background: "#fff",
              outline: "none",
            }}
          >
            <option value="">(루트) {task?.relFolder ?? ""}</option>
            {folders.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ModalFooter>
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 10.5,
            color: "#a09a8f",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {task?.relFolder ?? ""}
          {drop.target}
        </span>
        <GhostButton onClick={() => s.set({ drop: null })}>취소</GhostButton>
        <PrimaryButton onClick={() => void s.commitImport()}>
          {drop.mode === "copy" ? "복사해서 가져오기" : "링크로 연결"}
        </PrimaryButton>
      </ModalFooter>
    </Modal>
  );
}
