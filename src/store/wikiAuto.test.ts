/**
 * [완료] → 위키 자동 반영의 조건.
 *
 * 자동 반영은 사용자가 손대지 않아도 업무 내용을 AI 서비스로 보낸다. 그래서 언제 보내고
 * 언제 보내지 않는지가 곧 약속이다 — 설정을 껐거나 반영 연결이 없으면 보내지 않고, 완료가
 * 아닌 보관(지금 보관함으로)과 폴더째 지워지는 가벼운 업무도 보내지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const FOLDER = "/v/Tasks/[2026-09] 배포 정리";
let files: { p: string }[] = [];

function task(over: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "배포 정리",
    status: "in-progress",
    tags: [],
    category: null,
    created: "",
    updated: "",
    parentTask: null,
    templateRef: null,
    completedAt: null,
    archived: null,
    archivedAt: null,
    runs: 1,
    order: null,
    folder: FOLDER,
    relFolder: "Tasks/[2026-09] 배포 정리/",
    indexPath: `${FOLDER}/index.md`,
    tagline: "",
    ...over,
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string) => {
    switch (cmd) {
      case "list_task_files":
        return files;
      case "read_text_file":
        return "---\nid: task-1\n---\n## 개요\n";
      case "set_task_status":
        return task({ status: "completed", completedAt: "2026-09-30" });
      case "set_task_archived":
        return task({ status: "completed", archived: true });
      case "note_day_entry":
        return { id: 1, day: "2026-09-30", folder: null, title: "", body: "", at: "" };
      case "scan_vault":
      case "day_entries":
        return [];
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");
const { useAi } = await import("./aiStore");
const { useWiki } = await import("./wikiStore");

const enqueue = vi.fn();

function open(opts: { wikiAuto?: boolean; route?: boolean; notepad?: string } = {}) {
  const s = useStore.getState();
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v", wikiAuto: opts.wikiAuto ?? true },
    tasks: [task()],
    activeFolder: FOLDER,
    ui: { ...s.ui, notepad: opts.notepad ?? "", docs: {} },
    uiCache: {},
    dayLog: { day: "2026-09-30", entries: [] },
    toasts: [],
  });
  useAi.setState({
    settings: {
      agents: {},
      active: { agentId: opts.route === false ? "" : "claude", model: "" },
    },
    detected: {
      claude: {
        id: "claude",
        name: "Claude Code",
        available: true,
        path: "c",
        version: null,
        source: "path",
        models: [],
        modelsSource: "fallback",
        diagnostic: null,
      },
    },
  });
}

beforeEach(() => {
  enqueue.mockClear();
  files = [{ p: "index.md" }, { p: "notes.md" }];
  useWiki.setState({ enqueue });
});

describe("완료 → 위키 자동 반영", () => {
  it("설정이 켜져 있고 반영 연결이 있으면 보관한 업무를 큐에 넣는다", async () => {
    open();
    await useStore.getState().setStatus("completed");
    expect(enqueue).toHaveBeenCalledWith("task-1", "배포 정리");
  });

  it("설정을 끄면 넣지 않는다", async () => {
    open({ wikiAuto: false });
    await useStore.getState().setStatus("completed");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("반영 연결이 없으면 넣지 않는다", async () => {
    open({ route: false });
    await useStore.getState().setStatus("completed");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("폴더째 지워지는 가벼운 업무는 넣지 않는다", async () => {
    files = [{ p: "index.md" }];
    open({ notepad: "전화로 끝냈다" });
    await useStore.getState().setStatus("completed");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("완료 없이 보관한 것(지금 보관함으로)은 넣지 않는다", async () => {
    open();
    await useStore.getState().archiveNow(FOLDER);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
