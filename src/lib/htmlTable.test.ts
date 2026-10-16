import { describe, expect, it } from "vitest";
import { htmlInlineToMd, mdInlineToHtml, parseHtmlTable } from "./htmlTable";

describe("mdInlineToHtml", () => {
  it("converts the inline marks a table cell can carry", () => {
    expect(mdInlineToHtml("**굵게** *기울임* ~~지움~~ `a<b`")).toBe(
      "<strong>굵게</strong> <em>기울임</em> <del>지움</del> <code>a&lt;b</code>",
    );
    expect(mdInlineToHtml("[링크](https://a.b/?x=1&y=2)")).toBe('<a href="https://a.b/?x=1&amp;y=2">링크</a>');
    expect(mdInlineToHtml("줄\n바꿈")).toBe("줄<br>바꿈");
  });

  it("keeps raw tags and entities but escapes stray brackets and ampersands", () => {
    expect(mdInlineToHtml("x<sup>2</sup> &nbsp; a < b & c")).toBe("x<sup>2</sup> &nbsp; a &lt; b &amp; c");
  });

  it("honours backslash escapes and leaves snake_case alone", () => {
    expect(mdInlineToHtml("\\*그대로\\* snake_case_name")).toBe("*그대로* snake_case_name");
    expect(mdInlineToHtml("2 * 3 * 4")).toBe("2 * 3 * 4");
  });

  it("leaves wikilinks as text", () => {
    expect(mdInlineToHtml("[[노트|별칭]]")).toBe("[[노트|별칭]]");
  });
});

describe("htmlInlineToMd", () => {
  const roundTrip = (md: string) => expect(htmlInlineToMd(mdInlineToHtml(md))).toBe(md);

  it("round-trips what mdInlineToHtml wrote", () => {
    roundTrip("**굵게** *기울임* ~~지움~~ `코드`");
    roundTrip("a < b > c & d");
    roundTrip("x<sup>2</sup>");
    roundTrip("[링크](https://a.b/?x=1&y=2)");
    roundTrip("줄\n바꿈");
    roundTrip("\\*별표\\* 와 \\_밑줄\\_ 그리고 snake_case");
  });

  it("keeps escaped tags as text across a round trip", () => {
    const html = mdInlineToHtml("&lt;b&gt; 는 글자다");
    expect(html).toBe("&lt;b&gt; 는 글자다");
    expect(mdInlineToHtml(htmlInlineToMd(html))).toBe(html);
  });

  it("writes code containing backticks so it reads back the same", () => {
    const html = mdInlineToHtml("`` a`b ``");
    expect(html).toBe("<code>a`b</code>");
    expect(mdInlineToHtml(htmlInlineToMd(html))).toBe(html);
  });

  it("collapses source whitespace and reads <p> as line breaks", () => {
    expect(htmlInlineToMd("\n  첫   줄\n  <p>둘째</p>")).toBe("첫 줄\n둘째");
  });

  it("strips unknown tags and decodes entities for display", () => {
    expect(htmlInlineToMd("<span>a</span> &lt;b&gt; <em>c</em> <a href='x'>d</a>", { display: true })).toBe(
      "a <b> c d",
    );
  });
});

describe("parseHtmlTable", () => {
  it("places cells around rowspans like a browser does", () => {
    const g = parseHtmlTable(
      "<table><thead><tr><th>a</th><th>b</th><th>c</th></tr></thead>" +
        '<tbody><tr><td rowspan="2">x</td><td colspan="2">y</td></tr><tr><td>p</td><td>q</td></tr></tbody></table>',
    )!;
    expect(g.headRows).toBe(1);
    expect(g.rows.map((r) => r.map((x) => (x ? x.html : null)))).toEqual([
      ["a", "b", "c"],
      ["x", "y", null],
      [null, "p", "q"],
    ]);
    expect(g.rows[1][0]).toMatchObject({ rs: 2, cs: 1 });
  });

  it("clamps rowspans that run past the last row and pads ragged rows", () => {
    const g = parseHtmlTable("<table><tr><td rowspan=5>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>")!;
    expect(g.rows[0][0]).toMatchObject({ rs: 2 });
    expect(g.rows[1].map((x) => x?.html ?? null)).toEqual([null, "c", "d"]);
    expect(g.rows[0][2]).toMatchObject({ html: "" });
  });

  it("ignores captions", () => {
    const g = parseHtmlTable("<table><caption>제목</caption><tr><td>a</td></tr></table>")!;
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0][0]?.html).toBe("a");
  });
});
