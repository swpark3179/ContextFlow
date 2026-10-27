import { describe, expect, it } from "vitest";
import { withLeaving } from "./leaving";

const id = (s: string) => s;
const view = (prev: string[], next: string[]) =>
  withLeaving(prev, next, id).map((k) => (k.leaving ? `-${k.item}` : k.item));

describe("withLeaving", () => {
  it("바뀐 것이 없으면 새 목록 그대로다", () => {
    expect(view(["a", "b", "c"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("빠진 줄은 옛 자리에 남고 나가는 중으로 표시된다", () => {
    expect(view(["a", "b", "c"], ["a", "c"])).toEqual(["a", "-b", "c"]);
  });

  it("맨 앞에서 빠진 줄은 맨 앞에 남는다", () => {
    expect(view(["a", "b", "c"], ["b", "c"])).toEqual(["-a", "b", "c"]);
  });

  it("이어서 빠진 줄들은 순서를 지킨다", () => {
    expect(view(["a", "b", "c", "d"], ["a", "d"])).toEqual(["a", "-b", "-c", "d"]);
  });

  it("모두 빠지면 모두 나가는 중이다", () => {
    expect(view(["a", "b"], [])).toEqual(["-a", "-b"]);
  });

  it("새로 생긴 줄은 새 목록의 자리에 선다", () => {
    expect(view(["a", "b"], ["x", "a"])).toEqual(["x", "a", "-b"]);
  });

  it("앞의 줄이 자리를 옮겨도 빠진 줄은 그 줄을 따라간다", () => {
    expect(view(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "-b"]);
  });

  it("같은 열쇠가 두 번 있으면 한 번만 센다", () => {
    expect(view(["a", "a", "b"], ["b"])).toEqual(["-a", "b"]);
  });
});
