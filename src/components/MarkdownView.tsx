import { useEffect, useRef, useState } from "react";
import { Box } from "../lib/ui";
import { GREEN, LANG, TOAST } from "../lib/design";
import { copyText } from "../lib/clipboard";
import { useStore } from "../store/useStore";
import type { Block, Seg } from "../lib/markdown";

/**
 * 읽기 화면이다. 그래서 앱의 다른 곳(11.5px 위주의 조밀한 UI)보다 본문이 크고 행간이
 * 넓다 — 목록·버튼은 훑는 것이고 노트는 읽는 것이라, 같은 크기로 맞추면 둘 중 하나가
 * 손해를 본다. 한 줄이 너무 길어지지 않도록 글줄 폭에도 상한을 둔다.
 */
const BODY = 14;
const LH = 1.85;
/** 본문 한 줄의 높이(px). 체크박스 · 글머리를 첫 줄에 맞추는 데 쓴다. */
const ROW = Math.round(BODY * LH);
const MEASURE = 860;

/** 코드 블록은 다섯 줄까지만 펼쳐 보이고 나머지는 안에서 스크롤한다. */
const CODE_LINES = 5;
const CODE_SIZE = 12;
/** px 로 고정한다 — 배수로 두면 `maxHeight` 가 줄 수와 어긋나 여섯째 줄이 반쯤 보인다. */
const CODE_LH = 20;
const CODE_PAD = 8;

function Inline({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((g) => {
        if (g.isB)
          return (
            <span key={g.key} style={{ fontWeight: 600, color: "#23211e" }}>
              {g.text}
            </span>
          );
        if (g.isStrike)
          // 그어 지운 글은 이미 지나간 이야기다. 완료된 체크 항목과 같은 회색으로
          // 낮춰 본문의 시선을 뺏지 않게 둔다.
          return (
            <span key={g.key} style={{ textDecoration: "line-through", color: "#8a857c" }}>
              {g.text}
            </span>
          );
        if (g.isCode)
          return (
            <span
              key={g.key}
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 12.5,
                color: "#8f5d17",
                background: "#f7f4ee",
                border: "1px solid #ebe5da",
                borderRadius: 3,
                padding: "1px 4px",
                wordBreak: "break-all",
              }}
            >
              {g.text}
            </span>
          );
        if (g.isLink)
          // 위키링크는 아직 이동을 지원하지 않는다. 눌렀을 때 링크 텍스트를 그대로
          // 되읽어 주는 토스트를 띄우느니, 누를 수 있는 것처럼 보이지 않게 두는 편이
          // 정직하다.
          return (
            <span
              key={g.key}
              title={g.text}
              style={{ display: "inline", color: "#3a6fd8", borderBottom: "1px solid #cddcf8" }}
            >
              {g.text}
            </span>
          );
        return <span key={g.key}>{g.text}</span>;
      })}
    </>
  );
}

/**
 * 코드 블록 카드.
 *
 * 다섯 줄이라는 상한은 노트를 읽는 화면에서 코드가 본문을 밀어내지 않게 하려는 것이다.
 * 대신 **몇 줄인지를 머리띠에 적는다** — 잘려 보이는 화면에서 스크롤바만으로는 뒤에
 * 두 줄이 남았는지 이백 줄이 남았는지 알 수 없다.
 */
