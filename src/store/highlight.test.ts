/**
 * 업무 리스트의 강조(우클릭 → 강조 표시)를 지킨다.
 *
 * * 쓰기를 기다리지 않고 먼저 칠한다 — 형광펜이 누른 순간에 그어진다. 실패하면 칠한 그대로일 때만 되돌린다.
 * * 켜기는 진행 중인 업무에만 — 보류 · 완료한 업무에는 백엔드를 부르지도 않는다. 끄기는 상태와 상관없다.
 * * 완료가 지운 강조는 [되돌리기] 가 다시 켠다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMeta } from "../lib/api";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
const FOLDER = "/v/Tasks/[2026-10] 배포 정리";
const OTHER = "/v/Tasks/[2026-10] 회의록";

let highlightFails = false;
let releaseHighlight: (() => void) | null = null;
/** 디스크에 쓰인 강조 — 다시 읽기(`scan_vault`)가 이 값을 돌려준다. */
let disk: Record<string, boolean> = {};

function task(folder: string, over: Partial<TaskMeta> = {}): TaskMeta {
  const title = folder.split("] ").pop() as string;
  return {
    id: `task-${title}`,
    title,
    status: "in-progress",
    tags: [],
    category: null,
    created: "2026-10-07 09:00",
    updated: "2026-10-07 09:00",
    parentTask: null,
    templateRef: null,
    completedAt: null,
    archived: null,
    archivedAt: null,
    runs: 1,
    order: null,
    highlight: false,
    folder,
    relFolder: `Tasks/${folder.split("/").pop()}/`,
    indexPath: `${folder}/index.md`,
    tagline: "",
    ...over,
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "set_task_highlight":
        await new Promise<void>((r) => (releaseHighlight = r));
        if (highlightFails) throw { kind: "io", message: "쓰지 못함" };
        disk[args.folder as string] = args.on as boolean;
        return task(args.folder as string, { highlight: args.on as boolean });
      case "list_task_files":
        return [{ p: "index.md", dir: false }, { p: "notes.md", dir: false }];
      case "read_text_file":
        return "---\nid: x\n---\n";
      case "set_task_status":
        return task(args.folder as string, { status: args.status as string });
      case "set_task_archived":
        return task(args.folder as string, { status: "completed", archived: args.archived as boolean });
      case "note_day_entry":
        return { id: 7, day: "2026-10-27", folder: args.folder, title: args.title, body: "", at: "10:00" };
      case "scan_vault":
        return [task(FOLDER, { highlight: !!disk[FOLDER] })];
      case "scan_templates":
      case "list_tree":
      case "day_entries":
        return [];
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");

const cmds = () => calls.map((c) => c.cmd);
const shown = (folder: string) => useStore.getState().tasks.find((t) => t.folder === folder)?.highlight;

beforeEach(() => {
  calls.length = 0;
  highlightFails = false;
  releaseHighlight = null;
  disk = {};
  const s = useStore.getState();
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v", wikiAuto: false },
    tasks: [task(FOLDER), task(OTHER)],
    activeFolder: FOLDER,
    ui: { ...s.ui, notepad: "", docs: {}, openTabs: [] },
    uiCache: {},
    dayLog: { day: "2026-10-27", entries: [] },
    toasts: [],
    fly: null,
    completing: "",
    justArchived: "",
    taskCtx: null,
  });
});

