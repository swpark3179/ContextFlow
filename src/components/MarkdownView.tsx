import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Box, CheckMark, EASE_OUT, reducedMotion, Span, useExitSnapshot } from "../lib/ui";
import { GREEN, LANG, TEXT, TOAST } from "../lib/design";
import { copyText } from "../lib/clipboard";
import { codeClip } from "../lib/codeClip";
import { useStore } from "../store/useStore";
import type { Block, Seg, TableAlign } from "../lib/markdown";
import { clipboardImage, type ClipImage } from "../lib/images";
import { codeLang, highlight, HIGHLIGHT_LIMIT, type TokenKind } from "../lib/highlight";

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
export interface WikiLinks {
  open: (target: string) => void;
  /**
   * 별칭 없는 링크에 보일 글. 업무 소스 페이지의 이름은 업무 id(`task-2026-…`)라 그대로
   * 보이면 무슨 업무인지 알 수 없다 — 위키 화면이 그 업무의 제목을 돌려준다.
   */
  label?: (target: string) => string | null;
}

export const WikiLinkContext = createContext<WikiLinks | null>(null);

function Inline({ segs }: { segs: Seg[] }) {
  const links = useContext(WikiLinkContext);
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
          const [rawTarget, ...alias] = g.text.split("|");
          const target = (rawTarget ?? "").trim();
          const label = alias.join("|").trim() || links?.label?.(target) || target;
          const go = links && target ? () => links.open(target) : undefined;
          // 누를 수 있는 링크만 올렸을 때 밑줄이 진해진다 — 아무 일도 없을 링크가 눌릴 것처럼 굴지 않게.
          return (
            <Span
              key={g.key}
              title={target}
              onClick={go}
              style={{
                display: "inline",
                color: "#3a6fd8",
                borderBottomWidth: 1,
                borderBottomStyle: "solid",
                borderBottomColor: "#cddcf8",
                borderRadius: 2,
                cursor: go ? "pointer" : undefined,
              }}
              hover={go ? { background: "#eef3fd", borderBottomColor: "#3a6fd8" } : undefined}
            >
              {label}
            </Span>
          );
        }
        return <span key={g.key}>{g.text}</span>;
      })}
    </>
  );
}

/**
 * 문법 강조의 색. 앱의 글자색 단계와 같은 바탕(#fbfaf7)에서 대비 4.5:1 이상인 색만 쓴다 —
 * 주석은 `TEXT.sub` 를 기울여 낮춘다. 보라는 쓰지 않는다(AI 전용 색이다, `design.ts`). 글자
 * 굵기는 바꾸지 않는다 — 고정폭 글꼴에서 굵기가 섞이면 줄이 들쭉날쭉해 보인다.
 */
const TOKEN_STYLE: Partial<Record<TokenKind, CSSProperties>> = {
  kw: { color: "#b03a2e" },
  tag: { color: "#b03a2e" },
  type: { color: "#2f6f80" },
  prop: { color: "#2f6f80" },
  fn: { color: "#8f5d17" },
  attr: { color: "#8f5d17" },
  str: { color: "#256b47" },
  num: { color: "#2f5cbb" },
  lit: { color: "#2f5cbb" },
  meta: { color: "#7c6a1b" },
  var: { color: "#9a4a14" },
  com: { color: "#6a665e", fontStyle: "italic" },
  op: { color: "#4e4a43" },
  punct: { color: "#4e4a43" },
};

/** 코드 블록 높이 · 그림 너비가 흘러가는 시간. 한 단계 바꾸는 것이라 m-base 보다 조금 길다. */
const RESIZE_MS = 240;

function SegButton({
  on,
  width,
  height,
  title,
  font,
  onPick,
  children,
}: {
  on: boolean;
  width: number;
  height: number;
  title?: string;
  font?: CSSProperties;
  onPick: () => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      title={title}
      onClick={on ? undefined : onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative",
        width,
        height,
        flex: `0 0 ${width}px`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        margin: 0,
        padding: 0,
        border: 0,
        borderRadius: 3,
        background: "transparent",
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
        userSelect: "none",
        cursor: on ? "default" : "pointer",
        color: on || hover ? TEXT.ink : TEXT.sub,
        transition: "color 140ms",
        ...font,
      }}
    >
      {children}
    </button>
  );
}

