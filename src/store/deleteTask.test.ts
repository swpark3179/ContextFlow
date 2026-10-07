/**
 * [업무 삭제] 의 **순서**와 거절을 지킨다.
 *
 * `logAndDiscard.test.ts` 와 같은 까닭으로 커맨드 호출을 본다. 이 경로는 사용자의 업무 폴더를
 * 지운다 — 미저장 글을 내려쓰기 전에 지우면 줄 서 있던 저장이 지운 폴더를 되살리고, 막혔을 때
 * 창과 버퍼를 먼저 치우면 남은 업무에서 쓰던 글이 사라진다. 화면에서는 둘 다 멀쩡해 보인다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMeta } from "../lib/api";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

const FOLDER = "/v/Tasks/[2026-10] 잘못 만든 업무";
const OTHER = "/v/Tasks/[2026-10] 남는 업무";

/** `delete_task` 가 던질 오류. `null` 이면 성공한다. */
let deleteError: { kind: string; message: string } | null = null;
/** 업무 폴더의 파일 목록. `null` 이면 읽기에 실패한다. */
let files: { p: string; dir: boolean }[] | null = [];

function task(folder: string, title: string, over: Partial<TaskMeta> = {}): TaskMeta {
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
        if (!files) throw { kind: "io", message: "읽지 못함" };
        return files;
      case "delete_task":
        if (deleteError) throw deleteError;
        return undefined;
      case "scan_vault":
        return deleteError ? [task(FOLDER, "잘못 만든 업무"), task(OTHER, "남는 업무")] : [task(OTHER, "남는 업무")];
      case "scan_templates":
      case "day_entries":
        return [];
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");
const { menuItems } = await import("../components/MenuBar");

/** `index.md` 에 저장하지 않은 글이 있는 채로 지울 업무를 연 상태. */
function openTask() {
  const s = useStore.getState();
  const ui = {
    ...s.ui,
    notepad: "메모",
    docs: { "index.md": { text: "---\nid: x\n---\n## 개요\n고치던 글", saved: "---\nid: x\n---\n## 개요\n" } },
  };
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v", archDays: 30 },
    tasks: [task(FOLDER, "잘못 만든 업무"), task(OTHER, "남는 업무")],
    activeFolder: FOLDER,
    ui,
    uiCache: { [FOLDER]: ui },
    dayLog: { day: "2026-10-07", entries: [] },
    taskDel: null,
    statusMenuOpen: true,
    toasts: [],
  });
}

function cmds(): string[] {
  return calls.map((c) => c.cmd);
}

beforeEach(() => {
  calls.length = 0;
  deleteError = null;
  files = [
    { p: "attachments/", dir: true },
    { p: "attachments/로그.txt", dir: false },
    { p: "index.md", dir: false },
  ];
  openTask();
});

describe("업무 삭제 — 대화상자", () => {
  it("함께 지워지는 파일 · 폴더 수를 세어 연다", async () => {
    await useStore.getState().askDeleteTask(FOLDER);

    const del = useStore.getState().taskDel;
    expect(del).toMatchObject({ folder: FOLDER, title: "잘못 만든 업무", files: 2, dirs: 1, confirm: "" });
    expect(useStore.getState().statusMenuOpen).toBe(false);
  });

  it("파일 목록을 못 읽어도 연다 — 수만 비운다", async () => {
    files = null;
    await useStore.getState().askDeleteTask(FOLDER);

    expect(useStore.getState().taskDel).toMatchObject({ files: null, dirs: null });
  });

  it("보관된 업무에는 열지 않는다", async () => {
    useStore.setState({
      tasks: [task(FOLDER, "잘못 만든 업무", { status: "completed", archived: true, archivedAt: "2026-10-01" })],
    });
    await useStore.getState().askDeleteTask(FOLDER);

    expect(useStore.getState().taskDel).toBeNull();
  });

  it("제목이 맞지 않으면 지우지 않는다", async () => {
    await useStore.getState().askDeleteTask(FOLDER);
    useStore.setState({ taskDel: { ...useStore.getState().taskDel!, confirm: "잘못 만든" } });
    await useStore.getState().deleteTask();

    expect(cmds()).not.toContain("delete_task");
    expect(useStore.getState().activeFolder).toBe(FOLDER);
  });
});

