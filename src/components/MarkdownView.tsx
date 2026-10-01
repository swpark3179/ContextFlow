import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Box } from "../lib/ui";
import { GREEN, LANG, TOAST } from "../lib/design";
import { copyText } from "../lib/clipboard";
import { useStore } from "../store/useStore";
import type { Block, Seg, TableAlign } from "../lib/markdown";
import { clipboardImage, type ClipImage } from "../lib/images";

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

/**
 * 코드 블록의 높이 단계. 넘치는 줄은 블록 안에서 스크롤한다.
 *
 * * `1x` — 기본값. 예전 상한(다섯 줄)의 1.5배인 7.5줄을 **여덟 줄**로 올려 잡는다.
 *   반 줄을 남기면 그 자리에 다음 줄의 위쪽 절반만 비쳐 잘린 화면처럼 보인다.
 * * `2x` — `1x` 의 두 배.
 * * `full` — 뷰어의 보이는 높이를 가득 채운다(`fullLines`).
 */
type CodeSize = "1x" | "2x" | "full";
const CODE_SIZES: CodeSize[] = ["1x", "2x", "full"];
const CODE_LINES_1X = Math.ceil(5 * 1.5);
const CODE_LINES: Record<Exclude<CodeSize, "full">, number> = {
  "1x": CODE_LINES_1X,
  "2x": CODE_LINES_1X * 2,
};
const SIZE_TITLE: Record<CodeSize, string> = {
  "1x": `${CODE_LINES["1x"]}줄까지 보입니다`,
  "2x": `${CODE_LINES["2x"]}줄까지 보입니다`,
  full: "뷰어 화면의 남은 높이를 가득 채웁니다",
};
const CODE_SIZE = 12;
/** px 로 고정한다 — 배수로 두면 `maxHeight` 가 줄 수와 어긋나 여섯째 줄이 반쯤 보인다. */
const CODE_LH = 20;
const CODE_PAD = 8;
/** 코드 카드에서 `<pre>` 가 아닌 몫: 머리띠(24) + 머리띠 밑줄(1) + 카드 위아래 테두리(2). */
const CODE_CHROME = 27;
/** `full` 일 때 카드 위아래로 남기는 틈. 카드의 바깥 여백(`margin`)과 같다. */
const CODE_GAP = 10;

/**
 * 이미지의 크기 단계. 고른 값은 Obsidian 과 같은 `|너비` 표기로 **문서에 남는다** —
 * 코드 블록 단계와 달리 그림의 크기는 읽는 방식이 아니라 노트의 모양이라, 다시 열었을
 * 때나 Obsidian 에서 열었을 때도 같아야 한다.
 *
 * `크게` 는 글줄 폭(`MEASURE`)이고, `원본` 은 표기를 걷어내 그림의 원래 크기로 둔다.
 * 어느 쪽이든 글줄 폭을 넘지는 않는다(`maxWidth: 100%`).
 */
const IMG_SIZES: { label: string; width: number | null; title: string }[] = [
  { label: "작게", width: 240, title: "너비 240px" },
  { label: "중간", width: 480, title: "너비 480px" },
  { label: "크게", width: MEASURE, title: "글줄 폭에 맞춥니다" },
  { label: "원본", width: null, title: "이미지의 원래 크기(글줄 폭을 넘지 않게)" },
];

/**
 * 뷰어의 스크롤 상자와 그 보이는 높이. `full` 코드 블록이 "남은 높이" 를 재는 기준이다.
 * 창 전체가 아니라 이 상자를 재는 이유: 창에서 제목줄 · 탭 · 뷰어 머리띠를 뺀 나머지가
 * 바로 이 상자이고, 그 값은 창을 줄이거나 패널을 옮길 때마다 달라진다.
 */
const Viewport = createContext<{ el: HTMLDivElement | null; height: number }>({
  el: null,
  height: 0,
});

/**
 * 위키링크를 누르면 부를 함수. 위키 화면만 이 값을 주고, 다른 화면(업무 노트)은 주지 않아
 * 링크가 예전처럼 보이기만 한다 — 업무 노트의 `[[…]]` 는 Obsidian 의 vault 전체를 가리키는데,
 * 이 앱은 그 해석기를 갖고 있지 않다.
 */
