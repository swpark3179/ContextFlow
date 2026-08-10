import { describe, expect, it } from "vitest";
import { dirsOf, flatten, type FileEntry } from "./tree";

function f(p: string, dir = false): FileEntry {
  return {
    p,
    name: p.replace(/\/$/, "").split("/").pop() ?? p,
    dir,
    size: dir ? "" : "1.0 KB",
    bytes: dir ? 0 : 1024,
    bin: false,
    link: null,
  };
}

const LIST: FileEntry[] = [
  f("index.md"),
  f("notes.md"),
  f("refs/", true),
  f("refs/guide.md"),
  f("refs/deep/", true),
  f("refs/deep/note.md"),
  f("attachments/", true),
  f("attachments/shot.png"),
];

describe("flatten", () => {
  it("nests directories above files and reports child counts", () => {
    const rows = flatten(LIST, {});
    const paths = rows.map((r) => r.path);
    // Directories come first at each level, files last — the design's order.
    expect(paths).toEqual([
      "refs/",
      "refs/deep/",
      "refs/deep/note.md",
      "refs/guide.md",
      "attachments/",
      "attachments/shot.png",
      "index.md",
      "notes.md",
    ]);
    const refs = rows.find((r) => r.path === "refs/");
    expect(refs?.kind === "dir" && refs.count).toBe(2);
  });

  it("increases depth with nesting", () => {
    const rows = flatten(LIST, {});
    expect(rows.find((r) => r.path === "refs/")?.depth).toBe(0);
    expect(rows.find((r) => r.path === "refs/deep/")?.depth).toBe(1);
    expect(rows.find((r) => r.path === "refs/deep/note.md")?.depth).toBe(2);
  });

  it("hides children of collapsed folders", () => {
    const rows = flatten(LIST, { "refs/": false });
    const paths = rows.map((r) => r.path);
    expect(paths).toContain("refs/");
    expect(paths).not.toContain("refs/guide.md");
    expect(paths).not.toContain("refs/deep/note.md");
    // Sibling folders stay open.
    expect(paths).toContain("attachments/shot.png");
  });

  it("treats an absent key as open, matching the design's openMap semantics", () => {
    expect(flatten(LIST, { "refs/": true }).map((r) => r.path)).toContain("refs/guide.md");
  });
});

describe("dirsOf", () => {
  it("lists every directory prefix once, sorted", () => {
    expect(dirsOf(LIST)).toEqual(["attachments/", "refs/", "refs/deep/"]);
  });

  it("infers directories from file paths alone", () => {
    expect(dirsOf([f("src/tauri/main.rs")])).toEqual(["src/", "src/tauri/"]);
  });
});
