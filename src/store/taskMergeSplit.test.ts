/**
 * 업무 편입 · 업무 분할이 **디스크를 건드리는 순서**를 지킨다.
 *
 * 이 앱의 테스트는 순수 로직만 덮는 것이 관례지만(`lib/*.test.ts`), 여기는
 * `logAndDiscard` 와 같은 이유로 예외다. 두 경로 모두 사용자의 폴더를 **옮긴다** —
 * 미저장 버퍼를 내려쓰기 전에 옮기면 900ms 뒤에 도는 자동 저장이 사라진 경로에 파일을
 * 되살리고, 옮긴 뒤 화면 상태를 걷어내지 않으면 탭이 없는 파일을 가리킨다. 둘 다 조용히
 * 일어나고 화면에서는 성공한 것처럼 보인다. 커맨드의 순서와 인자가 곧 그 약속이다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

const SRC = "/v/Tasks/[2026-09] 결제 점검";
const DST = "/v/Tasks/[2026-09] 인프라 정비";
const NEW = "/v/Tasks/[2026-09] 결제 점검 — 설계";

function task(folder: string, title: string) {
  return {
    id: `task-${title}`,
    title,
    status: "in-progress",
    tags: ["pay"],
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

/** `scan_vault` 가 돌려줄 목록. 옮긴 결과를 테스트마다 갈아 끼운다. */
let vault = [task(SRC, "결제 점검"), task(DST, "인프라 정비")];
/** `list_task_files` 가 돌려줄 트리. */
let files: { p: string; name: string; dir: boolean }[] = [];
/** 다음 `absorb_task` · `split_task` 호출이 이 사유로 실패한다. */
let failWith: { kind: string; message: string } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "scan_vault":
        return vault;
      case "list_task_files":
        return files;
      case "read_text_file":
        return "---\nid: x\n---\n## 개요\n";
      case "absorb_task":
        if (failWith) throw failWith;
        return { task: task(DST, "인프라 정비"), rel: "[2026-09] 결제 점검/", title: "결제 점검" };
      case "split_task":
        if (failWith) throw failWith;
        return { task: task(NEW, "결제 점검 — 설계"), moved: ["설계/", "가져갈 노트.md"] };
      case "note_day_entry":
        return {
          id: 1,
          day: args.day,
          folder: args.folder ?? null,
          title: args.title,
          body: args.body ?? "",
          at: args.at,
        };
      case "day_entries":
      case "scan_templates":
        return [];
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");

/** 미저장 버퍼와 열린 탭을 든 채로 `SRC` 업무를 열어 둔 상태. */
function openSource() {
  const s = useStore.getState();
  const ui = {
    ...s.ui,
    openTabs: [
      { path: "index.md", mode: "text" as const },
      { path: "설계/도면.md", mode: "text" as const },
      { path: "남는 노트.md", mode: "text" as const },
    ],
    activeTab: "text|설계/도면.md",
    sel: "설계/도면.md",
    docs: {
      // 아직 내려쓰지 않은 글. 옮기기 전에 저장되어야 한다.
      "설계/도면.md": { text: "고친 글", saved: "" },
      "남는 노트.md": { text: "그대로", saved: "그대로" },
    },
    treeOpen: { "설계/": true },
  };
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v" },
    tasks: vault,
    activeFolder: SRC,
    ui,
    uiCache: { [SRC]: ui },
    dayLog: { day: "2026-09-11", entries: [] },
    toasts: [],
    absorb: null,
    split: null,
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
  failWith = null;
  vault = [task(SRC, "결제 점검"), task(DST, "인프라 정비")];
  files = [
    { p: "index.md", name: "index.md", dir: false },
    { p: "남는 노트.md", name: "남는 노트.md", dir: false },
  ];
});

