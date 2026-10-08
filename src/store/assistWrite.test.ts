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
/** 이 경로에 쓰면 실패한다. */
let failWrite: string | null = null;

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
        if (args.path === failWrite) throw { kind: "io", message: "디스크 오류" };
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
const { applyBrief, applyIssue, applyToTaskFile, taskBriefFiles, taskIssueFiles, taskOverview, useAssist } = await import(
  "./assistStore"
);
const { mergeIntoIndex, planBrief } = await import("../lib/assist/brief");
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
  failWrite = null;
  disk = { [`${FOLDER}/index.md`]: `${FM}## 개요\n디스크의 개요\n` };
  useAssist.setState({ reveal: null });
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

describe("applyIssue", () => {
  const REL = "이슈/2026-10-05 B카드사 실패.md";
  const LINE = "- [ ] 10/05(월) [테스트 회신] B카드사 실패 → [[이슈/2026-10-05 B카드사 실패|B카드사 실패]]";
  const NEW = {
    mode: "new" as const,
    rel: REL,
    body: "# B카드사 실패\n\n## 처리 기록\n",
    entry: "## 2026-10-05 테스트 회신 · B카드사 실패\n- 재테스트도 실패",
    indexLine: LINE,
  };
  const activePath = () => useStore.getState().ui.activeTab.split("|")[1];

  it("creates the issue file, leaves one line in index.md, and comes back to the issue tab", async () => {
    open();
    const res = await applyIssue(FOLDER, NEW);
    expect(res).toEqual({ rel: REL, placed: true, indexError: null });
    expect(disk[`${FOLDER}/${REL}`]).toBe(NEW.body);
    expect(disk[`${FOLDER}/index.md`]).toBe(`${FM}## 개요\n디스크의 개요\n\n## 이슈\n${LINE}\n`);
    expect(activePath()).toBe(REL);
    expect(useAssist.getState().reveal).toEqual({ folder: FOLDER, path: REL, line: 0 });
  });

  it("never overwrites a file that appeared meanwhile, and never repeats the index line", async () => {
    open();
    await applyIssue(FOLDER, NEW);
    await applyIssue(FOLDER, NEW);
    const issue = disk[`${FOLDER}/${REL}`]!;
    expect(issue.startsWith("# B카드사 실패\n\n## 처리 기록\n")).toBe(true);
    expect(issue.endsWith("## 2026-10-05 테스트 회신 · B카드사 실패\n- 재테스트도 실패\n")).toBe(true);
    expect(disk[`${FOLDER}/index.md`]!.split(LINE).length - 1).toBe(1);
    // 두 번째 한 건의 머리로 스크롤한다.
    const reveal = useAssist.getState().reveal!;
    expect(issue.split("\n")[reveal.line]).toBe("## 2026-10-05 테스트 회신 · B카드사 실패");
  });

  it("puts an entry at the end of the chosen section on top of what is being typed", async () => {
    const path = `${FOLDER}/테스트 결과.md`;
    disk[path] = "# 테스트\n\n## 2차\n- a\n\n## 3차\n- c\n";
    const typing = "# 테스트\n\n## 2차\n- a\n- 방금 친 줄\n\n## 3차\n- c\n";
    open({ "테스트 결과.md": { text: typing, saved: disk[path]! } });
    const res = await applyIssue(FOLDER, {
      mode: "existing",
      rel: "테스트 결과.md",
      heading: "## 2차",
      entry: "### 2026-10-05 테스트 회신 · 건\n- b",
      indexLine: null,
    });
    expect(res.placed).toBe(true);
    expect(disk[path]).toBe("# 테스트\n\n## 2차\n- a\n- 방금 친 줄\n\n### 2026-10-05 테스트 회신 · 건\n- b\n\n## 3차\n- c\n");
    // index 줄을 끄면 index.md 는 건드리지 않는다.
    expect(writes().some((c) => c.args.path === `${FOLDER}/index.md`)).toBe(false);
    expect(activePath()).toBe("테스트 결과.md");
    expect(useAssist.getState().reveal?.line).toBe(6);
  });

  it("says when the chosen section is gone — the entry goes to the end", async () => {
    disk[`${FOLDER}/메모.md`] = "## 다른 섹션\n- x\n";
    open();
    const res = await applyIssue(FOLDER, {
      mode: "existing",
      rel: "메모.md",
      heading: "## 사라진 섹션",
      entry: "### 건",
      indexLine: null,
    });
    expect(res.placed).toBe(false);
    expect(disk[`${FOLDER}/메모.md`]).toBe("## 다른 섹션\n- x\n\n### 건\n");
  });

  it("keeps the issue when only the index line fails", async () => {
    open();
    failWrite = `${FOLDER}/index.md`;
    const res = await applyIssue(FOLDER, NEW);
    expect(disk[`${FOLDER}/${REL}`]).toBe(NEW.body);
    expect(res.indexError).toBeTruthy();
    expect(activePath()).toBe(REL);
  });

  it("writes nothing when another task is open now", async () => {
    open();
    useStore.setState({ activeFolder: OTHER });
    await expect(applyIssue(FOLDER, NEW)).rejects.toThrow("다른 업무로 옮겨 갔습니다");
    expect(writes()).toHaveLength(0);
    expect(useAssist.getState().reveal).toBeNull();
  });
});