export const WikiLinkContext = createContext<((target: string) => void) | null>(null);

function Inline({ segs }: { segs: Seg[] }) {
  const onWikiLink = useContext(WikiLinkContext);
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
        if (g.isLink) {
          // `[[대상|별칭]]` 은 별칭만 보인다(Obsidian 과 같다). 이동은 위키 화면에서만 —
          // 그 밖에서는 눌렀을 때 아무 일도 없을 링크를 누를 수 있는 것처럼 그리지 않는다.
          const [target, ...alias] = g.text.split("|");
          const label = alias.join("|").trim() || (target ?? "").trim();
          const go = onWikiLink && target?.trim() ? () => onWikiLink(target.trim()) : undefined;
          return (
            <span
              key={g.key}
              title={target}
              onClick={go}
              style={{
                display: "inline",
                color: "#3a6fd8",
                borderBottom: "1px solid #cddcf8",
                cursor: go ? "pointer" : undefined,
              }}
            >
              {label}
            </span>
          );
        }
        return <span key={g.key}>{g.text}</span>;
      })}
    </>
  );
}

/**
 * 코드 블록 카드.
 *
 * 기본 상한(`1x`)은 노트를 읽는 화면에서 코드가 본문을 밀어내지 않게 하려는 것이고,
 * 긴 로그를 읽을 때는 머리띠 오른쪽에서 `2x` · `full` 로 늘린다. 잘렸을 때는
 * **몇 줄인지를 머리띠에 적는다** — 잘려 보이는 화면에서 스크롤바만으로는 뒤에
 * 두 줄이 남았는지 이백 줄이 남았는지 알 수 없다.
 */
function CodeCard({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const [size, setSize] = useState<CodeSize>("1x");
  const view = useContext(Viewport);
  const card = useRef<HTMLDivElement | null>(null);
  /** `full` 을 고른 직후 한 번, 카드를 뷰어 맨 위로 올린다(아래 effect). */
  const align = useRef(false);
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
  /**
   * `full` 의 줄 수. 뷰어 높이에서 카드의 머리띠 · 테두리 · 위아래 틈 · 가로 스크롤바를
   * 빼고 남는 자리에 **온전히 들어가는** 줄만 센다(반 줄이 비치지 않게). 뷰어가 아주
   * 낮아져도 `1x` 보다 작아지지는 않는다 — 그러면 "가득" 이 오히려 줄어든다.
   */
  const fullLines = Math.max(
    CODE_LINES["1x"],
    Math.floor((view.height - CODE_GAP * 2 - CODE_CHROME - CODE_PAD - hBar) / CODE_LH),
  );
  const limit = size === "full" ? fullLines : CODE_LINES[size];
  const clipped = count > limit;
  /** `1x` 안에 다 들어가는 블록은 단계를 바꿔도 달라지는 것이 없으므로 고르개를 숨긴다. */
  const sizable = count > CODE_LINES["1x"];
  const label = LANG[lang.toLowerCase()] ?? lang;

  /**
   * `full` 로 늘린 카드는 뷰어 맨 위에 붙여야 화면을 채운다 — 카드가 화면 아래쪽에
   * 걸쳐 있으면 늘어난 높이의 대부분이 화면 밖에 있다. 높이가 바뀐 **뒤에** 옮겨야
   * 문서 끝 가까이의 카드도 끝까지 올라온다(그 전에는 스크롤할 자리가 없다).
   */
  useEffect(() => {
    if (!align.current || size !== "full") return;
    align.current = false;
    const el = card.current;
    const port = view.el;
    if (!el || !port) return;
    const off = el.getBoundingClientRect().top - port.getBoundingClientRect().top;
    port.scrollTop += off - CODE_GAP;
  }, [size, view.el]);

  const pick = (next: CodeSize) => {
    if (next === size) return;
    align.current = next === "full";
    setSize(next);
  };

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
      ref={card}
      style={{
        margin: `${CODE_GAP}px 0`,
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
            title={`${limit}줄까지 보이고 나머지는 안에서 스크롤합니다`}
          >
            {count}줄
          </span>
        )}
        {sizable && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              padding: 1,
              borderRadius: 4,
              background: "#ebe7df",
            }}
          >
            {CODE_SIZES.map((k) => {
              const on = k === size;
              return (
                <Box
                  key={k}
                  onClick={() => pick(k)}
                  title={SIZE_TITLE[k]}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: 16,
                    padding: "0 5px",
                    borderRadius: 3,
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 10,
                    fontWeight: on ? 600 : 500,
                    cursor: on ? "default" : "pointer",
                    userSelect: "none",
                    color: on ? "#3a3630" : "#8a857c",
                    background: on ? "#fff" : "transparent",
                    boxShadow: on ? "0 1px 1px rgba(0,0,0,.06)" : undefined,
                  }}
                  hover={on ? undefined : { color: "#3a3630" }}
                >
                  {k}
                </Box>
              );
            })}
          </div>
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
            상한을 넘을 때만 상한을 두고, 그 값에 **아래쪽 여백은 넣지 않는다**.
            여백은 스크롤되는 내용의 일부라 상한 안에 넣으면 그 자리에 다음 줄의
            머리가 몇 px 비쳐 "여덟 줄" 이 여덟 줄 반이 된다. 끝까지 내리면 여백은
            그때 제대로 보인다(스크롤 높이에는 그대로 들어 있다).
          */
          maxHeight: clipped ? CODE_PAD + limit * CODE_LH + hBar : undefined,
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
 * 이미지 카드. 크기 단계 고르개는 **그림 위에 마우스를 올렸을 때만** 뜬다 — 늘 떠 있으면
 * 스크린샷마다 버튼 줄이 하나씩 붙어 읽는 화면이 도구 상자가 된다.
 *
 * `url` 이 `null` 이면 그리지 않는 그림이다(외부 주소 — 앱 창의 CSP 가 막는다). 경로가
 * 틀려 읽지 못한 그림과 함께, 깨진 그림 아이콘 대신 **무엇이 적혀 있는지**를 보여 준다.
 */
