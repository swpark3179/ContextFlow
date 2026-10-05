import { useEffect, useState } from "react";
import { Box } from "../lib/ui";
import { VIOLET } from "../lib/design";
import { useAssist } from "../store/assistStore";

/**
 * 워크스페이스 머리의 [AI ▾] — 지금 업무에 대한 AI 도우미(위키 가이드 · 간략 입력 정리 · 이슈 추가)를 연다.
 * 메뉴 띠의 '업무' 메뉴에도 같은 항목이 있다.
 */
export default function AssistMenu({ folder }: { folder: string }) {
  const [open, setOpen] = useState(false);
  const { openGuide, openBrief, openIssue } = useAssist();
  // 다른 업무로 넘어가면 닫는다.
  useEffect(() => setOpen(false), [folder]);

  const items: [string, string, () => void][] = [
    ["위키 가이드", "위키에서 절차 · 주의점", () => openGuide(folder)],
    ["간략 입력 정리", "한두 줄 → 개요 · 할 일 · 일정", () => openBrief(folder)],
    ["이슈 추가", "새 이슈 → 새 파일 · 기존 파일에 기입", () => openIssue(folder)],
  ];

  return (
    <div style={{ position: "relative", flex: "0 0 auto" }}>
      <Box
        onClick={() => setOpen(!open)}
        title="지금 업무에 대한 AI 도우미"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          height: 26,
          padding: "0 9px",
          borderRadius: 5,
          cursor: "pointer",
          border: "1px solid #ddd5f3",
          background: open ? "#f1edfb" : "#faf8fe",
          color: VIOLET,
          fontSize: 12.5,
          fontWeight: 600,
        }}
        hover={{ background: "#f1edfb" }}
      >
        ✦ AI
        <span style={{ fontSize: 9, opacity: 0.7 }}>▼</span>
      </Box>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 25 }} />
          <div
            style={{
              position: "absolute",
              top: 31,
              right: 0,
              zIndex: 30,
              background: "#fff",
              border: "1px solid #d9d4ca",
              borderRadius: 6,
              boxShadow: "0 10px 26px rgba(35,33,30,.16)",
              padding: 4,
              minWidth: 300,
              animation: "pIn .12s ease-out",
            }}
          >
            {items.map(([label, hint, run]) => (
              <Box
                key={label}
                onClick={() => {
                  setOpen(false);
                  run();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 12.5,
                  color: "#3a3630",
                }}
                hover={{ background: "#f2efe9" }}
              >
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: VIOLET }} />
                <span style={{ flex: 1, whiteSpace: "nowrap" }}>{label}</span>
                <span style={{ fontSize: 11, color: "#6a665e", whiteSpace: "nowrap" }}>{hint}</span>
              </Box>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