describe("업무 삭제 — 지우기", () => {
  async function confirmAndDelete() {
    await useStore.getState().askDeleteTask(FOLDER);
    // 앞뒤 공백은 확인을 막지 않는다.
    useStore.setState({ taskDel: { ...useStore.getState().taskDel!, confirm: " 잘못 만든 업무 " } });
    await useStore.getState().deleteTask();
  }

  it("미저장 글을 먼저 내려쓰고 그 다음에 지운다", async () => {
    await confirmAndDelete();

    const write = cmds().indexOf("write_text_file");
    const del = cmds().indexOf("delete_task");
    expect(write).toBeGreaterThanOrEqual(0);
    // 뒤집히면 줄 서 있던 저장이 지운 폴더를 되살린다.
    expect(write).toBeLessThan(del);
    expect(calls[del].args).toEqual({ root: "/v", folder: FOLDER });
  });

  it("창을 닫고 화면 상태를 버리며, 다른 업무를 자동으로 열지 않는다", async () => {
    await confirmAndDelete();

    const after = useStore.getState();
    expect(after.activeFolder).toBe("");
    expect(after.uiCache[FOLDER]).toBeUndefined();
    expect(after.taskDel).toBeNull();
    expect(after.tasks.map((t) => t.folder)).toEqual([OTHER]);
    expect(after.toasts.map((t) => t.title)).toContain("업무를 완전히 삭제했습니다");
  });

  it("오늘의 한일과 업무 상태는 건드리지 않는다", async () => {
    // 미저장 글이 없을 때다 — 있으면 그것을 내려쓰는 저장이 평소처럼 오늘의 한일에 올린다.
    const ui = { ...useStore.getState().ui, docs: {} };
    useStore.setState({ ui, uiCache: { [FOLDER]: ui } });
    await confirmAndDelete();

    expect(cmds()).toContain("delete_task");

    for (const cmd of ["note_day_entry", "remove_day_entry", "set_task_status", "set_task_archived", "discard_task"]) {
      expect(cmds()).not.toContain(cmd);
    }
  });

  it("막히면 대화상자에 사유를 남기고 업무 창과 쓰던 글을 그대로 둔다", async () => {
    deleteError = { kind: "locked", message: "업무 폴더를 지우지 못했습니다 · 열려 있거나 쓰기가 막힌 파일: 회의록.xlsx" };
    await confirmAndDelete();

    const after = useStore.getState();
    expect(after.taskDel).toMatchObject({ busy: false, error: deleteError.message });
    expect(after.activeFolder).toBe(FOLDER);
    expect(after.uiCache[FOLDER]).toBeDefined();
    expect(after.ui.notepad).toBe("메모");
  });

  it("지우는 중에 한 번 더 눌러도 두 번 지우지 않는다", async () => {
    await useStore.getState().askDeleteTask(FOLDER);
    useStore.setState({ taskDel: { ...useStore.getState().taskDel!, confirm: "잘못 만든 업무" } });
    await Promise.all([useStore.getState().deleteTask(), useStore.getState().deleteTask()]);

    expect(cmds().filter((c) => c === "delete_task")).toHaveLength(1);
  });
});

describe("메뉴 띠", () => {
  const item = () => menuItems(useStore.getState()).업무.find((i) => i.label === "업무 삭제…");

  it("살아 있는 업무를 열어 두었을 때만 누를 수 있다", () => {
    expect(item()?.off).toBeFalsy();

    useStore.setState({ activeFolder: "" });
    expect(item()?.off).toBe(true);

    useStore.setState({
      activeFolder: FOLDER,
      tasks: [task(FOLDER, "잘못 만든 업무", { status: "completed", archived: true, archivedAt: "2026-10-01" })],
    });
    expect(item()?.off).toBe(true);
  });
});
