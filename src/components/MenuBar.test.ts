/**
 * 메뉴 띠의 약속 — 전체 카테고리 허브를 여는 길이 언제나 있다.
 *
 * 업무 리스트의 ⋯ 는 진행 중 업무에 카테고리가 있을 때만 보인다. 보관한 업무만 분류했어도 자동
 * 갱신은 `_index/카테고리.md` 를 계속 쓰므로, 그 허브를 여는 항목이 메뉴 띠에도 있어야 한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMeta } from "../lib/api";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "category_hub_path":
        return "/v/_index/카테고리.md";
      case "open_in_obsidian":
        return { opened: "obsidian", detail: "" };
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("../store/useStore");
const { menuItems } = await import("./MenuBar");

function task(n: number, over: Partial<TaskMeta> = {}): TaskMeta {
  const folder = `/v/Tasks/[2026-09] 업무 ${n}`;
  return {
    id: `task-${n}`,
    title: `업무 ${n}`,
    status: "in-progress",
    tags: [],
    category: null,
    created: `2026-09-0${n} 09:00`,
    updated: `2026-09-0${n} 09:00`,
    parentTask: null,
    templateRef: null,
    completedAt: null,
    archived: null,
    archivedAt: null,
    runs: 1,
    order: null,
    folder,
    relFolder: `Tasks/[2026-09] 업무 ${n}/`,
    indexPath: `${folder}/index.md`,
    tagline: "",
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v", archDays: 30 },
    // 보관한 업무 하나만 카테고리가 있다 — 진행 중 업무는 미분류라 업무 리스트의 ⋯ 가 숨는다.
    tasks: [
      task(1),
      task(2, {
        status: "completed",
        category: "운영",
        completedAt: "2026-09-02",
        archived: true,
        archivedAt: "2026-09-02",
      }),
    ],
    // 완료로 창을 닫은 직후처럼 고른 업무가 없다.
    activeFolder: "",
    toasts: [],
  });
});

describe("업무 메뉴", () => {
  it("진행 중 업무에 카테고리가 없고 고른 업무가 없어도 전체 허브를 연다", async () => {
    const item = menuItems(useStore.getState()).업무.find((i) => i.label === "카테고리 허브 열기");
    expect(item).toBeDefined();
    expect(item?.off).toBeFalsy();

    item?.run();
    await vi.waitFor(() => expect(calls.map((c) => c.cmd)).toContain("open_in_obsidian"));
    expect(calls).toEqual([
      { cmd: "category_hub_path", args: { root: "/v", archDays: 30, key: null } },
      { cmd: "open_in_obsidian", args: { root: "/v", path: "/v/_index/카테고리.md" } },
    ]);
    expect(useStore.getState().toasts).toEqual([]);
  });
});
