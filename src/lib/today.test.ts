import { describe, expect, it } from "vitest";
import {
  addItem,
  EMPTY_LOG,
  moveItem,
  parseLog,
  pruneLog,
  removeItem,
  type TodayLog,
} from "./today";

const DAY = "2026-09-09";
const YESTERDAY = "2026-09-08";

function log(date: string, folders: string[]): TodayLog {
  return { date, items: folders.map((f) => ({ folder: f, title: f, at: "09:00" })) };
}

describe("pruneLog", () => {
  it("keeps today's list as it is", () => {
    const mine = log(DAY, ["a"]);
    expect(pruneLog(mine, DAY)).toBe(mine);
  });

  it("throws yesterday's list away", () => {
    expect(pruneLog(log(YESTERDAY, ["a", "b"]), DAY)).toEqual({ date: DAY, items: [] });
  });
});

describe("addItem", () => {
  const item = { folder: "/v/Tasks/새 업무", title: "새 업무", at: "14:32" };

  it("puts the newest touch on top", () => {
    const next = addItem(log(DAY, ["a"]), DAY, item);
    expect(next.items.map((i) => i.folder)).toEqual([item.folder, "a"]);
  });

  it("keeps one line per task and refreshes its time", () => {
    const once = addItem(log(DAY, ["a", "b"]), DAY, { folder: "b", title: "b", at: "10:00" });
    const twice = addItem(once, DAY, { folder: "b", title: "b", at: "17:20" });
    expect(twice.items.map((i) => i.folder)).toEqual(["b", "a"]);
    expect(twice.items[0].at).toBe("17:20");
    expect(twice.items).toHaveLength(2);
  });

  it("starts a new day's list instead of appending to yesterday's", () => {
    const next = addItem(log(YESTERDAY, ["a", "b"]), DAY, item);
    expect(next).toEqual({ date: DAY, items: [item] });
  });

  it("stops growing past the cap", () => {
    let acc: TodayLog = EMPTY_LOG;
    for (let i = 0; i < 90; i++) {
      acc = addItem(acc, DAY, { folder: `f${i}`, title: `t${i}`, at: "09:00" });
    }
    expect(acc.items).toHaveLength(60);
    // 잘려 나가는 것은 가장 오래된 쪽이다.
    expect(acc.items[0].folder).toBe("f89");
  });
});

describe("removeItem", () => {
  it("drops just that task and leaves the day alone", () => {
    const next = removeItem(log(DAY, ["a", "b", "c"]), "b");
    expect(next.date).toBe(DAY);
    expect(next.items.map((i) => i.folder)).toEqual(["a", "c"]);
  });

  it("is a no-op for a task that was never listed", () => {
    expect(removeItem(log(DAY, ["a"]), "z").items).toHaveLength(1);
  });
});

describe("moveItem", () => {
  it("follows a task whose folder moved, keeping its place and time", () => {
    const next = moveItem(log(DAY, ["a", "b"]), "a", "/Archive/2026/a", "이름 바뀐 업무");
    expect(next.items[0]).toEqual({
      folder: "/Archive/2026/a",
      title: "이름 바뀐 업무",
      at: "09:00",
    });
    expect(next.items[1].folder).toBe("b");
  });

  it("updates only the title when the folder did not change", () => {
    const next = moveItem(log(DAY, ["a"]), "a", "a", "새 제목");
    expect(next.items[0].title).toBe("새 제목");
  });
});

describe("parseLog", () => {
  it("reads back what it wrote", () => {
    const mine = log(DAY, ["a", "b"]);
    expect(parseLog(JSON.stringify(mine))).toEqual(mine);
  });

  it("treats nothing, junk and the wrong shape as an empty list", () => {
    expect(parseLog(null)).toEqual(EMPTY_LOG);
    expect(parseLog("")).toEqual(EMPTY_LOG);
    expect(parseLog("{oops")).toEqual(EMPTY_LOG);
    expect(parseLog("[]")).toEqual(EMPTY_LOG);
    expect(parseLog('{"date":"2026-09-09"}')).toEqual(EMPTY_LOG);
    expect(parseLog('{"date":7,"items":[]}')).toEqual(EMPTY_LOG);
  });

  it("skips entries with no folder and fills in what is missing", () => {
    const raw = '{"date":"2026-09-09","items":[{"folder":""},{"folder":"/v/a"},null]}';
    expect(parseLog(raw)).toEqual({
      date: DAY,
      items: [{ folder: "/v/a", title: "/v/a", at: "" }],
    });
  });
});