function CodeCard({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  /**
   * 가로 스크롤바가 먹는 높이. 이걸 상한에 더해 주지 않으면 긴 줄이 있는 블록에서
   * 다섯째 줄이 반쯤 잘린다 — 스크롤바가 레이아웃 높이를 차지하는지(Windows 의 고전
   * 스크롤바)는 플랫폼마다 다르므로 값을 정해 두지 않고 실제로 재서 쓴다.
   *
   * 진동하지 않는다: 이 값은 **너비**로만 정해지고 우리가 바꾸는 것은 높이뿐이다.
   * 세로 스크롤바 자리는 `global.css` 의 `scrollbar-gutter: stable` 이 항상 잡아 둔다.
   */
  const box = useRef<HTMLPreElement | null>(null);
  const [hBar, setHBar] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setHBar(Math.max(0, el.offsetHeight - el.clientHeight));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [code]);

  const count = code.length ? code.split("\n").length : 0;
  const clipped = count > CODE_LINES;
  const label = LANG[lang.toLowerCase()] ?? lang;

  const copy = () => {
    void copyText(code).then((ok) => {
      if (!ok) {
        useStore.getState().toast("클립보드에 복사하지 못했습니다", "", TOAST.danger);
        return;
      }
      // 성공은 버튼이 스스로 말한다 — 토스트를 겹쳐 띄우면 같은 말을 두 번 한다.
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div
      style={{
        margin: "10px 0",
        border: "1px solid #e6e2da",
        borderRadius: 6,
        overflow: "hidden",
        background: "#fbfaf7",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 24,
          padding: "0 5px 0 9px",
          background: "#f4f2ed",
          borderBottom: "1px solid #e9e5dd",
        }}
      >
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 10.5,
            letterSpacing: ".2px",
            color: label ? "#6a665e" : "#b5afa2",
          }}
        >
          {label || "코드"}
        </span>
        <div style={{ flex: 1 }} />
        {clipped && (
          <span
            style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 10.5, color: "#a09a8f" }}
            title={`${CODE_LINES}줄까지 보이고 나머지는 안에서 스크롤합니다`}
          >
            {count}줄
          </span>
        )}
        <Box
          onClick={copy}
          title="블록 전체를 클립보드로 복사합니다"
          style={{
            display: "flex",
            alignItems: "center",
            height: 18,
            padding: "0 6px",
            borderRadius: 3,
            fontSize: 10.5,
            fontWeight: 600,
            cursor: "pointer",
            color: copied ? "#256b47" : "#6a665e",
            background: copied ? "#e9f4ee" : "transparent",
          }}
          hover={copied ? undefined : { background: "#e6e2da", color: "#3a3630" }}
        >
          {copied ? "복사됨" : "복사"}
        </Box>
      </div>
      <pre
        ref={box}
        style={{
          margin: 0,
          padding: CODE_PAD,
          /*
            다섯 줄이 넘을 때만 상한을 두고, 그 값에 **아래쪽 여백은 넣지 않는다**.
            여백은 스크롤되는 내용의 일부라 상한 안에 넣으면 그 자리에 여섯째 줄의
            머리가 몇 px 비쳐 "다섯 줄" 이 다섯 줄 반이 된다. 끝까지 내리면 여백은
            그때 제대로 보인다(스크롤 높이에는 그대로 들어 있다).
          */
          maxHeight: clipped ? CODE_PAD + CODE_LINES * CODE_LH + hBar : undefined,
          overflow: "auto",
          fontFamily: "'Roboto Mono',monospace",
          fontSize: CODE_SIZE,
          lineHeight: `${CODE_LH}px`,
          color: "#2c2a26",
          background: "#fbfaf7",
          whiteSpace: "pre",
          tabSize: 4,
        }}
      >
        {code}
      </pre>
    </div>
  );
}

/**
 * 마크다운 뷰어의 본문. 편집기와 같은 탭 안에 살지만 이쪽은 **읽는 화면**이고,
 * 손댈 수 있는 것은 체크박스 하나뿐이다(`onToggle`).
 *
 * `onToggle` 이 받는 값은 **문서 기준 줄 번호**가 아니라 파싱한 본문 기준이다.
 * 프런트마터만큼의 보정은 부르는 쪽이 한다(`splitFrontmatter` 의 `bodyLine`) — 뷰어는
 * 본문만 알고, 문서 전체를 아는 것은 버퍼를 든 쪽이다.
 */
