import { describe, expect, it } from "vitest";
import {
  blankTable,
  deleteCols,
  deleteRows,
  displayWidth,
  insertCol,
  insertRow,
  mergeBlocker,
  mergeCells,
  parseClipboardGrid,
  parseTableSource,
  parseTsv,
  pasteCells,
  placeTable,
  rectOf,
  replaceTableLines,
  setAlign,
  setCell,
  spliceBlock,
  tableFromGrid,
  tableToMarkdown,
  unmergeCells,
  type TableModel,
} from "./mdTable";
import { mdParse } from "./markdown";

const grid = (cells: string[][]): TableModel => tableFromGrid(cells);

describe("tableToMarkdown — GFM", () => {
  it("writes a padded pipe table with the first row as the header", () => {
    const t = grid([
      ["이름", "상태"],
      ["A", "진행"],
    ]);
    expect(tableToMarkdown(t)).toBe(
      ["| 이름 | 상태 |", "| ---- | ---- |", "| A    | 진행 |"].join("\n"),
    );
  });

  it("writes alignment markers and pads cells to match", () => {
    let t = grid([
      ["a", "b", "c", "d"],
      ["1", "2", "3", "4"],
    ]);
    t = setAlign(t, 1, 1, "left");
    t = setAlign(t, 2, 2, "center");
    t = setAlign(t, 3, 3, "right");
    expect(tableToMarkdown(t)).toBe(
      ["| a   | b   |  c  |   d |", "| --- | :-- | :-: | --: |", "| 1   | 2   |  3  |   4 |"].join("\n"),
    );
  });

  it("escapes pipes and turns line breaks into <br>", () => {
    const t = grid([["명령"], ["a | b\n둘째 줄"]]);
    const md = tableToMarkdown(t);
    expect(md).toContain("a \\| b<br>둘째 줄");
    // 이미 막아 둔 파이프를 두 번 막지 않는다.
    expect(tableToMarkdown(grid([["x"], ["a \\| b"]]))).toContain("a \\| b ");
  });

  it("reads back what it wrote", () => {
    let t = grid([
      ["항목", "값"],
      ["`a|b`", "**굵게**\n다음 줄"],
      ["", "빈 칸 옆"],
    ]);
    t = setAlign(t, 1, 1, "right");
    const back = parseTableSource(tableToMarkdown(t).split("\n"));
    expect(back).toEqual(t);
  });

  it("is parsed by the viewer as one table", () => {
    const md = tableToMarkdown(grid([["a", "b"], ["1", "2\n3"]]));
    const [b] = mdParse(md);
    expect(b.isTable).toBe(true);
    expect(b.end).toBe(3);
    expect(b.rows[0][1].map((g) => g.text).join("")).toBe("2\n3");
  });

  it("writes a header-only table", () => {
    expect(tableToMarkdown(grid([["a", "b"]]))).toBe("| a   | b   |\n| --- | --- |");
  });
});

