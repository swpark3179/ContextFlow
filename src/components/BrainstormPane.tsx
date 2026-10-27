/**
 * `.bs.md` 의 브레인스토밍 화면. 캔버스 · 개요 · 결정 로그 세 가지 보기가 같은 문서를 본다.
 *
 * 문서는 마크다운 텍스트 그대로 `ui.docs[path]` 버퍼에 들어 있다. 노드를 고치면 트리를
 * 다시 직렬화해 `editDoc` 에 넘기므로, 900ms 자동 저장 · 미저장 점 · Ctrl+S · 스냅샷
 * 보존이 텍스트 에디터와 똑같이 따라온다. 저장 경로를 새로 만들지 않는다.
 *
 * 줌 · 팬 · 접힘 · 선택 · 지금 보는 화면은 문서가 아니라 **보기**라서 `.bs.md` 가 아니라
 * `.context_snapshot.json`(`ui.bsView`)에 남는다.
 *
 * 움직임: 노드에는 id 가 없지만(`bstorm.ts`) 캔버스는 그리는 동안만 쓰는 id 를 붙인다
 * (`carryIds`). 그래서 배치가 바뀌면 같은 카드가 옛 자리에서 새 자리로 미끄러지고, 새로 생긴
 * 생각은 부모에서 자라나며, 지운 생각은 남은 조상 안으로 접혀 사라진다.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Box, EASE_IN, EASE_OUT, reducedMotion } from "../lib/ui";
import { inputFocus, inputStyle, labelStyle } from "../modals/Modal";
import { BS_BRANCH, BS_EVIDENCE, BS_STATUS, GREEN, TEXT, isImagePath } from "../lib/design";
import { joinPath, nowStamp } from "../lib/format";
import { useStore, type BsView, type BsViewKind } from "../store/useStore";
import { DecisionLog, Outline } from "./BrainstormViews";
import { DraftInput, DraftTextArea, StatusBadge, useChangedOnce } from "./BrainstormBits";
import {
  addChildAt,
  bstormName,
  carryIds,
  centerOn,
  clampZoom,
  EVIDENCE_KINDS,
  fitCamera,
  foldedPlaced,
  layout,
  mapAt,
  nodeAt,
  parentPath,
  parseBstorm,
  removeAt,
  revealRect,
  serializeBstorm,
  setFm,
  STATUS_MARK,
  STATUS_ORDER,
  unfoldTo,
  walkNodes,
  zoomAround,
  type BsNode,
  type Camera,
  type EvidenceKind,
  type Placed,
} from "../lib/bstorm";

const PAD = 28;
const INSPECTOR_W = 300;

/** 배치가 바뀔 때 카드 · 가지선이 옮겨 가는 시간. 둘이 같아야 선이 카드를 놓치지 않는다. */
const GLIDE_MS = 260;
/** 새 생각이 부모에서 자라나는 시간. 지운 생각이 접혀 사라지는 것은 그 0.7배다. */
const BORN_MS = 300;
const EXIT_MS = 200;
/** 보기 전환 · 숨는 카드의 투명도. */
const FADE_MS = 160;
/** 줌 · 맞춤 · 새 생각 따라가기(m-screen)와, 다른 보기에서 노드로 건너가기(m-travel). */
const CAM_MS = 280;
const TRAVEL_MS = 460;
/**
 * 카메라만 천천히 출발한다(디자인 보드 `Brainstorm` 의 `.cam`). 화면 전체가 첫 프레임에 튀어
 * 나가면 무엇이 움직였는지 놓친다.
 */
const CAM_EASE = "cubic-bezier(.3,0,.2,1)";
const ZOOM_STEP = 0.15;
/** [삭제] 를 한 번 누른 뒤 두 번째 누름을 기다리는 시간. 지나면 저절로 풀린다. */
const DISARM_MS = 3000;
/** 위치 알림 고리(`cf-pulse-ring`)가 카메라가 거의 다 온 뒤에 돌게 한다. */
const PULSE_DELAY_MS = 420;

const DEFAULT_VIEW: BsView = {
  view: "canvas",
  zoom: 1,
  panX: PAD,
  panY: PAD,
  sel: "",
  collapsed: {},
};

/** 되돌리기 스택의 깊이. 설계와 같은 값이다. */
const UNDO_MAX = 40;

/** 빈 근거 칸이 스스로 무엇을 적는 자리인지 말한다. */
const EVIDENCE_HINT: Record<EvidenceKind, string> = {
  근거: "무엇이 이 생각을 뒷받침하나",
  리스크: "무엇이 어긋날 수 있나",
  질문: "무엇을 더 알아야 하나",
};

function branchColor(path: string): string {
  const parts = path.split(".");
  if (parts.length < 2) return "#b5afa2";
  return BS_BRANCH[Number(parts[1]) % BS_BRANCH.length];
}

/**
 * 보기 상태를 읽고 쓴다. 이 기능이 생기기 전에 쓰인 스냅샷에는 없는 필드가 있으므로
 * 언제나 기본값 위에 덮어쓴다 — 저장된 값 하나가 빠졌다고 화면이 깨지면 안 된다.
 *
 * 쓸 때는 렌더 때 본 값이 아니라 스토어의 **지금** 값 위에 덮어쓴다. 휠 · 끌기는 렌더 사이에
 * 여러 번 오고, 한 동작 안에서 두 번 쓰면 앞의 것이 지워졌다.
 */
function readBsView(path: string): BsView {
  return { ...DEFAULT_VIEW, ...(useStore.getState().ui.bsView?.[path] ?? {}) };
}

function writeBsView(path: string, patch: Partial<BsView>): void {
  const st = useStore.getState();
  const views = st.ui.bsView ?? {};
  st.setUi({ bsView: { ...views, [path]: { ...DEFAULT_VIEW, ...(views[path] ?? {}), ...patch } } });
}

function useBsView(path: string) {
  const s = useStore();
  const view: BsView = { ...DEFAULT_VIEW, ...(s.ui.bsView?.[path] ?? {}) };
  const setView = (patch: Partial<BsView>) => writeBsView(path, patch);
  return { s, view, setView };
}

const TABS: [BsViewKind, string][] = [
  ["canvas", "캔버스"],
  ["outline", "개요"],
  ["decision", "결정 로그"],
];
const TAB_W = 66;

/**
 * 머리띠 안에 들어가는 보기 전환. HTML 뷰어의 [스크립트 끄기] 스위치와 같은 자리다.
 * 흰 손잡이가 고른 칸으로 미끄러진다 — 세 칸이 한 덩어리의 "보기"라는 것을 모양이 말한다.
 */
