import { describe, expect, it } from "vitest";
import { imageMarkdown, insertOwnLine, resolveImageSrc } from "./images";
import { mdParse, setImageWidth } from "./markdown";

describe("mdParse — 이미지", () => {
  it("이미지만 있는 줄은 이미지 블록이 된다", () => {
    const [b] = mdParse("![스크린샷](image-1.png)");
    expect(b.isImage).toBe(true);
    expect(b.src).toBe("image-1.png");
    expect(b.alt).toBe("스크린샷");
    expect(b.width).toBeNull();
    expect(b.wiki).toBe(false);
  });

  it("alt 의 |너비 를 떼어 읽는다 (Obsidian 표기)", () => {
    expect(mdParse("![설명|320](a.png)")[0]).toMatchObject({ alt: "설명", width: 320 });
    expect(mdParse("![|240x100](a.png)")[0]).toMatchObject({ alt: "", width: 240 });
    expect(mdParse("![a|b](a.png)")[0]).toMatchObject({ alt: "a|b", width: null });
  });

  it("꺾쇠 경로와 제목을 받는다", () => {
    expect(mdParse('![](<my shot.png> "제목")')[0].src).toBe("my shot.png");
  });

  it("위키 표기는 이미지 확장자일 때만 이미지다", () => {
    expect(mdParse("![[shot.png|480]]")[0]).toMatchObject({
      isImage: true,
      src: "shot.png",
      width: 480,
      wiki: true,
    });
    expect(mdParse("![[shot.png|그림]]")[0]).toMatchObject({ alt: "그림", width: null });
    expect(mdParse("![[다른 노트]]")[0].isImage).toBe(false);
  });

  it("한 줄의 여러 이미지는 줄 안의 순서를 들고 각각 블록이 된다", () => {
    const bs = mdParse("본문\n![](a.png) ![](b.png)");
    expect(bs.map((b) => [b.isImage, b.line, b.imgIdx, b.src])).toEqual([
      [false, 0, 0, ""],
      [true, 1, 0, "a.png"],
      [true, 1, 1, "b.png"],
    ]);
    expect(new Set(bs.map((b) => b.key)).size).toBe(3);
  });

  it("글과 섞인 이미지는 문단으로 남는다", () => {
    const [b] = mdParse("보세요 ![](a.png)");
    expect(b.isImage).toBe(false);
    expect(b.isBody).toBe(true);
  });

  it("목록 · 코드 블록 안의 이미지 표기는 건드리지 않는다", () => {
    expect(mdParse("- ![](a.png)")[0].isImage).toBe(false);
    expect(mdParse("```\n![](a.png)\n```")[0].isFence).toBe(true);
  });
});

describe("setImageWidth", () => {
  it("그 토큰의 너비만 바꾸고 나머지는 그대로 둔다", () => {
    const src = "# 제목\r\n![설명](a%20b.png \"t\") ![](c.png)\r\n끝";
    const next = setImageWidth(src, 1, 0, 240)!;
    expect(next).toBe("# 제목\r\n![설명|240](a%20b.png \"t\") ![](c.png)\r\n끝");
    expect(setImageWidth(next, 1, 1, 480)).toBe(
      "# 제목\r\n![설명|240](a%20b.png \"t\") ![|480](c.png)\r\n끝",
    );
  });

  it("너비를 바꾸거나 걷어낸다", () => {
    expect(setImageWidth("![x|240](a.png)", 0, 0, 860)).toBe("![x|860](a.png)");
    expect(setImageWidth("![x|240](a.png)", 0, 0, null)).toBe("![x](a.png)");
  });

  it("위키 표기도 고친다", () => {
    expect(setImageWidth("![[a.png]]", 0, 0, 240)).toBe("![[a.png|240]]");
    expect(setImageWidth("![[a.png|240]]", 0, 0, null)).toBe("![[a.png]]");
    expect(setImageWidth("![[a.png|그림]]", 0, 0, null)).toBe("![[a.png|그림]]");
  });

  it("줄이나 이미지가 없으면 null", () => {
    expect(setImageWidth("글", 0, 0, 240)).toBeNull();
    expect(setImageWidth("![](a.png)", 3, 0, 240)).toBeNull();
    expect(setImageWidth("![](a.png)", 0, 1, 240)).toBeNull();
  });

  it("고친 결과는 다시 같은 블록으로 읽힌다", () => {
    const next = setImageWidth("![](image-1.png)", 0, 0, 480)!;
    expect(mdParse(next)[0]).toMatchObject({ isImage: true, src: "image-1.png", width: 480 });
  });
});

describe("imageMarkdown · insertOwnLine", () => {
  it("링크를 끊는 글자만 인코딩한다", () => {
    expect(imageMarkdown("image-20261001-120000.png")).toBe("![](image-20261001-120000.png)");
    expect(imageMarkdown("a (2).png")).toBe("![](a%20%282%29.png)");
  });

  it("줄 가운데에 넣으면 앞뒤로 줄을 바꾼다", () => {
    const r = insertOwnLine("앞뒤", 1, 1, "![](a.png)");
    expect(r.text).toBe("앞\n![](a.png)\n뒤");
    expect(r.caret).toBe(r.text.indexOf("뒤"));
  });

  it("이미 줄 경계면 줄을 더 넣지 않는다", () => {
    expect(insertOwnLine("a\n\nb", 2, 2, "X").text).toBe("a\nX\nb");
    expect(insertOwnLine("", 0, 0, "X").text).toBe("X\n");
    expect(insertOwnLine("a\n", 2, 2, "X").text).toBe("a\nX\n");
  });

  it("고른 구간을 바꿔 넣는다", () => {
    expect(insertOwnLine("a\nsel\nb", 2, 5, "X").text).toBe("a\nX\nb");
  });
});

describe("resolveImageSrc", () => {
  it("상대 경로는 노트가 있는 폴더 기준이다", () => {
    expect(resolveImageSrc("index.md", "a.png")).toEqual({ kind: "rel", path: "a.png" });
    expect(resolveImageSrc("refs/n.md", "a.png")).toEqual({ kind: "rel", path: "refs/a.png" });
    expect(resolveImageSrc("refs/n.md", "./img/../a.png")).toEqual({
      kind: "rel",
      path: "refs/a.png",
    });
    expect(resolveImageSrc("refs/n.md", "../../x.png")).toEqual({ kind: "rel", path: "../x.png" });
  });

  it("마크다운 표기는 퍼센트 인코딩을 풀고, 위키 표기는 그대로 둔다", () => {
    expect(resolveImageSrc("n.md", "my%20shot.png")).toEqual({ kind: "rel", path: "my shot.png" });
    expect(resolveImageSrc("n.md", "100%.png", true)).toEqual({ kind: "rel", path: "100%.png" });
    expect(resolveImageSrc("n.md", "bad%zz.png")).toEqual({ kind: "rel", path: "bad%zz.png" });
  });

  it("절대 경로 · URL 을 가른다", () => {
    expect(resolveImageSrc("n.md", "C:\\shots\\a.png")).toEqual({
      kind: "abs",
      path: "C:/shots/a.png",
    });
    expect(resolveImageSrc("n.md", "file:///C:/a.png")).toEqual({ kind: "abs", path: "C:/a.png" });
    expect(resolveImageSrc("n.md", "data:image/png;base64,AAA")).toMatchObject({ kind: "url" });
    expect(resolveImageSrc("n.md", "https://example.com/a.png")).toMatchObject({ kind: "remote" });
  });
});
