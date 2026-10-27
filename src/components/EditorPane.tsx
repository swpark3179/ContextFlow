import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Box, CheckMark, EASE_IN, EASE_OUT, reducedMotion, Spinner } from "../lib/ui";
import { extOf, GREEN, LANG, statusOf, TEXT, TOAST } from "../lib/design";
import { fmValue, mdParse, splitFrontmatter } from "../lib/markdown";
import {
  parseTableSource,
  placeTable,
  spliceBlock,
  tableToMarkdown,
  type TableModel,
} from "../lib/mdTable";
import { cutLine } from "../lib/editing";
import { clipboardImage, insertOwnLine, resolveImageSrc } from "../lib/images";
import { basename, joinPath } from "../lib/format";
import { keepTabs, tabKey } from "../lib/tabs";
import { savedAgain, savedAt, saveView, type SaveView } from "../lib/saveView";
import { edgeFades, fadeMask, revealLeft } from "../lib/tabStrip";
import { useStore, viewerFor, type Tab, type TabMode } from "../store/useStore";
import { useAssist } from "../store/assistStore";
import type { Block } from "../lib/markdown";
import BrainstormPane, { BrainstormViewTabs } from "./BrainstormPane";
import MarkdownView, { Segmented } from "./MarkdownView";
import { NOTE_MS } from "./Notepad";
import TableModal from "../modals/TableModal";

/**
 * 열려 있는 표 팝업이 확정되면 쓸 자리.
 *
 * * `text` — 텍스트 에디터의 `[from, to)`. `snap` 은 연 순간의 편집기 글이다 — 확정할 때 글이
 *   그대로여야 그 자리가 맞는다. `sel` · `scroll` 은 취소했을 때 커서를 돌려놓을 자리다.
 * * `view` — 뷰어에서 고른 표. 문서의 `[start, end)` 줄이고, `lines` 는 연 순간의 그 줄들이다.
 */
type TableEdit = { seq: number; path: string; model: TableModel; edit: boolean } & (
  | { kind: "text"; from: number; to: number; snap: string; sel: [number, number]; scroll: number }
  | { kind: "view"; start: number; end: number; lines: string[] }
);

let tableSeq = 0;

/**
 * 편집기 머리띠의 표 아이콘. `overflow: visible` 은 빼면 안 된다 — `global.css` 의
 * `scrollbar-gutter: stable` 이 `overflow: hidden`(svg 의 기본값)인 이 작은 상자에 스크롤바 자리를
 * 잡아 그림이 통째로 가려진다.
 */
function TableIcon() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden style={{ display: "block", overflow: "visible" }}>
      <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.2" y="1.2" width="11.6" height="3" fill="currentColor" opacity="0.22" />
      <path d="M0.6 4.2h12.8M0.6 7.8h12.8M5 4.2v7.2M9.2 4.2v7.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

const MODE_BADGE: Record<TabMode, { label: string; fg: string; bg: string; bar: string }> = {
  md: { label: "MD", fg: "#2f6f80", bg: "#e8f3f5", bar: "#3f8ea3" },
  html: { label: "HTML", fg: "#8f5d17", bg: "#fbf3e6", bar: "#b07520" },
  text: { label: "TXT", fg: "#2f5cbb", bg: "#eef3fd", bar: "#3a6fd8" },
  bstorm: { label: "BS", fg: "#256b47", bg: "#e9f4ee", bar: "#2f7f57" },
};

/** 탭 띠 한 줄의 높이(px). 바깥 띠는 밑줄 1px 을 더해 27px 이다. */
const STRIP_H = 26;
/** 넘친 가장자리를 옅게 지우는 폭. 활성 탭을 보이게 굴릴 때도 이만큼 띄운다. */
const STRIP_FADE = 18;
/** ✕ · 가운데 클릭으로 닫는 탭이 폭째 접히는 시간(m-base). 그 뒤에 스토어가 탭을 뺀다. */
const CLOSE_MS = 200;
/** 저장 체크가 떠 있는 시간. 그 뒤 옅어지며 자리를 내준다. */
const SAVED_MS = 1400;
/** 메모장 머리띠의 높이 — 메모장을 접으면 편집기가 이만큼만 남기고 내려온다. */
const NOTE_HEAD = 26;
const RED = "#a83c3c";

const PANE_LABEL: Record<TabMode, string> = {
  md: "마크다운 뷰어",
  html: "HTML 뷰어",
  text: "텍스트 에디터",
  bstorm: "브레인스토밍",
};

/**
 * 뷰어와 편집기가 공유하는 머리띠. 모드를 바꿔도 **이 머리띠는 그대로 남는다** — 그래야 오른쪽 끝
 * [뷰어 | 텍스트] 스위치의 손잡이가 미끄러지고, 이름표만 바뀌어 올라온다(`roll`).
 */