export function BrainstormViewTabs({ path }: { path: string }) {
  const { view, setView } = useBsView(path);
  const at = Math.max(0, TABS.findIndex(([k]) => k === view.view));
  return (
    <div
      role="tablist"
      aria-label="보기"
      style={{
        position: "relative",
        display: "flex",
        height: 21,
        padding: 1,
        borderRadius: 5,
        background: "#ebe7df",
      }}
    >
      <div
        aria-hidden
        className="cf-mv"
        style={{
          position: "absolute",
          top: 1,
          left: 1,
          width: TAB_W,
          height: 19,
          borderRadius: 4,
          background: "#fff",
          boxShadow: "0 1px 1px rgba(35,33,30,.12)",
          transform: `translateX(${at * TAB_W}px)`,
          transition: "transform var(--m-base) var(--e-out)",
        }}
      />
      {TABS.map(([k, label]) => {
        const on = view.view === k;
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => setView({ view: k })}
            style={{
              position: "relative",
              width: TAB_W,
              height: 19,
              padding: 0,
              border: 0,
              borderRadius: 4,
              background: "transparent",
              fontSize: 11.5,
              fontWeight: 600,
              color: on ? TEXT.ink : TEXT.sub,
              cursor: "pointer",
              transition: "color var(--m-quick)",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** 캔버스에 그리는 노드 하나. 접힌 가지 안의 것도 투명하게 남겨 둔다(`hidden`). */
interface Item extends Placed {
  /** 그리는 동안만 쓰는 id(`carryIds`). React key 이자 움직임의 짝이다. */
  id: string;
  hidden: boolean;
  /** 숨은 노드가 모여 있는 접힌 조상의 경로. 보이는 노드는 빈 문자열. */
  anchor: string;
}

/** 지운 생각의 잔상 — 남은 조상 자리로 접혀 사라진다. */
interface Ghost {
  it: Item;
  to: { x: number; y: number };
  edge: string;
  look: EdgeLook | null;
}

interface EdgeLook {
  stroke: string;
  width: number;
  dash: string | undefined;
  opacity: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 부모 오른쪽 가운데에서 자식 왼쪽 가운데로 가는 곡선. 숨은 자식의 선은 접힌 조상의 오른쪽
 * 끝 한 점으로 줄어든다 — 명령이 늘 `M … C …` 하나라서 CSS `d` 전환이 두 모양 사이를 잇는다.
 */
function edgePath(from: Placed, to: Placed, anchor?: Placed): string {
  let x1 = from.x + from.w;
  let y1 = from.y + from.h / 2;
  let x2 = to.x;
  let y2 = to.y + to.h / 2;
  if (anchor) {
    x1 = x2 = anchor.x + anchor.w;
    y1 = y2 = anchor.y + anchor.h / 2;
  }
  return `M ${r2(x1)},${r2(y1)} C ${r2(x1 + 46)},${r2(y1)} ${r2(x2 - 46)},${r2(y2)} ${r2(x2)},${r2(y2)}`;
}

function edgeLook(it: Placed, from: Placed): EdgeLook {
  const dropped = it.node.status === "dropped";
  const adopted = it.node.status === "adopted" && from.node.status === "adopted";
  return {
    stroke: dropped ? "#d5d0c6" : adopted ? GREEN : branchColor(it.path),
    width: adopted ? 2.2 : 1.3,
    dash: dropped ? "4 4" : undefined,
    opacity: dropped ? 0.7 : 1,
  };
}

/**
 * 가지선의 전환. `d` 는 Chromium(WebView2)에서 CSS 속성으로 전환된다 — 받지 않는 엔진은
 * `d` 속성(attribute)으로 그려서 선이 곧바로 새 자리에 선다.
 */
const EDGE_TRANSITION = `d ${GLIDE_MS}ms ${EASE_OUT}, stroke 200ms linear, stroke-width 200ms linear, opacity ${FADE_MS}ms linear`;

function EdgePathEl({
  d,
  look,
  hidden,
  dataEdge,
  dataGhost,
}: {
  d: string;
  look: EdgeLook;
  hidden: boolean;
  dataEdge?: string;
  dataGhost?: string;
}) {
  return (
    <path
      data-bs-edge={dataEdge}
      data-bs-ghost-edge={dataGhost}
      d={d}
      className="cf-mv"
      style={{
        d: `path("${d}")`,
        fill: "none",
        stroke: look.stroke,
        strokeWidth: look.width,
        strokeDasharray: look.dash,
        opacity: hidden ? 0 : look.opacity,
        transition: EDGE_TRANSITION,
      }}
    />
  );
}

interface CardProps {
  it: Item;
  sel: boolean;
  folded: boolean;
  editing: boolean;
  /** 위치 알림 고리를 다시 돌리는 key. 0 이면 없다. */
  pulse: number;
  ghost?: boolean;
  srcOf: (rel: string) => string;
  onPick?: () => void;
  onAdd?: () => void;
  onFold?: () => void;
  onEdit?: () => void;
  onTitle?: (v: string) => void;
  onEditKey?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  onEditEnd?: () => void;
}

/**
 * 캔버스의 카드. 바깥 상자는 자리(`transform`)만, 안쪽 상자는 태어나는 움직임만, 카드는 색만
 * 맡는다 — 셋을 한 요소에 몰면 상태 색 전환과 자리 옮기기가 서로의 `transition` 을 덮는다.
 */
function NodeCard({
  it,
  sel: on,
  folded,
  editing,
  pulse,
  ghost = false,
  srcOf,
  onPick,
  onAdd,
  onFold,
  onEdit,
  onTitle,
  onEditKey,
  onEditEnd,
}: CardProps) {
  const n = it.node;
  const st = BS_STATUS[n.status];
  const dropped = n.status === "dropped";
  /**
   * 정해진 것과 아직인 것. 탐색중은 흰 카드에 실선 한 겹으로 조용히 두고,
   * 나머지 넷은 배지 · 바탕 · 테두리 세 가지를 한꺼번에 바꾼다 — 색 하나만
   * 다르게 하면 축소한 캔버스에서 채택과 유력이 갈리지 않는다.
   */
  const decided = n.status !== "explore";
  const kids = n.children.length;
  const pill = folded ? `▸${kids}` : "▾";
  const statusMoved = useChangedOnce(n.status);
  const pillMoved = useChangedOnce(pill);
  const away = it.hidden || ghost;
  const frame = on ? "#3a6fd8" : st.line;

  const inputRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    // 캔버스는 overflow:hidden 이라도 스크롤된다 — 그냥 focus() 하면 카드를 보여 주려고
    // 상자째 밀려서 카메라와 어긋난다.
    el?.focus({ preventScroll: true });
    el?.select();
  }, [editing]);

  return (
    <div
      data-bs-node={ghost ? undefined : it.id}
      data-bs-ghost={ghost ? it.id : undefined}
      aria-hidden={away || undefined}
      className="cf-mv"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: it.w,
        transform: `translate(${r2(it.x)}px, ${r2(it.y)}px) scale(${it.hidden ? 0.6 : 1})`,
        transformOrigin: "0 50%",
        opacity: it.hidden ? 0 : 1,
        pointerEvents: away ? "none" : undefined,
        // 숨는 카드는 조상 카드 밑으로 들어간다. 위로 지나가면 "접혔다"가 아니라 "겹쳤다"로 보인다.
        zIndex: away ? 0 : on ? 2 : 1,
        transition: `transform ${GLIDE_MS}ms ${EASE_OUT}, opacity ${FADE_MS}ms linear`,
      }}
    >
      <div data-bs-born={ghost ? undefined : it.id} style={{ transformOrigin: "0 50%" }}>
        <div
          onMouseDown={
            onPick &&
            ((e) => {
              e.stopPropagation();
              onPick();
            })
          }
          style={{
            position: "relative",
            minHeight: it.h,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "7px 9px",
            borderRadius: 7,
            background: st.card,
            // 테두리는 낱낱의 속성으로 적는다. `border` 와 `borderLeft` 를 섞으면 고를 때 바뀐
            // `border` 가 왼쪽 띠까지 덮어써서, 한 번 고른 카드는 상태 띠를 잃었다.
            borderStyle: st.dash ? "dashed dashed dashed solid" : "solid",
            borderWidth: `${decided ? 1.5 : 1}px ${decided ? 1.5 : 1}px ${decided ? 1.5 : 1}px 4px`,
            // 왼쪽 굵은 띠는 탐색중일 때만 가지 색이다. 상태가 정해지면 그 자리를
            // 상태에 내준다 — 어느 가지에서 나왔는지는 잇는 선이 이미 말해 준다.
            borderColor: `${frame} ${frame} ${frame} ${decided ? st.dot : branchColor(it.path)}`,
            boxShadow: on ? "0 0 0 2px #dce7fb, 0 4px 14px rgba(35,33,30,.12)" : "0 1px 3px rgba(35,33,30,.08)",
            opacity: dropped ? 0.72 : 1,
            cursor: "pointer",
            transition:
              "background-color var(--m-base), border-color var(--m-base), box-shadow 160ms, opacity var(--m-base)",
          }}
        >
          {pulse > 0 && (
            <span
              key={pulse}
              aria-hidden
              className="cf-pulse-ring"
              style={{
                position: "absolute",
                top: -1.5,
                right: -1.5,
                bottom: -1.5,
                left: -4,
                borderRadius: 7,
                pointerEvents: "none",
                animationDelay: `${PULSE_DELAY_MS}ms`,
              }}
            />
          )}

          {decided && (
            <div
              key={n.status}
              className={statusMoved ? "cf-enter-down" : undefined}
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
              <StatusBadge status={n.status} />
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {!decided && (
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flex: "0 0 7px",
                  background: st.dot,
                }}
              />
            )}
            {editing ? (
              <DraftInput
                ref={inputRef}
                value={n.title}
                onCommit={(v) => onTitle?.(v)}
                onKeyDown={onEditKey}
                onBlur={onEditEnd}
                placeholder="한 문장으로"
                aria-label="생각 제목"
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 21,
                  border: "1px solid #3a6fd8",
                  borderRadius: 4,
                  padding: "0 5px",
                  fontSize: 12.5,
                  color: TEXT.ink,
                  background: "#fff",
                  outline: "none",
                  boxShadow: "0 0 0 2px #e6eefc",
                }}
              />
            ) : (
              <span
                onDoubleClick={onEdit}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  lineHeight: 1.36,
                  fontWeight: n.status === "adopted" ? 700 : 500,
                  color: dropped ? TEXT.hint : TEXT.ink,
                  textDecoration: dropped ? "line-through" : "none",
                  overflowWrap: "anywhere",
                }}
              >
                {n.title || <span style={{ color: TEXT.hint }}>이름 없는 생각</span>}
              </span>
            )}
            <Box
              role="button"
              aria-label="하위 생각 추가"
              title="하위 생각 (Tab)"
              onMouseDown={
                onAdd &&
                ((e) => {
                  // 기본 동작(캔버스로 포커스)을 막는다 — 막지 않으면 방금 열린 제목 칸의
                  // 커서를 곧바로 빼앗는다.
                  e.preventDefault();
                  e.stopPropagation();
                  onAdd();
                })
              }
              style={{
                flex: "0 0 auto",
                fontSize: 12,
                lineHeight: "16px",
                width: 16,
                textAlign: "center",
                borderRadius: 3,
                color: TEXT.hint,
                cursor: "pointer",
              }}
              hover={{ background: "#eef3fd", color: "#2f5cbb" }}
            >
              ＋
            </Box>
          </div>

          {!!n.images.length && (
            <div style={{ display: "flex", gap: 4, overflow: "hidden" }}>
              {n.images.slice(0, 3).map((rel) => (
                <img
                  key={rel}
                  src={srcOf(rel)}
                  alt=""
                  style={{
                    width: 52,
                    height: 34,
                    objectFit: "cover",
                    borderRadius: 4,
                    border: "1px solid #e6e2da",
                    background: "repeating-linear-gradient(45deg,#f3f0ea 0 5px,#eae6de 5px 10px)",
                  }}
                />
              ))}
              {n.images.length > 3 && (
                <span
                  style={{
                    alignSelf: "center",
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 9.5,
                    color: TEXT.sub,
                  }}
                >
                  +{n.images.length - 3}
                </span>
              )}
            </div>
          )}

          {!!n.detail.trim() && (
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                color: TEXT.sub,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {n.detail.replace(/\n/g, " ")}
            </div>
          )}

          {(n.evidence.length > 0 || !!n.reason.trim()) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
              {n.evidence.map((e, i) => {
                // 아직 비어 있는 칸은 점선으로 둔다. 채운 것과 같아 보이면
                // 카드가 "근거가 있다"고 거짓말을 한다.
                const empty = !e.text.trim();
                return (
                  <span
                    key={`e${i}`}
                    style={{
                      fontSize: 9,
                      fontWeight: 600,
                      padding: "1px 4px",
                      borderRadius: 3,
                      color: BS_EVIDENCE[e.kind].fg,
                      background: empty ? "transparent" : BS_EVIDENCE[e.kind].bg,
                      border: `1px ${empty ? "dashed" : "solid"} ${BS_EVIDENCE[e.kind].bd}`,
                      opacity: empty ? 0.75 : 1,
                    }}
                  >
                    {e.kind}
                  </span>
                );
              })}
              {!!n.reason.trim() && <span style={{ fontSize: 9.5, color: TEXT.sub }}>폐기 이유 있음</span>}
            </div>
          )}

          {kids > 0 && (
            <Box
              key={pill}
              role="button"
              aria-expanded={!folded}
              aria-label={folded ? `하위 ${kids}개 펼치기` : "하위 생각 접기"}
              title={folded ? `하위 ${kids}개 펼치기` : "하위 생각 접기"}
              // 개수가 바뀌면 한 번 튄다 — 접은 가지에 무엇이 몇 개 들어갔는지 눈이 따라간다.
              className={pillMoved ? "cf-bump" : undefined}
              onMouseDown={
                onFold &&
                ((e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onFold();
                })
              }
              style={{
                position: "absolute",
                right: -11,
                top: "50%",
                marginTop: -8,
                height: 16,
                minWidth: 16,
                padding: "0 4px",
                borderRadius: 8,
                borderWidth: 1,
                borderStyle: "solid",
                borderColor: "#ddd8cf",
                background: "#fff",
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 9,
                lineHeight: "14px",
                textAlign: "center",
                color: TEXT.sub,
                cursor: "pointer",
              }}
              hover={{ borderColor: "#3a6fd8", color: "#2f5cbb" }}
            >
              {pill}
            </Box>
          )}
        </div>
      </div>
    </div>
  );
}

