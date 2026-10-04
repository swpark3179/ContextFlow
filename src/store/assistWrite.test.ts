/**
 * AI 도우미가 업무 파일에 쓰는 길(`applyToTaskFile`) — 사람이 편집기에서 친 것과 같은 길이어야 한다.
 *
 * 순수 로직만 덮는 관례의 예외다(`logAndDiscard.test.ts` 와 같은 까닭). 이 길이 틀리면 고치던 글이 AI 정리에
 * 덮이거나, AI 정리가 다음 자동 저장에 지워지거나, 다른 업무의 파일에 쓰인다 — 화면에서는 성공한 것처럼 보인다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
/** 디스크 — 경로 → 글. */
let disk: Record<string, string> = {};

const FOLDER = "/v/Tasks/[2026-10] 결제 PG 교체";
const OTHER = "/v/Tasks/[2026-10] 다른 업무";

function task(folder = FOLDER) {
  return {
    id: folder === FOLDER ? "task-1" : "task-2",
    title: "결제 PG 교체",
    status: "in-progress",
    tags: [],
    category: null,
    created: "2026-10-04 09:00",
    updated: "2026-10-04 09:00",
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
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "read_text_file": {
        const p = String(args.path);
        if (!(p in disk)) throw { kind: "not_found", message: "없음" };
        return disk[p];
      }
      case "write_text_file":
        disk[String(args.path)] = String(args.content);
        return undefined;
      case "create_task_file": {
        const p = `${args.folder}/${args.rel}`;
        if (p in disk) throw { kind: "already_exists", message: "이미 있습니다" };
        disk[p] = "";
        return args.rel;
      }
      case "list_task_files":
        return Object.keys(disk)
          .filter((p) => p.startsWith(`${FOLDER}/`))
          .map((p) => ({ p: p.slice(FOLDER.length + 1), name: p.split("/").pop(), dir: false }));
      case "scan_vault":
        return [task()];
      case "note_day_entry":
        return { id: 1, day: args.day, folder: args.folder ?? null, title: args.title, body: "", at: args.at };
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");
const { applyToTaskFile, taskOverview } = await import("./assistStore");
const { mergeIntoIndex } = await import("../lib/assist/brief");
const { appendGuide } = await import("../lib/assist/guide");

const FM = "---\nid: task-1\nupdated: 2026-10-04 09:00\n---\n";
const SECS = [{ heading: "할 일", lines: ["- [ ] PG 연동 교체"] }];

function open(docs: Record<string, { text: string; saved: string }> = {}) {
  const s = useStore.getState();
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v" },
    tasks: [task(), task(OTHER)],
    activeFolder: FOLDER,
    ui: { ...s.ui, docs, openTabs: [], activeTab: "" },
    uiCache: {},
    dayLog: { day: "2026-10-04", entries: [] },
    toasts: [],
  });
}

const writes = () => calls.filter((c) => c.cmd === "write_text_file");

beforeEach(() => {
  calls.length = 0;
  disk = { [`${FOLDER}/index.md`]: `${FM}## 개요\n디스크의 개요\n` };
});

describe("applyToTaskFile", () => {
  it("merges into index.md on top of what is being typed, and saves at once", async () => {
    // 편집기에서 고치던 중(아직 저장 안 됨)이다.
    const typing = `${FM}## 개요\n디스크의 개요\n방금 친 줄\n`;
    open({ "index.md": { text: typing, saved: disk[`${FOLDER}/index.md`]! } });

    await applyToTaskFile(FOLDER, "index.md", (t) => mergeIntoIndex(t, SECS));

    const saved = disk[`${FOLDER}/index.md`]!;
    expect(saved).toBe(`${FM}## 개요\n디스크의 개요\n방금 친 줄\n\n## 할 일\n- [ ] PG 연동 교체\n`);
    // 버퍼도 디스크와 같아졌다 — 다음 자동 저장이 되돌리지 않는다.
    const doc = useStore.getState().ui.docs["index.md"]!;
    expect(doc.text).toBe(saved);
    expect(doc.saved).toBe(saved);
    // 결과가 탭으로 보인다.
    expect(useStore.getState().ui.openTabs.some((t) => t.path === "index.md")).toBe(true);
  });

  it("creates the guide file once and appends to it afterwards", async () => {
    open();
    await applyToTaskFile(FOLDER, "AI 가이드.md", (t) => appendGuide(t, "## 첫 가이드\n본문"), { create: true });
    const first = disk[`${FOLDER}/AI 가이드.md`]!;
    expect(first.startsWith("# AI 가이드\n")).toBe(true);
    expect(first.endsWith("## 첫 가이드\n본문\n")).toBe(true);

    await applyToTaskFile(FOLDER, "AI 가이드.md", (t) => appendGuide(t, "## 둘째 가이드\n본문"), { create: true });
    const second = disk[`${FOLDER}/AI 가이드.md`]!;
    expect(second.startsWith(first.trimEnd())).toBe(true);
    expect(second.endsWith("## 둘째 가이드\n본문\n")).toBe(true);
    expect(calls.filter((c) => c.cmd === "create_task_file")).toHaveLength(2);
  });

  it("writes nothing when another task is open now", async () => {
    open();
    useStore.setState({ activeFolder: OTHER });
    await expect(applyToTaskFile(FOLDER, "index.md", (t) => mergeIntoIndex(t, SECS))).rejects.toThrow(
      "다른 업무로 옮겨 갔습니다",
    );
    expect(writes()).toHaveLength(0);
  });
});

describe("taskOverview", () => {
  it("prefers the open buffer (unsaved included) over the disk", async () => {
    open({ "index.md": { text: `${FM}## 개요\n버퍼의 개요\n`, saved: "" } });
    expect(await taskOverview(task(), 600)).toBe("버퍼의 개요");
    useStore.setState({ ui: { ...useStore.getState().ui, docs: {} } });
    expect(await taskOverview(task(), 600)).toBe("디스크의 개요");
  });
});
