import { describe, expect, it } from "vitest";
import { escapeDelims, guessSummary, parsePageBlocks } from "./blocks";

describe("parsePageBlocks", () => {
  it("reads keyed blocks, ignores prose outside, keeps inner code fences", () => {
    const text = [
      "서술은 버린다",
      "<<<PAGE source>>>",
      "# 제목",
      "```bash",
      "deploy.ps1",
      "```",
      "<<<END>>>",
      "가운데 잡음",
      "<<<PAGE 1>>>",
      "요약: 배포 절차 요약",
      "# 배포",
      "<<<END>>>",
    ].join("\r\n");
    const m = parsePageBlocks(text);
    expect(m.get("source")).toEqual({
      body: "# 제목\n```bash\ndeploy.ps1\n```",
      summary: null,
      complete: true,
    });
    expect(m.get("1")).toEqual({ body: "# 배포", summary: "배포 절차 요약", complete: true });
  });

  it("marks an unterminated block as incomplete", () => {
    const m = parsePageBlocks("<<<PAGE 1>>>\n# 반쪽\n본문이 잘");
    expect(m.get("1")).toMatchObject({ body: "# 반쪽\n본문이 잘", complete: false });
  });

  it("a new opener before END closes the previous block as incomplete", () => {
    const m = parsePageBlocks("<<<PAGE 1>>>\nA\n<<<PAGE 2>>>\nB\n<<<END>>>");
    expect(m.get("1")?.complete).toBe(false);
    expect(m.get("2")).toMatchObject({ body: "B", complete: true });
  });

  it("strips an outer ```markdown wrapper and tolerates spacing", () => {
    const m = parsePageBlocks("  <<< PAGE   source >>>\n```markdown\n# 감싼 본문\n```\n<<< END >>>");
    expect(m.get("source")?.body).toBe("# 감싼 본문");
  });

  it("the later of two blocks with the same key wins", () => {
    const m = parsePageBlocks("<<<PAGE 1>>>\n첫\n<<<END>>>\n<<<PAGE 1>>>\n둘\n<<<END>>>");
    expect(m.get("1")?.body).toBe("둘");
  });

  it("returns nothing for text without blocks", () => {
    expect(parsePageBlocks("그냥 답변입니다").size).toBe(0);
  });
});

describe("escapeDelims / guessSummary", () => {
  it("defuses delimiters in input text", () => {
    expect(escapeDelims("a <<<PAGE 1>>> b")).toBe("a ‹‹‹PAGE 1››› b");
    expect(parsePageBlocks(escapeDelims("<<<PAGE 1>>>\nx\n<<<END>>>")).size).toBe(0);
  });

  it("takes the first prose line, unwrapping links and bullets", () => {
    expect(guessSummary("# 제목\n\n> 인용\n- [[배포 절차|배포]] 를 정리했다")).toBe("배포 를 정리했다");
    expect(guessSummary("# 제목만")).toBe("");
    expect([...guessSummary("가".repeat(200))].length).toBe(80);
  });
});
