import { useMemo } from "react";
import { Box, Input, TextArea } from "../lib/ui";
import { extOf, extStyle, VIOLET } from "../lib/design";
import { BSTORM_EXT } from "../lib/bstorm";
import { sanitizeFolderName } from "../lib/vaultPaths";
import { useStore } from "../store/useStore";
import { GhostButton, inputFocus, inputStyle, labelStyle, Modal, ModalFooter } from "./Modal";

/** 트리와 같은 확장자 배지. `.bs.md` 는 `md` 가 아니라 BS 로 가른다(`Explorer` 와 같다). */
function badgeFor(path: string, dir: boolean): { label: string; fg: string; bg: string } {
  if (dir) return { label: "DIR", fg: "#8f5d17", bg: "#fbf3e6" };
  if (path.toLowerCase().endsWith(BSTORM_EXT)) return { label: "BS", fg: "#256b47", bg: "#e9f4ee" };
  const e = extOf(path);
  return { label: e.toUpperCase() || "FILE", ...extStyle(e) };
}

/**
 * 업무 분할 — 고른 **최상위** 파일·폴더를 새 업무로 옮긴다.
 *
 * 최상위만 고르게 하는 것이 이 화면의 규칙이다. 폴더 안쪽까지 낱개로 고르게 하면 옮긴
 * 뒤 양쪽에 반쪽짜리 폴더가 남고, 어느 쪽이 원본인지 알 수 없게 된다. 폴더를 고르면 그
 * 아래는 통째로 따라온다 — 옮기는 것이 폴더 하나이므로 저절로 그렇다.
 *
 * **복사가 아니라 이동이다.** 끝난 뒤 같은 파일이 두 업무에 있는 일은 없다. 그래서
 * 실패했을 때 절반만 옮겨진 상태를 남기지 않는 것이 백엔드의 약속이고(`vault::split_task`),
 * 실패 사유는 이 대화상자 안에 남는다.
 */
