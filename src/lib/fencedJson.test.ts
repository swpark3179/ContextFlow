import { describe, expect, it } from "vitest";
import { extractFencedJson, looksTruncated, stripFence } from "./fencedJson";

const LABEL = "recommend";
const fence = (body: string) => "```" + LABEL + "\n" + body + "\n```";

describe("extractFencedJson", () => {
  it("reads a labelled fence", () => {
    const got = extractFencedJson(`서술입니다.\n\n${fence('{"items":[]}')}`, LABEL);
    expect(got).toEqual({ value: { items: [] }, truncated: false });
  });

  it("takes the last fence when the model emits several", () => {
    const text = `${fence('{"n":1}')}\n다시 생각해 보니\n${fence('{"n":2}')}`;
    expect(extractFencedJson(text, LABEL)?.value).toEqual({ n: 2 });
  });

  it("accepts an unlabelled or json fence", () => {
    expect(extractFencedJson('```json\n{"n":1}\n```', LABEL)?.value).toEqual({ n: 1 });
    expect(extractFencedJson('```\n{"n":2}\n```', LABEL)?.value).toEqual({ n: 2 });
  });

  it("falls back to a bare brace block with no fence at all", () => {
    expect(extractFencedJson('앞말 {"n":1} 뒷말', LABEL)?.value).toEqual({ n: 1 });
  });

  /**
   * 잘린 응답의 전형 — 닫는 ``` 도 닫는 `}` 도 오지 않는다. 앞쪽 항목은 온전히 살고,
   * 마지막 항목은 **그때까지 완성된 필드만** 남는다.
   *
   * 반쪽짜리 항목을 여기서 버리지 않는 것은 의도된 것이다. 이 파서는 스키마를 모르므로
   * 어느 필드가 필수인지 판단할 수 없다. 그 판단은 호출부가 한다 — `parseRecommend` 는
   * 유효한 `sim` 이 없는 항목을 떨어뜨리므로 아래 `{id:"c"}` 는 자동으로 걸러진다.
   */
  it("salvages a truncated fence and flags it", () => {
    const text =
      "```" +
      LABEL +
      '\n{"items":[{"id":"a","sim":90},{"id":"b","sim":80},{"id":"c","si';
    const got = extractFencedJson(text, LABEL);
    expect(got?.truncated).toBe(true);
    expect(got?.value).toEqual({
      items: [{ id: "a", sim: 90 }, { id: "b", sim: 80 }, { id: "c" }],
    });
  });

  it("closes a dangling string and a trailing key", () => {
    const open = extractFencedJson('```' + LABEL + '\n{"note":"쓰다가 끊', LABEL);
    expect(open?.truncated).toBe(true);
    expect(open?.value).toEqual({ note: "쓰다가 끊" });

    const key = extractFencedJson('```' + LABEL + '\n{"a":1,"b":', LABEL);
    expect(key?.truncated).toBe(true);
    expect(key?.value).toEqual({ a: 1, b: null });
  });

  /**
   * 회귀 방지: `lastIndexOf("{")` 만 쓰면 맨 끝의 **안쪽** 조각을 집어 언제나 실패한다.
   * 균형 스캔이 앞쪽 `{` 부터 읽어야 한다.
   */
  it("does not get stuck on a trailing inner-object fragment", () => {
    const text = '{"items":[{"id":"a","sim":9}],"clusters":[{"repId":"a';
    const got = extractFencedJson(text, LABEL);
    expect(got?.truncated).toBe(true);
    expect((got?.value as { items: unknown[] }).items).toHaveLength(1);
  });

  it("gives up on text with no JSON in it", () => {
    expect(extractFencedJson("펜스를 안 썼습니다.", LABEL)).toBeNull();
    expect(extractFencedJson("", LABEL)).toBeNull();
  });
});

describe("looksTruncated", () => {
  it("sees an unclosed fence", () => {
    expect(looksTruncated('```' + LABEL + '\n{"a":1', LABEL)).toBe(true);
    expect(looksTruncated(fence('{"a":1}'), LABEL)).toBe(false);
  });

  it("sees an unbalanced brace block with no fence", () => {
    expect(looksTruncated('{"a":{"b":1}', LABEL)).toBe(true);
    // 앞쪽 중첩 객체가 닫힌 것만으로는 온전하다고 볼 수 없다 — 여기가 그 경계다.
    expect(looksTruncated('{"a":{"b":1}}', LABEL)).toBe(false);
  });

  it("is false for prose with no JSON", () => {
    expect(looksTruncated("그냥 글", LABEL)).toBe(false);
  });
});

describe("stripFence", () => {
  it("removes closed and unclosed fences", () => {
    expect(stripFence(`서술\n${fence('{"a":1}')}`, LABEL)).toBe("서술");
    expect(stripFence('서술\n```' + LABEL + '\n{"a":1', LABEL)).toBe("서술");
  });
});