/**
 * 몇 칸 중 하나를 고르는 스위치 — 코드 블록 높이 · 그림 크기 · 편집기의 [뷰어 | 텍스트]. 흰 손잡이 하나가
 * 고른 칸으로 미끄러진다(예전에는 칸마다 바탕이 순간 바뀌었다). 칸 폭은 같아야 손잡이가 맞는다.
 * `value` 가 어느 칸도 아니면(문서에 손으로 적은 그림 너비) 손잡이를 숨긴다.
 */
export function Segmented({
  options,
  value,
  onPick,
  seg,
  height = 16,
  pad = 1,
  font,
  label,
  className,
  style,
}: {
  options: { id: string; label: ReactNode; title?: string }[];
  value: string | null;
  onPick: (id: string) => void;
  /** 칸 하나의 폭(px). */
  seg: number;
  height?: number;
  pad?: number;
  font?: CSSProperties;
  /** 스위치 전체의 이름(`aria-label`). */
  label: string;
  className?: string;
  style?: CSSProperties;
}) {
  const at = options.findIndex((o) => o.id === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={className}
      style={{
        position: "relative",
        flex: "0 0 auto",
        display: "flex",
        padding: pad,
        borderRadius: 4,
        background: "#ebe7df",
        lineHeight: "normal",
        ...style,
      }}
    >
      <span
        aria-hidden
        className="cf-mv"
        style={{
          position: "absolute",
          top: pad,
          left: pad,
          width: seg,
          height,
          borderRadius: 3,
          background: "#fff",
          boxShadow: "0 1px 1px rgba(35,33,30,.12)",
          transform: `translateX(${Math.max(0, at) * seg}px)`,
          opacity: at < 0 ? 0 : 1,
          transition: `transform 160ms ${EASE_OUT}, opacity 140ms`,
        }}
      />
      {options.map((o) => (
        <SegButton
          key={o.id}
          on={o.id === value}
          width={seg}
          height={height}
          title={o.title}
          font={font}
          onPick={() => onPick(o.id)}
        >
          {o.label}
        </SegButton>
      ))}
    </div>
  );
}

/**
 * 코드 블록 카드.
 *
 * 펜스에 언어를 적었고 그 언어를 알면(`codeLang` — Java · Python · SQL · 웹 언어) 문법을 칠하고
 * 머리띠에 언어 이름과 점을 단다. 언어가 없거나 모르는 언어면 예전처럼 한 가지 색이다. 칠하는
 * 것은 보이는 모양뿐이다 — [복사] 는 언제나 원문 그대로를 옮긴다.
 *
 * 기본 상한(`1x`)은 노트를 읽는 화면에서 코드가 본문을 밀어내지 않게 하려는 것이고,
 * 긴 로그를 읽을 때는 머리띠 오른쪽에서 `2x` · `full` 로 늘린다. 잘렸을 때는
 * **몇 줄인지를 머리띠에 적는다** — 잘려 보이는 화면에서 스크롤바만으로는 뒤에
 * 두 줄이 남았는지 이백 줄이 남았는지 알 수 없다.
 */
