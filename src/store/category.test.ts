/**
 * 카테고리 지정 · 새 업무 · 분할이 백엔드에 넘기는 값과 **순서**.
 *
 * 지정은 index.md 의 frontmatter 한 줄을 고친다. 고치던 글을 먼저 내려쓰지 않거나, 고친 뒤
 * 열린 버퍼를 디스크에 맞추지 않으면 다음 자동 저장이 그 줄을 조용히 지운다 — 화면의 칩은
 * 바뀐 채로 남으므로 재시작해야 사라진 것을 안다. 그래서 커맨드 모킹으로 지킨다.
 *
 * 업무 리스트에서 다른 묶음 머리에 놓아 바꾸기(`dropOnCategory`)와 그 [되돌리기] 토스트도 여기서
 * 본다 — 같은 지정 길을 거친다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST } from "../lib/design";
import { splitFrontmatter } from "../lib/markdown";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

const A = "/v/Tasks/[2026-09] 결제 점검";
const B = "/v/Tasks/[2026-09] 인프라 정비";
const NEW = "/v/Tasks/[2026-09] 결제 점검 — 설계";
const HEAD = '---\nid: task-1\ntitle: "결제 점검"\nstatus: in-progress\ntags: [pay]\n---\n';
const BODY = "## 개요\n처음 글\n";

function task(folder: string, title: string, category: string | null = null) {
  return {
    id: `task-${title}`,
    title,
    status: "in-progress",
    tags: ["pay"],
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

let disk: Record<string, string> = {};
let vault = [task(A, "결제 점검"), task(B, "인프라 정비", "프로젝트/ContextFlow")];
/** 다음 `set_task_category` 가 이 폴더들을 실패로 돌려준다. */
let lockedFolders: string[] = [];
/** 커맨드 → 이것이 풀릴 때까지 응답을 붙든다. 커맨드가 오래 도는 사이를 흉내 낸다. */
let holds: Record<string, Promise<void>> = {};

/** 붙들어 둘 약속과 그것을 푸는 손잡이. */
function hold(cmd: string): () => void {
  let release!: () => void;
  holds[cmd] = new Promise((r) => (release = r));
  return release;
}

const idx = (folder: string) => `${folder}/index.md`;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "read_text_file": {
        const text = disk[args.path as string];
        if (text === undefined) throw { kind: "io", message: "읽을 수 없습니다" };
        // 읽은 시점의 내용을 늦게 돌려준다.
        await holds[cmd];
        return text;
      }
      case "write_text_file":
        disk[args.path as string] = args.content as string;
        return undefined;
      case "set_task_category": {
        const category = args.category as string | null;
        const changed: string[] = [];
        const failed: { folder: string; title: string; reason: string }[] = [];
        for (const f of args.folders as string[]) {
          if (lockedFolders.includes(f)) {
            failed.push({ folder: f, title: "결제 점검", reason: "다른 프로그램이 파일을 쓰고 있습니다" });
            continue;
          }
          const without = disk[idx(f)].replace(/category: .*\n/, "");
          disk[idx(f)] = category
            ? without.replace("tags: [pay]\n", `tags: [pay]\ncategory: "${category}"\n`)
            : without;
          changed.push(f);
          vault = vault.map((t) => (t.folder === f ? { ...t, category } : t));
        }
        // 파일은 이미 고쳤고 응답만 늦다.
        await holds[cmd];
        return { tasks: vault, changed, failed };
      }
      case "create_task":
        return task(NEW, args.title as string, (args.category as string | null) ?? null);
      case "split_task":
        return { task: task(NEW, args.title as string), moved: ["설계.md"] };
      case "scan_vault": {
        // 훑은 시점의 목록을 늦게 돌려준다.
        const seen = vault;
        await holds[cmd];
        return seen;
      }
      case "list_task_files":
        return [{ p: "index.md", name: "index.md", dir: false }];
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

// 타이머는 돌리지 않는다(`indexResync.test.ts` 와 같은 이유). 자동 저장을 보는 테스트만 가짜
// 타이머를 켜고, 그때만 시간을 직접 넘긴다.
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms: number) => (vi.isFakeTimers() ? setTimeout(fn, ms) : 0),
  clearTimeout: (id: number) => clearTimeout(id),
});
const realTimeout = setTimeout;

const { useStore, DEFAULT_SETTINGS, emptyNewTask } = await import("./useStore");

