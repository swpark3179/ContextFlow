/**
 * 창에 돌아왔을 때의 다시 읽기(`refreshFromDisk`)와 그것이 기대는 경로마다의 저장 줄(`saveDoc`).
 *
 * Obsidian 에서 고친 값은 들어오되 **앱이 쓰는 것과 엇갈리지 않아야** 한다 — 앱이 쓰는 사이에 읽은
 * 목록은 어느 쪽이 새것인지 가를 수 없고, 고치던 글은 저장하면 앱 쪽이 이긴다. 틀리면 화면에서는
 * "가끔 값이 되돌아간다" · "글이 사라졌다" 로만 보이므로 커맨드 모킹으로 순서와 내용을 지킨다.
 *
 * 커맨드는 백엔드처럼 다룬다 — 읽기는 부른 순간의 디스크를, 쓰기는 끝나는 순간에 디스크를 바꾼다.
 * `hold` 로 한 번 붙든 커맨드는 풀어 줄 때까지 끝나지 않는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAY_MS, RELOAD_GAP_MS, shouldReload } from "../lib/focus";
import { TOAST } from "../lib/design";
import type { TaskUi } from "./useStore";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

const A = "/v/Tasks/[2026-09] 결제 점검";
const A2 = "/v/Tasks/[2026-09] 결제 점검 2차";
const B = "/v/Tasks/[2026-09] 인프라 정비";
const C = "/v/Tasks/[2026-09] 문서 정리";

const head = (title: string, category: string) =>
  `---\nid: task-${title}\ntitle: "${title}"\nstatus: in-progress\ncategory: "${category}"\n---\n`;
const BODY = "## 개요\n처음 글\n";

function task(folder: string, title: string, category: string | null = "운영") {
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
    order: null as number | null,
    folder,
    relFolder: `${folder.replace("/v/", "")}/`,
    indexPath: `${folder}/index.md`,
    tagline: "",
  };
}

type Task = ReturnType<typeof task>;

let vault: Task[] = [];
let disk: Record<string, string> = {};
/** 한 번만 붙드는 커맨드. 키는 `cmd` 또는 `cmd 경로`. */
let holds: Record<string, Promise<void>> = {};
/** 아직 풀지 않은 것 — 실패한 테스트가 붙든 쓰기를 다음 테스트로 넘기지 않게 끝에서 모두 푼다. */
let releases: (() => void)[] = [];

const idx = (folder: string) => `${folder}/index.md`;
const at = (folder: string, rel: string) => `${folder}/${rel}`;

function hold(key: string): () => void {
  let release!: () => void;
  holds[key] = new Promise<void>((r) => (release = r));
  releases.push(release);
  return release;
}

/** 부른 순간의 답. 쓰기는 끝날 때 디스크에 닿는다(아래). */
function answer(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case "scan_vault":
      // 백엔드는 늘 새 배열 · 새 객체를 준다 — 내용이 같아도 같은 객체가 아니다.
      return vault.map((t) => ({ ...t }));
    case "read_text_file": {
      const text = disk[args.path as string];
      if (text === undefined) throw { kind: "not_found", message: "파일이 없습니다" };
      return text;
    }
    case "path_exists":
      return disk[args.path as string] !== undefined;
    case "list_task_files":
      return [{ p: "index.md", name: "index.md", dir: false }];
    case "note_day_entry":
      return { id: 1, day: args.day, folder: args.folder ?? null, title: args.title, body: "", at: args.at };
    case "set_task_category": {
      const folders = args.folders as string[];
      vault = vault.map((t) => (folders.includes(t.folder) ? { ...t, category: args.category as string | null } : t));
      return { tasks: vault.map((t) => ({ ...t })), changed: folders, failed: [] };
    }
    case "scan_templates":
      return [];
    case "reorder_tasks":
      // 넘겨받은 차례대로 `order` 를 매긴다.
      vault = vault.map((t) => ({ ...t, order: (args.folders as string[]).indexOf(t.folder) }));
      return vault.map((t) => ({ ...t }));
    case "wiki_status":
      return { dir: "/v/Wiki", exists: true, pages: [], tasks: [], orphans: [], moved: [], logTail: [] };
    default:
      return undefined;
  }
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    let out: unknown;
    let err: unknown = null;
    try {
      out = answer(cmd, args);
    } catch (e) {
      err = e;
    }
    const key = [`${cmd} ${String(args.path ?? "")}`, cmd].find((k) => holds[k]);
    if (key) {
      const h = holds[key];
      delete holds[key];
      await h;
    }
    if (err) throw err;
    if (cmd === "write_text_file") disk[args.path as string] = args.content as string;
    return out;
  },
}));