const paneStyle = (on: boolean, enter: boolean): CSSProperties => ({
  position: "absolute",
  inset: 0,
  display: "flex",
  opacity: on ? 1 : 0,
  pointerEvents: on ? undefined : "none",
  transition: `opacity ${FADE_MS}ms linear`,
  animation: enter ? `cfFadeIn ${FADE_MS}ms linear backwards` : undefined,
});

/** 직전에 그린 캔버스. 다음 렌더와 견주어 무엇이 생기고 무엇이 사라졌는지 안다. */
interface Shot {
  path: string;
  roots: BsNode[];
  ids: Map<string, string>;
  items: Item[];
  at: Map<string, Item>;
}

export default function BrainstormPane({ path }: { path: string }) {
  const { s, view, setView } = useBsView(path);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const fittedRef = useRef("");
  /** 삭제는 두 번 눌러야 한다. 되돌리기가 있어도 한 번의 실수는 막는 편이 낫다. */
  const [armedDelete, setArmedDelete] = useState("");
  const [picking, setPicking] = useState(false);
  /** 방금 만든 근거 칸("<노드경로>|<번째>"). 만들자마자 커서가 거기 들어가야 한다. */
  const [freshEv, setFreshEv] = useState("");
  const [undo, setUndo] = useState<string[]>([]);
  /** 캔버스 카드 위에서 제목을 고치는 노드의 경로. */
  const [editing, setEditing] = useState("");
  /** 개요에서 만든 생각 — 캔버스가 안 보이므로 인스펙터의 제목 칸이 커서를 받는다. */
  const titleFocus = useRef("");
  /** 카메라 전환 시간. 끌기 · 휠은 0 이다 — 손을 따라가는 움직임에 지연을 얹으면 미끄러진다. */
  const [camMs, setCamMs] = useState(0);
  const [panning, setPanning] = useState(false);
  const [pulse, setPulse] = useState<{ path: string; n: number } | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const ghostRun = useRef(new Set<string>());
  const focusCanvas = useRef(false);
  /** 지금 그려 둔 보기. 나가는 보기는 흐려지는 동안만 남는다. */
  const [shownViews, setShownViews] = useState<BsViewKind[]>([view.view]);

  const text = s.ui.docs[path]?.text ?? "";
  const doc = useMemo(() => parseBstorm(text), [text]);
  const lay = useMemo(() => layout(doc.roots, view.collapsed), [doc.roots, view.collapsed]);
  const placedBy = useMemo(() => new Map(lay.placed.map((p) => [p.path, p])), [lay.placed]);

  const seq = useRef(0);
  const shot = useRef<Shot | null>(null);
  const ids = useMemo(() => {
    const prev = shot.current && shot.current.path === path ? shot.current : null;
    return carryIds(prev?.roots ?? [], prev?.ids ?? new Map(), doc.roots, () => `n${++seq.current}`);
  }, [doc.roots, path]);

  /** 전체 트리를 위에서 아래로 — 숨은 것도 접힌 조상 자리에 둔다. 순서가 편집 사이에 유지된다. */
  const items = useMemo(() => {
    const hidden = new Map(foldedPlaced(doc.roots, view.collapsed, lay.placed).map((f) => [f.path, f]));
    const out: Item[] = [];
    for (const { path: at } of walkNodes(doc.roots)) {
      const id = ids.get(at) ?? at;
      const p = placedBy.get(at);
      if (p) out.push({ ...p, id, hidden: false, anchor: "" });
      else {
        const f = hidden.get(at);
        if (f) out.push({ ...f, id, hidden: true });
      }
    }
    return out;
  }, [doc.roots, view.collapsed, lay.placed, placedBy, ids]);
  const itemBy = useMemo(() => new Map(items.map((it) => [it.path, it])), [items]);

  // 되돌리기 스택은 파일마다 따로다. 다른 문서의 상태로 되돌아가면 안 된다.
  useEffect(() => {
    setUndo([]);
    setArmedDelete("");
    setPicking(false);
    setEditing("");
    setGhosts([]);
    setPulse(null);
  }, [path]);

  // 한 번 누른 [삭제] 는 3초가 지나면 풀린다. 예전에는 무장한 채 남아서, 한참 뒤의 클릭 한 번이
  // 곧바로 지웠다.
  useEffect(() => {
    if (!armedDelete) return;
    const t = window.setTimeout(() => setArmedDelete(""), DISARM_MS);
    return () => window.clearTimeout(t);
  }, [armedDelete]);

  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => setPulse(null), PULSE_DELAY_MS + 1800 + 100);
    return () => window.clearTimeout(t);
  }, [pulse]);

  useEffect(() => {
    setShownViews((v) => (v.includes(view.view) ? v : [...v, view.view]));
    const t = window.setTimeout(() => setShownViews([view.view]), FADE_MS + 40);
    return () => window.clearTimeout(t);
  }, [view.view]);

  /** 트리를 고쳐 다시 직렬화한다. frontmatter 가 있는 문서만 `updated` 를 갱신한다. */
  const commit = (roots: BsNode[]) => {
    const fmLines = doc.fmLines.length ? setFm(doc.fmLines, "updated", nowStamp()) : doc.fmLines;
    setUndo((u) => [...u, text].slice(-UNDO_MAX));
    s.editDoc(path, serializeBstorm({ ...doc, fmLines, roots }));
  };

  const undoOnce = () => {
    if (!undo.length) return;
    const prev = undo[undo.length - 1];
    setUndo((u) => u.slice(0, -1));
    setEditing("");
    setArmedDelete("");
    s.editDoc(path, prev);
  };

  const sel = view.sel;
  const node = nodeAt(doc.roots, sel);
  const patchNode = (p: Partial<BsNode>) => {
    if (!node) return;
    commit(mapAt(doc.roots, sel, (n) => ({ ...n, ...p })));
  };

  const onCanvas = view.view === "canvas";
  const showInspector = view.view !== "decision";

  const vpSize = () => {
    const el = boxRef.current;
    return el && el.clientWidth && el.clientHeight ? { w: el.clientWidth, h: el.clientHeight } : null;
  };

  /** 카메라는 모두 여기로 옮긴다 — 시간을 함께 정해야 끌기 뒤의 줌이 엉뚱하게 미끄러지지 않는다. */
  const moveCam = (cam: Camera, ms: number, extra: Partial<BsView> = {}) => {
    setCamMs(ms);
    setView({ ...extra, zoom: cam.zoom, panX: cam.panX, panY: cam.panY });
  };

  /**
   * 하위 생각을 만들고 곧바로 그 제목을 고치게 한다. 예전에는 빈 노드만 생기고 커서가
   * 어디에도 없어서, 인스펙터를 찾아가 눌러야 이름을 붙일 수 있었다. 화면 밖에 생기면
   * 카메라가 그만큼만 따라간다.
   */
  const addChild = (at: string) => {
    const next = addChildAt(doc.roots, at);
    if (next.roots === doc.roots) return;
    commit(next.roots);
    const collapsed = at ? { ...view.collapsed, [at]: false } : view.collapsed;
    const patch: Partial<BsView> = { sel: next.path, collapsed };
    setArmedDelete("");
    if (onCanvas) {
      setEditing(next.path);
      const vp = vpSize();
      const p = layout(next.roots, collapsed).placed.find((x) => x.path === next.path);
      const cam = vp && p ? revealRect(view, p, vp.w, vp.h) : null;
      if (cam) {
        setCamMs(CAM_MS);
        Object.assign(patch, cam);
      }
    } else {
      titleFocus.current = next.path;
    }
    setView(patch);
  };

  const dropNode = (at: string) => {
    commit(removeAt(doc.roots, at));
    setView({ sel: parentPath(at) });
    setArmedDelete("");
    setEditing("");
  };

  const toggleFold = (at: string, folded: boolean) => {
    if (folded === false && editing.startsWith(`${at}.`)) setEditing("");
    setView({ collapsed: { ...view.collapsed, [at]: !folded } });
  };

  /** 업무 폴더 안의 그림 파일. 탐색기로 끌어다 놓은 것이 여기 나타난다. */
  const images = useMemo(
    () => s.files.filter((f) => !f.dir && isImagePath(f.p)).map((f) => f.p),
    [s.files],
  );
  const srcOf = (rel: string) => convertFileSrc(joinPath(s.activeFolder, rel));

  // 파일을 처음 열 때 한 번만 전체 가지에 맞춘다. 이후의 줌·팬은 사용자 것이다.
  useLayoutEffect(() => {
    if (!onCanvas || fittedRef.current === path) return;
    const vp = vpSize();
    if (!vp || !lay.placed.length) return;
    fittedRef.current = path;
    moveCam(fitCamera(lay.width, lay.height, vp.w, vp.h, PAD), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, onCanvas, lay.width, lay.height]);

  /**
   * 직전 렌더와 견준다. 새 id 는 부모에서 자라나고 가지선이 그어진다. 사라진 id 는 잔상을 남겨
   * 남은 조상 안으로 접힌다. 자리만 바뀐 것은 CSS 전환이 맡는다.
   */
  useLayoutEffect(() => {
    const prev = shot.current;
    const at = new Map(items.map((it) => [it.id, it]));
    shot.current = { path, roots: doc.roots, ids, items, at };
    if (!prev || prev.path !== path || prev.items === items || !onCanvas) return;
    const layer = layerRef.current;
    if (!layer || typeof Element.prototype.animate !== "function") return;
    const reduce = reducedMotion();

    for (const it of items) {
      if (it.hidden || prev.at.has(it.id)) continue;
      const inner = layer.querySelector<HTMLElement>(`[data-bs-born="${it.id}"]`);
      if (inner) {
        if (reduce) inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
        else {
          const par = it.parent ? itemBy.get(it.parent) : undefined;
          const dx = par ? par.x + par.w - 24 - it.x : 0;
          const dy = par ? par.y + par.h / 2 - (it.y + it.h / 2) : 0;
          inner.animate(
            [
              { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.55)` },
              { opacity: 1, transform: "none" },
            ],
            { duration: BORN_MS, easing: EASE_OUT },
          );
        }
      }
      const edge = layer.querySelector<SVGPathElement>(`[data-bs-edge="${it.id}"]`);
      if (edge && !reduce && it.node.status !== "dropped") {
        const len = edge.getTotalLength();
        if (len > 0) {
          edge.animate(
            [
              { strokeDasharray: `${len}`, strokeDashoffset: `${len}` },
              { strokeDasharray: `${len}`, strokeDashoffset: "0" },
            ],
            { duration: BORN_MS, easing: EASE_OUT },
          );
        }
      }
    }

    if (reduce) return;
    const prevBy = new Map(prev.items.map((x) => [x.path, x]));
    const gone: Ghost[] = [];
    for (const old of prev.items) {
      if (old.hidden || at.has(old.id)) continue;
      let anchor: Item | undefined;
      for (let up = old.parent; up; up = parentPath(up)) {
        const o = prevBy.get(up);
        const now = o && at.get(o.id);
        if (now && !now.hidden) {
          anchor = now;
          break;
        }
      }
      const from = old.parent ? prevBy.get(old.parent) : undefined;
      gone.push({
        it: old,
        to: anchor ? { x: anchor.x, y: anchor.y + anchor.h / 2 - old.h / 2 } : { x: old.x, y: old.y },
        edge: from ? edgePath(from, old) : "",
        look: from ? edgeLook(old, from) : null,
      });
    }
    if (gone.length) setGhosts((g) => [...g, ...gone]);
  });

  useLayoutEffect(() => {
    if (!ghosts.length) {
      ghostRun.current.clear();
      return;
    }
    const layer = layerRef.current;
    for (const g of ghosts) {
      if (ghostRun.current.has(g.it.id)) continue;
      ghostRun.current.add(g.it.id);
      layer?.querySelector<HTMLElement>(`[data-bs-ghost="${g.it.id}"]`)?.animate(
        [
          { opacity: 1, transform: `translate(${r2(g.it.x)}px, ${r2(g.it.y)}px) scale(1)` },
          { opacity: 0, transform: `translate(${r2(g.to.x)}px, ${r2(g.to.y)}px) scale(.6)` },
        ],
        { duration: EXIT_MS, easing: EASE_IN, fill: "forwards" },
      );
      layer
        ?.querySelector<SVGPathElement>(`[data-bs-ghost-edge="${g.it.id}"]`)
        ?.animate([{ opacity: g.look?.opacity ?? 1 }, { opacity: 0 }], {
          duration: 120,
          easing: "linear",
          fill: "forwards",
        });
    }
    const t = window.setTimeout(() => setGhosts([]), EXIT_MS + 40);
    return () => window.clearTimeout(t);
  }, [ghosts]);

  // 다른 보기에서 건너왔으면 캔버스가 키보드를 받는다(Tab · Enter · Delete 가 곧바로 듣는다).
  useEffect(() => {
    if (!onCanvas || !focusCanvas.current) return;
    focusCanvas.current = false;
    boxRef.current?.focus({ preventScroll: true });
  });

  /**
   * 휠: Ctrl(⌘)+휠 · 트랙패드 오므리기는 포인터 자리를 붙박고 줌, 그냥 휠은 팬(Shift 면 가로).
   * React 의 onWheel 은 passive 라 기본 동작(창 확대 · 스크롤)을 막지 못해서 직접 붙인다.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = readBsView(path);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      setCamMs(0);
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const k = r.width ? el.clientWidth / r.width : 1;
        // 마우스 휠은 한 칸에 100 남짓, 트랙패드 오므리기는 몇 픽셀씩 잘게 온다. 같은 비율이면
        // 휠은 너무 튀거나 오므리기가 너무 굼뜨다.
        const rate = Math.abs(dy) < 40 ? 0.01 : 0.0015;
        const cam = zoomAround(v, v.zoom * Math.exp(-dy * rate), (e.clientX - r.left) * k, (e.clientY - r.top) * k);
        writeBsView(path, cam);
      } else if (e.shiftKey && !dx) {
        writeBsView(path, { panX: v.panX - dy });
      } else {
        writeBsView(path, { panX: v.panX - dx, panY: v.panY - dy });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [path]);

  const startPan = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    // 진행 중인 카메라 전환은 손에 넘긴다 — 전환 위에서 끌면 손보다 늦게 따라온다.
    setCamMs(0);
    panRef.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, moved: false };
    const move = (ev: MouseEvent) => {
      const d = panRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(ev.clientX - d.x) < 3 && Math.abs(ev.clientY - d.y) < 3) return;
      if (!d.moved) {
        d.moved = true;
        setPanning(true);
      }
      setView({ panX: d.panX + (ev.clientX - d.x), panY: d.panY + (ev.clientY - d.y) });
    };
    const up = () => {
      const d = panRef.current;
      panRef.current = null;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      setPanning(false);
      // 끌지 않고 빈 곳을 눌렀으면 선택을 푼다.
      if (d && !d.moved) setView({ sel: "" });
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  /** ± 는 화면 가운데를 붙박는다. 예전에는 왼쪽 위를 붙박아 보던 노드가 화면 밖으로 달아났다. */
  const zoomStep = (dz: number) => {
    const vp = vpSize();
    if (!vp) return;
    const v = readBsView(path);
    moveCam(zoomAround(v, Math.round((v.zoom + dz) * 100) / 100, vp.w / 2, vp.h / 2), CAM_MS);
  };

  const fit = () => {
    const vp = vpSize();
    if (!vp || !lay.placed.length) return;
    moveCam(fitCamera(lay.width, lay.height, vp.w, vp.h, PAD), CAM_MS);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undoOnce();
    } else if (e.key === "Tab") {
      e.preventDefault();
      addChild(sel);
    } else if (e.key === "Enter" && sel) {
      e.preventDefault();
      addChild(parentPath(sel));
    } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
      e.preventDefault();
      dropNode(sel);
    }
  };

  /** 카드 위 제목 칸의 키. Enter · Esc 는 끝내고 캔버스로, Tab 은 하위 생각을 하나 더. */
  const onEditKey = (at: string) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // 한글 조합 중의 Enter 는 글자를 확정하는 키다 — 여기서 끝내면 마지막 글자가 사라진다.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      setEditing("");
      boxRef.current?.focus({ preventScroll: true });
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      addChild(at);
    }
  };

  /**
   * 결정 로그 · 개요에서 캔버스로 건너간다. 예전에는 선택만 바꿔서, 접힌 가지 안이거나 화면
   * 밖에 있는 생각이면 캔버스로 와도 보이지 않았다. 접힌 조상을 펴고, 그 자리를 가운데로
   * 카메라를 옮기고(460ms), 도착하면 고리가 한 번 퍼진다.
   */
  const jump = (to: string) => {
    const collapsed = unfoldTo(view.collapsed, to);
    const p = layout(doc.roots, collapsed).placed.find((x) => x.path === to);
    const row = rowRef.current;
    const patch: Partial<BsView> = { view: "canvas", sel: to, collapsed };
    setEditing("");
    setArmedDelete("");
    if (p && row && row.clientWidth > INSPECTOR_W) {
      // 캔버스 보기에서는 인스펙터가 늘 펴져 있다. 결정 로그에서 오면 아직 접혀 있으므로
      // 지금 너비가 아니라 도착했을 때의 너비로 잰다.
      const cam = centerOn(p, row.clientWidth - INSPECTOR_W, row.clientHeight, clampZoom(Math.max(view.zoom, 0.9)));
      setCamMs(TRAVEL_MS);
      Object.assign(patch, cam);
      // 처음 여는 캔버스라도 맞춤이 이 카메라를 덮어쓰지 않는다.
      fittedRef.current = path;
    }
    setPulse((q) => ({ path: to, n: (q?.n ?? 0) + 1 }));
    focusCanvas.current = true;
    setView(patch);
  };

  const live = (k: BsViewKind) => k === view.view || shownViews.includes(k);

  return (
    <div ref={rowRef} style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        {/* 캔버스는 늘 그려 둔다 — 돌아올 때 카드가 다시 태어나지 않고, 카메라가 이어서 움직인다. */}
        <div style={paneStyle(onCanvas, false)} inert={!onCanvas}>
          <div
            ref={boxRef}
            tabIndex={0}
            aria-label="생각 캔버스 — Tab 하위 생각 · Enter 형제 · 더블클릭 제목 고치기 · Ctrl+Z 되돌리기"
            onMouseDown={startPan}
            onKeyDown={onKeyDown}
            onScroll={(e) => {
              // 포커스 · 글자 끌기가 overflow:hidden 상자를 밀어 두면 카메라와 어긋난다.
              const el = e.currentTarget;
              if (el.scrollTop || el.scrollLeft) {
                el.scrollTop = 0;
                el.scrollLeft = 0;
              }
            }}
            className="cf-mv"
            style={{
              flex: 1,
              minWidth: 0,
              position: "relative",
              overflow: "hidden",
              outline: "none",
              cursor: panning ? "grabbing" : "default",
              background: "#fbfaf7",
              backgroundImage: "radial-gradient(#e2ded6 1px,transparent 1px)",
              // 점 격자도 카메라를 따라간다. 격자가 서 있으면 팬이 "카드가 움직인다"로 읽힌다.
              backgroundSize: `${r2(22 * view.zoom)}px ${r2(22 * view.zoom)}px`,
              backgroundPosition: `${r2(view.panX)}px ${r2(view.panY)}px`,
              transition: camMs
                ? `background-position ${camMs}ms ${CAM_EASE}, background-size ${camMs}ms ${CAM_EASE}`
                : "none",
            }}
          >
            {!lay.placed.length && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, color: TEXT.hint }}>아직 생각이 없습니다.</div>
                <Box
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    addChild("");
                  }}
                  style={{
                    fontSize: 12,
                    color: "#2f5cbb",
                    border: "1px solid #cddcf8",
                    background: "#fff",
                    borderRadius: 5,
                    padding: "5px 10px",
                    cursor: "pointer",
                  }}
                  hover={{ background: "#eef3fd" }}
                >
                  ＋ 중심 생각 만들기
                </Box>
              </div>
            )}

            <div
              ref={layerRef}
              className="cf-mv"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                transformOrigin: "0 0",
                transform: `translate(${r2(view.panX)}px, ${r2(view.panY)}px) scale(${view.zoom})`,
                transition: camMs ? `transform ${camMs}ms ${CAM_EASE}` : "none",
              }}
            >
              <svg
                width={Math.max(1, lay.width)}
                height={Math.max(1, lay.height)}
                style={{ position: "absolute", top: 0, left: 0, overflow: "visible" }}
              >
                {ghosts.map((g) =>
                  g.edge && g.look ? (
                    <EdgePathEl key={`g${g.it.id}`} d={g.edge} look={g.look} hidden={false} dataGhost={g.it.id} />
                  ) : null,
                )}
                {items.map((it) => {
                  const from = it.parent ? itemBy.get(it.parent) : undefined;
                  if (!from) return null;
                  const anchor = it.hidden ? itemBy.get(it.anchor) : undefined;
                  return (
                    <EdgePathEl
                      key={it.id}
                      d={edgePath(from, it, anchor)}
                      look={edgeLook(it, from)}
                      hidden={it.hidden}
                      dataEdge={it.id}
                    />
                  );
                })}
              </svg>

              {ghosts.map((g) => (
                <NodeCard
                  key={`g${g.it.id}`}
                  it={g.it}
                  sel={false}
                  folded={false}
                  editing={false}
                  pulse={0}
                  ghost
                  srcOf={srcOf}
                />
              ))}

              {items.map((it) => {
                const folded = !!view.collapsed[it.path];
                const isEditing = !it.hidden && editing === it.path;
                return (
                  <NodeCard
                    key={it.id}
                    it={it}
                    sel={it.path === sel}
                    folded={folded}
                    editing={isEditing}
                    pulse={pulse && pulse.path === it.path && !it.hidden ? pulse.n : 0}
                    srcOf={srcOf}
                    onPick={() => {
                      setView({ sel: it.path });
                      setArmedDelete("");
                    }}
                    onAdd={() => addChild(it.path)}
                    onFold={() => toggleFold(it.path, folded)}
                    onEdit={() => {
                      setView({ sel: it.path });
                      setEditing(it.path);
                    }}
                    onTitle={(v) => commit(mapAt(doc.roots, it.path, (x) => ({ ...x, title: v })))}
                    onEditKey={onEditKey(it.path)}
                    onEditEnd={() => setEditing((e) => (e === it.path ? "" : e))}
                  />
                );
              })}
            </div>

            <div
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: "absolute",
                right: 10,
                bottom: 10,
                zIndex: 3,
                display: "flex",
                alignItems: "center",
                gap: 2,
                padding: 3,
                borderRadius: 12,
                background: "#fff",
                border: "1px solid #e0dcd4",
                boxShadow: "0 2px 8px rgba(35,33,30,.10)",
              }}
            >
              <Box
                role="button"
                aria-disabled={!undo.length}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  undoOnce();
                }}
                style={{
                  fontSize: 11,
                  padding: "0 7px",
                  height: 18,
                  lineHeight: "18px",
                  borderRadius: 9,
                  color: undo.length ? TEXT.body : "#cfcabf",
                  cursor: undo.length ? "pointer" : "default",
                }}
                hover={undo.length ? { background: "#f2efe9" } : {}}
                title="되돌리기 (Ctrl+Z)"
              >
                ↶ 되돌리기
              </Box>
              <span style={{ width: 1, height: 12, background: "#e6e2da" }} />
              {(
                [
                  ["－", "축소", -ZOOM_STEP],
                  ["＋", "확대", ZOOM_STEP],
                ] as [string, string, number][]
              ).map(([label, name, dz]) => (
                <Box
                  key={label}
                  role="button"
                  aria-label={name}
                  title={`${name} (Ctrl+휠)`}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    zoomStep(dz);
                  }}
                  style={{
                    width: 20,
                    height: 18,
                    borderRadius: 9,
                    fontSize: 11,
                    lineHeight: "18px",
                    textAlign: "center",
                    color: TEXT.sub,
                    cursor: "pointer",
                  }}
                  hover={{ background: "#f2efe9" }}
                >
                  {label}
                </Box>
              ))}
              <span
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11.5,
                  color: TEXT.sub,
                  padding: "0 4px",
                  minWidth: 38,
                  textAlign: "center",
                }}
              >
                {Math.round(view.zoom * 100)}%
              </span>
              <Box
                role="button"
                title="가지 전체를 화면에 맞춘다"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  fit();
                }}
                style={{
                  fontSize: 11,
                  padding: "0 7px",
                  height: 18,
                  lineHeight: "18px",
                  borderRadius: 9,
                  color: "#2f5cbb",
                  cursor: "pointer",
                }}
                hover={{ background: "#eef3fd" }}
              >
                맞춤
              </Box>
            </div>
          </div>
        </div>

        {live("outline") && (
          <div style={paneStyle(view.view === "outline", true)} inert={view.view !== "outline"}>
            <Outline
              roots={doc.roots}
              sel={sel}
              onSelect={(p) => setView({ sel: p })}
              onAddChild={addChild}
              onJump={jump}
            />
          </div>
        )}

        {live("decision") && (
          <div style={paneStyle(view.view === "decision", true)} inert={view.view !== "decision"}>
            <DecisionLog roots={doc.roots} onJump={jump} />
          </div>
        )}
      </div>

      {/* 결정 로그는 읽는 화면이라 인스펙터를 접는다. 한 프레임에 사라지면 로그가 옆으로 튄다. */}
      <div
        inert={!showInspector}
        className="cf-mv"
        style={{
          flex: "0 0 auto",
          display: "flex",
          width: showInspector ? INSPECTOR_W : 0,
          opacity: showInspector ? 1 : 0,
          overflow: "hidden",
          transition: "width var(--m-base) var(--e-out), opacity var(--m-quick) linear",
        }}
      >
        <div
          style={{
            flex: `0 0 ${INSPECTOR_W}px`,
            width: INSPECTOR_W,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            background: "#fff",
            borderLeft: "1px solid #e6e2da",
          }}
        >
          <div
            style={{
              flex: "0 0 26px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 10px",
              background: "#f7f5f1",
              borderBottom: "1px solid #e6e2da",
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".4px", color: TEXT.sub }}>생각</span>
            <div style={{ flex: 1 }} />
            <span
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11.5,
                color: TEXT.sub,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {bstormName(path)}
            </span>
          </div>

          {!node && (
            <div style={{ padding: "16px 12px", fontSize: 11.5, lineHeight: 1.7, color: "#6a665e" }}>
              노드를 고르면 여기서 자세히 적을 수 있습니다.
              <div style={{ marginTop: 8, color: "#6a665e" }}>
                Tab 하위 생각 · Enter 형제 · 더블클릭 제목 고치기 · Delete 삭제 · Ctrl+Z 되돌리기
              </div>
              <div style={{ color: "#6a665e" }}>휠 이동 · Ctrl+휠 확대</div>
            </div>
          )}

          {node && (
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px 16px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                <div style={{ ...labelStyle, marginBottom: 0 }}>제목</div>
                <div style={{ flex: 1 }} />
                <StatusBadge status={node.status} big />
              </div>
              <DraftInput
                key={`${path}|${sel}|title`}
                ref={(el) => {
                  // 개요에서 막 만든 생각이면 여기서 곧바로 이름을 붙인다(캔버스는 카드 위에서 한다).
                  if (el && titleFocus.current === sel) {
                    titleFocus.current = "";
                    el.focus();
                    el.select();
                  }
                }}
                value={node.title}
                onCommit={(v) => patchNode({ title: v })}
                placeholder="한 문장으로"
                style={{ ...inputStyle, width: "100%", marginBottom: 10 }}
                focusStyle={inputFocus}
              />

              <div style={labelStyle}>상태</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "4px 0 10px 0" }}>
                {STATUS_ORDER.map((k) => {
                  const on = node.status === k;
                  const stk = BS_STATUS[k];
                  return (
                    <Box
                      key={k}
                      onClick={() => patchNode({ status: k })}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 11,
                        padding: "3px 8px",
                        borderRadius: 3,
                        cursor: "pointer",
                        color: on ? stk.fg : "#6a665e",
                        background: on ? stk.bg : "#fff",
                        // 고른 것은 테두리를 두 겹으로 두른다. 옅은 배경색만으로는
                        // 지금 이 생각이 채택인지 유력인지 한눈에 들어오지 않았다.
                        // 호버가 `borderColor` 만 바꾸므로 테두리를 낱낱으로 적는다(섞으면 호버가
                        // 끝날 때 테두리 색이 통째로 지워진다).
                        borderWidth: 1,
                        borderStyle: stk.dash ? "dashed" : "solid",
                        borderColor: on ? stk.line : "#e6e2da",
                        boxShadow: on ? `inset 0 0 0 1px ${stk.bd}` : "none",
                        fontWeight: on ? 700 : 400,
                      }}
                      hover={{ borderColor: stk.line }}
                    >
                      {STATUS_MARK[k] ? (
                        <span style={{ fontSize: 9 }}>{STATUS_MARK[k]}</span>
                      ) : (
                        <span
                          style={{ width: 6, height: 6, borderRadius: "50%", background: stk.dot }}
                        />
                      )}
                      {stk.label}
                    </Box>
                  );
                })}
              </div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <div style={labelStyle}>상세</div>
                <span style={{ fontSize: 11, color: "#6a665e" }}>Enter 로 줄바꿈</span>
              </div>
              <DraftTextArea
                key={`${path}|${sel}|detail`}
                value={node.detail}
                onCommit={(v) => patchNode({ detail: v })}
                placeholder={"왜 이 생각인지, 무엇을 확인해야 하는지\n여러 줄로 적어도 됩니다"}
                rows={4}
                style={{
                  ...inputStyle,
                  width: "100%",
                  height: "auto",
                  minHeight: 66,
                  padding: "6px 8px",
                  lineHeight: 1.6,
                  marginBottom: 10,
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
                focusStyle={inputFocus}
              />

              {node.status === "dropped" && (
                <>
                  <div style={labelStyle}>폐기 이유</div>
                  <DraftInput
                    key={`${path}|${sel}|reason`}
                    value={node.reason}
                    onCommit={(v) => patchNode({ reason: v })}
                    placeholder="왜 접었는지 남겨 둡니다"
                    style={{ ...inputStyle, width: "100%", marginBottom: 10 }}
                    focusStyle={inputFocus}
                  />
                </>
              )}

              <div style={labelStyle}>그림 · 다이어그램</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "4px 0 6px 0" }}>
                {node.images.map((rel) => (
                  <div key={rel} style={{ position: "relative" }}>
                    <img
                      src={srcOf(rel)}
                      alt={rel}
                      title={rel}
                      style={{
                        width: 78,
                        height: 52,
                        objectFit: "cover",
                        borderRadius: 5,
                        border: "1px solid #e6e2da",
                        background:
                          "repeating-linear-gradient(45deg,#f3f0ea 0 5px,#eae6de 5px 10px)",
                      }}
                    />
                    <Box
                      onClick={() => patchNode({ images: node.images.filter((x) => x !== rel) })}
                      style={{
                        position: "absolute",
                        top: -5,
                        right: -5,
                        width: 15,
                        height: 15,
                        borderRadius: "50%",
                        background: "#fff",
                        borderWidth: 1,
                        borderStyle: "solid",
                        borderColor: "#e0dcd4",
                        fontSize: 9,
                        lineHeight: "13px",
                        textAlign: "center",
                        color: "#6a665e",
                        cursor: "pointer",
                      }}
                      hover={{ color: "#a55a4c", borderColor: "#eddad4" }}
                    >
                      ✕
                    </Box>
                  </div>
                ))}
              </div>

              {!picking && (
                <Box
                  onClick={() => setPicking(true)}
                  style={{
                    display: "inline-block",
                    fontSize: 11,
                    padding: "3px 7px",
                    borderRadius: 3,
                    marginBottom: 12,
                    cursor: "pointer",
                    color: "#6a665e",
                    background: "#fff",
                    borderWidth: 1,
                    borderStyle: "dashed",
                    borderColor: "#ddd8cf",
                  }}
                  hover={{ borderColor: "#3a6fd8", color: "#2f5cbb" }}
                >
                  ＋ 그림 붙이기
                </Box>
              )}

              {picking && (
                <div
                  style={{
                    border: "1px solid #e0dcd4",
                    borderRadius: 5,
                    background: "#faf9f6",
                    padding: 6,
                    marginBottom: 12,
                  }}
                >
                  {!images.length && (
                    <div style={{ fontSize: 11, lineHeight: 1.7, color: "#6a665e" }}>
                      업무 폴더에 그림이 없습니다.
                      <div style={{ color: "#6a665e" }}>
                        탐색기로 끌어다 놓으면 여기에 나타납니다.
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 152, overflow: "auto" }}>
                    {images.map((rel) => {
                      const already = node.images.includes(rel);
                      return (
                        <Box
                          key={rel}
                          onClick={() => {
                            if (!already) patchNode({ images: [...node.images, rel] });
                            setPicking(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "3px 5px",
                            borderRadius: 4,
                            cursor: already ? "default" : "pointer",
                            opacity: already ? 0.45 : 1,
                          }}
                          hover={already ? {} : { background: "#efece6" }}
                        >
                          <img
                            src={srcOf(rel)}
                            alt=""
                            style={{
                              width: 26,
                              height: 18,
                              objectFit: "cover",
                              borderRadius: 2,
                              border: "1px solid #e6e2da",
                            }}
                          />
                          <span
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontFamily: "'Roboto Mono',monospace",
                              fontSize: 11.5,
                              color: "#4e4a43",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {rel}
                          </span>
                          {already && <span style={{ fontSize: 11, color: "#6a665e" }}>붙어 있음</span>}
                        </Box>
                      );
                    })}
                  </div>
                  <Box
                    onClick={() => setPicking(false)}
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      color: "#6a665e",
                      cursor: "pointer",
                      textAlign: "right",
                    }}
                    hover={{ color: "#4e4a43" }}
                  >
                    닫기
                  </Box>
                </div>
              )}

              <div style={labelStyle}>근거 · 리스크 · 질문</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "4px 0 6px 0" }}>
                {node.evidence.map((e, i) => (
                  <div key={`ev${i}`} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span
                      style={{
                        flex: "0 0 auto",
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "2px 5px",
                        borderRadius: 3,
                        color: BS_EVIDENCE[e.kind].fg,
                        background: BS_EVIDENCE[e.kind].bg,
                        border: `1px solid ${BS_EVIDENCE[e.kind].bd}`,
                      }}
                    >
                      {e.kind}
                    </span>
                    <DraftInput
                      key={`${path}|${sel}|ev${i}`}
                      value={e.text}
                      onCommit={(v) =>
                        patchNode({
                          evidence: node.evidence.map((x, k) => (k === i ? { ...x, text: v } : x)),
                        })
                      }
                      autoFocus={freshEv === `${sel}|${i}`}
                      placeholder={EVIDENCE_HINT[e.kind]}
                      style={{ ...inputStyle, flex: 1, minWidth: 0, height: 24, fontSize: 11.5 }}
                      focusStyle={inputFocus}
                    />
                    <Box
                      onClick={() => patchNode({ evidence: node.evidence.filter((_, k) => k !== i) })}
                      style={{
                        flex: "0 0 auto",
                        fontSize: 11,
                        color: "#6a665e",
                        cursor: "pointer",
                        padding: "0 3px",
                      }}
                      hover={{ color: "#a55a4c" }}
                      title="이 줄 지우기"
                    >
                      ✕
                    </Box>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
                {EVIDENCE_KINDS.map((k) => (
                  <Box
                    key={k}
                    onClick={() => {
                      // 빈 줄 하나를 만들고 거기로 커서를 옮긴다. 빈 줄이 문서에도 남기
                      // 때문에(`serializeBstorm`) 화면과 파일이 같은 것을 본다.
                      setFreshEv(`${sel}|${node.evidence.length}`);
                      patchNode({ evidence: [...node.evidence, { kind: k, text: "" }] });
                    }}
                    style={{
                      fontSize: 11,
                      padding: "3px 7px",
                      borderRadius: 3,
                      cursor: "pointer",
                      color: BS_EVIDENCE[k].fg,
                      background: "#fff",
                      border: `1px dashed ${BS_EVIDENCE[k].bd}`,
                    }}
                    hover={{ background: BS_EVIDENCE[k].bg }}
                  >
                    ＋ {k}
                  </Box>
                ))}
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  paddingTop: 10,
                  borderTop: "1px solid #f0ede7",
                }}
              >
                <Box
                  onClick={() => addChild(sel)}
                  style={{
                    fontSize: 11.5,
                    padding: "4px 9px",
                    borderRadius: 5,
                    cursor: "pointer",
                    color: "#2f5cbb",
                    background: "#fff",
                    border: "1px solid #cddcf8",
                  }}
                  hover={{ background: "#eef3fd" }}
                >
                  ＋ 하위 생각
                </Box>
                <div style={{ flex: 1 }} />
                <Box
                  onClick={() => (armedDelete === sel ? dropNode(sel) : setArmedDelete(sel))}
                  style={{
                    position: "relative",
                    overflow: "hidden",
                    fontSize: 11.5,
                    padding: "4px 9px",
                    borderRadius: 5,
                    cursor: "pointer",
                    color: "#a83c3c",
                    background: armedDelete === sel ? "#fceceb" : "#fff",
                    border: "1px solid #eddad4",
                  }}
                  hover={{ background: "#fceceb" }}
                >
                  {armedDelete === sel
                    ? node.children.length
                      ? `하위 ${node.children.length}개까지 삭제`
                      : "한 번 더 눌러 삭제"
                    : "삭제"}
                  {/* 무장이 풀리기까지 남은 3초. 기다림은 진행으로 보인다. */}
                  {armedDelete === sel && (
                    <span
                      key={sel}
                      aria-hidden
                      className="cf-countdown"
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: 2,
                        background: "#a83c3c",
                        opacity: 0.45,
                        animationDuration: `${DISARM_MS}ms`,
                      }}
                    />
                  )}
                </Box>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