function PaneHeader({
  label,
  hint,
  roll,
  note,
  switcher,
  children,
}: {
  label: string;
  hint: string;
  /** 같은 파일의 모드를 방금 바꿨다 — 이름표가 아래에서 올라온다. */
  roll: boolean;
  /** 잠깐 뜨는 알림(체크 저장됨) · 저장 실패. */
  note?: ReactNode;
  switcher?: ReactNode;
  /** 스위치 왼쪽에 붙는 뷰어별 단추. */
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        flex: "0 0 25px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 8px 0 12px",
        background: "#fbfaf7",
        borderBottom: "1px dashed #e4e0d8",
        minWidth: 0,
      }}
    >
      {/* flex 로 둔다 — inline-block 이면 바깥 글꼴(16px)의 줄 상자에 얹혀 이름표가 아래로 밀려 잘린다.
          `clip` 은 스크롤 상자가 아니라서 `scrollbar-gutter` 가 자리를 잡지 않는다. */}
      <span style={{ flex: "0 0 auto", display: "flex", height: 16, overflow: "clip" }}>
        <span
          key={label}
          className={roll ? "cf-enter" : undefined}
          style={{
            display: "inline-block",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: ".4px",
            color: TEXT.sub,
            lineHeight: "16px",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </span>
      <span
        style={{
          fontSize: 11,
          color: TEXT.sub,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {hint}
      </span>
      <div style={{ flex: 1 }} />
      {note}
      {children}
      {switcher}
    </div>
  );
}

/**
 * [뷰어 | 텍스트] — 예전의 "텍스트로 편집" · "저장 후 뷰어로 열기" 링크를 갈음한다. 편집기에서 뷰어로
 * 갈 때는 저장을 기다리므로(`setTabMode`) 그동안 손잡이는 뷰어 칸에 가 있고 작은 돌기가 돈다. 저장이
 * 실패하면 손잡이는 텍스트로 돌아오고, 실패는 상태 막대가 계속 보인다.
 */
function ViewSwitch({
  viewing,
  pending,
  color,
  dirty,
  onViewer,
  onText,
}: {
  viewing: boolean;
  pending: boolean;
  color: string;
  dirty: boolean;
  onViewer: () => void;
  onText: () => void;
}) {
  return (
    <Segmented
      label="보기 방식"
      seg={52}
      height={17}
      value={viewing || pending ? "viewer" : "text"}
      onPick={(id) => (id === "viewer" ? onViewer() : onText())}
      options={[
        {
          id: "viewer",
          title: viewing ? "뷰어로 보는 중" : dirty ? "저장한 뒤 뷰어로 엽니다" : "뷰어로 엽니다",
          label: (
            <>
              {pending && <Spinner size={8} color={color} />}
              뷰어
            </>
          ),
        },
        { id: "text", title: viewing ? "원본 텍스트를 고칩니다" : "텍스트로 고치는 중", label: "텍스트" },
      ]}
    />
  );
}

/**
 * 저장 다시 시도 — 상태 막대와 뷰어 머리띠가 같이 쓴다. 또 실패하면 단추가 좌우로 흔들린다(`shake`).
 * 실패가 다른 길로 풀리면(자동 저장 성공 · 다시 읽기) 흔들림을 잊는다 — 다음 실패에 단추가 처음부터
 * 흔들리며 나타나지 않게.
 */
function useRetry(path: string, failed: boolean) {
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  useEffect(() => {
    if (!busy && !failed) setShake(0);
  }, [busy, failed]);
  const retry = () => {
    if (busy) return;
    setBusy(true);
    void useStore
      .getState()
      .saveDoc(path)
      .finally(() => {
        setBusy(false);
        if (useStore.getState().docSave[path]?.state === "failed") setShake((k) => k + 1);
      });
  };
  return { busy, shake, retry };
}

/**
 * 문서 하나의 저장 표시와 다시 시도. 다시 시도하는 동안에는 빨간 표시를 그대로 두고 단추 안에서만
 * 돌기가 돈다 — 막대가 "저장하는 중" 으로 바뀌었다가 다시 빨개지면 깜빡임으로 보인다.
 */
function useSaveState(path: string) {
  const save = useStore((st) => st.docSave[path]);
  const doc = useStore((st) => st.ui.docs[path]);
  const dirty = !!doc && doc.text !== doc.saved;
  const raw = saveView(dirty, save);
  const r = useRetry(path, raw === "failed");
  /** 실패 문구. 다시 시도하는 동안 스토어는 문구를 비우므로 마지막 것을 든다. */
  const err = useRef("");
  if (save?.error) err.current = save.error;
  const view: SaveView = r.busy && raw === "saving" ? "failed" : raw;
  return { ...r, save, view, error: err.current };
}

function RetryButton({ busy, shake, onRetry }: { busy: boolean; shake: number; onRetry: () => void }) {
  return (
    <Box
      key={shake}
      role="button"
      tabIndex={0}
      aria-busy={busy || undefined}
      className={shake ? "cf-shake" : undefined}
      onClick={onRetry}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onRetry();
      }}
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 18,
        padding: "0 8px",
        borderRadius: 4,
        border: "1px solid #f2d6d2",
        background: "#fff",
        color: RED,
        fontFamily: "'Noto Sans KR',system-ui,sans-serif",
        fontSize: 11.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
        cursor: busy ? "default" : "pointer",
        userSelect: "none",
      }}
      hover={busy ? undefined : { background: "#fbe8e6" }}
    >
      {busy && <Spinner size={9} color={RED} track="#f2d6d2" />}
      다시 시도
    </Box>
  );
}

/**
 * 텍스트 에디터의 상태 막대. 오른쪽 끝이 저장의 흐름을 말한다 — 미저장(주황) → 저장하는 중 → 저장됨
 * (체크 · 이 문서의 저장 시각). 상태가 바뀔 때마다 글이 아래에서 올라온다. 저장에 실패하면 막대가
 * 붉어지고 [다시 시도] 가 남는다 — 열린 탭의 실패는 토스트를 띄우지 않으므로(`saveDoc`) 여기가 실패를
 * 보여 줄 자리다.
 */
function StatusBar({
  path,
  caret,
  lang,
  title,
}: {
  path: string;
  caret: { ln: number; col: number };
  lang: string;
  title: string;
}) {
  const snapAt = useStore((st) => st.snapAt);
  const { view, save, error, busy, shake, retry } = useSaveState(path);
  const failed = view === "failed";
  const color =
    view === "dirty" ? TEXT.warn : view === "saved" ? "#256b47" : failed ? RED : TEXT.sub;
  return (
    <div
      style={{
        flex: "0 0 auto",
        minHeight: 22,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 12px",
        background: failed ? "#fdf3f2" : "#f7f5f1",
        borderTop: `1px solid ${failed ? "#f2d6d2" : "#e6e2da"}`,
        fontFamily: "'Roboto Mono',monospace",
        fontSize: 11.5,
        color: TEXT.sub,
        transition: "background-color 200ms, border-color 200ms",
        minWidth: 0,
      }}
    >
      <span style={{ flex: "0 0 auto" }}>
        Ln {caret.ln}, Col {caret.col}
      </span>
      <span style={{ flex: "0 0 auto" }}>{lang}</span>
      <span style={{ flex: "0 0 auto" }}>UTF-8</span>
      <div style={{ flex: 1 }} />
      <span role="status" title={failed ? error : title} style={{ minWidth: 0, overflow: "hidden", display: "flex" }}>
        <span
          key={view}
          className="cf-enter"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            whiteSpace: "nowrap",
            color,
          }}
        >
          {view === "dirty" && (
            <>
              <span
                style={{ width: 5, height: 5, flex: "0 0 5px", borderRadius: "50%", background: "#b07520" }}
              />
              미저장 변경 · 곧 저장
            </>
          )}
          {view === "saving" && (
            <>
              <Spinner size={10} track="#d9d4ca" />
              저장하는 중
            </>
          )}
          {view === "saved" && (
            <>
              <CheckMark size={10} />
              저장됨 {savedAt(save, snapAt)}
            </>
          )}
          {failed && (
            <span
              style={{
                fontFamily: "'Noto Sans KR',system-ui,sans-serif",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              저장하지 못했습니다{error ? ` — ${error}` : ""}
            </span>
          )}
        </span>
      </span>
      {failed && <RetryButton busy={busy} shake={shake} onRetry={retry} />}
    </div>
  );
}

/**
 * 뷰어 · 캔버스의 머리띠에 남는 저장 실패. 이 화면들에는 상태 막대가 없지만 체크 · 그림 크기 · 캔버스
 * 편집도 파일을 쓴다 — 실패하면 탭의 빨간 점과 함께 여기에 [다시 시도] 가 남는다.
 */
function SaveFailNote({ path }: { path: string }) {
  const { view, error, busy, shake, retry } = useSaveState(path);
  if (view !== "failed") return null;
  return (
    <span
      className="cf-fade"
      role="status"
      title={error ? `저장하지 못했습니다 — ${error}` : undefined}
      style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: RED, whiteSpace: "nowrap" }}
    >
      저장하지 못했습니다
      <RetryButton busy={busy} shake={shake} onRetry={retry} />
    </span>
  );
}

/**
 * 방금 끝난 저장의 체크. 저장할 때마다(`n` 이 오를 때) 튀어나왔다가 `SAVED_MS` 뒤 옅어지며 자리를
 * 내준다. 업무를 바꿔 `n` 이 0 으로 돌아간 것은 저장이 아니다(`savedAgain`).
 */