// 타이머는 돌리지 않는다 — 자동 저장 · 토스트 닫기가 다음 테스트의 상태 위에서 터지지 않게.
vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => undefined });

const { useStore, DEFAULT_SETTINGS, lastReloadAt } = await import("./useStore");
const { useWiki } = await import("./wikiStore");

const st = () => useStore.getState();
const cmds = () => calls.map((c) => c.cmd);
/** 붙들리지 않은 비동기 사슬을 끝까지 돌린다. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const clean = (text: string) => ({ text, saved: text });
const toasts = () => st().toasts.map((t) => [t.title, t.sub]);

function ui(docs: TaskUi["docs"], tabs = Object.keys(docs)): TaskUi {
  return {
    openTabs: tabs.map((path) => ({ path, mode: "text" as const })),
    activeTab: tabs.length ? `text|${tabs[0]}` : "",
    sel: "",
    notepad: "",
    colPct: 64,
    rowPct: 62,
    treeOpen: {},
    docs,
    extOpened: {},
    bsView: {},
  };
}

/** `A` 를 연 상태. `cache` 는 다른 업무의 화면 상태다. */
function openA(docs: TaskUi["docs"], tabs?: string[], cache: Record<string, TaskUi> = {}) {
  const u = ui(docs, tabs);
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v" },
    tasks: vault,
    activeFolder: A,
    ui: u,
    uiCache: { ...cache, [A]: u },
    files: [],
    toasts: [],
    screen: "workspace",
    newOpen: false,
    ntBusy: false,
    catMgr: null,
    absorb: null,
    split: null,
    dayLog: { day: "2026-09-11", entries: [] },
  });
}

let clock = 0;
/** 다시 읽기가 적는 시각을 정한다 — 간격(`lastReloadAt`)을 견준다. */
const now = (ms: number) => (clock = ms);

beforeEach(() => {
  calls.length = 0;
  holds = {};
  now(1_000_000 + Math.floor(Math.random() * 1000));
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vault = [task(A, "결제 점검"), task(B, "인프라 정비")];
  disk = {
    [idx(A)]: head("결제 점검", "운영") + BODY,
    [idx(B)]: head("인프라 정비", "운영") + BODY,
    [at(A, "메모.md")]: "메모 처음",
    [at(A, "초안.md")]: "초안 처음",
  };
  useWiki.setState({ running: false });
});

afterEach(async () => {
  for (const release of releases) release();
  releases = [];
  await flush();
  vi.restoreAllMocks();
});

describe("shouldReload — 창에 돌아왔을 때 다시 읽을지", () => {
  const T = 100_000;

  it("흐려진 적이 없으면 읽지 않는다", () => {
    expect(shouldReload(null, T, 0)).toBe(false);
  });

  it("1초 넘게 다른 창에 있었어야 한다 — Obsidian 을 띄우는 깜빡임은 거른다", () => {
    expect(AWAY_MS).toBe(1000);
    expect(shouldReload(T - 999, T, 0)).toBe(false);
    expect(shouldReload(T - 1000, T, 0)).toBe(true);
  });

  it("지난 다시 읽기에서 3초가 지나야 한다", () => {
    expect(RELOAD_GAP_MS).toBe(3000);
    expect(shouldReload(T - 5000, T, T - 2999)).toBe(false);
    expect(shouldReload(T - 5000, T, T - 3000)).toBe(true);
  });
});