export default function SplitModal() {
  const s = useStore();
  const split = s.split;
  // `files` 는 **열려 있는 업무**의 트리다. 나눌 업무를 먼저 열고 이 대화상자를 띄우므로
  // (`openSplit`) 보통 같은 업무이지만, 어긋난 순간에 남의 업무 파일을 목록에 올리는
  // 일은 없어야 한다 — 그 목록이 곧 옮길 것을 정한다.
  const files = s.activeFolder === split?.source ? s.files : [];

  /** 트리의 최상위 줄들. 폴더가 먼저, 그 다음 파일 — 탐색기와 같은 순서다. */
  const rows = useMemo(() => {
    const top = files.filter((f) => f.p.replace(/\/$/, "").split("/").length === 1);
    const dirs = top.filter((f) => f.dir);
    const rest = top.filter((f) => !f.dir);
    return [...dirs, ...rest].map((f) => ({
      ...f,
      /** 폴더 안에 든 항목 수. 무엇이 함께 가는지 숫자로 보여 준다. */
      count: f.dir ? files.filter((x) => x.p !== f.p && x.p.startsWith(f.p)).length : 0,
    }));
  }, [files]);

  if (!split) return null;

  const source = s.tasks.find((t) => t.folder === split.source);
  // `index.md` 는 업무의 메타데이터 노트라 옮길 수 없다(`fsops` 의 삭제·이동 금지와 같다).
  const movable = rows.filter((f) => f.p !== "index.md");
  const picked = movable.filter((f) => split.sel[f.p]);
  const allOn = movable.length > 0 && picked.length === movable.length;
  const title = split.title.trim();
  const ready = !!title && picked.length > 0 && !split.busy;
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const folderPreview = `Tasks/[${monthPrefix}] ${sanitizeFolderName(title) || "새 업무"}/`;

  const toggle = (p: string) => s.set({ split: { ...split, sel: { ...split.sel, [p]: !split.sel[p] }, error: "" } });
  const toggleAll = () =>
    s.set({
      split: {
        ...split,
        sel: allOn ? {} : Object.fromEntries(movable.map((f) => [f.p, true])),
        error: "",
      },
    });

  return (
    <Modal
      width={760}
      zIndex={76}
      onClose={() => !split.busy && s.set({ split: null })}
      panelStyle={{ height: 540, maxHeight: "90vh" }}
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
        <span style={{ fontSize: 14, fontWeight: 600 }}>업무 분할</span>
        <span style={{ fontSize: 11.5, color: "#8a857c" }}>
          고른 최상위 항목을 새 업무로 옮깁니다 · 폴더는 하위 전체가 함께 갑니다
        </span>
        <div style={{ flex: 1 }} />
        <Box
          onClick={() => !split.busy && s.set({ split: null })}
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
            flex: "0 0 52%",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid #e6e2da",
          }}
        >
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 12px 7px 12px",
            }}
          >
            <span style={{ ...labelStyle, marginBottom: 0, flex: 1, minWidth: 0 }}>
              옮길 항목 {picked.length}/{movable.length}
            </span>
            {movable.length > 0 && (
              <Box
                onClick={toggleAll}
                style={{ fontSize: 11, color: "#3a6fd8", cursor: "pointer" }}
                hover={{ textDecoration: "underline" }}
              >
                {allOn ? "전체 해제" : "전체 선택"}
              </Box>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 8px 10px 8px" }}>
            {movable.length === 0 && (
              <div
                style={{
                  padding: "20px 12px",
                  fontSize: 12,
                  color: "#a09a8f",
                  textAlign: "center",
                  lineHeight: 1.7,
                }}
              >
                옮길 파일이 없습니다.
                <br />
                업무 노트(index.md)는 업무와 함께 남습니다.
              </div>
            )}
            {movable.map((f) => {
              const on = !!split.sel[f.p];
              const es = badgeFor(f.p, f.dir);
              return (
                <Box
                  key={f.p}
                  onClick={() => toggle(f.p)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 7px",
                    borderRadius: 5,
                    cursor: "pointer",
                    border: `1px solid ${on ? "#e0d6f8" : "transparent"}`,
                    background: on ? "#f7f4fe" : "transparent",
                    marginBottom: 1,
                  }}
                  hover={on ? undefined : { background: "#f4f2ee" }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      flex: "0 0 14px",
                      border: `1px solid ${on ? VIOLET : "#cfcabf"}`,
                      background: on ? VIOLET : "#fff",
                      color: "#fff",
                      fontSize: 11,
                      lineHeight: "13px",
                      textAlign: "center",
                    }}
                  >
                    {on ? "✓" : ""}
                  </div>
                  <span
                    style={{
                      fontFamily: "'Roboto Mono',monospace",
                      fontSize: 8.5,
                      fontWeight: 600,
                      borderRadius: 2,
                      padding: "1px 3px",
                      flex: "0 0 auto",
                      color: es.fg,
                      background: es.bg,
                    }}
                  >
                    {es.label}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "#23211e",
                    }}
                    title={f.p}
                  >
                    {f.name}
                  </span>
                  <span
                    style={{
                      fontFamily: "'Roboto Mono',monospace",
                      fontSize: 10.5,
                      color: "#a09a8f",
                      flex: "0 0 auto",
                    }}
                  >
                    {f.dir ? `하위 ${f.count}개` : f.size}
                  </span>
                </Box>
              );
            })}
            {rows.some((f) => f.p === "index.md") && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 7px",
                  marginTop: 3,
                  borderTop: "1px solid #f0ede7",
                  fontSize: 11.5,
                  color: "#a09a8f",
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>index.md</span>
                <span>업무 노트라 남습니다</span>
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 11,
            padding: "11px 13px",
            overflowY: "auto",
            background: "#fdfcfa",
          }}
        >
          <div>
            <div style={labelStyle}>새 업무 제목</div>
            <Input
              autoFocus
              value={split.title}
              onChange={(e) => s.set({ split: { ...split, title: e.target.value, error: "" } })}
              onKeyDown={(e) => {
                // 한글 조합을 닫는 Enter 까지 받으면 제목을 치다가 분할이 시작된다.
                if (e.key !== "Enter" || e.repeat || e.nativeEvent.isComposing) return;
                if (ready) void s.doSplit();
              }}
              placeholder="갈라져 나온 업무의 제목"
              style={inputStyle}
              focusStyle={inputFocus}
            />
            <div
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11,
                color: "#8a857c",
                marginTop: 6,
                wordBreak: "break-all",
              }}
            >
              {folderPreview}
            </div>
          </div>
          <div>
            <div style={labelStyle}>개요</div>
            <TextArea
              value={split.summary}
              onChange={(e) => s.set({ split: { ...split, summary: e.target.value } })}
              placeholder="왜 갈라 놓는지 한두 줄"
              style={{
                width: "100%",
                height: 74,
                border: "1px solid #ddd8cf",
                borderRadius: 5,
                padding: "7px 9px",
                fontSize: 12.5,
                lineHeight: 1.6,
                resize: "none",
                outline: "none",
                color: "#23211e",
                background: "#fff",
              }}
              focusStyle={inputFocus}
            />
          </div>
          <div>
            <div style={labelStyle}>태그 (쉼표로 구분)</div>
            <Input
              value={split.tags}
              onChange={(e) => s.set({ split: { ...split, tags: e.target.value } })}
              placeholder="dev, infra"
              style={inputStyle}
              focusStyle={inputFocus}
            />
          </div>
          <div style={{ fontSize: 11.5, color: "#8a857c", lineHeight: 1.65 }}>
            원본 업무: {source?.title ?? ""} · 고른 항목은 <b>복사가 아니라 이동</b>이며,
            파일이 다른 프로그램에서 열려 있으면 아무것도 옮기지 않고 실패합니다.
          </div>
        </div>
      </div>

      {!!split.error && (
        <div
          style={{
            flex: "0 0 auto",
            borderTop: "1px solid #f0d6d2",
            background: "#fdf2f1",
            padding: "8px 14px",
            fontSize: 11.5,
            color: "#a83c3c",
            lineHeight: 1.6,
            wordBreak: "break-all",
          }}
        >
          분할하지 못했습니다 · {split.error}
        </div>
      )}

      <ModalFooter>
        <span style={{ fontSize: 11.5, color: "#8a857c", flex: 1, minWidth: 0 }}>
          {picked.length
            ? `${picked.length}개 항목이 새 업무로 이동합니다`
            : "옮길 항목을 하나 이상 고르세요"}
        </span>
        <GhostButton onClick={() => !split.busy && s.set({ split: null })}>취소</GhostButton>
        <Box
          onClick={() => ready && void s.doSplit()}
          style={{
            height: 28,
            padding: "0 15px",
            display: "flex",
            alignItems: "center",
            borderRadius: 5,
            fontSize: 12.5,
            fontWeight: 600,
            background: ready ? VIOLET : "#e6e2da",
            color: ready ? "#fff" : "#a09a8f",
            cursor: ready ? "pointer" : "not-allowed",
          }}
          hover={ready ? { background: "#5a44b4" } : undefined}
        >
          {split.busy ? "옮기는 중…" : "분할 실행"}
        </Box>
      </ModalFooter>
    </Modal>
  );
}
