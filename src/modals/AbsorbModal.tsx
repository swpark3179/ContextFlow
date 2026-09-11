import { useMemo } from "react";
import { Box, Input } from "../lib/ui";
import { statusOf, VIOLET } from "../lib/design";
import { basename } from "../lib/format";
import { sanitizeFolderName } from "../lib/vaultPaths";
import { isArchived, useStore } from "../store/useStore";
import { GhostButton, inputFocus, inputStyle, labelStyle, Modal, ModalFooter } from "./Modal";

/**
 * 업무 편입 — 한 업무의 폴더 전체를 다른 업무의 하위 폴더로 옮긴다.
 *
 * 합치는 것이 아니라 **옮기는 것**이다. 노트를 섞지 않고 파일을 지우지 않으며, 편입된
 * 업무는 업무 리스트에서 사라져 받는 업무 안의 폴더 하나가 된다. 그래서 이 대화상자가
 * 보여 줄 것은 딱 셋이다: 무엇이 가는가, 어디로 가는가, 그 안에서 어떤 이름이 되는가.
 *
 * 실패가 일상적인 기능이라(파일 락) 사유를 대화상자 안에 남긴다 — 토스트로만 알리면
 * 어느 파일을 닫아야 하는지 읽기도 전에 사라진다.
 */
export default function AbsorbModal() {
  const s = useStore();
  const absorb = s.absorb;

  const source = s.tasks.find((t) => t.folder === absorb?.source);
  const q = (absorb?.query ?? "").trim().toLowerCase();
  const candidates = useMemo(() => {
    if (!absorb) return [];
    // 보관된 업무는 받는 쪽이 될 수 없다 — 끝난 업무 안으로 살아 있는 일을 넣는 것은
    // 업무 리스트에서 일감 하나를 조용히 지우는 것과 같다.
    return s.tasks
      .filter((t) => t.folder !== absorb.source && !isArchived(t, s.settings.archDays))
      .filter((t) => !q || `${t.title} ${t.relFolder} ${t.tags.join(" ")}`.toLowerCase().includes(q));
  }, [absorb, s.tasks, s.settings.archDays, q]);

  if (!absorb) return null;

  const target = s.tasks.find((t) => t.folder === absorb.target);
  const folderName = sanitizeFolderName(absorb.name.trim()) || basename(absorb.source);
  const ready = !!target && !absorb.busy;

  return (
    <Modal
      width={620}
      zIndex={76}
      onClose={() => !absorb.busy && s.set({ absorb: null })}
      panelStyle={{ maxHeight: "90vh" }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          height: 40,
          borderBottom: "1px solid #e6e2da",
          background: "#faf9f6",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>다른 업무에 편입</span>
        <span style={{ fontSize: 11.5, color: "#8a857c" }}>
          업무 폴더 전체를 고른 업무의 하위 폴더로 옮깁니다
        </span>
        <div style={{ flex: 1 }} />
        <Box
          onClick={() => !absorb.busy && s.set({ absorb: null })}
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

      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 11, minHeight: 0 }}>
        <div>
          <div style={labelStyle}>편입할 업무</div>
          <div
            style={{
              border: "1px solid #eae6de",
              borderRadius: 6,
              background: "#fbfaf7",
              padding: "8px 10px",
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#23211e" }}>
              {source?.title ?? basename(absorb.source)}
            </div>
            <div
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 10.5,
                color: "#a09a8f",
                marginTop: 3,
                wordBreak: "break-all",
              }}
            >
              {source?.relFolder ?? absorb.source}
            </div>
          </div>
        </div>

        <div style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div style={labelStyle}>받는 업무</div>
          <Input
            autoFocus
            value={absorb.query}
            onChange={(e) => s.set({ absorb: { ...absorb, query: e.target.value } })}
            placeholder="업무 · 태그 · 경로 검색"
            style={{ ...inputStyle, height: 27, marginBottom: 6 }}
            focusStyle={inputFocus}
          />
          <div
            style={{
              maxHeight: 190,
              overflowY: "auto",
              border: "1px solid #eae6de",
              borderRadius: 6,
              padding: 4,
            }}
          >
            {candidates.length === 0 && (
              <div style={{ padding: "14px 10px", fontSize: 12, color: "#a09a8f", textAlign: "center" }}>
                받을 수 있는 업무가 없습니다
              </div>
            )}
            {candidates.map((t) => {
              const on = t.folder === absorb.target;
              const cfg = statusOf(t.status);
              return (
                <Box
                  key={t.folder}
                  onClick={() => s.set({ absorb: { ...absorb, target: t.folder, error: "" } })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 5,
                    cursor: "pointer",
                    border: `1px solid ${on ? "#e0d6f8" : "transparent"}`,
                    background: on ? "#f7f4fe" : "transparent",
                  }}
                  hover={on ? undefined : { background: "#f4f2ee" }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      flex: "0 0 12px",
                      border: `1px solid ${on ? VIOLET : "#cfcabf"}`,
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
                        background: on ? VIOLET : "transparent",
                      }}
                    />
                  </div>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", flex: "0 0 6px", background: cfg.dot }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: on ? 600 : 400,
                        color: "#23211e",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.title}
                    </div>
                    <div
                      style={{
                        fontFamily: "'Roboto Mono',monospace",
                        fontSize: 10.5,
                        color: "#a09a8f",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.relFolder}
                    </div>
                  </div>
                </Box>
              );
            })}
          </div>
        </div>

        <div>
          <div style={labelStyle}>하위 폴더 이름</div>
          <Input
            value={absorb.name}
            onChange={(e) => s.set({ absorb: { ...absorb, name: e.target.value } })}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.repeat || e.nativeEvent.isComposing) return;
              if (ready) void s.doAbsorb();
            }}
            placeholder={basename(absorb.source)}
            style={{ ...inputStyle, fontFamily: "'Roboto Mono',monospace" }}
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
            {target ? `${target.relFolder}${folderName}/` : "받는 업무를 고르세요"}
          </div>
        </div>

        <div style={{ fontSize: 11.5, color: "#8a857c", lineHeight: 1.65 }}>
          편입한 업무는 업무 리스트에서 사라지고 파일은 그대로 남습니다 · 파일이 다른
          프로그램에서 열려 있으면 옮기지 못하고, 그때는 아무것도 움직이지 않습니다.
        </div>

        {!!absorb.error && (
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
            편입하지 못했습니다 · {absorb.error}
          </div>
        )}
      </div>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        <GhostButton onClick={() => !absorb.busy && s.set({ absorb: null })}>취소</GhostButton>
        <Box
          onClick={() => ready && void s.doAbsorb()}
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
          {absorb.busy ? "옮기는 중…" : "편입 실행"}
        </Box>
      </ModalFooter>
    </Modal>
  );
}