describe("refreshFromDisk — 업무 목록", () => {
  it("Obsidian 에서 고친 목록이 들어오고 다시 읽은 시각을 적는다", async () => {
    openA({ "index.md": clean(disk[idx(A)]) });
    vault = [task(A, "결제 점검", "운영/결제"), task(B, "인프라 정비")];
    now(5_000_000);

    await st().refreshFromDisk();

    expect(st().tasks.find((t) => t.folder === A)?.category).toBe("운영/결제");
    expect(lastReloadAt()).toBe(5_000_000);
  });

  it("같은 목록이면 넣지 않는다 — 새 배열이면 사이드바가 통째로 다시 그려진다", async () => {
    openA({});
    const before = st().tasks;
    let changes = 0;
    const stop = useStore.subscribe((s, p) => void (s.tasks !== p.tasks && changes++));

    await st().refreshFromDisk();
    stop();

    expect(cmds()).toContain("scan_vault");
    expect(st().tasks).toBe(before);
    expect(changes).toBe(0);
  });

  it("읽는 사이에 메타데이터 쓰기가 끝났으면 이번 목록은 버린다", async () => {
    openA({});
    vault = [task(A, "결제 점검", "Obsidian 값"), task(B, "인프라 정비")];
    const scan = hold("scan_vault");
    const run = st().refreshFromDisk();
    await flush();

    await st().setCategory([B], "앱 값");
    const written = st().tasks;
    scan();
    await run;

    expect(st().tasks).toBe(written);
    expect(cmds()).not.toContain("path_exists");
  });

  it("읽는 사이에 저장이 시작됐으면 이번 목록은 버린다", async () => {
    openA({ "메모.md": clean("메모 처음") });
    const before = st().tasks;
    vault = [task(A, "결제 점검", "Obsidian 값"), task(B, "인프라 정비")];
    const scan = hold("scan_vault");
    const run = st().refreshFromDisk();
    await flush();

    const write = hold(`write_text_file ${at(A, "메모.md")}`);
    st().editDoc("메모.md", "메모 고침");
    const save = st().saveDoc("메모.md");
    await flush();
    scan();
    await run;

    expect(st().tasks).toBe(before);
    write();
    await save;
    expect(disk[at(A, "메모.md")]).toBe("메모 고침");
  });

  it("메타데이터를 쓰는 중이면 건너뛰고 간격에 세지 않는다", async () => {
    openA({});
    now(2_000_000);
    await st().refreshFromDisk();
    expect(lastReloadAt()).toBe(2_000_000);

    const meta = hold("set_task_category");
    const writing = st().setCategory([B], "앱 값");
    await flush();
    calls.length = 0;
    now(2_009_000);
    await st().refreshFromDisk();

    expect(cmds()).toEqual([]);
    expect(lastReloadAt()).toBe(2_000_000);

    meta();
    await writing;
    await st().refreshFromDisk();
    expect(cmds()).toContain("scan_vault");
    expect(lastReloadAt()).toBe(2_009_000);
  });

  it("저장이 도는 중이면 건너뛰고 간격에 세지 않는다", async () => {
    openA({ "메모.md": clean("메모 처음") });
    now(3_000_000);
    await st().refreshFromDisk();

    const write = hold(`write_text_file ${at(A, "메모.md")}`);
    st().editDoc("메모.md", "메모 고침");
    const save = st().saveDoc("메모.md");
    await flush();
    calls.length = 0;
    now(3_009_000);
    await st().refreshFromDisk();

    expect(cmds()).toEqual([]);
    expect(lastReloadAt()).toBe(3_000_000);

    write();
    await save;
    await st().refreshFromDisk();
    expect(lastReloadAt()).toBe(3_009_000);
  });

  it.each([
    ["업무 생성", () => useStore.setState({ ntBusy: true })],
    ["카테고리 관리", () => (st().openCatMgr(), useStore.setState({ catMgr: { ...st().catMgr!, busy: true } }))],
  ])("%s 가 도는 중이면 건너뛴다", async (_, busy) => {
    openA({});
    busy();
    await st().refreshFromDisk();
    expect(cmds()).toEqual([]);
  });
});