describe("업무 편입", () => {
  it("미저장 버퍼를 내려쓴 뒤에 폴더를 옮긴다", async () => {
    openSource();
    useStore.setState({
      absorb: { source: SRC, target: DST, name: "[2026-09] 결제 점검", query: "", busy: false, error: "" },
    });
    vault = [task(DST, "인프라 정비")];

    await useStore.getState().doAbsorb();

    // 뒤집히면 자동 저장이 옛 경로에 파일을 되살린다.
    expect(order("write_text_file")).toBeGreaterThanOrEqual(0);
    expect(order("write_text_file")).toBeLessThan(order("absorb_task"));
    const args = argsOf("absorb_task");
    expect(args.source).toBe(SRC);
    expect(args.target).toBe(DST);
    expect(args.name).toBe("[2026-09] 결제 점검");
  });

  it("편입된 업무의 창을 닫고 받는 업무를 연다", async () => {
    openSource();
    useStore.setState({
      absorb: { source: SRC, target: DST, name: "", query: "", busy: false, error: "" },
    });
    vault = [task(DST, "인프라 정비")];

    await useStore.getState().doAbsorb();

    const after = useStore.getState();
    expect(after.absorb).toBeNull();
    expect(after.activeFolder).toBe(DST);
    // 사라진 업무의 화면 상태를 들고 있으면 없는 경로에 자동 저장이 돈다.
    expect(after.uiCache[SRC]).toBeUndefined();
    // 어디로 들어갔는지 보여 주는 것이 결과다.
    expect(after.ui.treeOpen["[2026-09] 결제 점검/"]).toBe(true);
    expect(after.ui.sel).toBe("[2026-09] 결제 점검/");
    expect(after.toasts.map((t) => t.title)).toContain("업무를 편입했습니다");
  });

  it("이름 칸이 비면 폴더 이름을 정하지 않고 백엔드에 맡긴다", async () => {
    openSource();
    useStore.setState({
      absorb: { source: SRC, target: DST, name: "   ", query: "", busy: false, error: "" },
    });
    vault = [task(DST, "인프라 정비")];

    await useStore.getState().doAbsorb();

    expect(argsOf("absorb_task").name).toBeNull();
  });

  it("오늘의 한일을 받는 업무로 옮겨 죽은 줄을 남기지 않는다", async () => {
    openSource();
    useStore.setState({
      absorb: { source: SRC, target: DST, name: "", query: "", busy: false, error: "" },
    });
    vault = [task(DST, "인프라 정비")];

    await useStore.getState().doAbsorb();

    const args = argsOf("relocate_day_entries");
    expect(args.from).toBe(SRC);
    expect(args.to).toBe(DST);
    expect(args.title).toBe("인프라 정비");
  });

  it("실패하면 사유를 대화상자에 남기고 아무것도 닫지 않는다", async () => {
    openSource();
    useStore.setState({
      absorb: { source: SRC, target: DST, name: "", query: "", busy: false, error: "" },
    });
    failWith = { kind: "locked", message: "'결제 점검' 을(를) 옮길 수 없습니다 · 다른 프로그램이 열어 둔 파일: 정산.xlsx" };

    await useStore.getState().doAbsorb();

    const after = useStore.getState();
    // 파일을 닫고 그 자리에서 다시 누를 수 있어야 한다.
    expect(after.absorb?.busy).toBe(false);
    expect(after.absorb?.error).toContain("정산.xlsx");
    expect(after.activeFolder).toBe(SRC);
    expect(after.uiCache[SRC]).toBeDefined();
    expect(after.toasts.map((t) => t.title)).toContain("편입하지 못했습니다");
  });

  it("받는 업무를 고르지 않았으면 아무 일도 하지 않는다", async () => {
    openSource();
    useStore.setState({
      absorb: { source: SRC, target: "", name: "", query: "", busy: false, error: "" },
    });

    await useStore.getState().doAbsorb();

    expect(calls.map((c) => c.cmd)).not.toContain("absorb_task");
    expect(useStore.getState().absorb).not.toBeNull();
  });
});

