import { describe, expect, it } from "vitest";
import { rebaseIndexDoc } from "./indexDoc";
import { splitFrontmatter } from "./markdown";

/** 편집기가 본문 한 글자를 고칠 때 파일을 다시 조립하는 방식(`EditorPane` 의 `onEdit`). */
function editorAssemble(text: string, body: string): string {
  const { fm } = splitFrontmatter(text);
  return fm ? `---\n${fm}\n---\n${body}` : body;
}

const OLD = "---\nid: task-1\nstatus: in-progress\n---\n## 개요\n처음 글\n";
const DISK = '---\nid: task-1\nstatus: on-hold\ncategory: "프로젝트/ContextFlow"\n---\n## 개요\n처음 글\n';

describe("rebaseIndexDoc", () => {
  it("본문을 고치지 않은 버퍼는 디스크 내용이 된다", () => {
    expect(rebaseIndexDoc(DISK, OLD)).toBe(DISK);
  });

  it("고치던 본문은 지키고 frontmatter 는 디스크를 따른다", () => {
    const buf = editorAssemble(OLD, "## 개요\n처음 글\n덧붙인 줄\n");
    const out = rebaseIndexDoc(DISK, buf);
    expect(out).toBe(
      '---\nid: task-1\nstatus: on-hold\ncategory: "프로젝트/ContextFlow"\n---\n## 개요\n처음 글\n덧붙인 줄\n',
    );
    // 다음 입력이 같은 머리로 조립되어야 한다 — 다르면 다시 한 번 되돌아간다.
    expect(editorAssemble(out, splitFrontmatter(out).body)).toBe(out);
  });

  it("frontmatter 가 없는 노트는 버퍼 그대로 둔다", () => {
    expect(rebaseIndexDoc("# 노트\n옛 글\n", "# 노트\n고친 글\n")).toBe("# 노트\n고친 글\n");
  });

  it("디스크에 frontmatter 가 새로 생기면 버퍼 전체가 본문이 된다", () => {
    expect(rebaseIndexDoc('---\ncategory: "운영"\n---\n# 노트\n', "# 노트\n고친 글\n")).toBe(
      '---\ncategory: "운영"\n---\n# 노트\n고친 글\n',
    );
  });

  it("디스크에서 frontmatter 가 사라졌으면 버퍼의 것도 버린다", () => {
    expect(rebaseIndexDoc("# 노트\n", "---\nid: task-1\n---\n# 노트\n고친 글\n")).toBe(
      "# 노트\n고친 글\n",
    );
  });

  it("CRLF 디스크도 같은 본문이면 그대로, 고친 본문이면 LF 로 조립한다", () => {
    const crlf = DISK.replace(/\n/g, "\r\n");
    expect(rebaseIndexDoc(crlf, OLD)).toBe(crlf);
    expect(rebaseIndexDoc(crlf, editorAssemble(OLD, "## 개요\n고친 글\n"))).toBe(
      '---\nid: task-1\nstatus: on-hold\ncategory: "프로젝트/ContextFlow"\n---\n## 개요\n고친 글\n',
    );
  });
});
