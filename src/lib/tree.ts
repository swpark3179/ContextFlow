/**
 * File-tree assembly ported from design/ContextFlow.dc.html
 * (`buildTree` / `dirsOf` / `walk`, lines 1240-1278). The backend returns a flat
 * list of paths; this rebuilds the nesting and flattens it again in display
 * order honouring the collapsed-folder map.
 */

export interface FileEntry {
  /** Task-folder-relative path; directories carry a trailing `/`. */
  p: string;
  name: string;
  dir: boolean;
  size: string;
  bytes: number;
  bin: boolean;
  link: string | null;
}

interface TreeNode {
  dirs: Record<string, TreeNode>;
  order: string[];
  files: FileEntry[];
}

export type Row =
  | { kind: "dir"; name: string; path: string; depth: number; open: boolean; count: number }
  | {
      kind: "file";
      name: string;
      path: string;
      depth: number;
      size: string;
      bin: boolean;
      link: string | null;
    };

function emptyNode(): TreeNode {
  return { dirs: {}, order: [], files: [] };
}

export function buildTree(list: FileEntry[]): TreeNode {
  const root = emptyNode();
  const ensure = (parts: string[], n: number): TreeNode => {
    let node = root;
    for (let i = 0; i < n; i++) {
      const d = parts[i];
      if (!node.dirs[d]) {
        node.dirs[d] = emptyNode();
        node.order.push(d);
      }
      node = node.dirs[d];
    }
    return node;
  };
  list.forEach((f) => {
    const parts = f.p.replace(/\/$/, "").split("/");
    if (f.dir) {
      ensure(parts, parts.length);
      return;
    }
    ensure(parts, parts.length - 1).files.push({ ...f, name: parts[parts.length - 1] });
  });
  return root;
}

/** Every directory path in the list, for the import modal's target picker. */
export function dirsOf(list: FileEntry[]): string[] {
  const out: Record<string, boolean> = {};
  list.forEach((f) => {
    const parts = f.p.replace(/\/$/, "").split("/");
    const n = f.dir ? parts.length : parts.length - 1;
    let pre = "";
    for (let i = 0; i < n; i++) {
      pre += parts[i] + "/";
      out[pre] = true;
    }
  });
  return Object.keys(out).sort();
}

/** `openMap[path] === false` means collapsed; anything else is open. */
export function walk(
  node: TreeNode,
  prefix: string,
  depth: number,
  openMap: Record<string, boolean>,
  out: Row[],
): void {
  node.order.forEach((d) => {
    const path = prefix + d + "/";
    const open = openMap[path] !== false;
    const kid = node.dirs[d];
    out.push({
      kind: "dir",
      name: d,
      path,
      depth,
      open,
      count: kid.order.length + kid.files.length,
    });
    if (open) walk(kid, path, depth + 1, openMap, out);
  });
  node.files.forEach((f) =>
    out.push({
      kind: "file",
      name: f.name,
      path: f.p,
      depth,
      size: f.size,
      bin: f.bin,
      link: f.link,
    }),
  );
}

export function flatten(list: FileEntry[], openMap: Record<string, boolean>): Row[] {
  const rows: Row[] = [];
  walk(buildTree(list), "", 0, openMap, rows);
  return rows;
}