describe("강조 켜고 끄기", () => {
  it("쓰기가 끝나기 전에 먼저 칠하고, 돌아온 값으로 맞춘다", async () => {
    const run = useStore.getState().setHighlight(OTHER, true);
    expect(shown(OTHER)).toBe(true);
    await vi.waitFor(() => expect(releaseHighlight).not.toBeNull());
    expect(calls.find((c) => c.cmd === "set_task_highlight")?.args).toMatchObject({
      root: "/v",
      folder: OTHER,
      on: true,
    });
    releaseHighlight!();
    await run;
    expect(shown(OTHER)).toBe(true);
    // 바뀐 것이 제자리에 보이므로 성공은 알리지 않는다.
    expect(useStore.getState().toasts).toEqual([]);
  });

  it("실패하면 되돌리고 사유를 알린다", async () => {
    highlightFails = true;
    const run = useStore.getState().setHighlight(OTHER, true);
    expect(shown(OTHER)).toBe(true);
    await vi.waitFor(() => expect(releaseHighlight).not.toBeNull());
    releaseHighlight!();
    await run;
    expect(shown(OTHER)).toBe(false);
    expect(useStore.getState().toasts[0]?.title).toBe("강조하지 못했습니다");
  });

  it("실패해도 그사이 다시 읽은 목록은 덮지 않는다", async () => {
    highlightFails = true;
    const run = useStore.getState().setHighlight(OTHER, true);
    await vi.waitFor(() => expect(releaseHighlight).not.toBeNull());
    // 그사이 Obsidian 에서 켠 값이 다시 읽혀 들어왔다.
    useStore.setState({ tasks: [task(FOLDER), task(OTHER, { highlight: true, title: "다시 읽음" })] });
    releaseHighlight!();
    await run;
    // 값은 칠한 것과 같아도 칠한 행이 아니다 — 디스크에서 온 행이라 그대로 둔다.
    const now = useStore.getState().tasks.find((t) => t.folder === OTHER);
    expect(now?.title).toBe("다시 읽음");
    expect(now?.highlight).toBe(true);
  });

  it("보류 · 완료한 업무는 켜지 않는다 — 백엔드를 부르지도 않는다", async () => {
    useStore.setState({ tasks: [task(FOLDER, { status: "on-hold" }), task(OTHER, { status: "completed" })] });
    await useStore.getState().setHighlight(FOLDER, true);
    await useStore.getState().setHighlight(OTHER, true);
    expect(cmds()).not.toContain("set_task_highlight");
    expect(shown(FOLDER)).toBe(false);
  });

  it("보류 중에 남은 강조는 끌 수 있다", async () => {
    useStore.setState({ tasks: [task(FOLDER, { status: "on-hold", highlight: true })] });
    const run = useStore.getState().setHighlight(FOLDER, false);
    expect(shown(FOLDER)).toBe(false);
    await vi.waitFor(() => expect(releaseHighlight).not.toBeNull());
    releaseHighlight!();
    await run;
    expect(calls.find((c) => c.cmd === "set_task_highlight")?.args).toMatchObject({ on: false });
  });

  it("이미 그 값이면 쓰지 않는다", async () => {
    await useStore.getState().setHighlight(OTHER, false);
    expect(cmds()).not.toContain("set_task_highlight");
  });

  it("화면을 바꾸면 업무 메뉴가 닫힌다", () => {
    useStore.setState({ taskCtx: { x: 10, y: 20, folder: OTHER } });
    useStore.getState().setScreen("archive");
    expect(useStore.getState().taskCtx).toBeNull();
  });
});

describe("완료 → [되돌리기]", () => {
  it("완료가 지운 강조를 다시 켠다", async () => {
    useStore.setState({ tasks: [task(FOLDER, { highlight: true })] });
    await useStore.getState().setStatus("completed");
    calls.length = 0;
    useStore.getState().toasts.find((x) => x.action)!.action!.run();
    await vi.waitFor(() => expect(releaseHighlight).not.toBeNull());
    expect(calls.find((c) => c.cmd === "set_task_highlight")?.args).toMatchObject({ on: true });
    expect(cmds().indexOf("set_task_status")).toBeLessThan(cmds().indexOf("set_task_highlight"));
    releaseHighlight!();
    await vi.waitFor(() => expect(shown(FOLDER)).toBe(true));
  });

  it("강조하지 않았던 업무는 되돌려도 켜지 않는다", async () => {
    await useStore.getState().setStatus("completed");
    calls.length = 0;
    useStore.getState().toasts.find((x) => x.action)!.action!.run();
    await vi.waitFor(() => expect(useStore.getState().activeFolder).toBe(FOLDER));
    expect(cmds()).not.toContain("set_task_highlight");
  });
});