function CodeCard({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  /** [복사] 를 누른 횟수. 처음 그릴 때는 글자를 페이드하지 않는다. */
  const [copyN, setCopyN] = useState(0);
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

  const info = codeLang(lang);
  // 큰 로그를 칠하느라 뷰어가 멈추지 않게 상한을 둔다. 다시 그릴 때마다 자르지 않게 기억해 둔다.
  const tokens = useMemo(
    () => (info && code.length <= HIGHLIGHT_LIMIT ? highlight(code, info.lang) : null),
    [code, info?.lang],
  );

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
  const clip = codeClip({ count, limit, pad: CODE_PAD, lh: CODE_LH, bar: hBar });
  const clipped = clip.clipped;
  /** 잘림이 풀려 머리띠의 줄 수가 사라지는 동안에도 마지막 숫자를 든다(0 으로 바뀌며 사라지지 않게). */
  const lastHidden = useRef(clip.hidden);
  if (clip.hidden) lastHidden.current = clip.hidden;
  /** `1x` 안에 다 들어가는 블록은 단계를 바꿔도 달라지는 것이 없으므로 고르개를 숨긴다. */
  const sizable = count > CODE_LINES["1x"];
  const label = info?.label ?? LANG[lang.toLowerCase()] ?? lang;

  /**
   * `full` 로 늘린 카드는 뷰어 맨 위(10px 아래)에 붙여야 화면을 채운다 — 카드가 화면 아래쪽에
   * 걸쳐 있으면 늘어난 높이의 대부분이 화면 밖에 있다. 높이는 `RESIZE_MS` 동안 자라므로 곧바로
   * 부드럽게 굴리고, 다 자란 뒤 한 번 더 맞춘다 — 문서 끝 가까이의 카드는 그때야 스크롤할 자리가 생긴다.
   * 동작 줄이기면 높이가 곧바로 바뀌므로 한 번에 옮긴다.
   */
  useEffect(() => {
    if (!align.current || size !== "full") return;
    align.current = false;
    const el = card.current;
    const port = view.el;
    if (!el || !port) return;
    const go = (smooth: boolean) => {
      const off = el.getBoundingClientRect().top - port.getBoundingClientRect().top;
      if (Math.abs(off - CODE_GAP) < 1) return;
      port.scrollTo({ top: port.scrollTop + off - CODE_GAP, behavior: smooth ? "smooth" : "auto" });
    };
    if (reducedMotion()) {
      go(false);
      return;
    }
    go(true);
    const t = window.setTimeout(() => go(true), RESIZE_MS + 40);
    return () => window.clearTimeout(t);
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
      setCopyN((n) => n + 1);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setCopied(false);
        setCopyN((n) => n + 1);
      }, 1600);
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
        {info && (
          <span
            aria-hidden
            style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 7px", background: info.dot }}
          />
        )}
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 11.5,
            letterSpacing: ".2px",
            color: label ? "#6a665e" : "#b5afa2",
          }}
        >
          {label || "코드"}
        </span>
        {/*
          잘렸을 때만 보인다 — 몇 줄 중 몇 줄이 아래에 남았는지. 단계를 바꿔 다 보이게 되면 자리를
          지킨 채 옅게 사라진다(옆의 고르개가 흔들리지 않게).
        */}
        {sizable && (
          <span
            aria-hidden={!clipped}
            className="cf-mv"
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              color: TEXT.sub,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
              opacity: clipped ? 1 : 0,
              transition: "opacity 140ms",
            }}
            title={clipped ? `${limit}줄까지 보이고 나머지는 안에서 스크롤합니다` : undefined}
          >
            {count}줄 · 아래 {lastHidden.current}줄 더
          </span>
        )}
        <div style={{ flex: 1 }} />
        {sizable && (
          <Segmented
            label="코드 블록 높이"
            options={CODE_SIZES.map((k) => ({ id: k, label: k, title: SIZE_TITLE[k] }))}
            value={size}
            onPick={(k) => pick(k as CodeSize)}
            seg={34}
            font={{ fontFamily: "'Roboto Mono',monospace", fontSize: 10.5 }}
          />
        )}
        {/* 누르면 초록 "복사됨" 으로 폭째 바뀌고 1.6초 뒤 돌아온다 — 성공을 버튼 자신이 말한다. */}
        <Box
          onClick={copy}
          role="button"
          aria-live="polite"
          title="블록 전체를 클립보드로 복사합니다"
          className="cf-mv"
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            width: copied ? 62 : 38,
            height: 18,
            borderRadius: 3,
            overflow: "hidden",
            whiteSpace: "nowrap",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            color: copied ? "#256b47" : TEXT.sub,
            background: copied ? "#e9f4ee" : "transparent",
            transition: `width 160ms ${EASE_OUT}, background-color 140ms, color 140ms`,
          }}
          hover={copied ? undefined : { background: "#e6e2da", color: "#3a3630" }}
        >
          {copied && <CheckMark size={9} />}
          <span key={copied ? "y" : "n"} className={copyN ? "cf-fade" : undefined}>
            {copied ? "복사됨" : "복사"}
          </span>
        </Box>
      </div>
      <pre
        ref={box}
        className="cf-mv"
        style={{
          margin: 0,
          padding: CODE_PAD,
          /*
            잘릴 때의 상한에는 **아래쪽 여백을 넣지 않는다**. 여백은 스크롤되는 내용의 일부라
            상한 안에 넣으면 그 자리에 다음 줄의 머리가 몇 px 비쳐 "여덟 줄" 이 여덟 줄 반이
            된다. 끝까지 내리면 여백은 그때 제대로 보인다(스크롤 높이에는 그대로 들어 있다).
            안 잘려도 상한은 내용 높이의 숫자다 — 단계를 바꿀 때 높이가 흘러가야 한다(`codeClip`).
          */
          maxHeight: clip.maxHeight,
          transition: `max-height ${RESIZE_MS}ms ${EASE_OUT}`,
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
        {tokens
          ? tokens.map((t, i) =>
              TOKEN_STYLE[t.kind] ? (
                <span key={i} style={TOKEN_STYLE[t.kind]}>
                  {t.text}
                </span>
              ) : (
                t.text
              ),
            )
          : code}
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
  /** 고르개 안에 키보드 초점이 있다 — 마우스가 없어도 고르개가 떠 있어야 한다. */
  const [focus, setFocus] = useState(false);
  const [broken, setBroken] = useState(false);
  /**
   * 그림의 원래 너비. `원본` 을 숫자로 두어야 단계 사이를 오갈 때 너비가 흘러간다 — `auto` 와 숫자
   * 사이는 움직일 수 없다. 읽기 전에는 모르므로 그때는 `auto` 다(그려지는 너비가 같다).
   */
  const [natural, setNatural] = useState(0);
  useEffect(() => {
    setBroken(false);
    setNatural(0);
  }, [url]);
  const bar = hover || focus;

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
        onFocus={() => setFocus(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
        }}
        style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}
      >
        <img
          src={url}
          alt={b.alt}
          title={b.alt || undefined}
          draggable={false}
          onError={() => setBroken(true)}
          onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
          className="cf-mv"
          style={{
            display: "block",
            width: b.width ?? (natural || undefined),
            maxWidth: "100%",
            height: "auto",
            borderRadius: 4,
            border: "1px solid #ebe7df",
            transition: `width ${RESIZE_MS}ms ${EASE_OUT}`,
          }}
        />
        {/*
          고르개는 늘 그려 두고 투명도로만 드나든다 — 올린 순간 생겨나면 깜빡이고, 키보드로 들어온
          초점(`focus`)에도 떠야 한다. 숨어 있는 동안에는 눌리지 않는다.
        */}
        {onWidth && (
          <Segmented
            label="그림 크기"
            options={IMG_SIZES.map((z) => ({
              id: z.width === null ? "orig" : String(z.width),
              label: z.label,
              title: z.title,
            }))}
            value={
              b.width === null ? "orig" : IMG_SIZES.some((z) => z.width === b.width) ? String(b.width) : null
            }
            onPick={(id) => onWidth(id === "orig" ? null : Number(id))}
            seg={38}
            height={18}
            pad={2}
            className="cf-mv"
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              borderRadius: 5,
              background: "rgba(235,231,223,.94)",
              boxShadow: "0 2px 6px rgba(35,33,30,.12)",
              opacity: bar ? 1 : 0,
              transform: bar ? "none" : "translateY(-3px)",
              pointerEvents: bar ? "auto" : "none",
              transition: `opacity 140ms, transform 140ms ${EASE_OUT}`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 표 카드. 본문보다 한 단 작은 글씨로 조밀하게 그리고, 넓은 표는 글줄 폭을 넘기지
 * 않도록 **표만** 가로로 스크롤한다 — 본문 전체가 옆으로 밀리면 읽던 자리를 잃는다.
 *
 * 합친 칸(HTML 표의 `colspan` · `rowspan`)은 `spans` 대로 넓히고 덮인 칸은 그리지 않는다.
 * 칸 안의 줄바꿈(`<br>`)은 줄을 바꿔 그린다. `onMenu` 가 있으면 우클릭이 표 메뉴를 연다.
 */
function TableCard({ b, onMenu }: { b: Block; onMenu?: (x: number, y: number) => void }) {
  const cell = (a: TableAlign, head: boolean) => ({
    padding: "5px 10px",
    border: "1px solid #e6e2da",
    textAlign: (a || "left") as "left" | "center" | "right",
    verticalAlign: "top" as const,
    fontWeight: head ? 600 : 400,
    color: head ? "#23211e" : "#3a3630",
    minWidth: 40,
    whiteSpace: "pre-line" as const,
  });
  /** `r` 은 머리 줄을 0 으로 센다. 덮인 칸이면 `null`. */
  const span = (r: number, c: number) => {
    const sp = b.spans[r]?.[c];
    if (!sp) return {};
    if (!sp.rs) return null;
    return { colSpan: sp.cs > 1 ? sp.cs : undefined, rowSpan: sp.rs > 1 ? sp.rs : undefined };
  };
  return (
    <div
      style={{ margin: "10px 0", overflowX: "auto" }}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(e.clientX, e.clientY);
            }
          : undefined
      }
    >
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
            {b.head.map((segs, c) => {
              const sp = span(0, c);
              if (!sp) return null;
              return (
                <th key={c} {...sp} style={cell(b.align[c], true)}>
                  <Inline segs={segs} />
                </th>
              );
            })}
          </tr>
        </thead>
        {b.rows.length > 0 && (
          <tbody>
            {b.rows.map((row, r) => (
              // 줄무늬는 넓은 표에서 눈이 옆 줄로 미끄러지지 않게 하는 정도로만 옅게 둔다.
              <tr key={r} style={{ background: r % 2 ? "#fbfaf7" : "#fff" }}>
                {row.map((segs, c) => {
                  const sp = span(r + 1, c);
                  if (!sp) return null;
                  return (
                    <td key={c} {...sp} style={cell(b.align[c], false)}>
                      <Inline segs={segs} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

/**
 * 표 우클릭 메뉴. 탐색기의 `ContextMenu` 와 같은 껍데기다 — 바깥을 누르거나 Esc 로 닫고,
 * 화면 밖으로 넘치면 안쪽으로 되접는다.
 */
function TableMenu({
  x,
  y,
  b,
  onEdit,
  onClose,
}: {
  x: number;
  y: number;
  b: Block;
  onEdit: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // 닫힐 때 잔상이 짧게 나간다 — 예전에는 한 프레임에 사라졌다.
  useExitSnapshot(ref, "menu");
  /** 자리와, 메뉴가 자라나는 점(`transform-origin`) — 되접힌 쪽에서도 누른 자리에서 자란다. */
  const [pos, setPos] = useState({ x, y, origin: "0 0" });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const M = 8;
    const r = ref.current.getBoundingClientRect();
    let nx = x;
    let ny = y;
    let ox = "0";
    let oy = "0";
    if (nx + r.width > window.innerWidth - M) {
      nx = Math.max(M, window.innerWidth - M - r.width);
      ox = `${Math.round(x - nx)}px`;
    }
    if (ny + r.height > window.innerHeight - M) {
      ny = Math.max(M, y - r.height);
      oy = "100%";
    }
    setPos({ x: nx, y: ny, origin: `${ox} ${oy}` });
  }, [x, y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 앱의 Esc(맨 위 레이어 닫기)는 이 메뉴를 모른다 — 여기서 닫고 거기까지 가지 않게 한다.
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** 칸마다의 크기를 든 표는 HTML 표다(GFM 표는 빈 배열). */
  const html = b.spans.length > 0;
  return (
    <>
      <div
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 80 }}
      />
      <div
        ref={ref}
        role="menu"
        className="cf-menu"
        style={{
          position: "fixed",
          zIndex: 81,
          minWidth: 200,
          left: pos.x,
          top: pos.y,
          transformOrigin: pos.origin,
          background: "#fff",
          border: "1px solid #d9d4ca",
          borderRadius: 6,
          boxShadow: "0 12px 30px rgba(35,33,30,.20)",
          padding: 4,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 8px 6px 8px",
            borderBottom: "1px solid #f0ede7",
            marginBottom: 3,
          }}
        >
          <span
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 8.5,
              fontWeight: 600,
              borderRadius: 2,
              padding: "1px 3px",
              color: "#2f6f80",
              background: "#e8f3f5",
            }}
          >
            {html ? "HTML" : "MD"}
          </span>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "#3a3630" }}>
            표 · {b.head.length}열 × {b.rows.length + 1}행
          </span>
        </div>
        <Box
          onClick={onEdit}
          role="menuitem"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            borderRadius: 4,
            cursor: "pointer",
          }}
          hover={{ background: "#f2efe9" }}
        >
          <span
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 9,
              fontWeight: 600,
              borderRadius: 2,
              padding: "1px 4px",
              color: "#2f5cbb",
              background: "#eef3fd",
            }}
          >
            ▦
          </span>
          <span style={{ fontSize: 12, color: "#3a3630", flex: 1 }}>표 편집</span>
          <span style={{ fontSize: 11, color: "#6a665e" }}>그리드 편집기</span>
        </Box>
      </div>
    </>
  );
}

/**
 * 방금 닿은 블록을 한 번 빛낸다(`cf-flash`). 블록 요소는 React 가 클래스를 쥐고 있지 않으므로 직접 붙였다
 * 떼고, 같은 블록이 다시 불리면 처음부터 다시 돈다. 안쪽 요소의 애니메이션 끝은 세지 않는다.
 */
function flashOnce(el: HTMLElement): void {
  el.classList.remove("cf-flash");
  void el.offsetWidth;
  el.classList.add("cf-flash");
  const done = (e: AnimationEvent) => {
    if (e.target !== el) return;
    el.classList.remove("cf-flash");
    el.removeEventListener("animationend", done);
  };
  el.addEventListener("animationend", done);
}

/** 체크박스 — 상자가 초록으로 차고 체크 획이 그어진다(예전에는 ☐ · ☑ 글자가 순간 바뀌었다). */
function TaskBox({ checked }: { checked: boolean }) {
  return (
    // `overflow: visible` — 작은 svg 에 `scrollbar-gutter` 가 스크롤바 자리를 잡아 그림이 가려진다.
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden style={{ display: "block", overflow: "visible" }}>
      <rect
        x="1"
        y="1"
        width="12"
        height="12"
        rx="3"
        fill={checked ? GREEN : "#fff"}
        stroke={checked ? GREEN : "#b5afa2"}
        strokeWidth="1.3"
        style={{ transition: "fill 140ms, stroke 140ms" }}
      />
      <path
        className="cf-mv"
        d="M3.8 7.2 6 9.4 10.3 4.8"
        fill="none"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="12"
        strokeDashoffset={checked ? 0 : 12}
        style={{ transition: `stroke-dashoffset 180ms ${EASE_OUT}` }}
      />
    </svg>
  );
}

/** 완료한 항목의 취소선 색. 회색 글(`#8a857c`)보다 한 단 옅게 — 글을 가리지 않는다. */
const STRIKE = "#b5afa2";

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
  inline,
  reveal,
  onRevealed,
  onEditTable,
}: {
  blocks: Block[];
  /**
   * 스크롤 상자 없이 내용 높이만큼 그린다. 위키 대화처럼 답 여러 개를 한 스크롤 안에 쌓을 때
   * 쓴다 — 답마다 제 스크롤을 가지면 바깥 스크롤과 겹쳐 휠이 엉뚱한 곳을 굴린다.
   */
  inline?: boolean;
  /** 체크박스를 눌렀다. `checked` 는 누른 뒤의 상태다(머리띠의 "완료 · 파일에 저장됨" 이 쓴다). */
  onToggle?: (line: number, checked: boolean) => void;
  /** 이미지 블록의 경로를 `<img src>` 로 바꾼다. `null` 이면 그리지 않는다. */
  imageUrl?: (b: Block) => string | null;
  /** 크기 단계를 골랐다. `line` 은 `onToggle` 과 같이 본문 기준이다. */
  onImageWidth?: (line: number, idx: number, width: number | null) => void;
  /** 뷰어에 초점이 있을 때 이미지를 붙여넣었다. */
  onPasteImage?: (img: ClipImage) => void;
  /** 이 줄(`onToggle` 과 같이 본문 기준)이 든 블록으로 한 번 스크롤한다 — AI 도우미가 넣은 자리. */
  reveal?: number;
  /** `reveal` 로 스크롤했다. 요청을 지우는 데 쓴다. */
  onRevealed?: () => void;
  /**
   * 표를 우클릭해 [표 편집] 을 골랐다. 블록의 `line` · `end` 는 `onToggle` 과 같이 본문 기준이다.
   * 주지 않으면(위키 화면) 표 우클릭은 평소와 같다.
   */
  onEditTable?: (b: Block) => void;
}) {
  const [port, setPort] = useState<HTMLDivElement | null>(null);
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number; b: Block } | null>(null);
  // 문서가 바뀌면(다른 탭 · 다시 읽기) 메뉴가 가리키던 표의 줄이 맞지 않을 수 있다.
  useEffect(() => setTableMenu(null), [blocks]);
  const list = useRef<HTMLDivElement | null>(null);
  // 블록 하나가 목록의 자식 하나다(블록마다 뿌리 요소 하나를 그린다) — 그래서 n번째 자식이 n번째 블록이다.
  useEffect(() => {
    if (reveal === undefined || !list.current) return;
    let at = blocks.findIndex((b) => b.line >= reveal);
    if (at < 0) at = blocks.length - 1;
    const el = list.current.children[at];
    if (el instanceof HTMLElement) {
      // 부드럽게 굴리고, 닿은 블록이 한 번 빛난다 — 넣은 자리가 화면 어디인지 눈이 찾지 않아도 된다.
      el.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
      flashOnce(el);
    }
    onRevealed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, blocks]);
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
        style={
          inline
            ? { outline: "none" }
            : {
                flex: 1,
                minHeight: 0,
                overflow: "auto",
                padding: "14px 20px 28px 20px",
                outline: "none",
              }
        }
      >
        <div ref={list} style={{ maxWidth: MEASURE }}>
          {!blocks.length && (
            <div style={{ fontSize: 12.5, color: "#8a857c" }}>빈 문서입니다</div>
          )}
          {blocks.map((b, i) => {
            const first = i === 0;
            if (b.isFence) return <CodeCard key={b.key} code={b.code} lang={b.lang} />;
            if (b.isTable)
              return (
                <TableCard
                  key={b.key}
                  b={b}
                  onMenu={onEditTable ? (x, y) => setTableMenu({ x, y, b }) : undefined}
                />
              );
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
                    onClick={onToggle ? () => onToggle(b.line, !b.checked) : undefined}
                    role="checkbox"
                    aria-checked={b.checked}
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
                      cursor: onToggle ? "pointer" : "default",
                      userSelect: "none",
                    }}
                    hover={onToggle ? { background: "#f0ede7" } : undefined}
                  >
                    <TaskBox checked={b.checked} />
                  </Box>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: BODY,
                      lineHeight: LH,
                      color: b.fg,
                      wordBreak: "break-word",
                      transition: "color 200ms",
                    }}
                  >
                    {/*
                      취소선은 왼쪽에서 오른쪽으로 그어진다. 줄 안 요소의 배경은 여러 줄에 걸쳐 한 줄로
                      이어 붙으므로(`box-decoration-break: slice`), 접힌 항목도 읽는 순서대로 그어진다.
                    */}
                    <span
                      className="cf-mv"
                      style={{
                        backgroundImage: `linear-gradient(${STRIKE}, ${STRIKE})`,
                        backgroundRepeat: "no-repeat",
                        backgroundPosition: "0 54%",
                        backgroundSize: `${b.checked ? 100 : 0}% 1px`,
                        transition: `background-size 220ms ${EASE_OUT} 40ms`,
                      }}
                    >
                      <Inline segs={b.segs} />
                    </span>
                  </div>
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
      {tableMenu && onEditTable && (
        <TableMenu
          x={tableMenu.x}
          y={tableMenu.y}
          b={tableMenu.b}
          onClose={() => setTableMenu(null)}
          onEdit={() => {
            setTableMenu(null);
            onEditTable(tableMenu.b);
          }}
        />
      )}
    </Viewport.Provider>
  );
}
