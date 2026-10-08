/**
 * 업무 파일의 마크다운 구조 — 간략 입력 정리 · 이슈 추가가 함께 읽는 제목 · 열린 할 일.
 *
 * 지킬 약속: 코드 펜스 안의 `#` · `- [ ]` 는 제목 · 할 일이 아니다. frontmatter 는 본문이 아니다.
 */
import { describe, expect, it } from "vitest";
import { headingKey, headingLevel, openTodosOf } from "./outline";

describe("openTodosOf", () => {
  it("lists open checkboxes outside fences with the heading they sit under", () => {
    const text = [
      "---",
      "todo: - [ ] frontmatter 는 본문이 아니다",
      "---",
      "- [ ] 제목 앞의 할 일",
      "## 할 일",
      "- [ ] PG 연동 교체",
      "- [x] 끝낸 일",
      "  * [ ] 들여 쓴 하위 할 일  ",
      "```md",
      "- [ ] 코드 안의 예시",
      "## 코드 안의 제목",
      "```",
      "### 2차",
      "+ [ ] 재테스트",
      "- [ ]",
      "- 그냥 목록",
    ].join("\r\n");
    expect(openTodosOf(text)).toEqual([
      { text: "제목 앞의 할 일", raw: "- [ ] 제목 앞의 할 일", heading: null },
      { text: "PG 연동 교체", raw: "- [ ] PG 연동 교체", heading: "## 할 일" },
      { text: "들여 쓴 하위 할 일", raw: "* [ ] 들여 쓴 하위 할 일", heading: "## 할 일" },
      { text: "재테스트", raw: "+ [ ] 재테스트", heading: "### 2차" },
    ]);
  });

  it("stops at the cap", () => {
    const text = Array.from({ length: 30 }, (_, i) => `- [ ] 일 ${i}`).join("\n");
    expect(openTodosOf(text, 5)).toHaveLength(5);
    expect(openTodosOf(text)).toHaveLength(15);
  });
});

describe("headingKey · headingLevel", () => {
  it("compares level and text, and does not take an indented line for a heading level", () => {
    expect(headingKey("##  할 일 ")).toBe(headingKey("## 할 일"));
    expect(headingKey("### 할 일")).not.toBe(headingKey("## 할 일"));
    expect(headingKey("본문")).toBeNull();
    expect(headingLevel("### 2차")).toBe(3);
    expect(headingLevel("  ## 들여 씀")).toBe(0);
    expect(headingLevel("#해시태그")).toBe(0);
  });
});
