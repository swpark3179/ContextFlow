import { describe, expect, it } from "vitest";
import { fmValue, mdParse, mdSegs, splitFrontmatter, toggleTaskLine } from "./markdown";

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

  it("reads a rule at any indentation, and in its other spellings", () => {
    for (const line of ["---", "      ---", "***", "___", "-----"]) {
      expect(mdParse(line)[0].isHr).toBe(true);
    }
    // 세 글자가 안 되거나 사이에 글자가 섞이면 구분선이 아니다.
    expect(mdParse("--")[0].isHr).toBe(false);
    expect(mdParse("--- 끝")[0].isHr).toBe(false);
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

describe("mdParse — 펜스 코드 블록", () => {
  it("keeps a fenced block whole instead of scattering its lines", () => {
    const [intro, code, after] = mdParse(
      "설명\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n뒷말",
    );
    expect(intro.isBody).toBe(true);
    expect(code.isFence).toBe(true);
    expect(code.lang).toBe("ts");
    // 블록 안의 빈 줄은 코드의 일부다 — 본문에서처럼 버리지 않는다.
    expect(code.code).toBe("const a = 1;\n\nconst b = 2;");
    expect(after.segs[0].text).toBe("뒷말");
  });

  it("does not read the fence markers as body text", () => {
    expect(mdParse("```\n$ cargo test\n```")).toHaveLength(1);
  });

  it("treats ~~~ as a fence and never as strikethrough", () => {
    const [b] = mdParse("~~~bash\necho ~~hi~~\n~~~");
    expect(b.isFence).toBe(true);
    expect(b.lang).toBe("bash");
    expect(b.code).toBe("echo ~~hi~~");
  });

  it("closes an unterminated fence at the end of the document", () => {
    const [b] = mdParse("```\n한 줄\n또 한 줄");
    expect(b.isFence).toBe(true);
    expect(b.code).toBe("한 줄\n또 한 줄");
  });

  it("drops blank lines at the end of a block but keeps the ones inside", () => {
    // 파일 마지막 개행이 카드에 빈 줄과 잘못된 줄 수를 남기지 않게 한다.
    expect(mdParse("```\na\n\nb\n\n\n")[0].code).toBe("a\n\nb");
    expect(mdParse("```\na\n\n```\n")[0].code).toBe("a");
  });

  it("needs a fence of the same length to close", () => {
    // 안쪽의 ``` 로 닫히면 블록이 반토막 난다.
    const [b] = mdParse("````\n```\nnested\n```\n````");
    expect(b.code).toBe("```\nnested\n```");
  });

  it("strips the opening fence's own indentation from the code", () => {
    const blocks = mdParse("- 항목\n    ```\n    ls -al\n    ```");
    expect(blocks[1].code).toBe("ls -al");
  });

  it("does not mistake a horizontal rule for a fence", () => {
    expect(mdParse("---").every((b) => b.isHr)).toBe(true);
  });

  it("does not open a fence on a line that closes its own backticks", () => {
    // ```x``` 한 줄을 여는 펜스로 읽으면 닫는 펜스가 없어 문서의 나머지 전부가
    // 코드가 된다. 백틱 펜스의 정보 문자열에는 백틱이 못 온다(CommonMark).
    const blocks = mdParse("```x``` 를 쓴다\n- [ ] 남은 항목");
    expect(blocks[0].isFence).toBe(false);
    expect(blocks[1].isTask).toBe(true);
  });
});

describe("mdParse — 줄 번호와 목록 깊이", () => {
  it("carries the source line of every block", () => {
    const blocks = mdParse("## 제목\n\n- [ ] 할 일\n```\nx\n```\n끝");
    expect(blocks.map((b) => b.line)).toEqual([0, 2, 3, 6]);
  });

  it("reads task items at any indentation, and marks them toggleable", () => {
    const [top, nested] = mdParse("- [ ] 위\n    - [x] 아래");
    expect(top.isTask).toBe(true);
    expect(top.checked).toBe(false);
    expect(top.indent).toBe(2);
    expect(nested.isTask).toBe(true);
    expect(nested.checked).toBe(true);
    expect(nested.mark).toBe("☑");
    expect(nested.indent).toBe(18);
  });

  it("counts depth by comparing with ancestors, not by width", () => {
    // 2칸 · 4칸 · 탭이 섞인 문서도 같은 계단으로 읽힌다.
    const two = mdParse("- a\n  - b\n    - c").map((b) => b.indent);
    const four = mdParse("- a\n    - b\n        - c").map((b) => b.indent);
    expect(two).toEqual([2, 18, 34]);
    expect(four).toEqual(two);
  });

  it("starts a new list after a paragraph breaks it", () => {
    const blocks = mdParse("    - 깊은 항목\n문단\n    - 다시 첫 단계");
    expect(blocks[0].indent).toBe(2);
    expect(blocks[2].indent).toBe(2);
  });

  it("separates # from ## so the viewer can size them apart", () => {
    const [h1, h2] = mdParse("# 문서 제목\n## 절 제목");
    expect(h1.isH1).toBe(true);
    expect(h1.isH2).toBe(false);
    expect(h2.isH2).toBe(true);
  });
});

describe("toggleTaskLine", () => {
  const src = "## 할 일\n- [ ] 첫째\n    - [x] 둘째\n평범한 줄";

  it("flips an unchecked box and leaves the rest byte-identical", () => {
    expect(toggleTaskLine(src, 1)).toBe("## 할 일\n- [x] 첫째\n    - [x] 둘째\n평범한 줄");
  });

  it("flips a checked box back, keeping its indentation", () => {
    expect(toggleTaskLine(src, 2)).toBe("## 할 일\n- [ ] 첫째\n    - [ ] 둘째\n평범한 줄");
  });

  it("returns null for a line that is not a task", () => {
    expect(toggleTaskLine(src, 0)).toBeNull();
    expect(toggleTaskLine(src, 3)).toBeNull();
    expect(toggleTaskLine(src, 99)).toBeNull();
    expect(toggleTaskLine(src, -1)).toBeNull();
  });

  it("keeps CRLF line endings and trailing spaces as they were", () => {
    // 대괄호 안쪽 한 글자만 바꾼다 — 체크 하나에 파일 전체가 다시 쓰이면 안 된다.
    const crlf = "- [ ] 첫째  \r\n- [ ] 둘째\r\n";
    expect(toggleTaskLine(crlf, 0)).toBe("- [x] 첫째  \r\n- [ ] 둘째\r\n");
  });

  it("uppercase [X] counts as done and toggles off", () => {
    expect(toggleTaskLine("* [X] 끝", 0)).toBe("* [ ] 끝");
  });
});

describe("splitFrontmatter — bodyLine", () => {
  /** 뷰어가 체크박스를 눌렀을 때 실제로 밟는 길. 여기가 한 줄 밀리면 다른 줄이 토글된다. */
  const clickFirstTask = (doc: string) => {
    const { fm, body, bodyLine } = splitFrontmatter(doc);
    const task = mdParse(body).find((b) => b.isTask);
    return {
      fm,
      line: task ? bodyLine + task.line : -1,
      hit: task ? doc.split("\n")[bodyLine + task.line] : "",
      toggled: task ? toggleTaskLine(doc, bodyLine + task.line) : null,
    };
  };

  it("lands on the line the viewer drew", () => {
    const doc = "---\nid: task-1\nstatus: in-progress\n---\n- [ ] 첫 줄\n- [ ] 둘째 줄\n";
    const { fm, line, hit } = clickFirstTask(doc);
    expect(fm).toBe("id: task-1\nstatus: in-progress");
    expect(line).toBe(4);
    expect(hit).toBe("- [ ] 첫 줄");
  });

  it("survives a closing line that is not exactly three dashes", () => {
    // `--- ` (뒤 공백) · `----` (대시 넷) 모두 Obsidian 이 프런트마터로 읽는다.
    // 프런트마터 줄 수를 세어 짐작하면 여기서 한 줄이 밀려 둘째 항목이 토글된다.
    for (const close of ["--- ", "----", "---\t"]) {
      const doc = `---\nid: task-1\n${close}\n- [ ] 첫 줄\n- [ ] 둘째 줄\n`;
      const { hit } = clickFirstTask(doc);
      expect(hit).toBe("- [ ] 첫 줄");
    }
  });

  it("handles an empty frontmatter block", () => {
    const doc = "---\n---\n- [ ] 첫 줄\n";
    const { fm, body, bodyLine } = splitFrontmatter(doc);
    expect(fm).toBe("");
    expect(body).toBe("- [ ] 첫 줄\n");
    expect(bodyLine).toBe(2);
    expect(clickFirstTask(doc).hit).toBe("- [ ] 첫 줄");
  });

  it("is zero for a note with no frontmatter", () => {
    const doc = "- [ ] 첫 줄\n";
    expect(splitFrontmatter(doc).bodyLine).toBe(0);
    expect(clickFirstTask(doc).toggled).toBe("- [x] 첫 줄\n");
  });

  it("leaves an unclosed block as body instead of guessing", () => {
    const doc = "---\nid: task-1\n- [ ] 첫 줄\n";
    const { fm, body, bodyLine } = splitFrontmatter(doc);
    expect(fm).toBe("");
    expect(body).toBe(doc);
    expect(bodyLine).toBe(0);
  });

  it("keeps CRLF documents in step", () => {
    const doc = "---\r\nid: task-1\r\n---\r\n- [ ] 첫 줄\r\n- [ ] 둘째 줄\r\n";
    const { toggled } = clickFirstTask(doc);
    expect(toggled).toBe("---\r\nid: task-1\r\n---\r\n- [x] 첫 줄\r\n- [ ] 둘째 줄\r\n");
  });
});
