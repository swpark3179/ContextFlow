/**
 * 파일을 안 붙인 업무를 완료하는 경로의 **순서**를 지킨다.
 *
 * 이 앱의 테스트는 순수 로직만 덮는 것이 관례지만, 여기만 예외를 둔다. 이 경로는 사용자의
 * 업무 폴더를 **지운다**. 기록을 쓰기 전에 지우거나, 곧 지울 폴더에 상태를 써 넣거나,
 * `index.md` 본문을 싣는 것을 빼먹으면 — 전부 조용히 사용자의 글이 사라지는 고장이고,
 * 화면에서는 성공한 것처럼 보인다. 커맨드 호출의 순서와 인자가 곧 그 약속이다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

/** 업무 폴더의 파일 목록. 테스트마다 갈아 끼운다. */
let files: { p: string }[] = [{ p: "index.md" }];
/** `index.md` 전문(frontmatter 포함). */
let indexText = "";

const FOLDER = "/v/Tasks/[2026-09] 통화로 끝낸 일";

function task() {
  return {
    id: "task-1",
    title: "통화로 끝낸 일",
    status: "in-progress",
    tags: [],
    created: "2026-09-11 09:00",
    updated: "2026-09-11 09:00",
    parentTask: null,
    templateRef: null,
    completedAt: null,
    archived: null,
    archivedAt: null,
    runs: 1,
    order: null,
    folder: FOLDER,
    relFolder: "Tasks/[2026-09] 통화로 끝낸 일/",
    indexPath: `${FOLDER}/index.md`,
    tagline: "",
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "list_task_files":
        return files;
      case "read_text_file":
        return indexText;
      case "note_day_entry":
        return {
          id: 7,
          day: args.day,
          folder: args.folder ?? null,
          title: args.title,
          body: args.body ?? "",
          at: args.at,
        };
      case "scan_vault":
      case "day_entries":
        return [];
      case "set_task_status":
        return { ...task(), status: "completed", completedAt: "2026-09-11" };
      case "set_task_archived":
        return { ...task(), archived: true };
      default:
        return undefined;
    }
  },
}));

// 스토어는 `window` 의 타이머를 쓴다(저장 디바운스 · 토스트 사라짐). 브라우저 환경을
// 끌어오는 대신 필요한 둘만 빌려 준다 — 이 테스트가 보는 것은 커맨드 호출이다.
vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");

/** 메모장에 글이 있고 파일은 `index.md` 하나뿐인, 갓 만든 업무를 연 상태. */
function openLightTask(notepad: string) {
  const s = useStore.getState();
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v" },
    tasks: [task()],
    activeFolder: FOLDER,
    ui: { ...s.ui, notepad, docs: {} },
    uiCache: {},
    dayLog: { day: "2026-09-11", entries: [] },
    toasts: [],
  });
}

function order(cmd: string): number {
  return calls.findIndex((c) => c.cmd === cmd);
}

function argsOf(cmd: string): Record<string, unknown> {
  const hit = calls.find((c) => c.cmd === cmd);
  if (!hit) throw new Error(`${cmd} 를 부르지 않았다`);
  return hit.args;
}

beforeEach(() => {
  calls.length = 0;
  files = [{ p: "index.md" }];
  indexText = "---\nid: task-1\n---\n## 개요\n적어 둔 개요\n";
});

describe("완료 — 파일을 안 붙인 업무", () => {
  it("기록을 먼저 쓰고 그 다음에 폴더를 지운다", async () => {
    openLightTask("전화로 정리하고 끝냈다");
    await useStore.getState().setStatus("completed");

    expect(order("note_day_entry")).toBeGreaterThanOrEqual(0);
    expect(order("discard_task")).toBeGreaterThanOrEqual(0);
    // 뒤집히면 쓰기가 실패한 순간 사용자의 글이 어디에도 없다.
    expect(order("note_day_entry")).toBeLessThan(order("discard_task"));
  });

  it("곧 지울 폴더에는 아무것도 쓰지 않는다", async () => {
    openLightTask("메모");
    await useStore.getState().setStatus("completed");

    const written = calls.map((c) => c.cmd);
    expect(written).not.toContain("set_task_status");
    expect(written).not.toContain("save_snapshot");
    expect(written).not.toContain("set_task_archived");
  });

  it("메모와 index.md 본문을 함께 내용으로 싣는다", async () => {
    openLightTask("전화로 정리하고 끝냈다");
    await useStore.getState().setStatus("completed");

    const args = argsOf("note_day_entry");
    expect(args.title).toBe("통화로 끝낸 일");
    expect(args.body).toBe("전화로 정리하고 끝냈다\n\n---\n\n적어 둔 개요");
    // 폴더가 곧 사라지므로 경로로 남기면 눌러도 아무 일이 없는 죽은 줄이 된다.
    expect(args.folder).toBeNull();
  });

  it("index.md 를 못 읽어도 메모는 남기고 폴더를 지운다", async () => {
    indexText = "";
    openLightTask("메모만 있다");
    await useStore.getState().setStatus("completed");

    expect(argsOf("note_day_entry").body).toBe("메모만 있다");
    expect(order("discard_task")).toBeGreaterThan(order("note_day_entry"));
  });

  it("창을 닫고, 자동으로 다른 업무를 열지 않는다", async () => {
    openLightTask("메모");
    await useStore.getState().setStatus("completed");

    const after = useStore.getState();
    expect(after.activeFolder).toBe("");
    expect(after.uiCache).toEqual({});
    expect(after.toasts.map((t) => t.title)).toContain("오늘의 한일에 남겼습니다");
  });
});

describe("완료 — 보관으로 가는 경우", () => {
  it("파일을 하나라도 붙였으면 예전대로 보관한다", async () => {
    files = [{ p: "index.md" }, { p: "회의록.md" }];
    openLightTask("메모도 있다");
    await useStore.getState().setStatus("completed");

    expect(calls.map((c) => c.cmd)).toContain("set_task_status");
    expect(calls.map((c) => c.cmd)).not.toContain("discard_task");
  });

  it("메모가 비었으면 남길 글이 없으니 보관한다", async () => {
    openLightTask("   ");
    await useStore.getState().setStatus("completed");

    expect(calls.map((c) => c.cmd)).toContain("set_task_status");
    expect(calls.map((c) => c.cmd)).not.toContain("discard_task");
  });

  it("파일 목록을 못 읽었으면 되돌릴 수 있는 쪽으로 간다", async () => {
    files = null as unknown as { p: string }[];
    openLightTask("메모");
    await useStore.getState().setStatus("completed");

    expect(calls.map((c) => c.cmd)).not.toContain("discard_task");
  });

  it("완료가 아닌 상태 변경은 판정을 거치지 않는다", async () => {
    openLightTask("메모");
    await useStore.getState().setStatus("on-hold");

    expect(calls.map((c) => c.cmd)).not.toContain("list_task_files");
    expect(calls.map((c) => c.cmd)).not.toContain("discard_task");
    expect(calls.map((c) => c.cmd)).toContain("set_task_status");
  });
});
