import { describe, expect, it } from "vitest";
import {
  composeDiscardBody,
  EMPTY_LEGACY,
  EMPTY_LOG,
  parseLegacyLog,
  relocateEntries,
  removeEntry,
  rollDay,
  upsertEntry,
  type DayEntry,
  type DayLog,
} from "./daylog";

const DAY = "2026-09-11";
const YESTERDAY = "2026-09-10";

let nextId = 1;

function entry(patch: Partial<DayEntry> = {}): DayEntry {
  return {
    id: nextId++,
    day: DAY,
    folder: null,
    title: "제목",
    body: "",
    at: "09:00",
    ...patch,
  };
}

/** 폴더 경로가 곧 제목인 줄들로 하루를 만든다 — 옛 테스트와 같은 읽기 편의다. */
function log(day: string, folders: string[]): DayLog {
  return {
    day,
    entries: folders.map((f) => entry({ day, folder: f, title: f })),
  };
}

function titles(l: DayLog): string[] {
  return l.entries.map((e) => e.title);
}

describe("rollDay", () => {
  it("keeps today's list as it is", () => {
    const mine = log(DAY, ["a"]);
    expect(rollDay(mine, DAY)).toBe(mine);
  });

  it("clears the screen when the day turns, without claiming the old day is gone", () => {
    // 화면만 빈다. 어제의 줄은 DB 에 남아 팝업에서 볼 수 있다.
    expect(rollDay(log(YESTERDAY, ["a", "b"]), DAY)).toEqual({ day: DAY, entries: [] });
  });
});

describe("upsertEntry", () => {
  it("puts the newest touch on top", () => {
    const row = entry({ folder: "/v/Tasks/새 업무", title: "새 업무", at: "14:32" });
    expect(titles(upsertEntry(log(DAY, ["a"]), DAY, row))).toEqual(["새 업무", "a"]);
  });

  it("keeps one line per task and refreshes its time", () => {
    const first = entry({ folder: "/v/b", title: "b", at: "10:00" });
    const once = upsertEntry(log(DAY, ["/v/a"]), DAY, first);
    // DB 는 같은 날 같은 업무를 한 줄로 접으므로 같은 id 가 돌아온다.
    const twice = upsertEntry(once, DAY, { ...first, at: "17:20" });

    expect(titles(twice)).toEqual(["b", "/v/a"]);
    expect(twice.entries[0].at).toBe("17:20");
    expect(twice.entries).toHaveLength(2);
  });

  it("folds a line whose folder was taken over by the incoming row", () => {
    // 옛 업무를 보관한 자리에 새 업무가 같은 경로로 들어선 경우. DB 쪽 UPDATE OR REPLACE 가
    // 한 줄만 남기므로 화면도 한 줄이어야 한다.
    const before = { day: DAY, entries: [entry({ folder: "/v/a", title: "옛 업무" })] };
    const incoming = entry({ folder: "/v/a", title: "새 업무" });
    expect(titles(upsertEntry(before, DAY, incoming))).toEqual(["새 업무"]);
  });

  it("never folds two free entries into each other", () => {
    // 자유 항목은 경로가 없다 — 제목이 같아도 다른 줄이다.
    let acc: DayLog = EMPTY_LOG;
    acc = upsertEntry(acc, DAY, entry({ title: "회의" }));
    acc = upsertEntry(acc, DAY, entry({ title: "회의" }));
    expect(acc.entries).toHaveLength(2);
  });

  it("starts a new day's list instead of appending to yesterday's", () => {
    const row = entry({ day: DAY, folder: "/v/a", title: "a" });
    expect(upsertEntry(log(YESTERDAY, ["x", "y"]), DAY, row)).toEqual({
      day: DAY,
      entries: [row],
    });
  });
});

describe("removeEntry", () => {
  it("drops just that line and leaves the day alone", () => {
    const l = log(DAY, ["a", "b", "c"]);
    const next = removeEntry(l, l.entries[1].id);
    expect(next.day).toBe(DAY);
    expect(titles(next)).toEqual(["a", "c"]);
  });

  it("is a no-op for a line that is already gone", () => {
    expect(removeEntry(log(DAY, ["a"]), 9999).entries).toHaveLength(1);
  });
});