describe("refreshFromDisk — 열린 업무의 버퍼", () => {
  it("고치던 index.md 는 본문을 지키고 frontmatter 만 디스크를 따른다", async () => {
    const typed = head("결제 점검", "운영") + "## 개요\n고치던 글\n";
    openA({ "index.md": { text: typed, saved: disk[idx(A)] } });
    disk[idx(A)] = head("결제 점검", "운영/결제") + BODY;

    await st().refreshFromDisk();

    expect(st().ui.docs["index.md"]).toEqual({
      text: head("결제 점검", "운영/결제") + "## 개요\n고치던 글\n",
      saved: disk[idx(A)],
    });
    expect(st().uiCache[A].docs["index.md"]).toEqual(st().ui.docs["index.md"]);
    expect(cmds()).not.toContain("write_text_file");
  });

  it("깨끗한 노트는 디스크 내용이 되고 고치던 노트는 그대로다 — 저장하면 앱 쪽이 이긴다", async () => {
    openA({ "index.md": clean(disk[idx(A)]), "메모.md": clean("메모 처음"), "초안.md": { text: "초안 고침", saved: "초안 처음" } });
    disk[idx(A)] = head("결제 점검", "개인") + BODY;
    disk[at(A, "메모.md")] = "메모 — Obsidian 에서 고침";
    disk[at(A, "초안.md")] = "초안 — Obsidian 에서 고침";

    await st().refreshFromDisk();

    expect(st().ui.docs).toEqual({
      "index.md": clean(head("결제 점검", "개인") + BODY),
      "메모.md": clean("메모 — Obsidian 에서 고침"),
      "초안.md": { text: "초안 고침", saved: "초안 처음" },
    });
    expect(calls.filter((c) => c.cmd === "read_text_file").map((c) => c.args.path)).not.toContain(at(A, "초안.md"));
    expect(cmds()).not.toContain("write_text_file");
  });

  it("탭이 없는 깨끗한 버퍼는 읽지 않고 버린다 — 고치던 버퍼는 남긴다", async () => {
    openA({ "index.md": clean(disk[idx(A)]), "메모.md": clean("메모 처음"), "초안.md": { text: "초안 고침", saved: "초안 처음" } }, [
      "index.md",
    ]);

    await st().refreshFromDisk();

    expect(Object.keys(st().ui.docs)).toEqual(["index.md", "초안.md"]);
    expect(Object.keys(st().uiCache[A].docs)).toEqual(["index.md", "초안.md"]);
    expect(calls.filter((c) => c.cmd === "read_text_file").map((c) => c.args.path)).toEqual([idx(A)]);
  });

  it("읽는 사이에 버퍼가 바뀌면 덮지 않는다 — 고쳐서 저장까지 끝났어도", async () => {
    openA({ "메모.md": clean("메모 처음") });
    disk[at(A, "메모.md")] = "메모 — Obsidian 에서 고침";
    const read = hold(`read_text_file ${at(A, "메모.md")}`);
    const run = st().refreshFromDisk();
    await flush();
    expect(calls.filter((c) => c.cmd === "read_text_file").map((c) => c.args.path)).toEqual([at(A, "메모.md")]);

    // 붙든 읽기는 고치기 전의 디스크를 읽었다. 그사이 친 글이 저장까지 끝나 버퍼는 다시 깨끗하다.
    st().editDoc("메모.md", "앱에서 친 글");
    await st().saveDoc("메모.md");
    read();
    await run;

    expect(st().ui.docs["메모.md"]).toEqual(clean("앱에서 친 글"));
    expect(disk[at(A, "메모.md")]).toBe("앱에서 친 글");
  });

  it("못 읽는 노트는 그대로 둔다", async () => {
    openA({ "메모.md": clean("메모 처음") });
    delete disk[at(A, "메모.md")];
    await st().refreshFromDisk();
    expect(st().ui.docs["메모.md"]).toEqual(clean("메모 처음"));
  });
});

