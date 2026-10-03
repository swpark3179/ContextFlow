/**
 * 위키 페이지의 카테고리 — 앱의 위키 화면이 카테고리로 거르고 페이지에 칩을 다는 계산. 순수 함수만.
 *
 * 위키 페이지에는 카테고리를 쓰지 않는다. 페이지를 뒷받침하는 **업무**의 카테고리를 그때그때
 * 본다 — 업무 카테고리를 바꾸면 위키 상태를 다시 읽지 않아도 목록 · 칩이 바로 따라간다.
 *
 * 규칙은 Obsidian 허브(`src-tauri/src/hub.rs` 의 `View::members` · `wiki_of` · `sources`)와
 * **같아야** 한다. 둘이 같은 fixture(`categories.json`)로 시험한다. 허브와 다른 것은 둘이다.
 *
 * * 허브의 '위키' 절 · `위키 N` 은 소스가 아닌 페이지만 센다. 여기의 개수는 소스 페이지도 센다.
 * * 같은 업무의 소스 페이지가 둘 이상이면 허브는 경로순 마지막 하나만 링크하고, 여기는 모두 넣는다.
 */
import { isWithin, keyOf, knownCategories, revealKeys, UNCAT_LABEL, type CategoryNode } from "../category";

/**
 * 멤버십 계산에 필요한 업무 조각. `TaskMeta` 도, fixture 의 `{id, category}` 도 캐스트 없이 넣는다.
 */
export interface CatTask {
  id: string;
  category: string | null;
}

/**
 * 멤버십 계산에 필요한 페이지 조각. `kind` 를 `WikiKind` 가 아닌 `string` 으로 두는 것도
 * fixture 를 캐스트 없이 넣기 위함이다.
 */
export interface CatPage {
  path: string;
  kind: string;
  taskId: string | null;
  sources: string[];
}

/** 업무 id → 그 id 를 가진 업무들의 카테고리. 같은 id 의 업무가 여럿일 수 있어 멀티맵이다. */
export type TaskCatIndex = Map<string, (string | null)[]>;

export function taskCategories(tasks: CatTask[]): TaskCatIndex {
  const idx: TaskCatIndex = new Map();
  for (const t of tasks) {
    const cats = idx.get(t.id);
    if (cats) cats.push(t.category);
    else idx.set(t.id, [t.category]);
  }
  return idx;
}

/**
 * 페이지를 뒷받침하는 업무 id. 소스 페이지는 자기 업무(`taskId`) 하나뿐이고 `sources` 는 보지
 * 않는다. 그 밖의 페이지는 `sources` 이고, 남은 `taskId` 는 보지 않는다(`fileAnswer` 와 같은 식).
 */
function backingIds(page: CatPage): string[] {
  if (page.kind === "source") return page.taskId ? [page.taskId] : [];
  return page.sources;
}

/** 코드포인트 순 비교 — `knownCategories` 가 형제를 놓는 순서와 같다. */
function ordinal(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

/**
 * 키를 `knownCategories` 의 트리 순서로 — 단계마다 견주고, 상위가 하위보다 앞이다. 키 문자열을
 * 통째로 견주면 `/` 가 공백보다 뒤라서 `a/x` 가 `a b` 뒤로 간다. 미분류 `""` 는 맨 끝이다.
 */
function treeOrder(a: string, b: string): number {
  if (a === "" || b === "") return (a === "" ? 1 : 0) - (b === "" ? 1 : 0);
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < x.length && i < y.length; i++) {
    const d = ordinal(x[i], y[i]);
    if (d) return d;
  }
  return x.length - y.length;
}

/**
 * 페이지가 직접 든 카테고리 키 — 뒷받침하는 업무들의 키(미분류 `""`)를 중복 없이, 트리 순서로.
 * 상위 키는 넣지 않는다(그것은 `categoryPageCounts` 가 센다). 업무와 이어지지 않은 페이지는 `[]` 다.
 */
export function pageCategoryKeys(page: CatPage, idx: TaskCatIndex): string[] {
  const keys = new Set<string>();
  for (const id of backingIds(page)) for (const cat of idx.get(id) ?? []) keys.add(keyOf(cat));
  return [...keys].sort(treeOrder);
}

/**
 * 페이지가 카테고리 `key`(하위 포함)에 드는가. 뒷받침하는 업무 하나라도 그 안이면 든다.
 * `key === ""` 는 미분류 업무 하나로 충분하다. 출처 없는 답변 · 지워진 업무만 가리키는 페이지 ·
 * 고아 소스는 어디에도, 미분류에도 들지 않는다(허브와 같다).
 */
export function inCategory(page: CatPage, key: string, idx: TaskCatIndex): boolean {
  return backingIds(page).some((id) => (idx.get(id) ?? []).some((cat) => isWithin(cat, key)));
}

/**
 * 키(미분류 `""` 포함)마다 든 페이지 수. 상위 노드는 하위의 **합집합**이다 — 한 페이지가 `a/b` 와
 * `a/c` 에 다 들어도 `a` 에는 한 번 센다. 늘 `pages.filter(p => inCategory(p, k, idx)).length` 와 같다.
 */
