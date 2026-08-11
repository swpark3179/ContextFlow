import { useEffect, useState } from "react";
import { Box, Input, TextArea } from "../lib/ui";
import { useStore } from "../store/useStore";
import {
  GhostButton,
  Modal,
  ModalFooter,
  OptionCard,
  PrimaryButton,
  inputFocus,
  inputStyle,
} from "./Modal";
import { sanitizeFolderName } from "../lib/vaultPaths";
import * as api from "../lib/api";

export default function TemplateModal() {
  const s = useStore();
  const tp = s.tplNew;
  // 폴더 모드에서 "복사될 파일" 목록. 훅은 조기 반환보다 앞에 와야 한다.
  const [srcFiles, setSrcFiles] = useState<string[]>([]);
  const src = tp?.src ?? "";
  useEffect(() => {
    if (!src) return setSrcFiles([]);
    let live = true;
    void api
      .listTaskFiles(src)
      .then((f) => live && setSrcFiles(f.map((e) => (e.dir ? `${e.p}/` : e.p))))
      .catch(() => live && setSrcFiles([]));
    return () => {
      live = false;
    };
  }, [src]);

  if (!tp) return null;

  const name = tp.name.trim();
  const folderMode = tp.mode === "folder";
  const safe = sanitizeFolderName(name) || "새 템플릿";
  const path = `${s.settings.vault.split("/").pop()}/Templates/${safe}${folderMode ? "/" : ".md"}`;

  const preview = folderMode
    ? srcFiles.length
      ? srcFiles
      : [src ? "(빈 폴더)" : "폴더를 선택하세요."]
    : [
        "---",
        `template: ${name || "(이름 없음)"}`,
        `purpose: ${tp.desc || "—"}`,
        "---",
        "",
        ...tp.sections
          .split("\n")
          .filter((x) => x.trim())
          .map((x) => `## ${x.trim()}`),
      ];

  const pickFolder = () => {
    void (async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false, title: "템플릿 폴더 선택" });
      if (typeof picked !== "string") return;
      const dir = picked.replace(/\\/g, "/");
      // 이름을 아직 안 적었으면 폴더 이름을 그대로 쓴다.
      const base = dir.split("/").pop() ?? "";
      s.set({ tplNew: { ...tp, src: dir, name: tp.name.trim() ? tp.name : base } });
    })();
  };

  const label = { fontSize: 12, fontWeight: 600, color: "#6a665e", marginBottom: 5 } as const;

  return (
    <Modal
      width={720}
      zIndex={74}
      onClose={() => s.set({ tplNew: null })}
      panelStyle={{ height: 480, maxHeight: "90vh" }}
    >
      <div
        style={{
          flex: "0 0 40px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          borderBottom: "1px solid #e6e2da",
          background: "#faf9f6",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>표준 패턴 추가</span>
        <span style={{ fontSize: 11.5, color: "#8a857c" }}>
          {folderMode
            ? "폴더를 통째로 등록하면 새 업무에 그 파일들이 그대로 복사됩니다"
            : "반복되는 업무의 골격을 템플릿으로 등록해 회차 로그로 누적합니다"}
        </span>
        <div style={{ flex: 1 }} />
        <Box
          onClick={() => s.set({ tplNew: null })}
          style={{
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            cursor: "pointer",
            color: "#8a857c",
            fontSize: 13,
          }}
          hover={{ background: "#ece8e0" }}
        >
          ✕
        </Box>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div
          style={{
            flex: "0 0 55%",
            minWidth: 0,
            padding: 14,
            display: "flex",
            flexDirection: "column",
            gap: 11,
            overflow: "auto",
            borderRight: "1px solid #e6e2da",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <OptionCard
              on={!folderMode}
              onClick={() => s.set({ tplNew: { ...tp, mode: "sections" } })}
              label="섹션 직접 입력"
              desc="헤딩만 있는 노트 한 장을 만듭니다. 새 업무의 index.md 골격이 됩니다."
            />
            <OptionCard
              on={folderMode}
              onClick={() => s.set({ tplNew: { ...tp, mode: "folder" } })}
              label="폴더에서 가져오기"
              desc="고른 폴더를 Templates/ 안으로 복사합니다. 새 업무를 만들 때 그 파일이 전부 따라옵니다."
            />
          </div>

          {folderMode && (
            <div>
              <div style={label}>원본 폴더</div>
              <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: 29,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 9px",
                    border: "1px solid #ddd8cf",
                    borderRadius: 5,
                    background: "#faf9f6",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 11,
                    color: src ? "#4e4a43" : "#a09a8f",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={src}
                >
                  {src || "선택된 폴더 없음"}
                </div>
                <GhostButton onClick={pickFolder}>폴더 선택</GhostButton>
              </div>
            </div>
          )}

          <div>
            <div style={label}>템플릿 이름</div>
            <Input
              autoFocus
              value={tp.name}
              onChange={(e) => s.set({ tplNew: { ...tp, name: e.target.value } })}
              placeholder="예: 릴리스 노트 양식"
              style={inputStyle}
              focusStyle={inputFocus}
            />
          </div>
          <div>
            <div style={label}>설명</div>
            <Input
              value={tp.desc}
              onChange={(e) => s.set({ tplNew: { ...tp, desc: e.target.value } })}
              placeholder="어떤 상황에서 쓰는 패턴인지"
              style={inputStyle}
              focusStyle={inputFocus}
            />
          </div>
          {!folderMode && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#6a665e" }}>섹션 구성</span>
              <span style={{ fontSize: 11, color: "#a09a8f" }}>한 줄에 하나씩</span>
            </div>
            <TextArea
              value={tp.sections}
              onChange={(e) => s.set({ tplNew: { ...tp, sections: e.target.value } })}
              spellCheck={false}
              style={{
                width: "100%",
                height: 110,
                border: "1px solid #ddd8cf",
                borderRadius: 5,
                padding: "8px 9px",
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 12.5,
                lineHeight: 1.7,
                outline: "none",
              }}
              focusStyle={inputFocus}
            />
          </div>
          )}
          {!folderMode && (
          <Box
            onClick={() => {
              const on = !tp.fromTask;
              const doc = s.ui.docs["index.md"];
              const heads = (doc?.text ?? "")
                .split("\n")
                .filter((l) => /^##\s+/.test(l))
                .map((l) => l.replace(/^##\s+/, "").trim());
              s.set({
                tplNew: {
                  ...tp,
                  fromTask: on,
                  sections: on && heads.length ? heads.join("\n") : tp.sections,
                },
              });
            }}
            style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
          >
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                flex: "0 0 14px",
                border: `1px solid ${tp.fromTask ? "#3a6fd8" : "#cfcabf"}`,
                background: tp.fromTask ? "#3a6fd8" : "#fff",
                color: "#fff",
                fontSize: 11,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {tp.fromTask ? "✓" : ""}
            </div>
            <span style={{ fontSize: 12, color: "#4e4a43" }}>
              현재 업무의 index.md 구조에서 섹션 가져오기
            </span>
          </Box>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "#fbfaf7" }}>
          <div
            style={{
              flex: "0 0 30px",
              display: "flex",
              alignItems: "center",
              padding: "0 12px",
              borderBottom: "1px solid #e6e2da",
            }}
          >
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "#4e4a43" }}>
              {folderMode ? "복사될 파일" : "생성될 템플릿"}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px" }}>
            {preview.map((l, i) => (
              <div
                key={i}
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11.5,
                  lineHeight: 1.75,
                  color: l === "---" ? "#b5afa2" : l.startsWith("## ") ? "#2f5cbb" : "#3a3630",
                  minHeight: 18,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {l}
              </div>
            ))}
          </div>
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
          {path}
        </span>
        <GhostButton onClick={() => s.set({ tplNew: null })}>취소</GhostButton>
        <PrimaryButton
          disabled={!name || (folderMode && !src)}
          onClick={() => void s.createTemplate()}
        >
          템플릿 등록
        </PrimaryButton>
      </ModalFooter>
    </Modal>
  );
}