describe("refreshFromDisk — 열린 업무가 사라졌다", () => {
  it("폴더 이름이 바뀌었으면 같은 id 의 업무로 따라간다 — 탭 · 고치던 글 · 오늘의 한일까지", async () => {
    const typed = { text: "초안 고침", saved: "초안 처음" };
    openA({ "index.md": clean(disk[idx(A)]), "초안.md": typed });
    // Obsidian 에서 폴더 이름을 바꿨다 — index.md 는 그대로 따라갔다.
    vault = [task(A2, "결제 점검"), task(B, "인프라 정비")];
    disk[idx(A2)] = disk[idx(A)];
    disk[at(A2, "초안.md")] = disk[at(A, "초안.md")];
    delete disk[idx(A)];

    await st().refreshFromDisk();

    expect(st().activeFolder).toBe(A2);
    expect(st().uiCache[A]).toBeUndefined();
    expect(st().uiCache[A2].docs["초안.md"]).toEqual(typed);
    expect(st().ui.docs["초안.md"]).toEqual(typed);
    expect(argsOf("relocate_day_entries")).toMatchObject({ from: A, to: A2, title: "결제 점검" });
    expect(argsOf("list_task_files")).toEqual({ folder: A2 });
    expect(toasts()).toEqual([["업무 폴더가 옮겨져 따라갔습니다", `Tasks/[2026-09] 결제 점검/ → Tasks/[2026-09] 결제 점검 2차/`]]);
    expect(cmds()).not.toContain("write_text_file");
  });

  it("따라갈 곳이 없으면 저장하지 않고 창을 닫는다 — 옛 자리에 폴더를 되살리지 않게", async () => {
    openA({ "index.md": clean(disk[idx(A)]), "메모.md": clean("메모 처음") });
    // 복사본이 둘이면 어느 쪽인지 모른다 — 따라가지 않는다.
    vault = [task(A2, "결제 점검"), task(C, "결제 점검"), task(B, "인프라 정비")];
    delete disk[idx(A)];

    await st().refreshFromDisk();

    expect(st().activeFolder).toBe("");
    expect(st().uiCache[A]).toBeUndefined();
    expect(st().ui.openTabs).toEqual([]);
    expect(cmds()).not.toContain("write_text_file");
    expect(cmds()).not.toContain("relocate_day_entries");
    expect(toasts()).toEqual([["업무 폴더가 사라져 창을 닫았습니다", "결제 점검"]]);
  });

  it("고치던 글이 있으면 닫지 않고 알리기만 한다", async () => {
    openA({ "초안.md": { text: "초안 고침", saved: "초안 처음" } });
    vault = [task(B, "인프라 정비")];
    delete disk[idx(A)];

    await st().refreshFromDisk();

    expect(st().activeFolder).toBe(A);
    expect(st().ui.docs["초안.md"].text).toBe("초안 고침");
    expect(cmds()).not.toContain("write_text_file");
    expect(st().toasts.map((t) => [t.title, t.color])).toEqual([["업무 폴더를 찾을 수 없습니다", TOAST.warn]]);
  });

  it("목록에서만 빠지고 index.md 가 남았으면 그대로 둔다 — 읽지 못한 노트다", async () => {
    openA({ "index.md": clean(disk[idx(A)]) });
    vault = [task(B, "인프라 정비")];

    await st().refreshFromDisk();

    expect(st().activeFolder).toBe(A);
    expect(toasts()).toEqual([]);
  });
});

describe("refreshFromDisk — 다른 업무의 캐시", () => {
  it("깨끗한 버퍼는 버리고 고치던 index.md 는 frontmatter 를 맞춘다", async () => {
    const typed = head("인프라 정비", "운영") + "## 개요\n고친 글\n";
    const other = ui({
      "index.md": { text: typed, saved: disk[idx(B)] },
      "메모.md": clean("B 의 메모"),
      "초안.md": { text: "B 초안 고침", saved: "B 초안" },
    });
    const third = ui({ "index.md": clean("C 의 index") });
    openA({}, [], { [B]: other, [C]: third });
    disk[idx(B)] = head("인프라 정비", "개인") + BODY;

    await st().refreshFromDisk();

    expect(st().uiCache[B].docs).toEqual({
      "index.md": { text: head("인프라 정비", "개인") + "## 개요\n고친 글\n", saved: disk[idx(B)] },
      "초안.md": { text: "B 초안 고침", saved: "B 초안" },
    });
    // 탭은 남는다 — 다시 열 때 빠진 버퍼를 디스크에서 읽는다(`selectTask`).
    expect(st().uiCache[B].openTabs.map((t) => t.path)).toEqual(["index.md", "메모.md", "초안.md"]);
    expect(st().uiCache[C].docs).toEqual({});
    expect(calls.filter((c) => c.cmd === "read_text_file").map((c) => c.args.path)).toEqual([idx(B)]);
  });
});