/** `A` 를 열고 index.md 를 편집기 탭으로 띄운 상태. `text` 를 주면 고치던 중이다. */
function openA(text?: string) {
  const saved = disk[idx(A)];
  const ui = {
    ...useStore.getState().ui,
    openTabs: [{ path: "index.md", mode: "text" as const }],
    activeTab: "text|index.md",
    sel: "index.md",
    docs: { "index.md": { text: text ?? saved, saved } },
  };
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v" },
    tasks: vault,
    activeFolder: A,
    ui,
    uiCache: { [A]: ui },
    dayLog: { day: "2026-09-11", entries: [] },
    toasts: [],
    split: null,
    ntBusy: false,
    ntRefs: [],
  });
}

const cmds = () => calls.map((c) => c.cmd);
const at = (cmd: string) => cmds().indexOf(cmd);

function argsOf(cmd: string): Record<string, unknown> {
  const hit = calls.find((c) => c.cmd === cmd);
  if (!hit) throw new Error(`${cmd} 를 부르지 않았다`);
  return hit.args;
}

beforeEach(() => {
  calls.length = 0;
  lockedFolders = [];
  holds = {};
  vault = [task(A, "결제 점검"), task(B, "인프라 정비", "프로젝트/ContextFlow")];
  disk = { [idx(A)]: HEAD + BODY, [idx(B)]: HEAD + BODY };
});

describe("setCategory", () => {
  it("고치던 글을 내려쓰고 → 지정하고 → 열린 index.md 를 다시 읽는다", async () => {
    openA(HEAD + "## 개요\n고치던 글\n");

    const ok = await useStore.getState().setCategory([A], "프로젝트 › ContextFlow");

    expect(ok).toBe(true);
    expect(at("write_text_file")).toBeGreaterThanOrEqual(0);
    expect(at("write_text_file")).toBeLessThan(at("set_task_category"));
    expect(cmds().lastIndexOf("read_text_file")).toBeGreaterThan(at("set_task_category"));
    // 정규화한 값을 넘긴다.
    expect(argsOf("set_task_category")).toEqual({ root: "/v", folders: [A], category: "프로젝트/ContextFlow" });
    expect(useStore.getState().tasks.find((t) => t.folder === A)?.category).toBe("프로젝트/ContextFlow");
  });

  it("지정한 뒤 이어서 친 글이 category 줄을 지우지 않는다", async () => {
    openA();
    await useStore.getState().setCategory([A], "프로젝트/ContextFlow");

    // 편집기가 본문을 고칠 때 조립하는 그대로(`EditorPane` 의 `onEdit`).
    const st = useStore.getState();
    const { fm } = splitFrontmatter(st.ui.docs["index.md"].text);
    st.editDoc("index.md", `---\n${fm}\n---\n## 개요\n처음 글\n덧붙인 글\n`);
    await useStore.getState().saveDoc("index.md");

    const last = calls.filter((c) => c.cmd === "write_text_file").pop();
    expect(last?.args.content).toContain('category: "프로젝트/ContextFlow"');
    expect(last?.args.content).toContain("덧붙인 글");
  });

  it("이미 있는 상위는 알려진 철자로 맞춘다", async () => {
    openA();
    await useStore.getState().setCategory([A], "프로젝트/contextflow/UI");
    expect(argsOf("set_task_category").category).toBe("프로젝트/ContextFlow/UI");
  });

  it("바꾸는 업무 자신의 철자로는 맞추지 않는다 — 대소문자만 고칠 수 있다", async () => {
    vault = [task(A, "결제 점검", "proj"), task(B, "인프라 정비")];
    openA();
    await useStore.getState().setCategory([A], "Proj");
    expect(argsOf("set_task_category").category).toBe("Proj");
  });

  it("해제는 null 로 넘긴다", async () => {
    openA();
    await useStore.getState().setCategory([A], null);
    expect(argsOf("set_task_category").category).toBeNull();
  });

  it("잘못된 값이면 아무것도 부르지 않는다", async () => {
    openA(HEAD + "## 개요\n고치던 글\n");

    expect(await useStore.getState().setCategory([A], "a/b/c/d")).toBe(false);
    expect(await useStore.getState().setCategory([A], "미분류/x")).toBe(false);

    expect(calls).toEqual([]);
    expect(useStore.getState().toasts.map((t) => t.sub)).toEqual([
      "카테고리는 3단계까지입니다",
      "‘미분류’는 카테고리 이름으로 쓸 수 없습니다",
    ]);
  });

  it("열린 업무가 아니면 내려쓰지 않는다", async () => {
    openA(HEAD + "## 개요\n고치던 글\n");
    await useStore.getState().setCategory([B], "운영");
    expect(cmds()).not.toContain("write_text_file");
  });

  it("지정하지 못한 업무가 있으면 알리고 false", async () => {
    openA();
    lockedFolders = [A];

    expect(await useStore.getState().setCategory([A], "운영")).toBe(false);

    const [toast] = useStore.getState().toasts;
    expect(toast.title).toBe("카테고리를 지정하지 못했습니다");
    expect(toast.sub).toContain("결제 점검");
  });
});