describe("relocateEntries", () => {
  it("follows a task whose folder moved, keeping its place and time", () => {
    const next = relocateEntries(log(DAY, ["a", "b"]), "a", "/Archive/2026/a", "이름 바뀐 업무");
    expect(next.entries[0]).toMatchObject({
      folder: "/Archive/2026/a",
      title: "이름 바뀐 업무",
      at: "09:00",
    });
    expect(next.entries[1].folder).toBe("b");
  });

  it("updates only the title when the folder did not change", () => {
    const next = relocateEntries(log(DAY, ["a"]), "a", "a", "새 제목");
    expect(next.entries[0].title).toBe("새 제목");
  });

  it("leaves free entries alone", () => {
    // 자유 항목은 가리키는 업무가 없다 — 경로가 바뀌는 일에 끌려 들어가면 안 된다.
    const free = entry({ folder: null, title: "회의" });
    const next = relocateEntries({ day: DAY, entries: [free] }, "a", "b", "옮긴 업무");
    expect(next.entries[0]).toEqual(free);
  });
});

describe("parseLegacyLog", () => {
  it("reads the shape localStorage used to hold", () => {
    const raw = JSON.stringify({
      date: DAY,
      items: [{ folder: "/v/a", title: "a", at: "09:00" }],
    });
    expect(parseLegacyLog(raw)).toEqual({
      day: DAY,
      rows: [{ folder: "/v/a", title: "a", at: "09:00" }],
    });
  });

  it("treats nothing, junk and the wrong shape as nothing to import", () => {
    expect(parseLegacyLog(null)).toEqual(EMPTY_LEGACY);
    expect(parseLegacyLog("")).toEqual(EMPTY_LEGACY);
    expect(parseLegacyLog("{oops")).toEqual(EMPTY_LEGACY);
    expect(parseLegacyLog("[]")).toEqual(EMPTY_LEGACY);
    expect(parseLegacyLog('{"date":"2026-09-11"}')).toEqual(EMPTY_LEGACY);
    expect(parseLegacyLog('{"date":7,"items":[]}')).toEqual(EMPTY_LEGACY);
  });

  it("skips entries with no folder and fills in what is missing", () => {
    const raw = '{"date":"2026-09-11","items":[{"folder":""},{"folder":"/v/a"},null]}';
    expect(parseLegacyLog(raw)).toEqual({
      day: DAY,
      rows: [{ folder: "/v/a", title: "/v/a", at: "" }],
    });
  });
});

describe("composeDiscardBody", () => {
  // 파일을 안 붙인 업무를 완료하면 폴더가 사라진다. 그 폴더가 들고 있던 글이 전부
  // 기록으로 옮겨 가는지가 이 함수의 전부다 — 빠뜨리면 사용자의 글이 사라진다.

  it("keeps only the memo when the body is just the generated skeleton", () => {
    expect(composeDiscardBody("전화로 정리하고 끝냈다", "## 개요\n")).toBe("전화로 정리하고 끝냈다");
    expect(composeDiscardBody("메모", "")).toBe("메모");
    expect(composeDiscardBody("메모", "\n\n## 개요\n\n  \n")).toBe("메모");
  });

  it("carries the summary the user typed in the new-task dialog", () => {
    expect(composeDiscardBody("메모 본문", "## 개요\n게이트웨이 타임아웃 확인\n")).toBe(
      "메모 본문\n\n---\n\n게이트웨이 타임아웃 확인",
    );
  });

  it("carries the index body even when there is no memo", () => {
    expect(composeDiscardBody("", "## 개요\n적어 둔 개요\n")).toBe("적어 둔 개요");
  });

  it("strips only the leading skeleton heading, never one the user wrote", () => {
    const body = "## 개요\n첫 문단\n\n## 개요\n사용자가 또 쓴 머리말\n";
    expect(composeDiscardBody("", body)).toBe("첫 문단\n\n## 개요\n사용자가 또 쓴 머리말");
  });

  it("keeps a body whose first line is not the skeleton", () => {
    expect(composeDiscardBody("", "## 결론\n바로 본문\n")).toBe("## 결론\n바로 본문");
  });

  it("is empty only when the task really held nothing", () => {
    expect(composeDiscardBody("", "## 개요\n")).toBe("");
  });

  it("reads CRLF bodies the same as LF", () => {
    expect(composeDiscardBody("메모", "## 개요\r\n윈도우에서 쓴 개요\r\n")).toBe(
      "메모\n\n---\n\n윈도우에서 쓴 개요",
    );
  });
});
