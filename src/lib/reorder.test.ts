import { describe, expect, it } from "vitest";
import { reorderedList } from "./reorder";

const ALL = ["a", "b", "c", "d"];

describe("reorderedList — 필터가 없을 때", () => {
  it("끌어온 업무를 놓은 자리에 넣는다", () => {
    expect(reorderedList(ALL, ALL, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorderedList(ALL, ALL, "a", 4)).toEqual(["b", "c", "d", "a"]);
    expect(reorderedList(ALL, ALL, "a", 2)).toEqual(["b", "a", "c", "d"]);
  });

  it("있던 자리 그대로면 아무것도 돌려주지 않는다", () => {
    // 자기 자신 바로 앞과 바로 뒤는 둘 다 제자리다.
    expect(reorderedList(ALL, ALL, "b", 1)).toBeNull();
    expect(reorderedList(ALL, ALL, "b", 2)).toBeNull();
  });

  it("목록 밖의 인덱스는 양 끝으로 잘린다", () => {
    expect(reorderedList(ALL, ALL, "a", 99)).toEqual(["b", "c", "d", "a"]);
    expect(reorderedList(ALL, ALL, "d", -3)).toEqual(["d", "a", "b", "c"]);
  });

  it("목록에 없는 업무는 옮기지 않는다", () => {
    expect(reorderedList(ALL, ALL, "z", 0)).toBeNull();
  });
});

describe("reorderedList — 상태 필터가 걸렸을 때", () => {
  // 보이는 것은 a · c · d 뿐이고 b 는 다른 상태라 숨어 있다.
  const VIS = ["a", "c", "d"];

  it("보이는 목록에서 본 결과가 그대로 나온다", () => {
    const next = reorderedList(ALL, VIS, "c", 0);
    expect(next).toEqual(["c", "a", "b", "d"]);
    expect(next!.filter((f) => VIS.includes(f))).toEqual(["c", "a", "d"]);
  });

  it("맨 아래로 보내면 마지막으로 보이던 업무 뒤에 선다", () => {
    const next = reorderedList(ALL, VIS, "a", 3);
    expect(next).toEqual(["b", "c", "d", "a"]);
    expect(next!.filter((f) => VIS.includes(f))).toEqual(["c", "d", "a"]);
  });

  it("숨어 있던 업무의 자리는 건드리지 않는다", () => {
    // a 를 c 와 d 사이로. b 는 a 와 c 사이에 있었으니 그 자리에 남는다.
    expect(reorderedList(ALL, VIS, "a", 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("보이는 것이 자기 하나뿐이면 옮길 자리가 없다", () => {
    expect(reorderedList(ALL, ["b"], "b", 0)).toBeNull();
    expect(reorderedList(ALL, ["b"], "b", 1)).toBeNull();
  });

  it("보이지 않는 업무는 옮기지 않는다", () => {
    expect(reorderedList(ALL, VIS, "b", 0)).toBeNull();
  });
});

describe("reorderedList — 카테고리 묶음 안에서", () => {
  // 사이드바는 끄는 업무와 같은 묶음의 행만 보이던 목록으로 넘긴다. 다른 묶음(b*)이 사이사이에 있다.
  const ALL2 = ["a1", "b1", "a2", "b2", "a3"];
  const GROUP = ["a1", "a2", "a3"];

  it("묶음 안에서 본 결과가 나오고, 다른 묶음의 업무끼리는 순서가 그대로다", () => {
    const next = reorderedList(ALL2, GROUP, "a3", 0);
    expect(next).toEqual(["a3", "a1", "b1", "a2", "b2"]);
    expect(next!.filter((f) => f.startsWith("b"))).toEqual(["b1", "b2"]);
  });

  it("다음 이웃과 붙어 있으면 제자리는 null", () => {
    expect(reorderedList(["a1", "a2", "b1", "a3"], GROUP, "a1", 0)).toBeNull();
    expect(reorderedList(["a1", "a2", "b1", "a3"], GROUP, "a1", 1)).toBeNull();
  });

  it("다음 이웃과의 사이에 다른 묶음이 끼어 있으면 제자리라도 그 앞으로 당긴다", () => {
    // 그래서 사이드바가 묶음 안 제자리 놓기를 먼저 거른다 — 아무것도 쓰지 않게.
    expect(reorderedList(ALL2, GROUP, "a2", 1)).toEqual(["a1", "b1", "b2", "a2", "a3"]);
  });
});