describe("setCategory 와 자동 저장", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /** 붙들지 않은 약속이 모두 돌 때까지 — 진짜 타이머 한 번을 기다리면 마이크로태스크가 다 빠진다. */
  const settle = () => new Promise((r) => realTimeout(r, 0));
  /** 편집기가 본문을 고칠 때 조립하는 그대로(`EditorPane` 의 `onEdit`). */
  const type = (body: string) => {
    const st = useStore.getState();
    const { fm } = splitFrontmatter(st.ui.docs["index.md"].text);
    st.editDoc("index.md", `---\n${fm}\n---\n${body}`);
  };

  it("커맨드가 도는 사이에 터진 자동 저장이 category 줄을 지우지 않는다", async () => {
    openA();
    const release = hold("set_task_category");

    const pending = useStore.getState().setCategory([A], "프로젝트/ContextFlow");
    await settle();
    // 커맨드가 파일을 고쳤지만 아직 답하지 않았다. 그 사이에 친 글의 자동 저장이 터진다.
    type("## 개요\n처음 글\n친 글\n");
    await vi.advanceTimersByTimeAsync(900);
    release();
    expect(await pending).toBe(true);
    await vi.runAllTimersAsync();
    await settle();

    const writes = calls.filter((c) => c.cmd === "write_text_file");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => String(c.args.content).includes('category: "프로젝트/ContextFlow"'))).toBe(true);
    expect(disk[idx(A)]).toContain('category: "프로젝트/ContextFlow"');
    expect(disk[idx(A)]).toContain("친 글");
    expect(useStore.getState().tasks.find((t) => t.folder === A)?.category).toBe("프로젝트/ContextFlow");
  });

  it("지정하는 사이에 끝난 저장 뒤의 재조회가 업무 목록을 옛것으로 되돌리지 않는다", async () => {
    openA();
    // 자동 저장이 파일을 쓰고 업무 목록을 다시 읽는 중이다 — 아직 카테고리가 없던 때의 목록.
    const release = hold("scan_vault");
    type("## 개요\n처음 글\n친 글\n");
    await vi.advanceTimersByTimeAsync(900);
    await settle();
    expect(cmds()).toContain("scan_vault");

    expect(await useStore.getState().setCategory([A], "운영")).toBe(true);
    release();
    await settle();

    expect(useStore.getState().tasks.find((t) => t.folder === A)?.category).toBe("운영");
  });


  it("맞추는 사이에 걸려 있던 자동 저장은 맞춘 뒤로 미룬다 — 감싸지 않은 호출도 지킨다", async () => {
    openA();
    // 상태 바꾸기처럼 게이트 없이 resync 만 부르는 길. 백엔드가 이미 파일을 고쳤고, 그 전에 친 글의
    // 자동 저장이 걸려 있다.
    type("## 개요\n처음 글\n친 글\n");
    disk[idx(A)] = disk[idx(A)].replace("tags: [pay]\n", 'tags: [pay]\ncategory: "운영"\n');
    const release = hold("read_text_file");

    const pending = useStore.getState().resyncIndexDocs([A]);
    await settle();
    // 디스크를 읽는 중에 자동 저장 시각이 지난다. 미뤄 두지 않으면 낡은 frontmatter 를 쓴다.
    await vi.advanceTimersByTimeAsync(900);
    expect(cmds()).not.toContain("write_text_file");

    release();
    await pending;
    await vi.advanceTimersByTimeAsync(900);
    await settle();

    const writes = calls.filter((c) => c.cmd === "write_text_file");
    expect(writes.length).toBe(1);
    expect(String(writes[0].args.content)).toContain('category: "운영"');
    expect(disk[idx(A)]).toContain('category: "운영"');
    expect(disk[idx(A)]).toContain("친 글");
  });
});

