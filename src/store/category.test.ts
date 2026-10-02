/**
 * 카테고리 지정 · 새 업무 · 분할이 백엔드에 넘기는 값과 **순서**.
 *
 * 지정은 index.md 의 frontmatter 한 줄을 고친다. 고치던 글을 먼저 내려쓰지 않거나, 고친 뒤
 * 열린 버퍼를 디스크에 맞추지 않으면 다음 자동 저장이 그 줄을 조용히 지운다 — 화면의 칩은
 * 바뀐 채로 남으므로 재시작해야 사라진 것을 안다. 그래서 커맨드 모킹으로 지킨다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const idx = (folder: string) => `${folder}/index.md`;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "read_text_file": {
        const text = disk[args.path as string];
        if (text === undefined) throw { kind: "io", message: "읽을 수 없습니다" };
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
        return { tasks: vault, changed, failed };
      }
      case "create_task":
        return task(NEW, args.title as string, (args.category as string | null) ?? null);
      case "split_task":
        return { task: task(NEW, args.title as string), moved: ["설계.md"] };
      case "scan_vault":
        return vault;
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

// 타이머는 돌리지 않는다(`indexResync.test.ts` 와 같은 이유).
vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => undefined });

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