describe("업무 분할", () => {
  /** 고른 항목과 새 업무 정보를 채운 분할 대화상자. */
  function openSplit() {
    openSource();
    useStore.setState({
      split: {
        source: SRC,
        sel: { "설계/": true, "가져갈 노트.md": true, "남는 노트.md": false },
        title: "  결제 점검 — 설계  ",
        summary: "도면만 따로 본다",
        tags: " design , pay ,, ",
        busy: false,
        error: "",
      },
    });
  }

  it("고른 최상위 항목만 넘기고, 제목과 태그를 다듬는다", async () => {
    openSplit();
    vault = [task(SRC, "결제 점검"), task(NEW, "결제 점검 — 설계")];

    await useStore.getState().doSplit();

    const args = argsOf("split_task");
    expect(args.source).toBe(SRC);
    expect(args.items).toEqual(["설계/", "가져갈 노트.md"]);
    expect(args.title).toBe("결제 점검 — 설계");
    expect(args.summary).toBe("도면만 따로 본다");
    expect(args.tags).toEqual(["design", "pay"]);
    // 옮기기 전에 내려쓴다 — 옮겨 갈 파일의 미저장 글이 어디에도 없으면 안 된다.
    expect(order("write_text_file")).toBeLessThan(order("split_task"));
  });

  it("옮겨 간 경로를 가리키던 탭과 버퍼를 원본에서 걷어낸다", async () => {
    openSplit();
    vault = [task(SRC, "결제 점검"), task(NEW, "결제 점검 — 설계")];

    await useStore.getState().doSplit();

    const left = useStore.getState().uiCache[SRC];
    // 폴더 하나가 가면 그 안의 탭도 함께 닫힌다(접두사 판정).
    expect(left.openTabs.map((t) => t.path)).toEqual(["index.md", "남는 노트.md"]);
    expect(Object.keys(left.docs)).toEqual(["남는 노트.md"]);
    expect(left.treeOpen["설계/"]).toBeUndefined();
    // 활성 탭이 닫혔으므로 남은 것 중 마지막이 활성이 된다.
    expect(left.activeTab).toBe("text|남는 노트.md");
    expect(left.sel).toBe("");
  });

  it("갈라져 나온 새 업무를 연다", async () => {
    openSplit();
    vault = [task(SRC, "결제 점검"), task(NEW, "결제 점검 — 설계")];

    await useStore.getState().doSplit();

    const after = useStore.getState();
    expect(after.split).toBeNull();
    expect(after.activeFolder).toBe(NEW);
    expect(after.toasts.map((t) => t.title)).toContain("업무를 분할했습니다");
  });

  it("제목이나 고른 항목이 없으면 부르지 않는다", async () => {
    openSplit();
    useStore.setState({ split: { ...useStore.getState().split!, title: "   " } });
    await useStore.getState().doSplit();
    expect(calls.map((c) => c.cmd)).not.toContain("split_task");

    useStore.setState({ split: { ...useStore.getState().split!, title: "새 업무", sel: {} } });
    await useStore.getState().doSplit();
    expect(calls.map((c) => c.cmd)).not.toContain("split_task");
  });

  it("실패하면 사유를 남기고 원본의 화면 상태를 그대로 둔다", async () => {
    openSplit();
    failWith = { kind: "locked", message: "'설계' 을(를) 옮길 수 없습니다 · 다른 프로그램이 열어 둔 파일: 설계/도면.md" };

    await useStore.getState().doSplit();

    const after = useStore.getState();
    expect(after.split?.busy).toBe(false);
    expect(after.split?.error).toContain("설계/도면.md");
    expect(after.activeFolder).toBe(SRC);
    // 옮기지 못했으면 탭도 그대로 있어야 한다.
    expect(after.ui.openTabs).toHaveLength(3);
    expect(after.toasts.map((t) => t.title)).toContain("분할하지 못했습니다");
  });
});

describe("탭 닫기", () => {
  it("여러 탭을 닫기 전에 미저장 버퍼를 내려쓴다", async () => {
    openSource();
    await useStore.getState().closeAllTabs();

    expect(calls.map((c) => c.cmd)).toContain("write_text_file");
    const after = useStore.getState();
    expect(after.ui.openTabs).toEqual([]);
    expect(after.ui.activeTab).toBe("");
    // 버퍼는 남긴다 — 다시 열면 있던 글이 그대로 나온다.
    expect(Object.keys(after.ui.docs)).toContain("설계/도면.md");
  });

  it("이 탭만 남기면 그 탭이 활성이 된다", async () => {
    openSource();
    await useStore.getState().closeOtherTabs("text|남는 노트.md");

    const after = useStore.getState();
    expect(after.ui.openTabs.map((t) => t.path)).toEqual(["남는 노트.md"]);
    expect(after.ui.activeTab).toBe("text|남는 노트.md");
  });

  it("탭 하나를 닫으면 우클릭 메뉴도 함께 닫힌다", () => {
    openSource();
    useStore.setState({ tabCtx: { key: "text|남는 노트.md", x: 10, y: 10 } });

    useStore.getState().closeTab("text|남는 노트.md");

    expect(useStore.getState().tabCtx).toBeNull();
    expect(useStore.getState().ui.openTabs.map((t) => t.path)).toEqual([
      "index.md",
      "설계/도면.md",
    ]);
  });
});