function useJustSaved(n: number): "pop" | "fade" | null {
  const [phase, setPhase] = useState<"pop" | "fade" | null>(null);
  const last = useRef(n);
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const again = savedAgain(last.current, n);
    last.current = n;
    if (!again) return;
    timers.current.forEach((t) => window.clearTimeout(t));
    setPhase("pop");
    timers.current = [
      window.setTimeout(() => setPhase("fade"), SAVED_MS),
      window.setTimeout(() => setPhase(null), SAVED_MS + 200),
    ];
  }, [n]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  return phase;
}

/**
 * 탭의 저장 자리 — 이름과 ✕ 사이의 10px. 미저장은 주황 점, 쓰는 중은 돌기, 방금 저장은 초록 체크, 실패는
 * 빨간 `!`. 보일 것이 없으면 자리가 접힌다.
 */
function SaveSlot({
  view,
  dirtyDot,
  n,
  error,
}: {
  view: SaveView;
  /** 미저장 점을 찍는 모드인가 — 텍스트 · 캔버스. 뷰어의 체크는 곧바로 쓰므로 점이 한 프레임 비칠 뿐이다. */
  dirtyDot: boolean;
  n: number;
  error?: string;
}) {
  const fresh = useJustSaved(n);
  const dot = view === "dirty" && dirtyDot;
  const check = view === "saved" && fresh !== null;
  const open = dot || view === "saving" || view === "failed" || (check && fresh === "pop");
  return (
    <span
      className="cf-mv"
      style={{
        position: "relative",
        flex: "0 0 auto",
        width: open ? 10 : 0,
        height: 10,
        transition: `width 160ms ${EASE_OUT}`,
      }}
    >
      {dot && (
        <span
          className="cf-pop"
          title="저장되지 않은 변경"
          style={{
            position: "absolute",
            left: 2.5,
            top: 2.5,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "#b07520",
          }}
        />
      )}
      {view === "saving" && <Spinner size={10} style={{ position: "absolute", left: 0, top: 0 }} />}
      {check && (
        <span
          key={n}
          title="저장됨"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            opacity: fresh === "fade" ? 0 : 1,
            transition: "opacity 200ms",
          }}
        >
          <CheckMark size={10} color={GREEN} />
        </span>
      )}
      {view === "failed" && (
        <span
          className="cf-pop"
          title={error ? `저장하지 못했습니다 — ${error}` : "저장하지 못했습니다"}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: "#c04a4a",
            color: "#fff",
            fontFamily: "'Noto Sans KR',system-ui,sans-serif",
            fontSize: 8,
            fontWeight: 700,
            lineHeight: "10px",
            textAlign: "center",
          }}
        >
          !
        </span>
      )}
    </span>
  );
}

function TabItem({
  t,
  on,
  isNew,
  closing,
  view,
  n,
  error,
  tabRef,
  onPick,
  onClose,
  onMenu,
}: {
  t: Tab;
  on: boolean;
  isNew: boolean;
  closing: boolean;
  view: SaveView;
  n: number;
  error?: string;
  tabRef: (el: HTMLDivElement | null) => void;
  onPick: () => void;
  onClose: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const badge = MODE_BADGE[t.mode];
  const name = basename(t.path);
  return (
    <Box
      ref={tabRef}
      role="tab"
      aria-selected={on}
      tabIndex={0}
      // 새로 연 탭은 아래에서 올라온다. ✕ 는 올렸을 때 · 초점이 들어왔을 때 · 활성 탭에만 보인다.
      className={`cf-mv cf-reveal-host${isNew ? " cf-enter" : ""}`}
      onClick={closing ? undefined : onPick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onPick();
      }}
      // 가운데 버튼은 닫기다. 누르는 순간의 기본 동작(자동 스크롤)은 막는다.
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        onClose();
      }}
      // 우클릭한 탭이 곧 메뉴의 대상이다 — 활성 탭이 아니어도 그 탭을 가리킨다
      // (탐색기에서 우클릭이 선택을 옮기지 않는 것과 같다).
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: closing ? 0 : "0 6px 0 9px",
        maxWidth: closing ? 0 : 180,
        opacity: closing ? 0 : 1,
        overflow: "hidden",
        outlineOffset: -2,
        fontFamily: "'Roboto Mono',monospace",
        fontSize: 11.5,
        cursor: "pointer",
        borderRight: closing ? "0 solid #e6e2da" : "1px solid #e6e2da",
        whiteSpace: "nowrap",
        background: on ? "#fff" : "transparent",
        color: on ? TEXT.ink : TEXT.sub,
        transition: `max-width ${CLOSE_MS}ms ${EASE_IN}, padding ${CLOSE_MS}ms ${EASE_IN}, opacity 140ms, background-color 90ms, color 90ms`,
      }}
      hover={on || closing ? undefined : { background: "#efece6" }}
    >
      <span
        style={{
          flex: "0 0 auto",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: ".3px",
          borderRadius: 2,
          padding: "1px 3px",
          color: badge.fg,
          background: badge.bg,
          transition: "color 140ms, background-color 140ms",
        }}
      >
        {badge.label}
      </span>
      <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      <SaveSlot view={view} dirtyDot={t.mode === "text" || t.mode === "bstorm"} n={n} error={error} />
      <Box
        role="button"
        tabIndex={0}
        aria-label={`${name} 탭 닫기`}
        title="닫기 (가운데 버튼으로도 닫힙니다)"
        className={on ? undefined : "cf-reveal"}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        style={{
          width: 15,
          height: 15,
          flex: "0 0 15px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 3,
          color: TEXT.sub,
          transition: "opacity 140ms, background-color 90ms, color 90ms",
        }}
        hover={{ background: "#e0dcd4", color: "#4e4a43" }}
      >
        <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden style={{ display: "block", overflow: "visible" }}>
          <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </Box>
    </Box>
  );
}

/**
 * 탭 띠. 넘치면 옆으로 굴러가고(휠로도), 활성 탭은 보이는 자리로 부드럽게 들어오며, 넘친 가장자리는
 * 옅게 지운다. 활성 탭의 밑줄은 하나가 탭 사이를 미끄러진다(모드 색 그대로).
 *
 * ✕ · 가운데 클릭으로 닫으면 탭이 폭째 접힌 뒤(`CLOSE_MS`) 스토어가 뺀다(`closeTab`). 활성 탭이었으면
 * 다음 탭은 곧바로 고른다 — 닫기와 같은 규칙(`keepTabs`)이라 끝 상태는 예전과 같고, 편집기가 접히는
 * 탭을 기다리지 않는다. 우클릭 메뉴의 닫기는 예전처럼 곧바로 닫는다.
 */
