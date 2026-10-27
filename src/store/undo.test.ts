/**
 * 디자인 개선(모션 · 되돌리기)이 바꾼 스토어 동작을 지킨다.
 *
 * * 완료 → 보관의 [되돌리기] 는 보관을 풀고 완료 전 상태로 돌린다 — 재개(`restoreTask`)와 달리 Run Log 에
 *   줄을 남기지 않는다(`set_task_archived` 의 `reopen` 이 거짓).
 * * 오늘의 한일 도크의 ✕ 는 되돌리기가 닫힐 때 DB 에서 지운다. 그사이 다시 손대 돌아온 줄은 지우지 않는다.
 * * 순서 바꾸기는 쓰기 전에 새 순서를 먼저 보이고, 실패하면 되돌린다.
 * * 자동 저장은 문서마다 따로 걸린다 — 예전의 전역 타이머 하나는 다른 문서를 고치면 앞 저장을 취소했다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMeta } from "../lib/api";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
const FOLDER = "/v/Tasks/[2026-10] 배포 정리";
const A = "/v/Tasks/[2026-10] A";
const B = "/v/Tasks/[2026-10] B";
const C = "/v/Tasks/[2026-10] C";

let reorderFails = false;
let dayRows: unknown[] = [];
let releaseReorder: (() => void) | null = null;

function task(folder: string, over: Partial<TaskMeta> = {}): TaskMeta {
  const title = folder.split("] ").pop() as string;
  return {
    id: `task-${title}`,
    title,
    status: "on-hold",
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
      case "reorder_tasks":
        await new Promise<void>((r) => (releaseReorder = r));
        if (reorderFails) throw { kind: "io", message: "쓰지 못함" };
        return (args.folders as string[]).map((f, i) => task(f, { order: (i + 1) * 1024 }));
      case "scan_vault":
        return [task(FOLDER, { status: "on-hold" })];
      case "day_entries":
        return dayRows;
      case "scan_templates":
      case "list_tree":
        return [];
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");

const cmds = () => calls.map((c) => c.cmd);

beforeEach(() => {
  calls.length = 0;
  reorderFails = false;
  releaseReorder = null;
  dayRows = [];
  const s = useStore.getState();
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v", wikiAuto: false },
    tasks: [task(FOLDER)],
    activeFolder: FOLDER,
    ui: { ...s.ui, notepad: "", docs: {}, openTabs: [] },
    uiCache: {},
    dayLog: { day: "2026-10-27", entries: [] },
    toasts: [],
    fly: null,
    completing: "",
    justArchived: "",
  });
});

describe("완료 → [되돌리기]", () => {
  it("보관을 풀고 완료 전 상태(보류)로 돌린다 — Run Log 에 재개 줄을 남기지 않는다", async () => {
    await useStore.getState().setStatus("completed");
    const t = useStore.getState().toasts.find((x) => x.action);
    expect(t?.title).toBe("보관함으로 옮겼습니다");
    calls.length = 0;
    t!.action!.run();
    await vi.waitFor(() => expect(cmds()).toContain("set_task_status"));
    const unarchive = calls.find((c) => c.cmd === "set_task_archived");
    expect(unarchive?.args).toMatchObject({ archived: false, reopen: false });
    expect(calls.find((c) => c.cmd === "set_task_status")?.args).toMatchObject({ status: "on-hold" });
    expect(cmds().indexOf("set_task_archived")).toBeLessThan(cmds().indexOf("set_task_status"));
  });

  it("창을 닫은 업무를 빈 작업공간이 기억하고, [되돌리기] 하면 잊는다", async () => {
    await useStore.getState().setStatus("completed");
    expect(useStore.getState().justArchived).toBe(FOLDER);
    useStore.getState().toasts.find((x) => x.action)!.action!.run();
    await vi.waitFor(() => expect(useStore.getState().activeFolder).toBe(FOLDER));
    expect(useStore.getState().justArchived).toBe("");
  });

  it("완료하는 동안 메뉴를 닫고 `completing` 을 세웠다가 끝나면 내린다", async () => {
    useStore.setState({ statusMenuOpen: true });
    const run = useStore.getState().setStatus("completed");
    expect(useStore.getState().statusMenuOpen).toBe(false);
    expect(useStore.getState().completing).toBe(FOLDER);
    await run;
    expect(useStore.getState().completing).toBe("");
  });
});

describe("오늘의 한일 ✕ — [되돌리기]", () => {
  const entry = { id: 7, day: "2026-10-27", folder: FOLDER, title: "배포 정리", body: "", at: "09:00" };

  it("화면에서는 곧바로 빼고, DB 에서는 토스트가 닫힐 때 지운다", () => {
    useStore.setState({ dayLog: { day: "2026-10-27", entries: [entry] } });
    useStore.getState().dropEntry(7, { undo: true });
    expect(useStore.getState().dayLog.entries).toEqual([]);
    expect(cmds()).not.toContain("remove_day_entry");
    const t = useStore.getState().toasts[0];
    useStore.getState().dropToast(t.id);
    expect(cmds()).toContain("remove_day_entry");
  });

  it("되돌리면 그 자리로 돌아오고 지우지 않는다", () => {
    const other = { ...entry, id: 8, folder: null, title: "회의" };
    useStore.setState({ dayLog: { day: "2026-10-27", entries: [other, entry] } });
    useStore.getState().dropEntry(7, { undo: true });
    useStore.getState().toasts[0].action!.run();
    expect(useStore.getState().dayLog.entries.map((e) => e.id)).toEqual([8, 7]);
    expect(cmds()).not.toContain("remove_day_entry");
  });

  it("되돌리기 시간 안에 그 업무를 다시 손대 줄이 돌아왔으면 지우지 않는다", async () => {
    useStore.setState({ dayLog: { day: "2026-10-27", entries: [entry] } });
    useStore.getState().dropEntry(7, { undo: true });
    useStore.getState().noteToday(FOLDER, "배포 정리");
    await vi.waitFor(() => expect(useStore.getState().dayLog.entries).toHaveLength(1));
    useStore.getState().dropToast(useStore.getState().toasts[0].id);
    expect(cmds()).not.toContain("remove_day_entry");
  });

  it("되돌리기를 기다리는 줄은 다시 읽어도 돌아오지 않는다", async () => {
    useStore.setState({ dayLog: { day: "2026-10-27", entries: [entry] } });
    useStore.getState().dropEntry(7, { undo: true });
    // DB 에는 아직 있다 — 토스트가 닫혀야 지운다.
    dayRows = [entry];
    await useStore.getState().rescopeToday();
    expect(useStore.getState().dayLog.entries).toEqual([]);
  });

  it("도크의 ＋ 는 업무가 아닌 줄을 맨 위에 넣는다", async () => {
    useStore.setState({ dayLog: { day: "2026-10-27", entries: [entry] } });
    vi.setSystemTime(new Date(2026, 9, 27, 10, 0));
    expect(await useStore.getState().addTodayNote("  주간 회의 ")).toBe(true);
    vi.useRealTimers();
    expect(calls.find((c) => c.cmd === "note_day_entry")?.args).toMatchObject({ folder: null, title: "주간 회의" });
    expect(useStore.getState().dayLog.entries.map((e) => e.id)).toEqual([7]);
    expect(await useStore.getState().addTodayNote("   ")).toBe(false);
  });

  it("앱이 스스로 지우는 줄은 곧바로 지운다", () => {
    useStore.setState({ dayLog: { day: "2026-10-27", entries: [entry] } });
    useStore.getState().dropEntry(7);
    expect(cmds()).toContain("remove_day_entry");
    expect(useStore.getState().toasts).toEqual([]);
  });
});

describe("순서 바꾸기 — 먼저 보인다", () => {
  beforeEach(() => {
    useStore.setState({ tasks: [task(A), task(B), task(C)], activeFolder: "" });
  });

  it("쓰기가 끝나기 전에 새 순서가 보인다", async () => {
    const run = useStore.getState().reorderTask(C, 0);
    expect(useStore.getState().tasks.map((t) => t.folder)).toEqual([C, A, B]);
    await vi.waitFor(() => expect(releaseReorder).not.toBeNull());
    releaseReorder!();
    await run;
    expect(useStore.getState().tasks.map((t) => t.folder)).toEqual([C, A, B]);
  });

  it("실패하면 보이던 순서로 되돌린다", async () => {
    reorderFails = true;
    const run = useStore.getState().reorderTask(C, 0);
    await vi.waitFor(() => expect(releaseReorder).not.toBeNull());
    releaseReorder!();
    await run;
    expect(useStore.getState().tasks.map((t) => t.folder)).toEqual([A, B, C]);
    expect(useStore.getState().toasts.map((t) => t.title)).toContain("순서를 바꾸지 못했습니다");
  });
});

describe("자동 저장 — 문서마다 따로", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));

  it("A 를 고치고 0.9초 안에 B 를 고쳐도 둘 다 내려간다", async () => {
    const s = useStore.getState();
    useStore.setState({
      ui: { ...s.ui, docs: { "a.md": { text: "", saved: "" }, "b.md": { text: "", saved: "" } } },
    });
    useStore.getState().editDoc("a.md", "가");
    vi.advanceTimersByTime(500);
    useStore.getState().editDoc("b.md", "나");
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    await vi.waitFor(() => {
      const writes = calls.filter((c) => c.cmd === "write_text_file").map((c) => c.args.path);
      expect(writes).toEqual([`${FOLDER}/a.md`, `${FOLDER}/b.md`]);
    });
    await vi.waitFor(() => expect(useStore.getState().docSave["b.md"]?.state).toBe("saved"));
  });
});
