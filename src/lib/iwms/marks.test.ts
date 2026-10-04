import { describe, expect, it } from "vitest";
import type { DayEntry } from "../daylog";
import { pushesByEntry, targetsOf, withMark } from "./marks";
import type { IwmsPush } from "./types";

const entry = (id: number, title = `e${id}`): DayEntry => ({
  id,
  day: "2026-10-02",
  folder: null,
  title,
  body: "",
  at: "09:00",
});

const push = (id: number, entryId: number | null, undoneAt: string | null = null): IwmsPush => ({
  id,
  commitId: "c",
  entryId,
  day: "2026-10-02",
  title: "t",
  ciKey: "A",
  ciName: "공통",
  wbsid: "w",
  task: "task",
  price: "O",
  minutes: 30,
  note: "n",
  pushedAt: "2026-10-04 09:00",
  undoneAt,
});

describe("i-WMS 표시", () => {
  it("고른 줄만 팝업 순서로, 이미 넣은 행과 함께", () => {
    const entries = [entry(3), entry(2), entry(1)];
    const t = targetsOf(
      entries,
      [
        { entryId: 1, price: "N" },
        { entryId: 3, price: "O" },
        { entryId: 99, price: "O" },
      ],
      [push(10, 3), push(11, 3, "2026-10-04 10:00"), push(12, null)],
    );
    expect(t.map((x) => [x.entry.id, x.price, x.pushed.map((p) => p.id)])).toEqual([
      [3, "O", [10]],
      [1, "N", []],
    ]);
  });

  it("되돌린 것 · 줄이 없는 것은 배지에 들지 않는다", () => {
    const m = pushesByEntry([push(1, 5), push(2, 5, "x"), push(3, null)]);
    expect([...m.keys()]).toEqual([5]);
    expect(m.get(5)?.map((p) => p.id)).toEqual([1]);
  });

  it("선택을 바꾸고 지운다", () => {
    let marks = withMark([], 1, "O");
    marks = withMark(marks, 1, "N");
    marks = withMark(marks, 2, "O");
    expect(marks).toEqual([
      { entryId: 1, price: "N" },
      { entryId: 2, price: "O" },
    ]);
    expect(withMark(marks, 1, null)).toEqual([{ entryId: 2, price: "O" }]);
  });
});