describe("새 업무 · 분할", () => {
  it("새 업무에 정규화한 카테고리를 넘긴다", async () => {
    openA();
    useStore.setState({ nt: { ...emptyNewTask(" 프로젝트 › contextflow "), title: "새 일" } });

    await useStore.getState().createTask();

    expect(argsOf("create_task").category).toBe("프로젝트/ContextFlow");
  });

  it("카테고리를 비우면 null", async () => {
    openA();
    useStore.setState({ nt: { ...emptyNewTask(), title: "새 일" } });
    await useStore.getState().createTask();
    expect(argsOf("create_task").category).toBeNull();
  });

  it("잘못된 카테고리면 업무를 만들지 않는다", async () => {
    openA();
    useStore.setState({ nt: { ...emptyNewTask("a/b/c/d"), title: "새 일" } });

    await useStore.getState().createTask();

    expect(cmds()).not.toContain("create_task");
    expect(useStore.getState().ntBusy).toBe(false);
    expect(useStore.getState().toasts.map((t) => t.title)).toContain("업무를 만들지 못했습니다");
  });

  it("분할은 원본의 카테고리를 미리 채우고 그대로 넘긴다", async () => {
    vault = [task(A, "결제 점검", "프로젝트/ContextFlow"), task(B, "인프라 정비")];
    openA();

    await useStore.getState().openSplit(A);
    expect(useStore.getState().split?.category).toBe("프로젝트/ContextFlow");

    useStore.setState({
      split: { ...useStore.getState().split!, sel: { "설계.md": true }, title: "결제 점검 — 설계" },
    });
    await useStore.getState().doSplit();

    expect(argsOf("split_task").category).toBe("프로젝트/ContextFlow");
  });

  it("잘못된 카테고리면 분할하지 않고 사유를 남긴다", async () => {
    openA();
    useStore.setState({
      split: {
        source: A,
        sel: { "설계.md": true },
        title: "결제 점검 — 설계",
        summary: "",
        tags: "",
        category: "미분류/설계",
        busy: false,
        error: "",
      },
    });

    await useStore.getState().doSplit();

    expect(cmds()).not.toContain("split_task");
    expect(useStore.getState().split?.error).toBe("‘미분류’는 카테고리 이름으로 쓸 수 없습니다");
  });
});

