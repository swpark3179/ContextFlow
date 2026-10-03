import { keyOf, label as categoryLabel, UNCAT_LABEL } from "./category";
import type { CategoryNode } from "./category";
import { qLabel } from "./format";

export interface ArchiveGroup<T> {
  /** 가상 스크롤의 머리 행 키. 같은 라벨이 다시 나와도 겹치지 않는다. */
  key: string;
  label: string;
  count: number;
  items: T[];
  /**
   * 카테고리로 묶었을 때 그 묶음의 키(`keyOf`). 미분류는 `""` 라 참 · 거짓으로 가르면 빠진다 —
   * `undefined` 와 견준다. 분기로 묶었으면 없다.
   */
  cat?: string;
}

/**
 * 보관함 목록을 묶는다. `sorted` 는 거르고 완료일 내림차순으로 정렬을 마친 것이고, 묶음 안은
 * 그 순서 그대로다.
 *
 * `quarter` 는 **이어지는** 같은 분기끼리 묶는다. 완료일 없는 업무는 보관일로 라벨을 얻으면서도
 * 정렬은 맨 뒤라 앞에서 본 분기가 다시 나올 수 있다 — 그래서 키에 순번을 넣는다.
 *
 * `category` 는 전체 경로마다 평평한 묶음 하나(직속 업무가 있는 것만), 순서는 `nodes`
 * (`knownCategories(보관 전체)`)를 따르고 미분류는 맨 끝이다. `nodes` 가 `sorted` 의 카테고리를
 * 모두 담고 있어야 한다 — 없는 카테고리의 업무는 어느 묶음에도 들지 않는다.
 */
export function groupArchived<
  T extends { category: string | null; completedAt: string | null; archivedAt: string | null },
>(sorted: T[], mode: "quarter" | "category", nodes: CategoryNode[]): ArchiveGroup<T>[] {
  if (mode === "quarter") {
    const out: ArchiveGroup<T>[] = [];
    for (const t of sorted) {
      const label = qLabel(t.completedAt ?? t.archivedAt ?? "");
      let g = out[out.length - 1];
      if (!g || g.label !== label) {
        g = { key: `h:q:${out.length}:${label}`, label, count: 0, items: [] };
        out.push(g);
      }
      g.items.push(t);
      g.count = g.items.length;
    }
    return out;
  }

  const byKey = new Map<string, T[]>();
  for (const t of sorted) {
    const k = keyOf(t.category);
    const items = byKey.get(k);
    if (items) items.push(t);
    else byKey.set(k, [t]);
  }
  const group = (key: string, text: string): ArchiveGroup<T>[] => {
    const items = byKey.get(key);
    return items ? [{ key: `h:c:${key}`, label: text, count: items.length, items, cat: key }] : [];
  };
  // 표시 철자는 `nodes` 에서 — 대소문자만 다른 업무들이 한 묶음에 섞여도 라벨은 하나다.
  return [...nodes.flatMap((n) => group(n.key, categoryLabel(n.path))), ...group("", UNCAT_LABEL)];
}

/**
 * 보관함 MOC(`_index/Archive.md`)의 Dataview 블록 — 여닫는 펜스 줄까지 한 줄씩. 보관함 오른쪽 패널의
 * 미리보기가 그린다. src-tauri/src/vault.rs write_archive_moc 와 같게.
 *
 * 보관 판정은 `isArchived` 와 같다. `completed_at AND` 를 빼면 안 된다 — Dataview 는 null 을 어느 값보다
 * 작게 보아 완료일 없는 완료 업무까지 보관으로 잡는다. 깊이 regex 는 `reference/` 사본과 편입된 하위
 * 노트를 막는다.
 */
export function archiveDataview(archDays: number): string[] {
  const archived =
    archDays > 0
      ? `(archived = true OR (archived = null AND status = "completed" AND completed_at AND completed_at <= date(today) - dur(${archDays} days)))`
      : "archived = true";
  return [
    "```dataview",
    'TABLE WITHOUT ID link(file.path, title) AS "업무", completed_at AS "완료", category AS "카테고리"',
    'FROM "Tasks" OR "Archive"',
    `WHERE file.name = "index" AND regexmatch("^(Tasks/[^/]+|Archive/[^/]+/[^/]+)$", file.folder) AND ${archived}`,
    "SORT completed_at DESC",
    "```",
  ];
}
