import { describe, expect, it } from "vitest";
import { cutLine } from "./editing";

describe("cutLine", () => {
  const doc = "첫 줄\n둘째 줄\n셋째 줄";

  it("takes the caret's line with its newline", () => {
    const cut = cutLine(doc, 6); // 둘째 줄 한가운데
    expect(cut?.text).toBe("둘째 줄\n");
    expect(cut?.next).toBe("첫 줄\n셋째 줄");
    // 남은 본문에서 캐럿은 밀려 올라온 줄의 첫 칸에 선다.
    expect(doc.slice(0, cut!.from)).toBe("첫 줄\n");
  });

  it("cuts the whole line from either edge of it", () => {
    const atStart = cutLine(doc, 4); // 둘째 줄 첫 칸
    const atEnd = cutLine(doc, 8); // 개행 바로 앞
    expect(atStart?.text).toBe("둘째 줄\n");
    expect(atEnd?.text).toBe("둘째 줄\n");
  });

  it("eats the preceding newline on the last line so no blank line is left", () => {
    const cut = cutLine(doc, doc.length);
    expect(cut?.next).toBe("첫 줄\n둘째 줄");
    expect(cut?.text).toBe("\n셋째 줄");
  });

  it("removes a trailing empty line", () => {
    const cut = cutLine("한 줄\n", 4);
    expect(cut?.next).toBe("한 줄");
    expect(cut?.text).toBe("\n");
  });

  it("empties a single-line document", () => {
    const cut = cutLine("혼자", 1);
    expect(cut?.from).toBe(0);
    expect(cut?.text).toBe("혼자");
    expect(cut?.next).toBe("");
  });

  it("drops a blank line without touching its neighbours", () => {
    const cut = cutLine("위\n\n아래", 2); // 가운데 빈 줄
    expect(cut?.text).toBe("\n");
    expect(cut?.next).toBe("위\n아래");
  });

  it("pasting the cut text back restores the document", () => {
    for (const at of [0, 3, 7, doc.length]) {
      const cut = cutLine(doc, at)!;
      expect(cut.next.slice(0, cut.from) + cut.text + cut.next.slice(cut.from)).toBe(doc);
    }
  });

  it("has nothing to cut in an empty document", () => {
    expect(cutLine("", 0)).toBeNull();
  });

  it("clamps a caret outside the text", () => {
    expect(cutLine(doc, 999)?.text).toBe("\n셋째 줄");
    expect(cutLine(doc, -5)?.text).toBe("첫 줄\n");
  });
});