describe("taskIssueFiles", () => {
  it("outlines the open task's notes, preferring unsaved buffers", async () => {
    disk[`${FOLDER}/메모.md`] = "## 디스크 제목\n";
    open({ "메모.md": { text: "## 버퍼 제목\n", saved: "## 디스크 제목\n" } });
    const entry = (p: string) => ({ p, name: p, dir: false, size: "1 KB", bytes: 10, bin: false, link: null });
    useStore.setState({ files: [entry("메모.md"), entry("index.md"), entry("없는 파일.md")] });
    const files = await taskIssueFiles(FOLDER);
    expect(files.map((f) => f.path)).toEqual(["index.md", "메모.md"]);
    expect(files[1]!.headings.map((h) => h.raw)).toEqual(["## 버퍼 제목"]);
    useStore.setState({ activeFolder: OTHER });
    expect(await taskIssueFiles(FOLDER)).toEqual([]);
  });
});

describe("applyBrief", () => {
  const ISSUE = "이슈/2026-10-05 B카드사 실패.md";
  const INDEX = `${FM}## 개요\n디스크의 개요\n\n## 할 일\n- [ ] QA팀 검증 받기\n`;
  const ISSUE_DOC = "# B카드사 실패\n\n## 처리할 일\n- [ ] 원인 확인\n\n## 처리 기록\n";
  const activePath = () => useStore.getState().ui.activeTab.split("|")[1];
  const plan = () =>
    planBrief(
      {
        summary: [],
        goals: [],
        todos: [],
        schedule: [],
        refs: [],
        unknowns: [],
        done: [
          {
            text: "QA팀 검증 완료",
            from: ["in"],
            todo: { id: "f1.c1", path: "index.md", raw: "- [ ] QA팀 검증 받기", text: "QA팀 검증 받기" },
            to: null,
          },
        ],
        notes: [{ text: "카드사 회신 대기", from: ["in"], to: { path: ISSUE, heading: "## 처리 기록" } }],
      },
      [],
      "2026-10-08",
    );

  it("writes every file the same way the editor does, then comes back to the first one", async () => {
    disk[`${FOLDER}/index.md`] = INDEX;
    disk[`${FOLDER}/${ISSUE}`] = ISSUE_DOC;
    open();
    const res = await applyBrief(FOLDER, plan());
    expect(res).toEqual({ paths: ["index.md", ISSUE], missed: 0, fellBack: 0 });
    const index = disk[`${FOLDER}/index.md`]!;
    expect(index).toBe(
      `${FM}## 개요\n디스크의 개요\n\n## 할 일\n- [x] QA팀 검증 받기\n\n## 진행 기록\n- 10/08(목) 완료 — QA팀 검증 완료\n`,
    );
    expect(disk[`${FOLDER}/${ISSUE}`]).toBe(`${ISSUE_DOC}- 10/08(목) 카드사 회신 대기\n`);
    expect(activePath()).toBe("index.md");
    const reveal = useAssist.getState().reveal!;
    expect(reveal.path).toBe("index.md");
    expect(index.split("\n")[reveal.line]).toBe("## 진행 기록");

    // 다시 눌러도 겹쳐 들어가지 않는다 — 체크는 이미 했으니 못 했다고 센다.
    const again = await applyBrief(FOLDER, plan());
    expect(again.missed).toBe(1);
    expect(disk[`${FOLDER}/index.md`]).toBe(index);
    expect(disk[`${FOLDER}/${ISSUE}`]).toBe(`${ISSUE_DOC}- 10/08(목) 카드사 회신 대기\n`);
  });

  it("names the file that failed", async () => {
    disk[`${FOLDER}/index.md`] = INDEX;
    disk[`${FOLDER}/${ISSUE}`] = ISSUE_DOC;
    open();
    failWrite = `${FOLDER}/${ISSUE}`;
    await expect(applyBrief(FOLDER, plan())).rejects.toThrow(ISSUE);
  });

  it("writes nothing when another task is open now", async () => {
    open();
    useStore.setState({ activeFolder: OTHER });
    await expect(applyBrief(FOLDER, plan())).rejects.toThrow("다른 업무로 옮겨 갔습니다");
    expect(writes()).toHaveLength(0);
    expect(useAssist.getState().reveal).toBeNull();
  });
});

describe("taskBriefFiles", () => {
  it("outlines the open task's notes with their open to-dos, preferring unsaved buffers", async () => {
    disk[`${FOLDER}/메모.md`] = "## 디스크\n- [ ] 디스크 할 일\n";
    open({ "메모.md": { text: "## 버퍼\n- [ ] 버퍼 할 일\n- [x] 끝낸 일\n", saved: "" } });
    const entry = (p: string) => ({ p, name: p, dir: false, size: "1 KB", bytes: 10, bin: false, link: null });
    useStore.setState({ files: [entry("메모.md"), entry("index.md")] });
    const files = await taskBriefFiles(FOLDER);
    expect(files.map((f) => f.path)).toEqual(["index.md", "메모.md"]);
    expect(files[1]!.todos).toEqual([{ id: "f2.c1", text: "버퍼 할 일", raw: "- [ ] 버퍼 할 일", heading: "## 버퍼" }]);
    useStore.setState({ activeFolder: OTHER });
    expect(await taskBriefFiles(FOLDER)).toEqual([]);
  });
});
