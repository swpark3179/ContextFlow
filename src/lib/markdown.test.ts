import { describe, expect, it } from "vitest";
import { fmValue, mdParse, mdSegs, splitFrontmatter } from "./markdown";

describe("mdSegs", () => {
  it("splits wikilinks, code spans and bold out of plain text", () => {
    const segs = mdSegs("관련 표준 절차: [[Templates/Tauri 표준절차]] 와 `tauri.conf.json`", "k");
    expect(segs.map((s) => s.text)).toEqual([
      "관련 표준 절차: ",
      "Templates/Tauri 표준절차",
      " 와 ",
      "tauri.conf.json",
    ]);
    expect(segs[1].isLink).toBe(true);
    expect(segs[3].isCode).toBe(true);
  });

  it("marks bold runs", () => {
    const segs = mdSegs("v2에서는 **capabilities** 파일을 씁니다", "k");
    expect(segs.find((s) => s.isB)?.text).toBe("capabilities");
  });

  it("marks ~~strikethrough~~ runs and drops the tildes", () => {
    const segs = mdSegs("이 단계는 ~~직접 빌드~~ 대신 배포본을 쓴다", "k");
    expect(segs.map((s) => s.text)).toEqual(["이 단계는 ", "직접 빌드", " 대신 배포본을 쓴다"]);
    expect(segs[1].isStrike).toBe(true);
    expect(segs[0].isStrike).toBe(false);
  });

  it("leaves a lone tilde pair alone", () => {
    // 여는 물결표만 있거나 사이가 비면 취소선이 아니다 — 본문 그대로 둔다.
    expect(mdSegs("~~닫히지 않은 표기", "k")[0].isStrike).toBe(false);
    expect(mdSegs("~~~~", "k")[0].isStrike).toBe(false);
    expect(mdSegs("경로: ~/notes 와 ~/vault", "k")[0].isStrike).toBe(false);
  });

  it("always returns at least one segment", () => {
    expect(mdSegs("", "k")).toHaveLength(1);
  });
});

describe("mdParse", () => {
  it("renders headings, rules and paragraphs", () => {
    const blocks = mdParse("## 배경\n설명 문장\n\n---\n### 하위\n");
    expect(blocks[0].isH2).toBe(true);
    expect(blocks[0].text).toBe("배경");
    expect(blocks[1].isBody).toBe(true);
    expect(blocks[2].isHr).toBe(true);
    expect(blocks[3].isH3).toBe(true);
  });

  it("distinguishes checked from unchecked task items", () => {
    const [open, done] = mdParse("- [ ] 할 일\n- [x] 끝난 일");
    expect(open.mark).toBe("☐");
    expect(done.mark).toBe("☑");
    // Completed items are dimmed, matching the design.
    expect(done.fg).toBe("#8a857c");
  });

  it("keeps nested bullets deeper than flush ones", () => {
    const [flush, nested] = mdParse("- 최상위\n    - 하위 항목");
    expect(flush.indent).toBe(2);
    expect(flush.mark).toBe("·");
    expect(nested.indent).toBe(18);
    expect(nested.mark).toBe("–");
  });

  it("handles quotes and ordered items", () => {
    const [quote, ordered] = mdParse("> 인용문\n1. 첫 항목");
    expect(quote.mark).toBe("│");
    expect(ordered.mark).toBe("1.");
  });

  it("drops blank lines instead of emitting empty blocks", () => {
    expect(mdParse("한 줄\n\n\n두 줄")).toHaveLength(2);
  });
});

describe("splitFrontmatter", () => {
  const withFm = "---\nid: task-1\nstatus: in-progress\n---\n## 배경\n내용\n";

  it("separates the yaml block from the body", () => {
    const { fm, body } = splitFrontmatter(withFm);
    expect(fm).toBe("id: task-1\nstatus: in-progress");
    expect(body).toBe("## 배경\n내용\n");
  });

  it("treats a file without frontmatter as all body", () => {
    const { fm, body } = splitFrontmatter("# 노트\n내용");
    expect(fm).toBe("");
    expect(body).toBe("# 노트\n내용");
  });

  it("reads scalars and strips quotes", () => {
    const { fm } = splitFrontmatter(
      '---\ntemplate_ref: "[[Templates/표준절차]]"\nstatus: on-hold\n---\n본문',
    );
    expect(fmValue(fm, "template_ref")).toBe("[[Templates/표준절차]]");
    expect(fmValue(fm, "status")).toBe("on-hold");
    expect(fmValue(fm, "missing")).toBe("");
  });
});
