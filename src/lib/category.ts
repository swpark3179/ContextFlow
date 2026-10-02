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
      /** 이 업무가 직접 든 묶음의 키(미분류 `""`). 끌어 옮기기는 이 안에서만 한다. */
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