describe("dropOnCategory — 다른 묶음 머리에 놓아 바꾸기 · 되돌리기", () => {
  /** 붙들지 않은 약속이 모두 돌 때까지. 되돌리기는 단추가 부르는 것이라 기다릴 약속을 주지 않는다. */
  const settle = () => new Promise((r) => realTimeout(r, 0));
  const toasts = () => useStore.getState().toasts;
  const catOf = (folder: string) => useStore.getState().tasks.find((t) => t.folder === folder)?.category;
  const sets = () => calls.filter((c) => c.cmd === "set_task_category").map((c) => c.args.category);

  it("그 카테고리로 바꾸고 [되돌리기] 를 단 토스트를 띄운다", async () => {
    openA();

    await useStore.getState().dropOnCategory(A, "프로젝트/ContextFlow");

    expect(sets()).toEqual(["프로젝트/ContextFlow"]);
    expect(catOf(A)).toBe("프로젝트/ContextFlow");
    const [t] = toasts();
    expect(t).toMatchObject({
      title: "카테고리를 바꿨습니다",
      sub: "결제 점검 · ‘미분류’ → ‘프로젝트 › ContextFlow’",
      color: TOAST.ok,
    });
    expect(t.action?.label).toBe("되돌리기");
  });

  it("되돌리기는 토스트를 먼저 닫고 이전 값으로 다시 지정한다", async () => {
    vault = [task(A, "결제 점검", "운영"), task(B, "인프라 정비", "프로젝트/ContextFlow")];
    openA();
    await useStore.getState().dropOnCategory(A, "프로젝트/ContextFlow");

    toasts()[0].action!.run();
    expect(toasts()).toEqual([]);
    await settle();

    expect(sets()).toEqual(["프로젝트/ContextFlow", "운영"]);
    expect(catOf(A)).toBe("운영");
  });

  it("미분류 머리(\"\")에 놓으면 해제한다 — 되돌리면 원래 카테고리", async () => {
    vault = [task(A, "결제 점검", "운영"), task(B, "인프라 정비", "프로젝트/ContextFlow")];
    openA();

    await useStore.getState().dropOnCategory(A, "");

    expect(sets()).toEqual([null]);
    expect(catOf(A)).toBeNull();
    expect(toasts()[0]).toMatchObject({ title: "카테고리를 해제했습니다", sub: "결제 점검 · ‘운영’ → ‘미분류’" });

    toasts()[0].action!.run();
    await settle();
    expect(sets()).toEqual([null, "운영"]);
    expect(catOf(A)).toBe("운영");
  });

  it("그사이 값이 바뀌었으면 되돌리지 않는다", async () => {
    openA();
    await useStore.getState().dropOnCategory(A, "프로젝트/ContextFlow");
    const undo = toasts()[0].action!;
    // 토스트가 떠 있는 사이에 칩으로 다시 골랐다.
    await useStore.getState().setCategory([A], "운영");

    undo.run();
    await settle();

    expect(sets()).toEqual(["프로젝트/ContextFlow", "운영"]);
    expect(catOf(A)).toBe("운영");
    expect(toasts().at(-1)).toMatchObject({
      title: "그사이 바뀌어 되돌리지 않았습니다",
      sub: "결제 점검",
      color: TOAST.muted,
    });
  });

  it("대소문자만 다른 값은 같은 카테고리다 — 되돌린다", async () => {
    openA();
    await useStore.getState().dropOnCategory(A, "프로젝트/ContextFlow");
    const undo = toasts()[0].action!;
    useStore.setState({
      tasks: useStore.getState().tasks.map((t) => (t.folder === A ? { ...t, category: "프로젝트/contextflow" } : t)),
    });

    undo.run();
    await settle();

    expect(sets()).toEqual(["프로젝트/ContextFlow", null]);
  });

  it("업무가 목록에서 사라졌으면 되돌리지 않는다 — 보관으로 폴더가 옮겨 간 것도", async () => {
    openA();
    await useStore.getState().dropOnCategory(A, "프로젝트/ContextFlow");
    const undo = toasts()[0].action!;
    useStore.setState({ tasks: useStore.getState().tasks.filter((t) => t.folder !== A) });

    undo.run();
    await settle();

    expect(sets()).toEqual(["프로젝트/ContextFlow"]);
    expect(toasts().at(-1)?.title).toBe("그사이 바뀌어 되돌리지 않았습니다");
  });

  it("바꾸지 못하면 경고만 남고 되돌리기는 없다", async () => {
    openA();
    lockedFolders = [A];

    await useStore.getState().dropOnCategory(A, "프로젝트/ContextFlow");

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ title: "카테고리를 지정하지 못했습니다", color: TOAST.warn });
    expect(toasts()[0].action).toBeUndefined();
  });

  it("잘못된 값이면 아무것도 부르지 않는다", async () => {
    openA();
    await useStore.getState().dropOnCategory(A, "미분류/x");
    expect(cmds()).not.toContain("set_task_category");
    expect(toasts().map((t) => t.action)).toEqual([undefined]);
  });
});

describe("토스트 동작(action)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    useStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const titles = () => useStore.getState().toasts.map((t) => t.title);

  it("동작이 있으면 6초, 없으면 지금처럼 2.8초 보인다", () => {
    const st = useStore.getState();
    st.toast("알림");
    st.toast("바꿨습니다", "", TOAST.ok, { action: { label: "되돌리기", run: () => {} } });

    vi.advanceTimersByTime(2799);
    expect(titles()).toEqual(["알림", "바꿨습니다"]);
    vi.advanceTimersByTime(1);
    expect(titles()).toEqual(["바꿨습니다"]);
    vi.advanceTimersByTime(6000 - 2800 - 1);
    expect(titles()).toEqual(["바꿨습니다"]);
    vi.advanceTimersByTime(1);
    expect(titles()).toEqual([]);
  });

  it("동작이 없는 토스트에는 action 칸이 없다 — 모양이 지금과 같다", () => {
    useStore.getState().toast("알림", "자세히", TOAST.muted);
    expect(useStore.getState().toasts).toEqual([
      { id: expect.any(Number), title: "알림", sub: "자세히", color: TOAST.muted },
    ]);
  });

  it("누르면 토스트를 먼저 닫고, 두 번 눌러도 동작은 한 번만 돈다", () => {
    const seen: string[][] = [];
    const st = useStore.getState();
    st.toast("남는 것");
    st.toast("바꿨습니다", "", TOAST.ok, { action: { label: "되돌리기", run: () => seen.push(titles()) } });
    const { action } = useStore.getState().toasts[1];

    action!.run();
    action!.run();

    // 동작이 돌 때 이미 그 토스트는 없다.
    expect(seen).toEqual([["남는 것"]]);
    expect(titles()).toEqual(["남는 것"]);
  });
});
