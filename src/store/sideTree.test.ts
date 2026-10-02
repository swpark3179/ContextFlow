/**
 * 업무 리스트 트리가 기대는 스토어의 약속 — 접힘 설정을 읽는 규칙과, 새 업무를 만든 뒤 무엇을 여는가.
 *
 * 트리는 열린 업무가 바뀔 때마다 그 묶음을 펼친다. 새 업무를 열기 전에 목록 첫 업무를 한 번
 * 거쳐 가면, 그 업무의 묶음까지 엉뚱하게 펼쳐 놓는다. 커맨드 모킹으로 그 경유를 막는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

const A = "/v/Tasks/[2026-09] 결제 점검";
const B = "/v/Tasks/[2026-09] 인프라 정비";
const NEW = "/v/Tasks/[2026-09] 새 일";

function task(folder: string, title: string, category: string | null = null) {
  return {
    id: `task-${title}`,
    title,
    status: "in-progress",
    tags: [],
    category,
    created: "2026-09-11 09:00",
    updated: "2026-09-11 09:00",
    parentTask: null,
    templateRef: null,
    completedAt: null,
    archived: null,
    archivedAt: null,
    runs: 1,
    order: null,
    folder,
    relFolder: `${folder.replace("/v/", "")}/`,
    indexPath: `${folder}/index.md`,
    tagline: "",
  };
}

/** `scan_vault` 가 돌려줄 목록 — 만든 뒤라 새 업무가 들어 있다. 목록 첫 업무는 A 다. */
const vault = [task(A, "결제 점검", "운영"), task(B, "인프라 정비", "프로젝트"), task(NEW, "새 일", "프로젝트")];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "scan_vault":
        return vault;
      case "create_task":
        return task(NEW, args.title as string, (args.category as string | null) ?? null);
      case "set_task_archived":
        return task(NEW, "새 일", "프로젝트");
      case "list_task_files":
        return [{ p: "index.md", name: "index.md", dir: false }];
      case "read_text_file":
        return "---\nid: x\n---\n## 개요\n";
      case "note_day_entry":
        return { id: 1, day: args.day, folder: args.folder ?? null, title: args.title, body: "", at: args.at };
      case "day_entries":
      case "scan_templates":
        return [];
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS, emptyNewTask, mergeSettings } = await import("./useStore");

beforeEach(() => {
  calls.length = 0;
});

describe("mergeSettings", () => {
  it("파일이 없거나 객체가 아니면 기본값", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("깨진 값")).toEqual(DEFAULT_SETTINGS);
  });

  it("저장된 값을 기본값 위에 얹는다", () => {
    const stored = { vault: "/v", sideGroup: false, catClosed: ["운영", ""] };
    expect(mergeSettings(stored)).toEqual({ ...DEFAULT_SETTINGS, ...stored });
  });

  it("모양이 틀린 sideGroup · catClosed 는 기본값으로 돌린다", () => {
    const got = mergeSettings({ sideGroup: "false", catClosed: "운영" });
    expect(got.sideGroup).toBe(true);
    expect(got.catClosed).toEqual([]);
  });

  it("catClosed 는 문자열만 남기고 중복을 지운다 — 미분류 빈 키도 키다", () => {
    const got = mergeSettings({ catClosed: ["운영", 3, null, "운영", "", ""] });
    expect(got.catClosed).toEqual(["운영", ""]);
  });
});

describe("createTask", () => {
  it("만든 업무 하나만 연다 — 목록 첫 업무를 거쳐 가지 않는다", async () => {
    // 열려 있는 것은 B 이고 목록 첫 업무는 A 다.
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, vault: "/v" },
      tasks: vault.filter((t) => t.folder !== NEW),
      activeFolder: B,
      uiCache: {},
      dayLog: { day: "2026-09-11", entries: [] },
      toasts: [],
      ntBusy: false,
      ntRefs: [],
      nt: { ...emptyNewTask("프로젝트"), title: "새 일" },
    });

    await useStore.getState().createTask();

    const opened = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args.folder);
    expect(opened("load_snapshot")).toEqual([NEW]);
    expect(opened("list_task_files")).toEqual([NEW]);
    expect(useStore.getState().activeFolder).toBe(NEW);
    expect(useStore.getState().toasts).toEqual([]);
  });
});

describe("restoreTask", () => {
  it("재개한 업무 하나만 연다 — 목록 첫 업무를 거쳐 가지 않는다", async () => {
    // 보관된 NEW 를 보관함에서 재개한다. 열려 있는 것은 B 이고 목록 첫 업무는 A 다.
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, vault: "/v" },
      tasks: vault.map((t) => (t.folder === NEW ? { ...t, status: "completed", archived: true } : t)),
      activeFolder: B,
      uiCache: {},
      dayLog: { day: "2026-09-11", entries: [] },
      toasts: [],
    });

    await useStore.getState().restoreTask(NEW);

    const opened = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args.folder);
    expect(opened("load_snapshot")).toEqual([NEW]);
    expect(opened("list_task_files")).toEqual([NEW]);
    expect(useStore.getState().activeFolder).toBe(NEW);
  });
});