describe("tableToMarkdown — 병합은 HTML 표", () => {
  const merged = () =>
    mergeCells(
      grid([
        ["분기", "", "비고"],
        ["1월", "2월", "**메모**"],
        ["10", "20", "a < b"],
      ]),
      { r0: 0, c0: 0, r1: 0, c1: 1 },
    );

  it("writes colspan / rowspan / align and converts inline marks", () => {
    let t = mergeCells(merged(), { r0: 1, c0: 2, r1: 2, c1: 2 });
    t = setAlign(t, 0, 0, "center");
    expect(tableToMarkdown(t)).toBe(
      [
        "<table>",
        "<thead>",
        '<tr><th colspan="2" align="center">분기</th><th>비고</th></tr>',
        "</thead>",
        "<tbody>",
        '<tr><td align="center">1월</td><td>2월</td><td rowspan="2"><strong>메모</strong><br>a &lt; b</td></tr>',
        '<tr><td align="center">10</td><td>20</td></tr>',
        "</tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("round-trips through the HTML parser", () => {
    let t = mergeCells(merged(), { r0: 1, c0: 2, r1: 2, c1: 2 });
    t = setAlign(t, 1, 1, "right");
    t = setCell(t, 2, 0, "`x|y` ~~지움~~ *기울임* [링크](https://a.b/?q=1&r=2) & 기호");
    const back = parseTableSource(tableToMarkdown(t).split("\n"));
    expect(back).toEqual(t);
  });

  it("is drawn by the viewer with its spans", () => {
    const md = tableToMarkdown(merged());
    const blocks = mdParse(`앞\n\n${md}\n\n뒤`);
    const t = blocks.find((b) => b.isTable)!;
    expect(t.line).toBe(2);
    expect(t.end).toBe(2 + md.split("\n").length);
    expect(t.spans[0]).toEqual([
      { rs: 1, cs: 2 },
      { rs: 0, cs: 0 },
      { rs: 1, cs: 1 },
    ]);
    expect(t.head[0].map((g) => g.text).join("")).toBe("분기");
    expect(t.rows[0][2].find((g) => g.isB)?.text).toBe("메모");
    expect(blocks[blocks.length - 1].segs[0].text).toBe("뒤");
  });

  it("goes back to a pipe table once every merge is undone", () => {
    const t = unmergeCells(merged(), { r0: 0, c0: 0, r1: 0, c1: 0 });
    expect(tableToMarkdown(t).startsWith("| 분기")).toBe(true);
  });
});

describe("병합", () => {
  it("joins the texts of the merged cells instead of dropping them", () => {
    const t = mergeCells(grid([["h", "h2"], ["a", "b"], ["c", ""]]), { r0: 1, c0: 0, r1: 2, c1: 1 });
    expect(t.merges).toEqual([{ r: 1, c: 0, rs: 2, cs: 2 }]);
    expect(t.cells[1][0]).toBe("a\nb\nc");
    expect(t.cells[2]).toEqual(["", ""]);
  });

  it("refuses to merge across the header row", () => {
    expect(mergeBlocker({ r0: 0, c0: 0, r1: 1, c1: 0 })).toMatch(/머리 행/);
    expect(mergeBlocker({ r0: 1, c0: 1, r1: 1, c1: 1 })).toMatch(/둘 이상/);
    expect(mergeBlocker({ r0: 1, c0: 0, r1: 2, c1: 0 })).toBeNull();
  });

  it("grows a selection to cover every merge it touches", () => {
    const t = mergeCells(blankTable(4, 4), { r0: 1, c0: 1, r1: 2, c1: 2 });
    expect(rectOf(t, { r: 1, c: 0 }, { r: 1, c: 1 })).toEqual({ r0: 1, c0: 0, r1: 2, c1: 2 });
  });
});

describe("행 · 열 넣기와 지우기", () => {
  const base = () => mergeCells(blankTable(4, 3), { r0: 1, c0: 0, r1: 2, c1: 1 });

  it("shifts merges below an inserted row and grows the ones it splits", () => {
    expect(insertRow(base(), 1).merges).toEqual([{ r: 2, c: 0, rs: 2, cs: 2 }]);
    expect(insertRow(base(), 2).merges).toEqual([{ r: 1, c: 0, rs: 3, cs: 2 }]);
    expect(insertRow(base(), 3).merges).toEqual([{ r: 1, c: 0, rs: 2, cs: 2 }]);
  });

  it("does the same for columns and keeps the alignment in step", () => {
    let t = setAlign(base(), 2, 2, "right");
    t = insertCol(t, 1);
    expect(t.merges).toEqual([{ r: 1, c: 0, rs: 2, cs: 3 }]);
    expect(t.align).toEqual(["", "", "", "right"]);
  });

  it("moves a merge's text down when its top row is deleted", () => {
    let t = setCell(base(), 1, 0, "합친 글");
    t = deleteRows(t, 1, 1)!;
    // 2×2 에서 한 줄이 빠져 1×2 로 남는다.
    expect(t.merges).toEqual([{ r: 1, c: 0, rs: 1, cs: 2 }]);
    expect(t.cells[1][0]).toBe("합친 글");
    expect(t.cells).toHaveLength(3);
  });

  it("moves a merge's text right when its left column is deleted", () => {
    let t = mergeCells(blankTable(2, 4), { r0: 1, c0: 0, r1: 1, c1: 2 });
    t = setCell(t, 1, 0, "글");
    t = deleteCols(t, 0, 0)!;
    expect(t.merges).toEqual([{ r: 1, c: 0, rs: 1, cs: 2 }]);
    expect(t.cells[1][0]).toBe("글");
  });

  it("never deletes the last row or column", () => {
    expect(deleteRows(blankTable(2, 2), 0, 1)).toBeNull();
    expect(deleteCols(blankTable(2, 2), 0, 1)).toBeNull();
  });

  it("keeps merges out of the header when the header row is deleted", () => {
    const t = deleteRows(base(), 0, 0)!;
    // 본문에 있던 2×2 병합이 머리 행으로 올라왔다 — 머리 행 몫만 남는다.
    expect(t.merges).toEqual([{ r: 0, c: 0, rs: 1, cs: 2 }]);
  });
});

describe("붙여넣기", () => {
  it("reads Excel-style TSV with quoted cells", () => {
    expect(parseTsv('a\tb\r\n"줄\n바꿈"\t"따옴표 ""x"""\r\n')).toEqual([
      ["a", "b"],
      ["줄\n바꿈", '따옴표 "x"'],
    ]);
  });

  it("reads TSV and markdown tables but leaves plain text alone", () => {
    expect(parseClipboardGrid("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseClipboardGrid("| x | y |\n|---|---|\n| 1 | 2 |")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
    expect(parseClipboardGrid("그냥 글\n두 줄")).toBeNull();
  });

  it("grows the table and unmerges what it pastes over", () => {
    const t = mergeCells(blankTable(2, 2), { r0: 1, c0: 0, r1: 1, c1: 1 });
    const p = pasteCells(t, 1, 1, [
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(p.cells).toEqual([
      ["", "", ""],
      ["", "a", "b"],
      ["", "c", "d"],
    ]);
    expect(p.merges).toEqual([]);
  });
});

describe("parseTableSource", () => {
  it("reads <br> in pipe cells as line breaks and pads short rows", () => {
    const t = parseTableSource(["| a | b |", "|:-|-:|", "| 1<br/>2 |"])!;
    expect(t.align).toEqual(["left", "right"]);
    expect(t.cells).toEqual([
      ["a", "b"],
      ["1\n2", ""],
    ]);
  });

  it("reads a hand-written HTML table with implicit closes and stray tags", () => {
    const t = parseTableSource([
      "<table>",
      "  <tr><th>A<th style='text-align: right'>B",
      "  <tr><td rowspan=2>x<td><sup>2</sup>",
      "  <tr><td>y",
      "</table>",
    ])!;
    expect(t.cells).toEqual([
      ["A", "B"],
      ["x", "<sup>2</sup>"],
      ["", "y"],
    ]);
    expect(t.align).toEqual(["", "right"]);
    expect(t.merges).toEqual([{ r: 1, c: 0, rs: 2, cs: 1 }]);
  });

  it("is null for things that are not tables", () => {
    expect(parseTableSource(["| a | b |", "그냥 줄"])).toBeNull();
    expect(parseTableSource(["<table><tr><td><table></table></td></tr></table>"])).toBeNull();
  });
});

describe("placeTable — 넣을 자리", () => {
  const at = (doc: string) => {
    const i = doc.indexOf("‸");
    return { value: doc.replace("‸", ""), pos: i };
  };
  const place = (doc: string, fm = true) => {
    const { value, pos } = at(doc);
    return placeTable(value, pos, pos, fm);
  };

  it("takes a blank line, the start of a line and the end of a line", () => {
    expect(place("a\n‸\nb")).toMatchObject({ kind: "insert", from: 2, to: 2 });
    expect(place("a\n  ‸  \nb")).toMatchObject({ kind: "insert", from: 2, to: 6 });
    expect(place("a\n‸b")).toMatchObject({ kind: "insert", from: 2, to: 2 });
    expect(place("a‸\nb")).toMatchObject({ kind: "insert", from: 1, to: 1 });
    expect(place("")).toMatchObject({ kind: "insert", from: 0, to: 0 });
  });

  it("refuses the middle of a line", () => {
    expect(place("- 할 ‸일")).toMatchObject({ kind: "deny", title: expect.stringMatching(/줄 중간/) });
  });

  it("refuses the inside of a code block but takes its edges", () => {
    const doc = "```ts\nconst a = 1;\n```";
    expect(place("```ts\nconst ‸a = 1;\n```")).toMatchObject({ kind: "deny", title: expect.stringMatching(/코드 블록/) });
    expect(place("```ts\n‸\n```")).toMatchObject({ kind: "deny" });
    expect(place(`‸${doc}`)).toMatchObject({ kind: "insert", from: 0 });
    expect(place(`${doc}‸`)).toMatchObject({ kind: "insert", from: doc.length });
    // 닫지 않은 펜스는 문서 끝까지가 코드다.
    expect(place("```\n코드‸")).toMatchObject({ kind: "deny" });
  });

  it("refuses the frontmatter but takes the end of its closing line", () => {
    expect(place("---\nid: ‸x\n---\n본문")).toMatchObject({ kind: "deny", title: expect.stringMatching(/프런트마터/) });
    expect(place("---\nid: x\n---‸\n본문")).toMatchObject({ kind: "insert", from: 13 });
    // index.md 편집기는 본문만 보여 준다 — 맨 앞의 --- 는 프런트마터가 아니다.
    expect(place("---\n‸\n---", false)).toMatchObject({ kind: "insert" });
  });

  it("edits the table the caret is in", () => {
    const doc = "앞\n\n| a | b |\n|---|---|\n| 1 ‸| 2 |\n\n뒤";
    const p = place(doc);
    expect(p.kind).toBe("edit");
    if (p.kind !== "edit") return;
    const { value } = at(doc);
    expect(value.slice(p.from, p.to)).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(p.model.cells).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("edits an HTML table the caret is in", () => {
    const html = tableToMarkdown(mergeCells(blankTable(2, 2), { r0: 0, c0: 0, r1: 0, c1: 1 }));
    const value = `x\n\n${html}\n`;
    const p = placeTable(value, value.indexOf("<th"), value.indexOf("<th"));
    expect(p).toMatchObject({ kind: "edit", from: 3, to: 3 + html.length });
  });

  it("turns a tab-separated selection into a prefilled table", () => {
    const value = "앞\n이름\t나이\n철수\t20\n뒤";
    const from = value.indexOf("이름");
    const to = value.indexOf("뒤");
    const p = placeTable(value, from, to);
    expect(p).toMatchObject({ kind: "insert", from, to: to - 1 });
    if (p.kind === "insert")
      expect(p.model.cells).toEqual([
        ["이름", "나이"],
        ["철수", "20"],
      ]);
  });

  it("refuses a tab selection that runs into a code block", () => {
    const value = "a\tb\n```\nc\td\n```";
    expect(placeTable(value, 0, value.length)).toMatchObject({ kind: "deny" });
  });
});

describe("spliceBlock — 앞뒤 빈 줄", () => {
  const T = "| t |";
  it("separates the table from its neighbours by exactly one blank line", () => {
    expect(spliceBlock("문단\n\n다음", 4, 4, T).text).toBe("문단\n\n| t |\n\n다음");
    // 빈 줄 두 개 중 첫째에 넣었다 — 그 빈 줄 자리가 표가 되고, 앞뒤에 빈 줄이 하나씩 남는다.
    expect(spliceBlock("문단\n\n\n다음", 3, 3, T).text).toBe("문단\n\n| t |\n\n다음");
    // 이미 있는 빈 줄은 지우지 않는다.
    expect(spliceBlock("문단\n\n\n다음", 5, 5, T).text).toBe("문단\n\n\n| t |\n\n다음");
    expect(spliceBlock("문단\n다음", 2, 2, T).text).toBe("문단\n\n| t |\n\n다음");
    expect(spliceBlock("문단\n다음", 5, 5, T).text).toBe("문단\n다음\n\n| t |\n");
    expect(spliceBlock("", 0, 0, T).text).toBe("| t |\n");
    expect(spliceBlock("문단\n", 3, 3, T).text).toBe("문단\n\n| t |\n");
  });

  it("puts the caret at the end of the table", () => {
    const r = spliceBlock("문단\n다음", 2, 2, T);
    expect(r.text.slice(0, r.caret).endsWith(T)).toBe(true);
  });
});

describe("replaceTableLines", () => {
  it("replaces the lines and keeps CRLF", () => {
    const src = "앞\r\n| a |\r\n|---|\r\n뒤";
    const out = replaceTableLines(src, 1, 3, ["| a |\r", "|---|\r"], "| b |\n| --- |");
    expect(out).toBe("앞\r\n| b |\r\n| --- |\r\n뒤");
  });

  it("does not add a stray CR at the end of the document", () => {
    const src = "앞\r\n| a |\r\n|---|";
    expect(replaceTableLines(src, 1, 3, ["| a |\r", "|---|"], "| b |\n| --- |")).toBe("앞\r\n| b |\r\n| --- |");
  });

  it("refuses when the lines changed in the meantime", () => {
    expect(replaceTableLines("| x |\n|---|", 0, 2, ["| a |", "|---|"], "| b |")).toBeNull();
  });
});

describe("displayWidth", () => {
  it("counts Hangul and CJK as two columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("한글")).toBe(4);
    expect(displayWidth("漢字a")).toBe(5);
  });
});
