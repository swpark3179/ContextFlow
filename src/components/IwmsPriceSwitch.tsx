import { Box } from "../lib/ui";
import type { Price } from "../lib/iwms/types";

const OPTIONS: { value: Price | null; label: string; title: string; fg: string; bg: string }[] = [
  { value: null, label: "–", title: "i-WMS 에 입력하지 않습니다", fg: "#6a665e", bg: "#ece8e0" },
  { value: "O", label: "포함", title: "대가포함(운영) 업무로 i-WMS 에 입력합니다", fg: "#2f5cbb", bg: "#e6eefc" },
  { value: "N", label: "미포함", title: "대가미포함(비대상) 업무로 i-WMS 에 입력합니다", fg: "#4e4a43", bg: "#f0ede7" },
];

/**
 * 오늘의 한일 한 줄의 대가 구분 — `[– | 포함 | 미포함]`.
 *
 * 줄을 누르면 펼쳐지므로 여기서 누른 것은 줄까지 올라가지 않게 막는다.
 */
export default function IwmsPriceSwitch({
  value,
  onChange,
}: {
  value: Price | null;
  onChange: (next: Price | null) => void;
}) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        flex: "0 0 auto",
        display: "flex",
        border: "1px solid #e0dcd4",
        borderRadius: 4,
        overflow: "hidden",
        height: 18,
      }}
    >
      {OPTIONS.map((o) => {
        const on = o.value === value;
        return (
          <Box
            key={o.label}
            title={o.title}
            onClick={() => !on && onChange(o.value)}
            style={{
              padding: o.value ? "0 6px" : "0 5px",
              fontSize: 11,
              lineHeight: "18px",
              cursor: on ? "default" : "pointer",
              color: on ? o.fg : "#b5afa2",
              background: on ? o.bg : "#fff",
              fontWeight: on ? 600 : 400,
              borderLeft: o.value ? "1px solid #eeeae3" : "none",
            }}
            hover={on ? undefined : { background: "#f7f5f1", color: "#6a665e" }}
          >
            {o.label}
          </Box>
        );
      })}
    </div>
  );
}