export default function MarkdownView({
  blocks,
  onToggle,
}: {
  blocks: Block[];
  onToggle?: (line: number) => void;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 20px 28px 20px" }}>
      <div style={{ maxWidth: MEASURE }}>
        {!blocks.length && (
          <div style={{ fontSize: 12.5, color: "#a09a8f" }}>빈 문서입니다</div>
        )}
        {blocks.map((b, i) => {
          const first = i === 0;
          if (b.isFence) return <CodeCard key={b.key} code={b.code} lang={b.lang} />;
          if (b.isH1)
            return (
              <div
                key={b.key}
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  letterSpacing: "-.3px",
                  color: "#23211e",
                  margin: first ? "0 0 8px 0" : "20px 0 8px 0",
                  paddingBottom: 6,
                  borderBottom: "1px solid #e6e2da",
                }}
              >
                {b.text}
              </div>
            );
          if (b.isH2)
            return (
              <div
                key={b.key}
                style={{
                  fontSize: 15.5,
                  fontWeight: 600,
                  letterSpacing: "-.2px",
                  color: "#23211e",
                  margin: first ? "0 0 6px 0" : "18px 0 6px 0",
                  paddingBottom: 4,
                  borderBottom: "1px solid #f0ede7",
                }}
              >
                {b.text}
              </div>
            );
          if (b.isH3)
            return (
              <div
                key={b.key}
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "#3a3630",
                  margin: first ? "0 0 4px 0" : "14px 0 4px 0",
                }}
              >
                {b.text}
              </div>
            );
          if (b.isHr)
            return (
              <div key={b.key} style={{ height: 1, background: "#e6e2da", margin: "14px 0" }} />
            );

          const body = (
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: BODY,
                lineHeight: LH,
                color: b.fg,
                wordBreak: "break-word",
              }}
            >
              <Inline segs={b.segs} />
            </div>
          );

          if (b.isQuote)
            // 이어지는 인용 줄은 위쪽 간격을 두지 않아 **하나의 세로선**으로 붙는다.
            // 줄마다 선이 끊기면 한 문단을 따온 것이 여러 개로 보인다.
            return (
              <div
                key={b.key}
                style={{
                  display: "flex",
                  padding: "2px 0 2px 11px",
                  borderLeft: "3px solid #e0dcd4",
                  background: "#faf9f6",
                  marginTop: first ? 0 : blocks[i - 1].isQuote ? 0 : 9,
                }}
              >
                {body}
              </div>
            );

          if (b.isTask)
            return (
              <div
                key={b.key}
                style={{ display: "flex", gap: 4, marginTop: 2, paddingLeft: b.indent }}
              >
                <Box
                  onClick={onToggle ? () => onToggle(b.line) : undefined}
                  title={
                    onToggle
                      ? b.checked
                        ? "눌러서 완료를 해제합니다"
                        : "눌러서 완료로 표시합니다"
                      : undefined
                  }
                  style={{
                    flex: "0 0 auto",
                    width: 19,
                    height: ROW,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 4,
                    fontSize: 13.5,
                    lineHeight: 1,
                    color: b.markFg,
                    cursor: onToggle ? "pointer" : "default",
                    userSelect: "none",
                  }}
                  hover={
                    onToggle
                      ? { background: "#f0ede7", color: b.checked ? "#b5afa2" : GREEN }
                      : undefined
                  }
                >
                  {b.mark}
                </Box>
                {body}
              </div>
            );

          return (
            <div
              key={b.key}
              style={{
                display: "flex",
                gap: 7,
                // 문단은 문단끼리 떨어져야 읽히고, 목록은 붙어야 한 덩어리로 읽힌다.
                marginTop: first ? 0 : b.hasMark ? 3 : 9,
                paddingLeft: b.indent,
              }}
            >
              {b.hasMark && (
                <span
                  style={{
                    flex: "0 0 auto",
                    fontSize: 12.5,
                    lineHeight: `${ROW}px`,
                    color: b.markFg,
                  }}
                >
                  {b.mark}
                </span>
              )}
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
