import { describe, expect, it } from "vitest";
import { dragCursor, dragKind } from "./dragCursor";

describe("dragKind", () => {
  it("창 밖에서만 복사 · 링크로 갈린다", () => {
    expect(dragKind(true, false)).toBe("copy");
    expect(dragKind(true, true)).toBe("link");
    expect(dragKind(false, true)).toBe("move");
  });

  it("창 안에서 놓을 수 없는 자리면 금지 배지", () => {
    expect(dragKind(false, false, true)).toBe("none");
    // 창 밖은 언제나 놓을 수 있다 — 바탕화면으로 간다.
    expect(dragKind(true, false, true)).toBe("copy");
  });
});

describe("dragCursor", () => {
  it("링크 배지는 보라가 아니라 청록이다", () => {
    const v = decodeURIComponent(dragCursor("link"));
    expect(v).toContain("#2f6f80");
    expect(v.toLowerCase()).not.toContain("#6a54c6");
  });

  it("이미지가 막히면 표준 커서로 떨어진다", () => {
    expect(dragCursor("move").endsWith(", grabbing")).toBe(true);
    expect(dragCursor("copy").endsWith(", copy")).toBe(true);
    expect(dragCursor("link").endsWith(", alias")).toBe(true);
    expect(dragCursor("none").endsWith(", not-allowed")).toBe(true);
  });

  it("값 안에 인코딩되지 않은 따옴표 · # 가 남지 않는다", () => {
    const body = dragCursor("link").slice('url("'.length, dragCursor("link").indexOf('")'));
    expect(body).not.toMatch(/["#<>]/);
  });
});