function TabStrip() {
  const s = useStore();
  const { ui, activeFolder, docSave } = s;
  const scroller = useRef<HTMLDivElement | null>(null);
  const row = useRef<HTMLDivElement | null>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const refs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const refFor = (path: string) => {
    let f = refs.current.get(path);
    if (!f) {
      f = (el) => {
        if (el) els.current.set(path, el);
        else els.current.delete(path);
      };
      refs.current.set(path, f);
    }
    return f;
  };
  /** 접히는 중인 탭(경로). */
  const [closing, setClosing] = useState<Record<string, true>>({});
  const closingRef = useRef(closing);
  closingRef.current = closing;
  /** 밑줄. `glide` 가 거짓이면 미끄러지지 않고 그 자리에 나타난다(처음 · 탭이 하나도 없다가 생길 때). */
  const [ul, setUl] = useState({ x: 0, w: 0, color: MODE_BADGE.text.bar, on: false, glide: false });
  const [edges, setEdges] = useState({ left: false, right: false });

  const active = ui.openTabs.find((t) => tabKey(t) === ui.activeTab) ?? null;
  const activeRef = useRef(active);
  activeRef.current = active;

  /**
   * 새로 연 탭만 올라온다. 업무를 바꿔 되살아난 탭들은 셸이 한꺼번에 들이므로 여기서는 세지 않는다.
   * 키가 경로인 것도 같은 이유다 — 모드를 바꾼 탭(뷰어 ↔ 텍스트)은 새 탭이 아니다.
   */
  const seen = useRef<{ folder: string; paths: Set<string> } | null>(null);
  const known = seen.current && seen.current.folder === activeFolder ? seen.current.paths : null;

  const measure = () => {
    const sc = scroller.current;
    if (sc) {
      const e = edgeFades(sc.scrollLeft, sc.scrollWidth, sc.clientWidth);
      setEdges((p) => (p.left === e.left && p.right === e.right ? p : e));
    }
    const a = activeRef.current;
    const el = a && !closingRef.current[a.path] ? els.current.get(a.path) : undefined;
    if (!a || !el) {
      setUl((p) => (p.on ? { ...p, on: false } : p));
      return;
    }
    const x = el.offsetLeft;
    const w = el.offsetWidth;
    const color = MODE_BADGE[a.mode].bar;
    setUl((p) =>
      p.on && Math.abs(p.x - x) < 0.5 && Math.abs(p.w - w) < 0.5 && p.color === color
        ? p
        : { x, w, color, on: true, glide: p.on },
    );
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;

  const lastActive = useRef<string | null>(null);
  useLayoutEffect(() => {
    seen.current = { folder: activeFolder, paths: new Set(ui.openTabs.map((t) => t.path)) };
    measure();
    if (lastActive.current === ui.activeTab) return;
    const first = lastActive.current === null;
    lastActive.current = ui.activeTab;
    const a = activeRef.current;
    const el = a ? els.current.get(a.path) : undefined;
    const sc = scroller.current;
    if (!el || !sc) return;
    const left = revealLeft(el.offsetLeft, el.offsetWidth, sc.scrollLeft, sc.clientWidth, STRIP_FADE);
    if (left !== null) sc.scrollTo({ left, behavior: first || reducedMotion() ? "auto" : "smooth" });
  });

  // 띠의 폭(창 · 패널 크기)이나 탭들의 폭(접히는 탭 · 새 탭)이 바뀌면 밑줄과 가장자리를 다시 잰다.
  // 탭 줄은 내용 폭이라(`max-content`) 접히는 탭의 폭이 바뀌는 매 프레임 여기로 온다 — 밑줄이 따라간다.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureRef.current());
    if (scroller.current) ro.observe(scroller.current);
    if (row.current) ro.observe(row.current);
    return () => ro.disconnect();
  }, []);

  const close = (t: Tab) => {
    if (closingRef.current[t.path]) return;
    const st = useStore.getState();
    const key = tabKey(t);
    if (reducedMotion()) {
      st.closeTab(key);
      return;
    }
    // 접히는 시작점을 지금의 폭으로 잡는다 — 상한(180px)에서 시작하면 좁은 탭은 한동안 그대로 멈춰 있다.
    const el = els.current.get(t.path);
    if (el) {
      el.style.maxWidth = `${el.offsetWidth}px`;
      void el.offsetWidth;
    }
    if (st.ui.activeTab === key) {
      const left = keepTabs(st.ui.openTabs, key, (x) => tabKey(x) !== key && !closingRef.current[x.path]);
      st.setUi({ activeTab: left.activeTab });
    }
    const folder = st.activeFolder;
    setClosing((c) => ({ ...c, [t.path]: true }));
    window.setTimeout(() => {
      const now = useStore.getState();
      const cur = now.ui.openTabs.find((x) => x.path === t.path);
      // 접히는 사이에 업무를 바꿨으면 그 업무의 탭을 건드리지 않는다. 그사이 다시 열어(탐색기에서
      // 더블클릭) 활성이 됐으면 닫지 않는다.
      if (cur && now.activeFolder === folder && now.ui.activeTab !== tabKey(cur)) now.closeTab(tabKey(cur));
      setClosing((c) => {
        const n = { ...c };
        delete n[t.path];
        return n;
      });
    }, CLOSE_MS);
  };

  const mask = fadeMask(edges, STRIP_FADE);
  return (
    <div
      role="tablist"
      aria-label="열린 파일"
      style={{
        position: "relative",
        flex: `0 0 ${STRIP_H + 1}px`,
        background: "#f7f5f1",
        borderBottom: "1px solid #e6e2da",
        overflow: "hidden",
        scrollbarGutter: "auto",
      }}
    >
      {/*
        가로 스크롤바는 숨긴다(휠 · 활성 탭 따라가기로 굴린다). 스크롤바를 숨기지 못하는 웹뷰에서도
        탭을 덮지 않도록 스크롤 상자를 스크롤바 높이만큼 더 길게 두고 바깥 띠가 잘라 낸다.
      */}
      <div
        ref={scroller}
        onScroll={() => measureRef.current()}
        onWheel={(e) => {
          const sc = scroller.current;
          if (!sc || sc.scrollWidth <= sc.clientWidth) return;
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) sc.scrollLeft += e.deltaY;
        }}
        style={{
          height: STRIP_H + 11,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
          scrollbarGutter: "auto",
          WebkitMaskImage: mask,
          maskImage: mask,
        }}
      >
        <div
          ref={row}
          style={{ position: "relative", display: "flex", alignItems: "stretch", height: STRIP_H, width: "max-content" }}
        >
          {ui.openTabs.map((t) => {
            const key = tabKey(t);
            const tDoc = ui.docs[t.path];
            const save = docSave[t.path];
            const dirty = !!tDoc && tDoc.text !== tDoc.saved;
            return (
              <TabItem
                key={t.path}
                t={t}
                on={key === ui.activeTab}
                isNew={!!known && !known.has(t.path)}
                closing={!!closing[t.path]}
                view={saveView(dirty, save)}
                n={save?.n ?? 0}
                error={save?.error}
                tabRef={refFor(t.path)}
                onPick={() => s.setUi({ activeTab: key })}
                onClose={() => close(t)}
                onMenu={(x, y) => s.set({ tabCtx: { key, x, y }, ctx: null })}
              />
            );
          })}
          <span
            aria-hidden
            className="cf-mv"
            style={{
              position: "absolute",
              left: 0,
              bottom: 0,
              height: 2,
              width: ul.w,
              transform: `translateX(${ul.x}px)`,
              background: ul.color,
              opacity: ul.on ? 1 : 0,
              pointerEvents: "none",
              transition: ul.glide
                ? `transform 200ms ${EASE_OUT}, width 200ms ${EASE_OUT}, background-color 140ms, opacity 140ms`
                : "opacity 140ms",
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** 파일 내용이 바뀌면 값이 바뀌는 짧은 키. asset: URL 의 캐시를 무르는 데만 쓴다. */
function contentKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return `${(h >>> 0).toString(36)}${text.length.toString(36)}`;
}

/** Tab strip + one of: empty state / binary card / markdown viewer / HTML viewer / editor. */
export default function EditorPane() {
  const s = useStore();
  const { ui, files, activeFolder } = s;
  const [caret, setCaret] = useState({ ln: 1, col: 1 });
  /** 스크립트를 끈 HTML 탭. 기본은 실행이고, 여기 들어온 경로만 srcdoc 으로 되돌아간다. */
  const [noScript, setNoScript] = useState<Record<string, boolean>>({});
  /** 열려 있는 표 팝업. `null` = 닫힘. */
  const [tableEd, setTableEd] = useState<TableEdit | null>(null);
  /** 편집기 → 뷰어 전환이 저장을 기다리는 중인 경로. 그동안 스위치 안에서 돌기가 돈다. */
  const [switching, setSwitching] = useState<string | null>(null);
  /** 뷰어에서 체크를 누른 뒤 머리띠에 잠깐 뜨는 알림. `n` 이 오를 때마다 다시 뜬다. */
  const [taskNote, setTaskNote] = useState<{ n: number; path: string; text: string } | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  const task = s.tasks.find((t) => t.folder === activeFolder);
  const tab = ui.openTabs.find((t) => `${t.mode}|${t.path}` === ui.activeTab) ?? null;
  const meta = tab ? files.find((f) => f.p === tab.path) : undefined;
  const isBinary = !!meta?.bin;
  const doc = tab ? ui.docs[tab.path] : undefined;
  const body = doc?.text ?? "";
  const dirty = !!doc && doc.text !== doc.saved;
  const ext = tab ? extOf(tab.path) : "";
  /** 이 파일에 준비된 뷰어. 편집기 머리띠의 [뷰어 | 텍스트] 스위치는 이게 있을 때만 뜬다. */
  const viewer = tab && !isBinary ? viewerFor(tab.path) : null;

  /**
   * 같은 파일의 모드를 바꿨는가(뷰어 ↔ 텍스트). 그때만 본문이 페이드로 들어오고 머리띠 이름표가
   * 올라온다 — 다른 탭으로 옮겨 가는 것은 전환 효과 없이 곧바로 바뀐다.
   */
  const [pane, setPane] = useState({ path: tab?.path ?? "", mode: tab?.mode ?? "", n: 0, fade: false });
  if (tab && (pane.path !== tab.path || pane.mode !== tab.mode)) {
    const same = pane.path === tab.path;
    setPane({ path: tab.path, mode: tab.mode, n: same ? pane.n + 1 : pane.n, fade: same });
  }

  /**
   * 메모장을 접고 펴면 편집기 높이가 흘러간다. 높이 전환은 그 순간에만 켠다 — 늘 켜 두면 가운데 막대를
   * 끄는 동안 편집기가 손을 늦게 따라온다. 켜는 것은 그리는 중에 해야 같은 그리기에서 높이와 함께 걸린다.
   */
  const [split, setSplit] = useState({ min: s.noteMin, anim: false });
  if (split.min !== s.noteMin) setSplit({ min: s.noteMin, anim: true });
  useEffect(() => {
    if (!split.anim) return;
    const t = window.setTimeout(() => setSplit((p) => ({ ...p, anim: false })), NOTE_MS + 40);
    return () => window.clearTimeout(t);
  }, [split]);

  const scripts = !!tab && !noScript[tab.path];
  /**
   * HTML 뷰어가 읽을 파일의 `asset:` URL.
   *
   * srcdoc 을 쓰지 않는 이유는 그 문서가 **부모 창의 CSP 를 물려받기** 때문이다 —
   * `script-src 'self'` 아래에서는 문서 안의 `<script>` 가 한 줄도 돌지 않는다.
   * asset: 로 읽으면 별도 출처의 평범한 문서라 CSP 를 물려받지 않고, 옆에 있는 CSS ·
   * 이미지 · 스크립트 파일도 상대 경로 그대로 따라온다.
   *
   * 쿼리는 캐시를 무르기 위한 것이다(백엔드는 경로만 본다). 편집기에서 고친 뒤
   * 뷰어로 돌아왔을 때 예전 내용이 남아 있으면 고친 것이 반영되지 않은 것처럼 보인다.
   */
  const htmlSrc = useMemo(() => {
    if (!tab || isBinary || tab.mode !== "html" || !scripts) return "";
    return `${convertFileSrc(joinPath(activeFolder, tab.path))}?v=${contentKey(
      doc?.saved ?? "",
    )}`;
  }, [tab, isBinary, scripts, activeFolder, doc?.saved]);

  const fmSplit = useMemo(() => splitFrontmatter(body), [body]);
  const blocks = useMemo(
    () => (tab && !isBinary && tab.mode === "md" ? mdParse(fmSplit.body) : []),
    [tab, isBinary, fmSplit.body],
  );
  // The frontmatter is rendered as a summary header, so the textarea edits only
  // the body — otherwise the same YAML would appear twice on screen. Edits are
  // reassembled with the original block so metadata survives a save.
  const fm = fmSplit.fm;
  const editingBodyOnly = !!tab && tab.path === "index.md" && !!fm;
  const editorValue = editingBodyOnly ? fmSplit.body : body;
  const onEdit = (next: string) => {
    if (!tab) return;
    s.editDoc(tab.path, editingBodyOnly ? `---\n${fm}\n---\n${next}` : next);
  };

  /**
   * AI 도우미(이슈 추가)가 넣은 자리 — 이 탭이면 한 번 그리로 스크롤하고 요청을 지운다. 요청의 줄은 문서 전체
   * 기준이라, 프런트마터를 건너뛴 화면(뷰어 · index.md 편집기)에서는 본문이 시작하는 줄을 뺀다.
   */
  const reveal = useAssist((a) => a.reveal);
  const textArea = useRef<HTMLTextAreaElement | null>(null);
  const revealHere =
    reveal && tab && !isBinary && reveal.folder === activeFolder && reveal.path === tab.path ? reveal : null;
  useEffect(() => {
    // 다른 탭으로 옮겨 갔으면 버린다 — 나중에 그 파일을 열 때 엉뚱하게 스크롤하지 않게.
    if (reveal && !revealHere) useAssist.getState().setReveal(null);
  }, [reveal, revealHere]);
  useEffect(() => {
    if (!revealHere || tab?.mode !== "text") return;
    const el = textArea.current;
    if (!el) return;
    const line = Math.max(0, revealHere.line - (editingBodyOnly ? fmSplit.bodyLine : 0));
    const lines = el.value.split("\n");
    const at = Math.min(
      el.value.length,
      lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0),
    );
    el.focus();
    el.setSelectionRange(at, at);
    // 줄 높이로 어림한다 — 긴 줄이 접히면 조금 어긋나지만 넣은 자리 근처에 닿는다.
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.scrollTo({ top: Math.max(0, (line - 3) * lh), behavior: reducedMotion() ? "auto" : "smooth" });
    showCaret(el);
    useAssist.getState().setReveal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealHere, tab?.mode]);

  /**
   * 이미지 블록의 `<img src>`. 상대 경로는 **노트가 있는 폴더** 기준으로 풀고(`resolveImageSrc`),
   * asset: 로 읽는다 — Vault 루트가 asset 스코프에 들어 있다(`lib.rs` 의 `allow_directory`).
   */
  const imageUrl = (b: Block): string | null => {
    if (!tab) return null;
    const ref = resolveImageSrc(tab.path, b.src, b.wiki);
    if (ref.kind === "url") return ref.url;
    if (ref.kind === "remote") return null;
    return convertFileSrc(ref.kind === "abs" ? ref.path : joinPath(activeFolder, ref.path));
  };

  /**
   * 마크다운 편집기에 이미지를 붙여넣었다. 파일을 업무 폴더 최상위의 `images/` 에 저장한
   * 뒤 노트 기준 상대 경로의 링크를 커서 자리에 **한 줄로** 넣는다(뷰어는 이미지만 있는
   * 줄을 그림으로 그린다).
   *
   * 넣는 것은 `insertText` 로 웹뷰에 맡긴다 — 되돌리기(Ctrl+Z)가 네이티브 그대로 남고
   * 값은 평소처럼 onChange 로 따라온다(Ctrl+X 와 같은 방식). 저장을 기다리는 사이에 다른
   * 탭으로 옮겨 갔으면 커서가 없으므로 원래 노트의 끝에 붙인다.
   */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!tab || ext !== "md") return;
    const img = clipboardImage(e.clipboardData);
    if (!img) return;
    e.preventDefault();
    const el = e.currentTarget;
    const path = tab.path;
    void s.saveImage(path, img).then((md) => {
      if (!md) return;
      const st = useStore.getState();
      if (st.ui.activeTab !== `text|${path}` || !el.isConnected) {
        const cur = st.ui.docs[path];
        if (cur) st.editDoc(path, insertOwnLine(cur.text, cur.text.length, cur.text.length, md).text);
        return;
      }
      const from = el.selectionStart ?? el.value.length;
      const to = el.selectionEnd ?? from;
      const ins = insertOwnLine(el.value, from, to, md);
      el.focus();
      el.setSelectionRange(from, to);
      let native = false;
      try {
        native = document.execCommand("insertText", false, ins.insert);
      } catch {
        native = false;
      }
      if (!native) {
        onEdit(ins.text);
        requestAnimationFrame(() => el.setSelectionRange(ins.caret, ins.caret));
      }
      requestAnimationFrame(() => showCaret(el));
    });
  };

  const showCaret = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    const upto = el.value.slice(0, pos);
    setCaret({ ln: upto.split("\n").length, col: pos - upto.lastIndexOf("\n") });
  };
  const onCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => showCaret(e.currentTarget);

  /**
   * 고른 구간이 없을 때의 Ctrl+X 는 **커서가 놓인 줄 하나**를 잘라낸다(에디터의 관례).
   *
   * 잘라내기 자체는 그 줄을 선택해 두고 웹뷰에게 맡긴다 — 클립보드도 되돌리기(Ctrl+Z)도
   * 네이티브 그대로 남고, 값은 평소처럼 onChange 로 따라온다. 웹뷰가 거절하면 그때만
   * 클립보드 API 로 옮기고 본문은 직접 지운다. 클립보드에 못 올렸다고 줄까지 지우지
   * 않으려면 순서가 이대로여야 한다.
   */
  const onCut = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "x" && e.key !== "X") return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const el = e.currentTarget;
    const at = el.selectionStart ?? 0;
    if (at !== (el.selectionEnd ?? at)) return; // 구간을 골랐으면 평범한 잘라내기
    const cut = cutLine(el.value, at);
    if (!cut) return;
    e.preventDefault();
    el.setSelectionRange(cut.from, cut.to);
    let native = false;
    try {
      native = document.execCommand("cut");
    } catch {
      native = false;
    }
    if (native) return;
    void navigator.clipboard?.writeText(cut.text).catch(() => {});
    onEdit(cut.next);
    // 새 값이 그려진 뒤라야 캐럿이 붙는다 — 지금 놓으면 다시 그리면서 끝으로 밀린다.
    requestAnimationFrame(() => {
      el.setSelectionRange(cut.from, cut.from);
      showCaret(el);
    });
  };

  /**
   * 머리띠의 표 아이콘. 커서가 놓인 자리에 표 팝업을 연다 — 커서가 표 안이면 그 표를 고친다.
   *
   * 커서가 편집기에 없으면(다른 곳을 눌렀거나 아직 누르지 않았다) 넣을 자리가 없다. 아이콘은
   * 누를 때 초점을 가져가지 않으므로(`onMouseDown`) 편집기에 있던 커서는 그대로 남아 있다.
   * 넣을 수 없는 자리(코드 블록 · 프런트마터 · 줄 중간)는 `placeTable` 이 가린다.
   */
  const openTableFromEditor = () => {
    if (!tab) return;
    const el = textArea.current;
    if (!el || document.activeElement !== el) {
      s.toast("표를 넣을 자리를 먼저 클릭하세요", "텍스트 에디터에 커서를 둔 뒤 다시 누릅니다", TOAST.warn);
      return;
    }
    const from = el.selectionStart ?? 0;
    const to = el.selectionEnd ?? from;
    const p = placeTable(el.value, from, to, !editingBodyOnly);
    if (p.kind === "deny") {
      s.toast(p.title, p.sub, TOAST.warn);
      return;
    }
    setTableEd({
      seq: ++tableSeq,
      kind: "text",
      path: tab.path,
      model: p.model,
      edit: p.kind === "edit",
      from: p.from,
      to: p.to,
      snap: el.value,
      sel: [from, to],
      scroll: el.scrollTop,
    });
  };

  /** 뷰어에서 표를 우클릭해 [표 편집] 을 골랐다. 블록의 줄은 본문 기준이라 본문이 시작하는 줄을 더한다. */
  const openTableFromView = (b: Block) => {
    if (!tab || !doc) return;
    const start = fmSplit.bodyLine + b.line;
    const end = fmSplit.bodyLine + b.end;
    const lines = doc.text.split("\n").slice(start, end);
    const model = parseTableSource(lines);
    if (!model) {
      s.toast("이 표는 고칠 수 없습니다", "표 안에 다른 표가 들어 있습니다", TOAST.warn);
      return;
    }
    setTableEd({ seq: ++tableSeq, kind: "view", path: tab.path, model, edit: true, start, end, lines });
  };

  /**
   * 표 팝업을 확정했다. 텍스트 에디터면 붙여넣기 · Ctrl+X 와 같이 `insertText` 로 웹뷰에 맡겨
   * 되돌리기(Ctrl+Z)가 네이티브 그대로 남게 하고, 뷰어면 그 줄들을 바꿔 곧바로 저장한다.
   * 연 뒤에 글이 바뀌었으면(창에 돌아와 다시 읽었다) 엉뚱한 자리에 쓰지 않고 알린다.
   */
  const commitTable = (ed: TableEdit, model: TableModel) => {
    setTableEd(null);
    const md = tableToMarkdown(model);
    const st = useStore.getState();
    if (ed.kind === "view") {
      void st.replaceTable(ed.path, ed.start, ed.end, ed.lines, md).then((ok) => {
        if (!ok) useStore.getState().toast("그사이 문서가 바뀌어 표를 고치지 않았습니다", "", TOAST.warn);
      });
      return;
    }
    const el = textArea.current;
    if (!el || !el.isConnected || st.ui.activeTab !== `text|${ed.path}` || el.value !== ed.snap) {
      st.toast("그사이 문서가 바뀌어 표를 넣지 않았습니다", "", TOAST.warn);
      return;
    }
    const value = el.value;
    const r = ed.edit
      ? {
          from: ed.from,
          to: ed.to,
          insert: md,
          caret: ed.from + md.length,
          text: value.slice(0, ed.from) + md + value.slice(ed.to),
        }
      : spliceBlock(value, ed.from, ed.to, md);
    el.focus({ preventScroll: true });
    el.setSelectionRange(r.from, r.to);
    let native = false;
    try {
      native = document.execCommand("insertText", false, r.insert);
    } catch {
      native = false;
    }
    if (!native) onEdit(r.text);
    else el.setSelectionRange(r.caret, r.caret);
    // 새 값이 그려진 뒤라야 캐럿이 붙는다(직접 고친 길) — 지금 놓으면 다시 그리면서 끝으로 밀린다.
    requestAnimationFrame(() => {
      el.setSelectionRange(r.caret, r.caret);
      showCaret(el);
    });
  };

  /** 취소 — 텍스트 에디터면 커서와 스크롤을 연 순간 그대로 돌려놓는다. */
  const cancelTable = (ed: TableEdit) => {
    setTableEd(null);
    if (ed.kind !== "text") return;
    const el = textArea.current;
    if (!el || !el.isConnected || useStore.getState().ui.activeTab !== `text|${ed.path}`) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(ed.sel[0], ed.sel[1]);
    el.scrollTop = ed.scroll;
  };

  /**
   * 뷰어에서 체크를 눌렀다 — 파일에 곧바로 쓰인다(`toggleTask`). 쓰기가 끝나면 머리띠에 "완료 · 파일에
   * 저장됨" 이 잠깐 뜬다. 실패하면 뜨지 않고, 머리띠의 [다시 시도] 와 탭의 빨간 점이 대신 말한다.
   */
  const onToggleTask = (line: number, checked: boolean) => {
    if (!tab) return;
    const path = tab.path;
    const n0 = useStore.getState().docSave[path]?.n ?? 0;
    void s.toggleTask(path, fmSplit.bodyLine + line).then(() => {
      if ((useStore.getState().docSave[path]?.n ?? 0) <= n0) return;
      setTaskNote((p) => ({
        n: (p?.n ?? 0) + 1,
        path,
        text: checked ? "완료 · 파일에 저장됨" : "완료 해제 · 파일에 저장됨",
      }));
      window.clearTimeout(noteTimer.current);
      // `cf-chip` 이 다 사라진 뒤 자리를 비운다.
      noteTimer.current = window.setTimeout(() => setTaskNote(null), 3100);
    });
  };

  /** 텍스트 → 뷰어. 저장을 기다린다 — 저장이 실패하면 텍스트에 머문다(`setTabMode`). */
  const toViewer = () => {
    if (!tab || tab.mode !== "text" || !viewer || switching) return;
    const path = tab.path;
    setSwitching(path);
    void s.setTabMode(path, "text", viewer).finally(() => setSwitching((p) => (p === path ? null : p)));
  };
  const toText = () => {
    if (!tab || tab.mode === "text") return;
    void s.setTabMode(tab.path, tab.mode, "text");
  };

  const paneHint = !tab
    ? ""
    : tab.mode === "md"
      ? "체크박스 클릭 · 이미지 붙여넣기(Ctrl+V) · 표 우클릭 편집"
      : tab.mode === "html"
        ? scripts
          ? "스크립트 실행 · 앱 창과 격리됨"
          : "읽기 전용 · 스크립트와 외부 리소스 차단"
        : tab.mode === "text"
          ? // 언어 · 인코딩은 아래 상태줄이 이미 말한다. 여기서 보탤 것이 있는 파일은
            // 뷰어가 있는 파일뿐이다 — 지금 보고 있는 것이 렌더 결과가 아니라 원본이다.
            viewer
            ? "원본 텍스트"
            : ""
          : "";

  return (
    <div
      className="cf-mv"
      style={{
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        borderBottom: "1px solid #e6e2da",
        flex: "0 0 auto",
        height: s.noteMin ? `calc(100% - ${NOTE_HEAD}px)` : `${Math.round(ui.rowPct * 10) / 10}%`,
        transition: split.anim ? `height ${NOTE_MS}ms ${EASE_OUT}` : undefined,
      }}
    >
      <TabStrip />

      {!tab && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: "#fdfcfa",
          }}
        >
          <div style={{ fontSize: 13, color: "#8a857c" }}>열려 있는 파일이 없습니다</div>
          <div
            style={{ fontSize: 11.5, color: "#6a665e", textAlign: "center", lineHeight: 1.7 }}
          >
            오른쪽 탐색기에서 파일을 더블클릭하거나,
            <br />
            우클릭해 열기 방식을 선택하세요.
          </div>
        </div>
      )}

      {tab && isBinary && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            background: "#fdfcfa",
            padding: 20,
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 6,
              border: "1px solid #e4e0d8",
              background: "#f2efe9",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11,
              color: "#6a665e",
            }}
          >
            {ext.toUpperCase()}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{basename(tab.path)}</div>
          <div
            style={{ fontSize: 11.5, color: "#6a665e", textAlign: "center", lineHeight: 1.7 }}
          >
            텍스트로 표시할 수 없는 형식입니다 · {meta?.size ?? ""}
            <br />
            연결 프로그램으로 열어 확인하세요.
          </div>
          <Box
            onClick={() => s.openWith(tab.path)}
            style={{
              height: 27,
              padding: "0 13px",
              display: "flex",
              alignItems: "center",
              borderRadius: 5,
              border: "1px solid #cddcf8",
              background: "#eef3fd",
              color: "#2f5cbb",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
            hover={{ background: "#e2ebfb" }}
          >
            연결 프로그램으로 열기
          </Box>
        </div>
      )}

      {tab && !isBinary && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#fff" }}>
          <PaneHeader
            label={PANE_LABEL[tab.mode]}
            hint={paneHint}
            roll={pane.fade}
            note={
              tab.mode === "text" ? undefined : (
                <>
                  {tab.mode === "md" && taskNote && taskNote.path === tab.path && (
                    <span
                      key={taskNote.n}
                      className="cf-chip"
                      role="status"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        fontSize: 11,
                        color: "#256b47",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <CheckMark size={10} pop={false} />
                      {taskNote.text}
                    </span>
                  )}
                  <SaveFailNote path={tab.path} />
                </>
              )
            }
            switcher={
              tab.mode !== "text" || viewer ? (
                <ViewSwitch
                  viewing={tab.mode !== "text"}
                  pending={switching === tab.path}
                  color={MODE_BADGE[viewer ?? tab.mode].bar}
                  dirty={dirty}
                  onViewer={toViewer}
                  onText={toText}
                />
              ) : undefined
            }
          >
            {tab.mode === "html" && (
              <Box
                onClick={() => setNoScript((m) => ({ ...m, [tab.path]: scripts }))}
                title={
                  scripts
                    ? "문서 안의 스크립트를 멈추고 전부 차단된 화면으로 봅니다"
                    : "문서 안의 스크립트를 실행합니다"
                }
                style={{
                  fontSize: 11,
                  color: scripts ? "#8f5d17" : "#6a665e",
                  cursor: "pointer",
                  marginRight: 4,
                  whiteSpace: "nowrap",
                }}
                hover={{ textDecoration: "underline" }}
              >
                {scripts ? "스크립트 끄기" : "스크립트 켜기"}
              </Box>
            )}
            {tab.mode === "text" && viewer === "md" && (
              <Box
                // 누르는 순간 편집기의 커서를 뺏지 않는다 — 그 커서가 표를 넣을 자리다.
                onMouseDown={(e) => e.preventDefault()}
                onClick={openTableFromEditor}
                role="button"
                aria-label="표 넣기"
                title="표 넣기 — 커서 자리에 표를 만듭니다 (커서가 표 안이면 그 표를 고칩니다)"
                style={{
                  display: "flex",
                  alignItems: "center",
                  height: 19,
                  padding: "0 5px",
                  marginRight: 2,
                  borderRadius: 3,
                  color: "#6a665e",
                  cursor: "pointer",
                }}
                hover={{ background: "#ece9e3", color: "#2f5cbb" }}
              >
                <TableIcon />
              </Box>
            )}
            {tab.mode === "bstorm" && <BrainstormViewTabs path={tab.path} />}
          </PaneHeader>

          {/* 모드를 바꾸면 본문만 새로 들어온다(`pane`). 같은 모드의 다른 탭으로 옮길 때는 그대로 둔다. */}
          <div
            key={pane.n}
            className={pane.fade ? "cf-fade" : undefined}
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
          >
            {tab.mode === "md" && (
              // 블록의 `line` 은 **본문** 기준이라 본문이 시작하는 줄을 더해야 문서의 줄이
              // 된다. 뷰어가 문서 전체를 모르는 채로 두는 것이 요점이다 — 프런트마터를
              // 건너뛴 것은 여기이므로, 되돌려 맞추는 것도 여기서 한다.
              <MarkdownView
                blocks={blocks}
                onToggle={onToggleTask}
                imageUrl={imageUrl}
                onImageWidth={(line, idx, w) =>
                  void s.setImageWidth(tab.path, fmSplit.bodyLine + line, idx, w)
                }
                onPasteImage={(img) => void s.appendImage(tab.path, img)}
                reveal={revealHere ? Math.max(0, revealHere.line - fmSplit.bodyLine) : undefined}
                onRevealed={() => useAssist.getState().setReveal(null)}
                onEditTable={openTableFromView}
              />
            )}

            {tab.mode === "html" && (
              /*
                두 모드가 있고, 갈리는 지점은 **문서를 어디서 읽는가** 다.

                기본(scripts)은 asset: 로 파일을 직접 읽는다. 별도 출처의 평범한 문서라
                앱 창의 CSP 를 물려받지 않으므로 안의 <script> 가 실제로 돌고, 옆에 있는
                CSS · 이미지도 상대 경로 그대로 따라온다. 대신 sandbox 는 `allow-scripts`
                하나뿐이다 — allow-same-origin 을 함께 주면 샌드박스가 무의미해지므로 절대
                같이 쓰지 않는다. 불투명 출처라 앱 창 · IPC · 로컬 저장소에 닿지 못한다.

                [스크립트 끄기] 는 예전 방식인 srcdoc 으로 되돌아간다. sandbox 에 아무
                토큰도 없고 부모 CSP 까지 물려받아 스크립트 · 외부 리소스가 전부 막히며,
                디스크가 아니라 편집 중인 버퍼를 그린다.
              */
              <iframe
                key={scripts ? htmlSrc : `srcdoc|${tab.path}`}
                title="HTML 미리보기"
                sandbox={scripts ? "allow-scripts" : ""}
                src={scripts ? htmlSrc : undefined}
                srcDoc={scripts ? undefined : body}
                style={{ flex: 1, minHeight: 0, width: "100%", border: 0, background: "#fff" }}
              />
            )}

            {tab.mode === "text" && (
              <>
                {editingBodyOnly && (
                  <div
                    style={{
                      flex: "0 0 auto",
                      padding: "8px 12px",
                      background: "#faf9f6",
                      borderBottom: "1px dashed #e4e0d8",
                      fontFamily: "'Roboto Mono',monospace",
                      fontSize: 11.5,
                      lineHeight: 1.65,
                      color: "#6a665e",
                    }}
                  >
                    <div style={{ color: "#b5afa2" }}>---</div>
                    <div>
                      <span style={{ color: "#2f6f80" }}>id:</span> {fmValue(fm, "id")}
                    </div>
                    <div>
                      <span style={{ color: "#2f6f80" }}>status:</span>{" "}
                      <span style={{ color: statusOf(fmValue(fm, "status")).dot }}>
                        {fmValue(fm, "status")}
                      </span>{" "}
                      <span style={{ color: "#b5afa2" }}>&nbsp;tags:</span> {fmValue(fm, "tags")}
                    </div>
                    <div>
                      <span style={{ color: "#2f6f80" }}>updated:</span> {fmValue(fm, "updated")}{" "}
                      <span style={{ color: "#b5afa2" }}>&nbsp;template_ref:</span>{" "}
                      <span style={{ color: "#3a6fd8" }}>{fmValue(fm, "template_ref") || "null"}</span>
                    </div>
                    <div style={{ color: "#b5afa2" }}>---</div>
                  </div>
                )}
                <textarea
                  ref={textArea}
                  value={editorValue}
                  onChange={(e) => onEdit(e.target.value)}
                  onKeyDown={onCut}
                  onPaste={onPaste}
                  onKeyUp={onCaret}
                  onClick={onCaret}
                  spellCheck={false}
                  aria-label="본문 편집"
                  style={{
                    flex: 1,
                    minHeight: 0,
                    width: "100%",
                    border: 0,
                    outline: "none",
                    padding: "10px 12px",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 13,
                    lineHeight: 1.72,
                    color: "#2c2a26",
                    background: "#fff",
                  }}
                />
                <StatusBar
                  key={tab.path}
                  path={tab.path}
                  caret={caret}
                  lang={LANG[ext] ?? "Plain Text"}
                  title={task ? `${task.relFolder}${tab.path}` : ""}
                />
              </>
            )}

            {tab.mode === "bstorm" && <BrainstormPane path={tab.path} />}
          </div>
        </div>
      )}

      {tableEd && (
        <TableModal
          key={tableEd.seq}
          initial={tableEd.model}
          editing={tableEd.edit}
          onConfirm={(m) => commitTable(tableEd, m)}
          onCancel={() => cancelTable(tableEd)}
        />
      )}
    </div>
  );
}