export function categoryPageCounts(pages: CatPage[], idx: TaskCatIndex): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const keys = new Set(pageCategoryKeys(p, idx).flatMap((k) => revealKeys(k)));
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** 위키 화면 카테고리 고르기의 한 줄 — 페이지가 있는 노드, 그리고 맨 끝의 미분류. */
export interface WikiCatOption {
  /** 거르기 키(`keyOf`). 미분류는 `""`. */
  key: string;
  /** 표시 철자의 전체 경로(전체 업무 기준). 미분류는 `""`. */
  path: string;
  /** 고르기에 보일 이름 — 마지막 단계. 미분류는 `미분류`. */
  name: string;
  /** 1부터. 미분류는 1. */
  depth: number;
  /** 이 노드(하위 포함)에 든 위키 페이지 수 — 소스 페이지도 센다. 업무 수가 아니다. */
  count: number;
}

export interface WikiCategoryView<P extends CatPage> {
  idx: TaskCatIndex;
  /** 키 → 노드. 표시 철자는 전체 업무 기준이다(허브와 같다). */
  byKey: Map<string, CategoryNode>;
  /** `knownCategories(tasks)` — 노드의 `count` 는 업무 수다. */
  nodes: CategoryNode[];
  /** `categoryPageCounts` — 페이지가 없는 키는 빠져 있다. */
  counts: Map<string, number>;
  /** 고르기의 선택지(전체 줄은 빼고). */
  opts: WikiCatOption[];
  /** 실제로 거르는 키. 고른 키에 페이지가 없으면(없는 키 · 0페이지) `null` = 전체다. */
  effCat: string | null;
  /** 거른 페이지. 거르지 않으면 받은 `pages` 그대로(같은 배열)다. */
  shown: P[];
  /** 페이지가 있는 카테고리 노드(미분류 제외)가 있는가 — 없으면 고르기 · 칩을 그리지 않는다. */
  hasCats: boolean;
}

/**
 * 위키 화면이 쓰는 카테고리 계산을 한 번에. `sel` 은 스토어의 `wikiCat`(`null` = 전체, `""` = 미분류).
 *
 * 선택지에는 페이지가 있는 노드만 든다 — 업무만 있고 페이지가 없는 카테고리를 고르면 빈 목록뿐이다.
 * 고른 키가 그렇게 되면(업무 카테고리를 바꿈 · 페이지가 지워짐) `effCat` 이 `null` 로 돌아간다.
 */
export function wikiCategoryView<P extends CatPage>(
  tasks: CatTask[],
  pages: P[],
  sel: string | null,
): WikiCategoryView<P> {
  const idx = taskCategories(tasks);
  const nodes = knownCategories(tasks);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const counts = categoryPageCounts(pages, idx);
  const opts: WikiCatOption[] = [];
  for (const n of nodes) {
    const count = counts.get(n.key) ?? 0;
    if (count) opts.push({ key: n.key, path: n.path, name: n.name, depth: n.depth, count });
  }
  // 미분류를 더하기 전에 본다 — 미분류뿐이면 고를 카테고리가 없다.
  const hasCats = opts.length > 0;
  const uncat = counts.get("") ?? 0;
  if (uncat) opts.push({ key: "", path: "", name: UNCAT_LABEL, depth: 1, count: uncat });
  const effCat = sel !== null && (counts.get(sel) ?? 0) > 0 ? sel : null;
  const shown = effCat === null ? pages : pages.filter((p) => inCategory(p, effCat, idx));
  return { idx, byKey, nodes, counts, opts, effCat, shown, hasCats };
}

/**
 * 검색 결과를 `paths` 에 든 것만 남기고 `max` 건으로 자른다. **거른 뒤에** 자른다 — 먼저 자르면
 * 그 카테고리의 결과가 앞의 다른 결과에 밀려 사라진다. 순서(관련도)는 그대로다. `paths` 가 `null`
 * 이면 자르기만 한다.
 */
export function narrowHits<H extends { path: string }>(hits: H[], paths: Iterable<string> | null, max = 30): H[] {
  if (paths === null) return hits.slice(0, max);
  const keep = new Set(paths);
  return hits.filter((h) => keep.has(h.path)).slice(0, max);
}

/** 페이지 칩 하나. `path` 는 노드의 표시 철자(전체 업무 기준)이고, 미분류는 `미분류` 다. */
export interface PageChip {
  key: string;
  path: string;
}

/**
 * 페이지 패널의 카테고리 칩 — 앞의 `max` 개와 나머지(`외 n` · 그 title 용). 순서는
 * `pageCategoryKeys` 와 같고 미분류가 맨 끝이다. 업무와 이어지지 않은 페이지는 둘 다 빈 배열이다.
 */
export function pageChips(
  page: CatPage,
  idx: TaskCatIndex,
  byKey: Map<string, CategoryNode>,
  max = 2,
): { chips: PageChip[]; rest: PageChip[] } {
  const all = pageCategoryKeys(page, idx).map((key) => ({
    key,
    path: key === "" ? UNCAT_LABEL : (byKey.get(key)?.path ?? key),
  }));
  return { chips: all.slice(0, max), rest: all.slice(max) };
}