describe("refreshFromDisk — 그 밖", () => {
  it.each([
    ["위키 화면", { screen: "wiki" as const }, ["wiki_status"], ["scan_templates"]],
    ["템플릿 화면", { screen: "templates" as const }, ["scan_templates"], ["wiki_status"]],
    ["새 업무 창", { newOpen: true }, ["scan_templates"], ["wiki_status"]],
    ["작업공간", {}, [], ["wiki_status", "scan_templates"]],
  ])("%s — 보이는 것만 다시 읽는다", async (_, patch, called, skipped) => {
    openA({});
    useStore.setState(patch);
    await st().refreshFromDisk();
    expect(cmds()).toContain("list_task_files");
    for (const c of called) expect(cmds()).toContain(c);
    for (const c of skipped) expect(cmds()).not.toContain(c);
  });

  it("위키 반영이 도는 중이면 위키는 다시 읽지 않는다 — 반영이 끝나며 읽는다", async () => {
    openA({});
    useStore.setState({ screen: "wiki" });
    useWiki.setState({ running: true });
    await st().refreshFromDisk();
    expect(cmds()).not.toContain("wiki_status");
  });

  it("실패는 알리지 않는다 — 다음에 돌아올 때 다시 읽는다", async () => {
    openA({});
    const scan = hold("scan_vault");
    vault = null as unknown as Task[];
    const run = st().refreshFromDisk();
    scan();
    await run;
    expect(toasts()).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("saveDoc — 경로마다 한 줄", () => {
  it("같은 경로의 두 저장은 차례로 가고, 디스크와 saved 가 마지막 내용이다", async () => {
    openA({ "메모.md": clean("메모 처음") });
    const first = hold(`write_text_file ${at(A, "메모.md")}`);
    st().editDoc("메모.md", "첫째");
    const one = st().saveDoc("메모.md");
    await flush();
    st().editDoc("메모.md", "둘째");
    const two = st().saveDoc("메모.md");
    await flush();

    // 앞 저장이 끝나기 전에는 다음 저장이 쓰지 않는다.
    const writes = () => calls.filter((c) => c.cmd === "write_text_file").map((c) => c.args.content);
    expect(writes()).toEqual(["첫째"]);

    first();
    await Promise.all([one, two]);

    expect(writes()).toEqual(["첫째", "둘째"]);
    expect(disk[at(A, "메모.md")]).toBe("둘째");
    expect(st().ui.docs["메모.md"]).toEqual(clean("둘째"));
  });

  it("버퍼는 차례가 왔을 때 읽는다 — 기다리는 사이에 친 글까지 한 번에 간다", async () => {
    openA({ "메모.md": clean("메모 처음") });
    const first = hold(`write_text_file ${at(A, "메모.md")}`);
    st().editDoc("메모.md", "첫째");
    const one = st().saveDoc("메모.md");
    await flush();
    const two = st().saveDoc("메모.md");
    st().editDoc("메모.md", "첫째 더하기");
    first();
    await Promise.all([one, two]);

    expect(disk[at(A, "메모.md")]).toBe("첫째 더하기");
    expect(st().ui.docs["메모.md"]).toEqual(clean("첫째 더하기"));
  });

  it("차례는 파일을 쓰면 넘긴다 — index.md 의 목록 다시 읽기는 기다리지 않되, 그동안 디스크 다시 읽기는 건너뛴다", async () => {
    openA({ "index.md": clean(disk[idx(A)]) });
    const scan = hold("scan_vault");
    st().editDoc("index.md", head("결제 점검", "운영") + "## 개요\n고친 글\n");
    const first = st().saveDoc("index.md");
    await flush();
    expect(cmds()).toEqual(["write_text_file", "note_day_entry", "scan_vault"]);

    // 고칠 것이 없는 다음 저장은 곧바로 끝난다(카테고리 지정 앞의 내려쓰기가 그렇다).
    await st().saveDoc("index.md");
    calls.length = 0;
    await st().refreshFromDisk();
    expect(cmds()).toEqual([]);

    scan();
    await first;
    await st().refreshFromDisk();
    expect(cmds()).toContain("scan_vault");
  });

  it("index.md 가 메타데이터 쓰기를 기다리는 동안 다른 노트의 저장은 막히지 않는다", async () => {
    openA({ "index.md": clean(disk[idx(A)]), "메모.md": clean("메모 처음") });
    const meta = hold("set_task_category");
    const writing = st().setCategory([B], "앱 값");
    await flush();

    st().editDoc("index.md", head("결제 점검", "운영") + "## 개요\n고친 글\n");
    const index = st().saveDoc("index.md");
    st().editDoc("메모.md", "메모 고침");
    await st().saveDoc("메모.md");

    expect(disk[at(A, "메모.md")]).toBe("메모 고침");
    expect(calls.filter((c) => c.cmd === "write_text_file").map((c) => c.args.path)).toEqual([at(A, "메모.md")]);

    meta();
    await writing;
    await index;
    expect(disk[idx(A)]).toBe(head("결제 점검", "운영") + "## 개요\n고친 글\n");
  });
});

function argsOf(cmd: string, nth = 0): Record<string, unknown> {
  const hit = calls.filter((c) => c.cmd === cmd)[nth];
  if (!hit) throw new Error(`${cmd} 를 ${nth + 1}번 부르지 않았다`);
  return hit.args;
}

describe("메타데이터 쓰기는 쓰는 중인 저장 뒤에", () => {
  it("순서 바꾸기는 쓰는 중인 index.md 저장이 끝난 뒤에 쓴다 — 친 글자도 순서도 잃지 않는다", async () => {
    openA({ "index.md": clean(disk[idx(A)]) });
    const write = hold(`write_text_file ${idx(A)}`);
    const typed = head("결제 점검", "운영") + "## 개요\n친 글자\n";
    st().editDoc("index.md", typed);
    const saving = st().saveDoc("index.md");
    await flush();

    const moving = st().reorderTask(B, 0);
    await flush();
    // 저장이 블로킹 풀에서 쓰는 동안 순서 쓰기가 끼어들면 옛 본문 + 순서가 친 글자를 덮는다.
    expect(cmds()).not.toContain("reorder_tasks");

    write();
    await Promise.all([saving, moving]);
    const order = cmds().filter((c) => c === "write_text_file" || c === "reorder_tasks");
    expect(order).toEqual(["write_text_file", "reorder_tasks"]);
    expect(disk[idx(A)]).toBe(typed);
  });
});

describe("refreshFromDisk — 남겨 두는 것", () => {
  it("탭을 닫은 깨끗한 index.md 는 남겨 디스크에 맞춘다 — 템플릿 등록이 지금 업무의 섹션을 읽는다", async () => {
    openA({ "index.md": clean(disk[idx(A)]), "메모.md": clean("메모 처음") }, ["메모.md"]);
    disk[idx(A)] = head("결제 점검", "운영") + "## 새 섹션\n";

    await st().refreshFromDisk();

    expect(st().ui.docs["index.md"]).toEqual(clean(disk[idx(A)]));
  });

  it("폴더를 잃고 고치던 글이 있으면 그 버퍼를 건드리지 않는다 — 지운 폴더가 저절로 되살아나지 않게", async () => {
    openA({ "index.md": { text: "고친 index", saved: disk[idx(A)] } });
    vault = [task(B, "인프라 정비")];
    delete disk[idx(A)];
    calls.length = 0;

    await st().refreshFromDisk();

    expect(st().activeFolder).toBe(A);
    expect(st().ui.docs["index.md"].text).toBe("고친 index");
    // index.md 맞추기(읽기)도, 그 끝의 자동 저장도 없다.
    expect(calls.filter((c) => c.cmd === "read_text_file").map((c) => c.args.path)).not.toContain(idx(A));
    expect(cmds()).not.toContain("write_text_file");
  });
});
