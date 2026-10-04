/**
 * 업무 카테고리 — `index.md` frontmatter 의 `category: "프로젝트/ContextFlow"` 한 줄.
 *
 * 정규화 규칙은 Rust(`src-tauri/src/category.rs`)와 **같아야** 한다. 둘이 같은 fixture
 * (`category.cases.json`)로 시험한다. 백엔드가 모든 쓰기를 다시 검증하므로 여기서 하는
 * 정규화는 쓰기 전에 오류를 보여 주고, 입력 중에 저장될 값을 미리 보여 주기 위한 것이다.
 */

export const MAX_DEPTH = 3;
/** 세그먼트 하나의 최대 글자 수(코드포인트). */
export const SEG_MAX = 30;
export const UNCAT_LABEL = "미분류";
/** 화면 표시 구분자. 저장은 언제나 `/` 다. */
const SEP = " › ";

type CategoryError = "depth" | "reserved";

/** Rust 와 글자 하나까지 같은 공백 집합. JS 의 `trim()` · `\s` 는 U+0085 를 빼먹는다. */
const WS = /[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
/** 위키링크 · 파일 이름 · YAML 을 깨는 글자들. */
const FORBIDDEN = new Set(':*?"<>|#^[],');

function cleanSegment(raw: string): string {
  let out = "";
  for (const ch of raw) {
    if (WS.test(ch)) out += " ";
    else if (CONTROL.test(ch) || FORBIDDEN.has(ch)) out += "-";
    else out += ch;
  }
  const edge = (s: string) => s.replace(/^[ .]+|[ .]+$/g, "");
  // 자르는 단위는 코드포인트다 — UTF-16 으로 세면 이모지가 반으로 갈린다.
  return edge(Array.from(edge(out.replace(/ {2,}/g, " "))).slice(0, SEG_MAX).join(""));
}

/**
 * 입력을 저장 형태(`a/b/c`)로 다듬는다. `value: null` 은 미분류다.
 *
 * `write` 는 사용자가 고르는 값이라 4단계 이상 · `미분류/…` 를 오류로 돌려준다. `read` 는
 * Obsidian 에서 손으로 고친 값을 관대하게 읽는 쪽이라 고칠 수 있는 것은 고쳐 읽는다.
 */
export function normalizeCategory(
  text: string,
  mode: "write" | "read" = "write",
): { value: string | null; error: CategoryError | null } {
  const none = { value: null, error: null };
  let segs = text
    .split(/[/\\›]/)
    .map(cleanSegment)
    .filter(Boolean);
  if (segs[0] === UNCAT_LABEL) {
    if (segs.length === 1) return none;
    if (mode === "write") return { value: null, error: "reserved" };
    while (segs[0] === UNCAT_LABEL) segs = segs.slice(1);
  }
  // YAML 의 빈 값(`null` · `~`)은 다듬고 `미분류` 를 걷어 낸 **뒤에** 본다. `null/` · `Null.` ·
  // `미분류/null` 을 그대로 두면 되읽을 때 빈 값으로 읽혀, 쓴 값과 읽은 값이 어긋난다(Rust 와 같다).
  if (!segs.length) return none;
  if (segs.length === 1 && ["null", "~"].includes(segs[0].toLowerCase())) return none;
  if (segs.length > MAX_DEPTH) {
    if (mode === "write") return { value: null, error: "depth" };
    segs = [segs[0], segs[1], segs.slice(2).join(" · ")];
  }
  return { value: segs.join("/"), error: null };
}

export function categoryErrorMessage(code: CategoryError): string {
  return code === "depth"
    ? `카테고리는 ${MAX_DEPTH}단계까지입니다`
    : `‘${UNCAT_LABEL}’는 카테고리 이름으로 쓸 수 없습니다`;
}

export function segments(path: string | null): string[] {
  return path ? path.split("/") : [];
}

/** `프로젝트/ContextFlow` → `프로젝트 › ContextFlow`. 없으면 `미분류`. */
export function label(path: string | null): string {
  return path ? segments(path).join(SEP) : UNCAT_LABEL;
}

/** 같은 카테고리인지 가르는 키. 대소문자만 다른 것은 같은 카테고리다. */
export function categoryKey(path: string): string {
  return path.toLowerCase();
}

/**
 * 업무의 카테고리 키. 미분류는 `""` 다 — 접힘 상태 · 묶음 · 보관함 거르기가 모두 이 키로
 * 비교하므로, 미분류도 하나의 묶음처럼 다룰 수 있다.
 */
export function keyOf(cat: string | null): string {
  return cat ? categoryKey(cat) : "";
}

/**
 * `cat` 이 `key` 카테고리(그 하위 포함)에 드는가. `key === ""` 는 미분류만이다. `a/bc` 는
 * `a/b` 의 하위가 아니다 — 앞부분이 같아도 단계가 다르다.
 */
export function isWithin(cat: string | null, key: string): boolean {
  const k = keyOf(cat);
  if (key === "") return k === "";
  return k === key || k.startsWith(`${key}/`);
}

/**
 * 코드포인트 순 비교. `localeCompare` 는 공백 · 구두점을 건너뛰고 문자열 `<` 는 UTF-16
 * 단위로 비교해, 둘 다 Rust 의 정렬과 어긋난다.
 */
function ordinal(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

export interface CategoryNode {
  /** 비교 키(소문자 전체 경로). */
  key: string;
  /** 표시 철자의 전체 경로 — 상위의 표시 철자를 그대로 잇는다. */
  path: string;
  /** 마지막 세그먼트. */
  name: string;
  depth: number;
  /** 이 카테고리와 그 하위에 든 업무 수. */
  count: number;
}

/**
 * 업무들의 값에서 카테고리 목록을 만든다 — 레지스트리는 없다. 상위는 하위 업무만 있어도
 * 생기고, 업무가 0건이 되면 사라진다(태그와 같다). 진행 중 · 보관을 함께 넘긴다.
 *
 * 순서는 트리를 깊이 우선으로 편 것이고, 형제끼리는 세그먼트 키의 코드포인트 순이다.
 * 표시 철자는 그 노드 아래 업무들이 가장 많이 쓴 철자, 같으면 코드포인트 순으로 앞선 것.
 */
export function knownCategories(tasks: { category: string | null }[]): CategoryNode[] {
  interface Acc {
    seg: string;
    count: number;
    spell: Map<string, number>;
    kids: Map<string, Acc>;
  }
  const roots = new Map<string, Acc>();
  for (const t of tasks) {
    let level = roots;
    for (const seg of segments(t.category)) {
      const k = categoryKey(seg);
      let n = level.get(k);
      if (!n) level.set(k, (n = { seg: k, count: 0, spell: new Map(), kids: new Map() }));
      n.count++;
      n.spell.set(seg, (n.spell.get(seg) ?? 0) + 1);
      level = n.kids;
    }
  }
  const out: CategoryNode[] = [];
  const walk = (level: Map<string, Acc>, parent: CategoryNode | null) => {
    for (const n of [...level.values()].sort((a, b) => ordinal(a.seg, b.seg))) {
      const [name] = [...n.spell].sort((a, b) => b[1] - a[1] || ordinal(a[0], b[0]))[0];
      const node: CategoryNode = {
        key: parent ? `${parent.key}/${n.seg}` : n.seg,
        path: parent ? `${parent.path}/${name}` : name,
        name,
        depth: parent ? parent.depth + 1 : 1,
        count: n.count,
      };
      out.push(node);
      walk(n.kids, node);
    }
  };
  walk(roots, null);
  return out;
}

/** 이 카테고리를 보이려면 열려 있어야 할 키 — 조상 전부(자기 포함). 미분류는 `[""]`. */
export function revealKeys(cat: string | null): string[] {
  const segs = segments(cat);
  if (!segs.length) return [""];
  return segs.map((_, i) => keyOf(segs.slice(0, i + 1).join("/")));
}

/**
 * `cat` 이 보이도록 연 새 접힘 목록. 이미 다 열려 있으면 `null` 이고 그때는 설정을 쓰지
 * 않는다 — 업무를 고를 때마다 settings.json 을 다시 쓸 이유가 없다.
 */
export function openFor(closed: string[], cat: string | null): string[] | null {
  const need = revealKeys(cat);
  if (!closed.some((k) => need.includes(k))) return null;
  return closed.filter((k) => !need.includes(k));
}

/**
 * 업무 리스트 트리의 한 줄 — 카테고리 머리 행이거나 업무 행이다. 미분류 머리 행은 `key` ·
 * `path` 가 `""` 다.
 */
export type SideRow<T> =
  | (CategoryNode & { kind: "cat"; open: boolean })
  | {
      kind: "task";
      task: T;
      depth: number;
      /**
       * 이 업무가 직접 든 묶음의 키(미분류 `""`). 순서 바꾸기는 이 안에서만 한다 — 다른 묶음으로는
       * 그 묶음 **머리**에 놓아 카테고리를 바꾼다(`dropKind`).
       */
      group: string;
      /** 묶음 안의 순번과 묶음의 업무 수 — 놓을 자리 선을 묶음 기준으로 그린다. */
      gi: number;
      glen: number;
    };

/**
 * 보이는 업무를 카테고리 트리로 편다. 노드마다 머리 행, 그 바로 뒤에 **직속** 업무(들어온
 * 순서), 그다음 하위 노드다. 미분류 묶음은 맨 끝이다.
 *
 * 순서와 표시 철자는 `nodes`(`knownCategories(live)`)에서 온다 — 상태 필터 · 검색으로
 * 보이는 업무가 바뀌어도 머리 행의 철자가 흔들리지 않게. 개수와 행은 `visible` 에서 온다
 * (`visible` 은 `live` 에서 거른 것이라 그 카테고리가 모두 `nodes` 에 있다).
 * 보이는 업무가 없는 노드는 그리지 않는다. 미분류는 업무가 보이면 머리 행을 남긴다 —
 * 접어 둔 미분류를 다시 열 곳이 있어야 한다.
 *
 * 한 묶음의 업무 행은 연속이고 `visible`(전역 순서)의 부분열이다. 그래서 묶음 안에서
 * 놓은 자리를 그대로 `reorderedList` 의 `visible` 로 넘길 수 있다.
 */
export function flattenSideRows<T extends { category: string | null }>(
  visible: T[],
  { nodes, closed, forceOpen }: { nodes: CategoryNode[]; closed: string[]; forceOpen: boolean },
): SideRow<T>[] {
  const shut = new Set(forceOpen ? [] : closed);
  const direct = new Map<string, T[]>();
  const count = new Map<string, number>();
  for (const t of visible) {
    const k = keyOf(t.category);
    const list = direct.get(k);
    if (list) list.push(t);
    else direct.set(k, [t]);
    for (const a of revealKeys(t.category)) count.set(a, (count.get(a) ?? 0) + 1);
  }

  const out: SideRow<T>[] = [];
  const push = (node: CategoryNode) => {
    const open = !shut.has(node.key);
    out.push({ ...node, kind: "cat", open });
    if (!open) return;
    const items = direct.get(node.key) ?? [];
    items.forEach((task, gi) =>
      out.push({ kind: "task", task, depth: node.depth, group: node.key, gi, glen: items.length }),
    );
  };
  for (const n of nodes) {
    const c = count.get(n.key) ?? 0;
    // 닫힌 조상 아래는 머리 행도 감춘다. 자기 자신이 닫힌 것은 `push` 가 본다.
    if (!c || revealKeys(n.path).slice(0, -1).some((k) => shut.has(k))) continue;
    push({ ...n, count: c });
  }
  const uncat = count.get("") ?? 0;
  if (uncat) push({ key: "", path: "", name: UNCAT_LABEL, depth: 1, count: uncat });
  return out;
}

/** 다른 묶음 머리 위에 이만큼 머물러야 놓았을 때 카테고리가 바뀐다 — 지나가다 놓은 것과 가른다. */
export const HEAD_DWELL_MS = 300;

/**
 * 업무 리스트에서 끌던 업무를 놓았을 때 할 일.
 *
 * 놓을 곳은 **자기 묶음 안의 자리**(순서 바꾸기)와 **다른 묶음의 머리 행**(카테고리 바꾸기)뿐이다.
 * 다른 묶음의 업무 행 사이는 놓을 곳이 아니다 — 묶음 안의 순서는 전체 목록의 부분열이라, 그
 * 사이에 선을 그려도 놓은 자리를 지킬 수 없다.
 *
 * 머리 판정이 순서보다 먼저다. 끝 행 아래 반 행까지는 묶음 안의 맨 끝 자리로 치는데(`at >= 0`),
 * 그 자리가 바로 아래 묶음의 머리와 겹친다. 다만 머리 위에 `HEAD_DWELL_MS` 를 머물기 전(`armed`
 * 아님)에 놓은 넘침은 지금처럼 맨 끝으로 옮기기다. 자기 묶음의 머리는 바꿀 것이 없으니 머리가
 * 아닌 것과 같다. `group` 이 없으면(평평한 목록) 머리도 없다.
 *
 * `overKey` · `group` 은 둘 다 키(`keyOf`)라 그대로 견준다 — 미분류는 `""` 라 거짓 값 검사를 쓰지 않는다.
 */
export function dropKind({
  at,
  overKey,
  group,
  armed,
}: {
  /** 자기 묶음 안의 삽입 인덱스. 묶음 밖이면 `-1`. */
  at: number;
  /** 포인터 아래 묶음 머리의 키. 머리 위가 아니면 `null`. */
  overKey: string | null;
  /** 끄는 업무가 든 묶음의 키. 묶지 않은 평평한 목록이면 없다. */
  group?: string;
  /** 그 머리 위에 `HEAD_DWELL_MS` 이상 머물렀다. */
  armed: boolean;
}): "category" | "reorder" | "cancel" {
  if (armed && overKey !== null && group !== undefined && overKey !== group) return "category";
  return at >= 0 ? "reorder" : "cancel";
}

/**
 * 이미 있는 상위 경로는 알려진 철자로 맞춘다 — `프로젝트/contextflow/새것` 을 고르면
 * `프로젝트/ContextFlow/새것` 으로 저장해, 대소문자만 다른 카테고리가 생기지 않게 한다.
 * `value` 는 정규화를 마친 값이다.
 */
export function snapToExisting(value: string, nodes: CategoryNode[]): string {
  const segs = segments(value);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  for (let i = 1; i <= segs.length; i++) {
    const hit = byKey.get(categoryKey(segs.slice(0, i).join("/")));
    if (!hit) break;
    segs[i - 1] = hit.name;
  }
  return segs.join("/");
}

/**
 * 제안 목록에서 Tab 으로 채울 값 — 강조한 줄의 경로 `path` 에 `/` 를 붙여 그 아래로
 * 내려간다. 더 내려갈 수 없거나(미분류 · 3단계) 채워도 지금 값 `value` 그대로면 `null` 이고,
 * 그때는 Tab 을 가로채지 않는다 — 다음 칸으로 가는 키를 막으면 대화상자에서 빠져나갈 수 없다.
 */
export function tabTarget(path: string | null, value: string): string | null {
  if (!path || segments(path).length >= MAX_DEPTH) return null;
  const next = `${path}/`;
  return next === value ? null : next;
}

/**
 * 새 업무의 제안 카테고리. 유사 업무 추천 상위 3건 중 **2건 이상이 같은** 카테고리, 추천이
 * 한 건뿐이면 그 업무의 카테고리다 — 추천들이 제각각이면 어느 것도 이 업무의 자리라고
 * 하기 어렵다. 철자는 더 위에 추천된 쪽, 없으면 `null`. `folders` 는 추천 순서 그대로다.
 */
export function suggestCategory(
  folders: string[],
  tasks: { folder: string; category: string | null }[],
): string | null {
  const top = folders.slice(0, 3).map((f) => tasks.find((t) => t.folder === f)?.category ?? null);
  if (top.length === 1) return top[0];
  const tally = new Map<string, { value: string; count: number }>();
  for (const value of top) {
    if (!value) continue;
    const hit = tally.get(categoryKey(value));
    if (hit) hit.count++;
    else tally.set(categoryKey(value), { value, count: 1 });
  }
  return [...tally.values()].find((c) => c.count >= 2)?.value ?? null;
}

/** 한 단계 위의 경로 — 키든 철자든 받은 그대로 자른다. 최상위 · 미분류는 `null`. */
export function parentOf(path: string): string | null {
  const segs = segments(path);
  return segs.length > 1 ? segs.slice(0, -1).join("/") : null;
}

/**
 * `cat` 이 `fromKey` 카테고리(그 하위 포함)에 들면 그 아래 단계들(업무 자신의 철자), 아니면
 * `null`. 문자열 길이가 아니라 **단계로** 맞춘다 — `İ` 처럼 소문자에서 길이가 바뀌는 글자가
 * 있어, 키의 길이로 원문을 자르면 엉뚱한 자리에서 잘린다.
 */
function tailOf(cat: string | null, fromKey: string): string[] | null {
  const segs = segments(cat);
  const depth = fromKey.split("/").length;
  if (segs.length < depth) return null;
  return segs.slice(0, depth).map(categoryKey).join("/") === fromKey ? segs.slice(depth) : null;
}

/** 꼬리를 `to` 아래로 잇는다(`null` = 최상위). */
function moveTail(tail: string[], to: string | null): { value: string | null; error: CategoryError | null } {
  // 손으로 쓴 4단계 이상은 셋째 단계에 접혀 읽힌다(`c · d`). 그 단계가 30자를 넘으면 쓰기 규칙이
  // 잘라 이름이 몰래 바뀐다 — 단계가 넘친 것과 같게 막는다(Rust 와 같다).
  if (tail.some((seg) => Array.from(seg).length > SEG_MAX)) return { value: null, error: "depth" };
  const got = normalizeCategory([...(to === null ? [] : [to]), ...tail].join("/"));
  // `a/미분류` · `a/null` 을 최상위로 올리면 꼬리가 통째로 빈 값이 된다 — 몰래 미분류로 만들지 않는다.
  if (!got.error && got.value === null && tail.length) return { value: null, error: "reserved" };
  return got;
}

/**
 * 카테고리 `fromKey`(키)를 `to` 로 옮긴 뒤의 값. Rust `category::retarget` 와 같은 규칙이고
 * 같은 fixture(`category.move.json`)로 시험한다. 밖의 업무는 `null`.
 *
 * 안이면 `to` 의 단계에 업무 자신의 꼬리를 이어 쓰기 규칙으로 정규화한다. `to === null` 은
 * 최상위로 올리기라서, 노드 자신의 업무는 미분류(`value: null`)가 되고 하위는 최상위가 된다.
 */
export function retarget(
  cat: string | null,
  fromKey: string,
  to: string | null,
): { value: string | null; error: CategoryError | null } | null {
  const tail = tailOf(cat, fromKey);
  return tail && moveTail(tail, to);
}

export interface MovePlan<T> {
  /** 옮겨질 업무 — 서브트리 전부(진행 + 보관). 이미 목적지 값인 업무도 든다. */
  targets: T[];
  /** `targets` 중 보관 업무 수. */
  archived: number;
  /** 함께 옮겨지는 하위 카테고리 수(노드 자신은 빼고). */
  subcats: number;
  /** 백엔드에 넘길 목적지 — 정규화하고 서브트리 밖의 철자로 맞춘 값. `null` = 최상위. */
  value: string | null;
  /** 목적지 자체가 안 되는 사유. 있으면 아래 셋은 비어 있다. */
  invalid: string | null;
  /** 이미 있는 카테고리와 합쳐진다 — 겹치는 가장 얕은 키와 그 표시 이름. */
  merge: { key: string; label: string } | null;
  /** 옮기면 규칙을 어기는 업무. 하나라도 있으면 백엔드는 아무것도 쓰지 않는다. */
  errors: { title: string; code: CategoryError }[];
  /** 가장 깊은 업무 하나의 전후. */
  example: { from: string; to: string | null } | null;
}

/**
 * 경로 바꾸기 · 상위로 올리기의 미리보기. 판정은 백엔드(`move_category`)와 같다 — 백엔드가
 * 최종 판정을 하고, 이것은 누르기 전에 같은 결과를 보여 줄 뿐이다.
 *
 * 합치기: 옮긴 뒤의 키(와 그 상위)가 서브트리 밖 업무의 키(와 그 상위)와 겹치면 이미 있는
 * 카테고리에 섞이는 것이다. 목적지의 상위는 겹쳐도 그 아래로 들어가는 것뿐이라 빼고, 상위로
 * 올릴 때는 목적지 자신도 뺀다 — 원래 그 안에 있던 업무다. 대소문자만 고치는 것은 서브트리
 * 밖에 같은 키가 없으니 합치기가 아니다.
 */
export function movePlan<T extends { title: string; category: string | null }>(
  tasks: T[],
  fromKey: string,
  to: string | null,
  isArchived: (t: T) => boolean,
): MovePlan<T> {
  const moving: [T, string[]][] = [];
  const others: T[] = [];
  const subs = new Set<string>();
  for (const t of tasks) {
    const tail = tailOf(t.category, fromKey);
    if (!tail) {
      others.push(t);
      continue;
    }
    moving.push([t, tail]);
    tail.forEach((_, i) => subs.add([fromKey, ...tail.slice(0, i + 1).map(categoryKey)].join("/")));
  }
  const targets = moving.map(([t]) => t);
  const plan: MovePlan<T> = {
    targets,
    archived: targets.filter(isArchived).length,
    subcats: subs.size,
    value: null,
    invalid: null,
    merge: null,
    errors: [],
    example: null,
  };

  if (to !== null) {
    const norm = normalizeCategory(to);
    if (norm.error) return { ...plan, invalid: categoryErrorMessage(norm.error) };
    // 미분류로 돌리는 것은 [해제] 다 — 빈 칸이 몰래 최상위로 올리기가 되지 않게.
    if (norm.value === null) {
      return { ...plan, invalid: "옮길 경로를 입력하세요 — 미분류로 돌리려면 [해제] 를 쓰세요" };
    }
    // 서브트리의 철자로는 맞추지 않는다 — 맞추면 `proj` → `Proj` 처럼 대소문자만 고칠 수 없다.
    plan.value = snapToExisting(norm.value, knownCategories(others));
    if (categoryKey(plan.value).startsWith(`${fromKey}/`)) {
      return { ...plan, invalid: "자기 하위 카테고리로는 옮길 수 없습니다" };
    }
  }

  const fresh: string[] = [];
  let deepest = -1;
  for (const [t, tail] of moving) {
    const got = moveTail(tail, plan.value);
    if (got.error) {
      plan.errors.push({ title: t.title, code: got.error });
      continue;
    }
    if (got.value) fresh.push(...revealKeys(got.value));
    const depth = segments(t.category).length;
    if (depth > deepest) {
      deepest = depth;
      plan.example = { from: t.category!, to: got.value };
    }
  }

  const exists = new Set(others.flatMap((t) => (t.category ? revealKeys(t.category) : [])));
  const own = plan.value ? revealKeys(plan.value) : [];
  const up = plan.value === null || fromKey.startsWith(`${categoryKey(plan.value)}/`);
  const into = new Set(up ? own : own.slice(0, -1));
  const clash = fresh
    .filter((k) => !into.has(k) && exists.has(k))
    .sort((a, b) => segments(a).length - segments(b).length)[0];
  if (clash !== undefined) {
    const depth = segments(clash).length;
    // 이름은 그 키를 가진 첫 업무의 철자로 — 겹친 것은 서브트리 밖의 카테고리다.
    const first = others.find((t) => t.category && revealKeys(t.category).includes(clash))!;
    plan.merge = { key: clash, label: label(segments(first.category).slice(0, depth).join("/")) };
  }
  return plan;
}