function ImageCard({
  b,
  url,
  onWidth,
}: {
  b: Block;
  url: string | null;
  onWidth?: (width: number | null) => void;
}) {
  const [hover, setHover] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);

  if (!url || broken)
    return (
      <div
        style={{
          margin: "10px 0",
          padding: "8px 11px",
          border: "1px dashed #e0dcd4",
          borderRadius: 6,
          background: "#faf9f6",
          fontSize: 12,
          lineHeight: 1.6,
          color: "#8a857c",
          wordBreak: "break-all",
        }}
      >
        <div style={{ fontWeight: 600, color: "#6a665e" }}>
          {url ? "이미지를 불러오지 못했습니다" : "외부 이미지는 표시하지 않습니다"}
        </div>
        <div style={{ fontFamily: "'Roboto Mono',monospace", fontSize: 11 }}>{b.src}</div>
      </div>
    );

  return (
    <div style={{ margin: "10px 0", lineHeight: 0 }}>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}
      >
        <img
          src={url}
          alt={b.alt}
          title={b.alt || undefined}
          draggable={false}
          onError={() => setBroken(true)}
          style={{
            display: "block",
            width: b.width ?? undefined,
            maxWidth: "100%",
            height: "auto",
            borderRadius: 4,
            border: "1px solid #ebe7df",
          }}
        />
        {onWidth && hover && (
          <div
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              display: "flex",
              alignItems: "center",
              gap: 1,
              padding: 2,
              borderRadius: 5,
              background: "rgba(235,231,223,.94)",
              boxShadow: "0 1px 3px rgba(0,0,0,.12)",
              lineHeight: "normal",
              whiteSpace: "nowrap",
            }}
          >
            {IMG_SIZES.map((z) => {
              const on = z.width === b.width;
              return (
                <Box
                  key={z.label}
                  onClick={on ? undefined : () => onWidth(z.width)}
                  title={z.title}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: 18,
                    padding: "0 7px",
                    borderRadius: 3,
                    fontSize: 11,
                    fontWeight: on ? 600 : 500,
                    cursor: on ? "default" : "pointer",
                    userSelect: "none",
                    color: on ? "#3a3630" : "#6a665e",
                    background: on ? "#fff" : "transparent",
                    boxShadow: on ? "0 1px 1px rgba(0,0,0,.06)" : undefined,
                  }}
                  hover={on ? undefined : { color: "#23211e", background: "rgba(255,255,255,.6)" }}
                >
                  {z.label}
                </Box>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 표 카드. 본문보다 한 단 작은 글씨로 조밀하게 그리고, 넓은 표는 글줄 폭을 넘기지
 * 않도록 **표만** 가로로 스크롤한다 — 본문 전체가 옆으로 밀리면 읽던 자리를 잃는다.
 */
function TableCard({ b }: { b: Block }) {
  const cell = (a: TableAlign, head: boolean) => ({
    padding: "5px 10px",
    border: "1px solid #e6e2da",
    textAlign: (a || "left") as "left" | "center" | "right",
    verticalAlign: "top" as const,
    fontWeight: head ? 600 : 400,
    color: head ? "#23211e" : "#3a3630",
    minWidth: 40,
  });
  return (
    <div style={{ margin: "10px 0", overflowX: "auto" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 13,
          lineHeight: 1.65,
          wordBreak: "keep-all",
          overflowWrap: "break-word",
        }}
      >
        <thead>
          <tr style={{ background: "#f4f2ed" }}>
            {b.head.map((segs, c) => (
              <th key={c} style={cell(b.align[c], true)}>
                <Inline segs={segs} />
              </th>
            ))}
          </tr>
        </thead>
        {b.rows.length > 0 && (
          <tbody>
            {b.rows.map((row, r) => (
              // 줄무늬는 넓은 표에서 눈이 옆 줄로 미끄러지지 않게 하는 정도로만 옅게 둔다.
              <tr key={r} style={{ background: r % 2 ? "#fbfaf7" : "#fff" }}>
                {row.map((segs, c) => (
                  <td key={c} style={cell(b.align[c], false)}>
                    <Inline segs={segs} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
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
  imageUrl,
  onImageWidth,
  onPasteImage,
}: {
  blocks: Block[];
  onToggle?: (line: number) => void;
  /** 이미지 블록의 경로를 `<img src>` 로 바꾼다. `null` 이면 그리지 않는다. */
  imageUrl?: (b: Block) => string | null;
  /** 크기 단계를 골랐다. `line` 은 `onToggle` 과 같이 본문 기준이다. */
  onImageWidth?: (line: number, idx: number, width: number | null) => void;
  /** 뷰어에 초점이 있을 때 이미지를 붙여넣었다. */
  onPasteImage?: (img: ClipImage) => void;
}) {
  const [port, setPort] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!port) return;
    const measure = () => setHeight(port.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(port);
    return () => ro.disconnect();
  }, [port]);

  return (
    <Viewport.Provider value={{ el: port, height }}>
      {/*
        tabIndex 는 붙여넣기를 받기 위한 것이다. 붙여넣기 이벤트는 초점이 있는 요소로
        가므로, 뷰어를 누른 뒤의 Ctrl+V 만 여기로 온다 — 창 전체에서 받으면 다른 곳을
        보다가 누른 Ctrl+V 까지 이 노트에 그림을 붙인다.
      */}
      <div
        ref={setPort}
        tabIndex={onPasteImage ? -1 : undefined}
        onPaste={
          onPasteImage
            ? (e) => {
                const img = clipboardImage(e.clipboardData);
                if (!img) return;
                e.preventDefault();
                onPasteImage(img);
              }
            : undefined
        }
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "14px 20px 28px 20px",
          outline: "none",
        }}
      >
        <div style={{ maxWidth: MEASURE }}>
          {!blocks.length && (
            <div style={{ fontSize: 12.5, color: "#a09a8f" }}>빈 문서입니다</div>
          )}
          {blocks.map((b, i) => {
            const first = i === 0;
            if (b.isFence) return <CodeCard key={b.key} code={b.code} lang={b.lang} />;
            if (b.isTable) return <TableCard key={b.key} b={b} />;
            if (b.isImage)
              return (
                <ImageCard
                  key={b.key}
                  b={b}
                  url={imageUrl ? imageUrl(b) : null}
                  onWidth={
                    onImageWidth ? (w) => onImageWidth(b.line, b.imgIdx, w) : undefined
                  }
                />
              );
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
    </Viewport.Provider>
  );
}
