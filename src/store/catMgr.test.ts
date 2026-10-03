/**
 * 카테고리 관리 대화상자의 스토어 — 일괄 지정 · 경로 바꾸기 · 해제가 백엔드에 넘기는 값과 순서,
 * 그 뒤에 따라 옮겨야 하는 화면 상태(업무 리스트의 접힘 · 보관함 거르기 · 고른 노드).
 *
 * 접힘과 거르기는 키로 들고 있어서, 업무만 옮기고 키를 그대로 두면 사이드바가 엉뚱한 묶음을 접고
 * 보관함이 거르기를 놓아 버린다. 화면에서는 "그냥 펼쳐졌다" 로만 보이므로 커맨드 모킹으로 지킨다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isWithin, retarget } from "../lib/category";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

const A = "/v/Tasks/[2026-09] 결제 점검";
const B = "/v/Archive/2026/[2026-08] 결제 설계";
const C = "/v/Archive/2026/[2026-07] 결제 회고";
const D = "/v/Tasks/[2026-09] 문서 정리";
const HEAD = '---\nid: task-1\ntitle: "결제 점검"\nstatus: in-progress\ntags: [pay]\ncategory: "a/b"\n---\n';
const BODY = "## 개요\n처음 글\n";

function task(folder: string, title: string, category: string | null, archived = false) {
  return {
    id: `task-${title}`,
    title,
    status: archived ? "completed" : "in-progress",
    tags: [],
    category,
    created: "2026-09-11 09:00",
    updated: "2026-09-11 09:00",
    parentTask: null,
    templateRef: null,
    completedAt: archived ? "2026-09-01 10:00" : null,
    archived: archived || null,
    archivedAt: null,
    runs: 1,
    order: null,
    folder,
    relFolder: `${folder.replace("/v/", "")}/`,
    indexPath: `${folder}/index.md`,
    tagline: "",
  };
}

type Task = ReturnType<typeof task>;

let vault: Task[] = [];
let disk: Record<string, string> = {};
/** 다음 쓰기에서 이 폴더들이 잠겨 있다(OneDrive · 백신). */
let locked: string[] = [];
/** 백엔드가 화면 미리보기와 달리 합치기를 찾는다 — `allowMerge` 없이 오면 거절한다. */
let clash = false;
/** 백엔드가 훑을 때 이 폴더들의 index.md 를 읽지 못한다 — 목록에서 빠질 뿐 실패로 오지 않는다. */
let unreadable: string[] = [];
/** 경로 바꾸기가 쓰기를 마친 뒤에 오류를 낸다. */
let broken = false;
/** 그사이 지워졌거나 편입돼 index.md 가 없는 업무 폴더. */
let gone: string[] = [];

const idx = (folder: string) => `${folder}/index.md`;
const scanned = () => vault.filter((t) => !unreadable.includes(t.folder));

/** 백엔드의 일괄 쓰기 흉내. 바뀌지 않는 업무는 쓰지 않고, 잠긴 업무는 실패로 모은다. */
function rewrite(pick: (t: Task) => { value: string | null } | null, only: string[] | null) {
  const changed: string[] = [];
  const failed: { folder: string; title: string; reason: string }[] = [];
  vault = vault.map((t) => {
    const next = pick(t);
    if (!next || unreadable.includes(t.folder) || (only && !only.includes(t.folder)) || next.value === t.category) {
      return t;
    }
    if (locked.includes(t.folder)) {
      failed.push({ folder: t.folder, title: t.title, reason: "다른 프로그램이 파일을 쓰고 있습니다" });
      return t;
    }
    changed.push(t.folder);
    return { ...t, category: next.value };
  });
  return { tasks: scanned(), changed, failed };
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "read_text_file":
        return disk[args.path as string] ?? "";
      case "write_text_file":
        disk[args.path as string] = args.content as string;
        return undefined;
      case "set_task_category": {
        const folders = args.folders as string[];
        return rewrite((t) => (folders.includes(t.folder) ? { value: args.category as string | null } : null), null);
      }
      case "move_category": {
        if (clash && !args.allowMerge) throw { kind: "already_exists", message: "‘a › c’ 카테고리가 이미 있습니다" };
        const from = args.from as string;
        const to = args.to as string | null;
        const res = rewrite((t) => retarget(t.category, from, to), args.only as string[] | null);
        if (broken) throw { kind: "io", message: "디스크가 가득 찼습니다" };
        return res;
      }
      case "clear_category": {
        const from = args.from as string;
        return rewrite((t) => (isWithin(t.category, from) ? { value: null } : null), args.only as string[] | null);
      }
      case "scan_vault":
        return scanned();
      case "path_exists":
        return !gone.some((f) => args.path === `${f}/index.md`);
      default:
        return undefined;
    }
  },
}));

// 토스트 · 자동 저장 타이머는 돌리지 않는다 — 다음 테스트의 상태를 건드린다.
vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => undefined });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");

const st = () => useStore.getState();
const cmds = () => calls.map((c) => c.cmd);

function argsOf(cmd: string, nth = 0): Record<string, unknown> {
  const hit = calls.filter((c) => c.cmd === cmd)[nth];
  if (!hit) throw new Error(`${cmd} 를 ${nth + 1}번 부르지 않았다`);
  return hit.args;
}

/** 대화상자를 연 상태. 열린 업무는 없다 — 내려쓰기 · 다시 읽기는 순서 테스트만 본다. */
function open(node = "a/b", catClosed: string[] = [], archCat: string | null = null) {
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v", archDays: 14, catClosed },
    tasks: vault,
    activeFolder: "",
    uiCache: {},
    archCat,
    toasts: [],
  });
  st().openCatMgr(node, "all");
}

const mgr = () => st().catMgr!;
const toasts = () => st().toasts.map((t) => [t.title, t.sub]);

beforeEach(() => {
  calls.length = 0;
  locked = [];
  clash = false;
  unreadable = [];
  broken = false;
  gone = [];
  vault = [
    task(A, "결제 점검", "a/b"),
    task(B, "결제 설계", "a/b/c", true),
    task(C, "결제 회고", "a/b", true),
    task(D, "문서 정리", "a/c"),
  ];
  disk = { [idx(A)]: HEAD + BODY };
});

describe("applyCatMgr — 일괄 지정", () => {
  it("고른 업무에만 지정하고, 지정된 업무는 선택에서 뺀다 — 결과는 목록이라 토스트가 없다", async () => {
    open();
    st().toggleCatSel(A, false, [A, B, C]);
    st().toggleCatSel(C, false, [A, B, C]);
    st().setCatTarget("운영", false);

    await st().applyCatMgr();

    expect(argsOf("set_task_category")).toEqual({ root: "/v", folders: [A, C], category: "운영" });
    expect(mgr()).toMatchObject({ sel: [], failed: [], retry: null, busy: false });
    expect(st().tasks.find((t) => t.folder === C)?.category).toBe("운영");
    expect(toasts()).toEqual([]);
  });

  it("못 바꾼 업무는 선택에 남고, 다시 시도는 그 업무만 보낸다", async () => {
    open();
    st().toggleCatSel(A, false, [A, B, C]);
    st().toggleCatSel(B, false, [A, B, C]);
    st().setCatTarget("운영", false);
    locked = [B];

    await st().applyCatMgr();

    expect(mgr().sel).toEqual([B]);
    expect(mgr().failed.map((f) => f.folder)).toEqual([B]);
    expect(mgr().retry).toEqual({ kind: "assign", folders: [B], category: "운영" });
    expect(toasts()).toEqual([]);

    locked = [];
    await st().retryCatMgr();

    expect(argsOf("set_task_category", 1).folders).toEqual([B]);
    expect(mgr()).toMatchObject({ sel: [], failed: [], retry: null });
  });

  it("미분류를 고르면 null 로 보내고, 빈 입력이면 아무것도 하지 않는다", async () => {
    open();
    st().toggleCatSel(A, false, [A]);

    await st().applyCatMgr();
    expect(calls).toEqual([]);

    st().setCatTarget("", true);
    await st().applyCatMgr();
    expect(argsOf("set_task_category").category).toBeNull();
  });
});

describe("선택", () => {
  const rows = [A, B, C, D];

  it("Shift+클릭은 보이는 줄에서 기준 줄부터 누른 줄까지를 기준 줄의 상태로 맞춘다", () => {
    open();
    st().toggleCatSel(A, false, rows);
    st().toggleCatSel(D, true, rows);
    expect(mgr().sel).toEqual([A, B, C, D]);

    // C 를 끄고 Shift 로 A 까지 — C 의 새 상태(꺼짐)로 맞춘다.
    st().toggleCatSel(C, false, rows);
    st().toggleCatSel(A, true, rows);
    expect(mgr().sel).toEqual([D]);
  });

  it("기준 줄이 검색에 가려졌으면 Shift+클릭도 한 줄만 바꾼다", () => {
    open();
    st().toggleCatSel(A, false, rows);
    st().toggleCatSel(D, true, [B, C, D]);
    expect(mgr().sel).toEqual([A, D]);
  });

  it("모두 선택은 보이는 줄만 — 다시 누르면 그 줄만 푼다", () => {
    open();
    st().toggleCatSel(A, false, rows);
    st().toggleCatAll([C, D]);
    expect(mgr().sel).toEqual([A, C, D]);
    st().toggleCatAll([C, D]);
    expect(mgr().sel).toEqual([A]);
  });

  it("노드 · 범위를 바꾸면 선택을 비우고, 검색어는 선택을 남긴다", () => {
    open();
    st().toggleCatSel(A, false, rows);
    st().setCatQuery("결제");
    expect(mgr()).toMatchObject({ query: "결제", sel: [A], last: A });

    st().setCatScope("live");
    expect(mgr()).toMatchObject({ sel: [], last: null });

    st().toggleCatSel(A, false, rows);
    st().setCatEdit({ mode: "path", value: "", confirmMerge: false });
    st().setCatNode("a/c");
    expect(mgr()).toMatchObject({ node: "a/c", sel: [], last: null, edit: null, query: "결제" });
  });
});

describe("moveCategoryNode — 경로 바꾸기", () => {
  it("고치던 글을 내려쓰고 → 옮기고 → 열린 index.md 를 다시 읽는다", async () => {
    open();
    const ui = {
      ...st().ui,
      openTabs: [{ path: "index.md", mode: "text" as const }],
      activeTab: "text|index.md",
      docs: { "index.md": { text: HEAD + "## 개요\n고치던 글\n", saved: HEAD + BODY } },
    };
    useStore.setState({ activeFolder: A, ui, uiCache: { [A]: ui } });

    await st().moveCategoryNode("a/b", "x", false);

    expect(cmds().indexOf("write_text_file")).toBeGreaterThanOrEqual(0);
    expect(cmds().indexOf("write_text_file")).toBeLessThan(cmds().indexOf("move_category"));
    expect(cmds().lastIndexOf("read_text_file")).toBeGreaterThan(cmds().indexOf("move_category"));
    expect(argsOf("move_category")).toEqual({ root: "/v", from: "a/b", to: "x", allowMerge: false, only: null });
    expect(toasts()).toEqual([["카테고리를 바꿨습니다", "‘a › b’ → ‘x’ · 업무 3건(보관 2)"]]);
  });

  it("목적지는 정규화하고 서브트리 밖의 철자로 맞춰 보낸다", async () => {
    vault = [...vault, task("/v/Tasks/[2026-09] 기타", "기타", "Proj")];
    open();
    await st().moveCategoryNode("a/b", " proj › 결제 ", false);
    expect(argsOf("move_category").to).toBe("Proj/결제");
  });

  it("업무 목록과 같은 틱에 접힘 · 거르기 · 노드를 새 키로 옮긴다", async () => {
    // a/b → a/c 는 이미 있는 a/c 와 합치기다. a/b 의 접힘은 a/c 자신의 것에 양보하고, 새로 생기는
    // a/c/c 는 접힌 채 따라간다. 서브트리 밖의 키는 그대로다.
    open("a/b", ["a/b", "a/b/c", "a", "q", ""], "a/b/c");
    st().toggleCatSel(A, false, [A]);
    st().setCatEdit({ mode: "path", value: "a/c", confirmMerge: false });
    const seen: unknown[] = [];
    const stop = useStore.subscribe((s, prev) => {
      if (s.tasks === prev.tasks) return;
      // 같은 틱이 끝난 뒤의 상태 — 그 사이에 그려지는 화면은 없다.
      queueMicrotask(() => {
        const now = st();
        seen.push([now.settings.catClosed, now.archCat, now.catMgr?.node]);
      });
    });

    await st().moveCategoryNode("a/b", "a/c", true);
    stop();

    const want = [["a/c/c", "a", "q", ""], "a/c/c", "a/c"];
    expect(seen).toEqual([want]);
    expect([st().settings.catClosed, st().archCat, mgr().node]).toEqual(want);
    expect(mgr()).toMatchObject({ sel: [], last: null, edit: null, busy: false });
    expect(argsOf("save_settings").value).toMatchObject({ catClosed: want[0] });
    expect(toasts()).toEqual([["카테고리를 합쳤습니다", "‘a › b’ → ‘a › c’ · 업무 3건(보관 2)"]]);
  });

  it("대소문자만 고치면 같은 노드다 — 접힘을 그대로 두고 설정을 쓰지 않는다", async () => {
    open("a", ["a", "a/b"]);
    await st().moveCategoryNode("a", "A", false);

    expect(argsOf("move_category").to).toBe("A");
    expect(st().settings.catClosed).toEqual(["a", "a/b"]);
    expect(mgr().node).toBe("a");
    expect(cmds()).not.toContain("save_settings");
  });

  it("화면 미리보기와 달리 백엔드가 합치기를 찾으면 폼을 [합치기] 로 바꾼다 — 토스트 없음", async () => {
    open();
    st().setCatEdit({ mode: "path", value: "a/z", confirmMerge: false });
    clash = true;

    await st().moveCategoryNode("a/b", "a/z", false);

    expect(mgr().edit).toEqual({ mode: "path", value: "a/z", confirmMerge: true });
    expect(mgr().busy).toBe(false);
    expect(st().tasks).toBe(vault);
    expect(cmds()).not.toContain("scan_vault");
    expect(toasts()).toEqual([]);

    await st().moveCategoryNode("a/b", "a/z", true);
    expect(argsOf("move_category", 1).allowMerge).toBe(true);
    expect(mgr().edit).toBeNull();
  });

  it("못 옮긴 업무는 목록에 남고, 다시 시도는 그 업무만 합치기를 허락해 보낸다", async () => {
    open();
    locked = [B];

    await st().moveCategoryNode("a/b", "a/z", false);

    expect(mgr().failed.map((f) => f.folder)).toEqual([B]);
    expect(mgr().retry).toEqual({ kind: "move", from: "a/b", to: "a/z" });
    // 옮긴 업무가 이미 a/z 에 있다 — 화면 미리보기로는 합치기지만 확정한 이동의 나머지다.
    locked = [];
    await st().retryCatMgr();

    expect(argsOf("move_category", 1)).toEqual({ root: "/v", from: "a/b", to: "a/z", allowMerge: true, only: [B] });
    expect(mgr()).toMatchObject({ failed: [], retry: null });
    expect(vault.map((t) => t.category)).toEqual(["a/z", "a/z/c", "a/z", "a/c"]);
  });

  it("하나도 못 바꾸면 노드는 제자리다 — 접힘 · 거르기 · 고른 노드를 그대로 둔다", async () => {
    open("a/b", ["a/b", "a/b/c"], "a/b");
    locked = [A, B, C];

    await st().moveCategoryNode("a/b", "x", false);

    expect(mgr().failed.map((f) => f.folder)).toEqual([A, B, C]);
    expect([st().settings.catClosed, st().archCat, mgr().node]).toEqual([["a/b", "a/b/c"], "a/b", "a/b"]);
    expect(cmds()).not.toContain("save_settings");
    expect(toasts()).toEqual([]);
  });

  it("일부만 옮기면 옛 노드가 남는다 — 그 접힘도 남기고, 다시 시도로 다 옮기면 걷는다", async () => {
    open("a/b", ["a/b", "a/b/c"]);
    locked = [B];

    await st().moveCategoryNode("a/b", "x", false);
    expect(st().settings.catClosed).toEqual(["a/b", "x", "a/b/c", "x/c"]);

    locked = [];
    await st().retryCatMgr();
    expect(st().settings.catClosed).toEqual(["x", "x/c"]);
  });

  it("쓰다가 오류가 나면 목록을 다시 읽고 폼을 닫는다 — 낡은 미리보기로 다시 보내지 않게", async () => {
    open();
    st().setCatEdit({ mode: "path", value: "x", confirmMerge: false });
    broken = true;

    await st().moveCategoryNode("a/b", "x", false);

    expect(cmds().indexOf("scan_vault")).toBeGreaterThan(cmds().indexOf("move_category"));
    expect(st().tasks.find((t) => t.folder === A)?.category).toBe("x");
    expect(mgr()).toMatchObject({ edit: null, busy: false });
    expect(toasts()).toEqual([["카테고리를 바꾸지 못했습니다", "디스크가 가득 찼습니다"]]);
  });

  it("훑을 때 읽지 못한 노트는 실패로 적는다 — 다시 시도가 그 업무도 보낸다", async () => {
    open();
    unreadable = [C];

    await st().moveCategoryNode("a/b", "x", false);

    const skipped = { folder: C, title: "결제 회고", reason: "읽지 못해 건너뛰었습니다 — 파일을 닫고 다시 시도하세요" };
    expect(mgr().failed).toEqual([skipped]);
    expect(mgr().retry).toEqual({ kind: "move", from: "a/b", to: "x" });
    expect(toasts()).toEqual([["카테고리를 바꿨습니다", "‘a › b’ → ‘x’ · 업무 2건(보관 1)"]]);

    // 아직 못 읽으면 또 적는다 — 목록에서 빠진 업무라도 실패 목록이 곧 다시 보낼 업무다.
    await st().retryCatMgr();
    expect(argsOf("move_category", 1).only).toEqual([C]);
    expect(mgr().failed).toEqual([skipped]);

    unreadable = [];
    await st().retryCatMgr();
    expect(argsOf("move_category", 2)).toMatchObject({ only: [C], allowMerge: true });
    expect(mgr()).toMatchObject({ failed: [], retry: null });
    expect(vault.map((t) => t.category)).toEqual(["x", "x/c", "x", "a/c"]);
  });

  it("그사이 지워진 업무는 실패로 적지 않는다 — 다시 보낼 것이 없다", async () => {
    open();
    // 대화상자의 목록에는 있었지만 그사이 지워졌다(또는 다른 업무에 편입됐다).
    vault = vault.filter((t) => t.folder !== C);
    gone = [C];

    await st().moveCategoryNode("a/b", "x", false);

    expect(mgr()).toMatchObject({ failed: [], retry: null });
  });

  it("목적지가 안 되면 아무것도 부르지 않는다 — 자기 하위 · 미분류", async () => {
    open();
    await st().moveCategoryNode("a/b", "a/b/x", false);
    await st().moveCategoryNode("a/b", "미분류", false);

    expect(calls).toEqual([]);
    expect(toasts().map(([, sub]) => sub)).toEqual([
      "자기 하위 카테고리로는 옮길 수 없습니다",
      "옮길 경로를 입력하세요 — 미분류로 돌리려면 [해제] 를 쓰세요",
    ]);
  });

  it("바뀐 업무가 없으면 흐린 토스트", async () => {
    open();
    await st().moveCategoryNode("a/b", "a/b", false);
    expect(toasts()).toEqual([["바꿀 업무가 없습니다", ""]]);
  });
});

describe("clearCategoryNode — 해제", () => {
  it("모두 미분류로는 clear_category — 노드 · 거르기는 업무가 간 미분류로, 서브트리의 접힘은 걷는다", async () => {
    open("a/b", ["a/b", "a/b/c", "a"], "a/b");

    await st().clearCategoryNode("a/b", "none");

    expect(argsOf("clear_category")).toEqual({ root: "/v", from: "a/b", only: null });
    expect(cmds()).not.toContain("move_category");
    expect([st().settings.catClosed, st().archCat, mgr().node]).toEqual([["a"], "", ""]);
    expect(toasts()).toEqual([["카테고리를 해제했습니다", "‘a › b’ → 미분류 · 업무 3건(보관 2)"]]);
  });

  it("모두 미분류로의 다시 시도는 clear_category 로 그 업무만", async () => {
    open();
    locked = [C];
    await st().clearCategoryNode("a/b", "none");
    expect(mgr().retry).toEqual({ kind: "clear", from: "a/b", mode: "none" });

    locked = [];
    await st().retryCatMgr();
    expect(argsOf("clear_category", 1)).toEqual({ root: "/v", from: "a/b", only: [C] });
  });

  it("상위로 올리기는 상위의 표시 철자로 move_category", async () => {
    vault = [task(A, "결제 점검", "Proj/sub"), task(B, "결제 설계", "Proj/sub/x", true)];
    open("proj/sub");

    await st().clearCategoryNode("proj/sub", "parent");

    expect(argsOf("move_category")).toEqual({ root: "/v", from: "proj/sub", to: "Proj", allowMerge: false, only: null });
    expect(mgr().node).toBe("proj");
    expect(toasts()).toEqual([["카테고리를 해제했습니다", "‘Proj › sub’ → ‘Proj’ · 업무 2건(보관 1)"]]);
  });

  it("못 올린 업무의 다시 시도도 해제다 — 합치기를 허락해 그 업무만 올린다", async () => {
    vault = [task(A, "결제 점검", "Proj/sub"), task(B, "결제 설계", "Proj/sub/x", true)];
    open("proj/sub");
    locked = [B];

    await st().clearCategoryNode("proj/sub", "parent");
    expect(mgr().retry).toEqual({ kind: "clear", from: "proj/sub", mode: "parent" });

    locked = [];
    await st().retryCatMgr();

    expect(argsOf("move_category", 1)).toEqual({ root: "/v", from: "proj/sub", to: "Proj", allowMerge: true, only: [B] });
    expect(vault.map((t) => t.category)).toEqual(["Proj", "Proj/x"]);
    expect(toasts()).toEqual([
      ["카테고리를 해제했습니다", "‘Proj › sub’ → ‘Proj’ · 업무 1건"],
      ["카테고리를 해제했습니다", "‘Proj › sub’ → ‘Proj’ · 업무 1건(보관 1)"],
    ]);
  });

  it("최상위에서 올리면 null — 노드 자신의 키가 비면 미분류를 고르고 접힘은 버린다", async () => {
    vault = [task(A, "결제 점검", "a"), task(B, "결제 설계", "a/x", true), task(D, "문서 정리", "y")];
    open("a", ["a", "a/x", "y", ""], "a");

    await st().clearCategoryNode("a", "parent");

    expect(argsOf("move_category")).toMatchObject({ from: "a", to: null, allowMerge: false });
    expect(vault.map((t) => t.category)).toEqual([null, "x", "y"]);
    expect([st().settings.catClosed, st().archCat, mgr().node]).toEqual([["x", "y", ""], null, ""]);
    expect(toasts()).toEqual([["카테고리를 해제했습니다", "‘a’ → 최상위 · 업무 2건(보관 1)"]]);
  });

  it("미리보기가 합치기면 경고를 보고 누른 것이라 합치기를 허락해 보낸다", async () => {
    // a/b/c → a/c 가 이미 있는 a/c 와 겹친다.
    vault = [task(A, "결제 점검", "a/b/c"), task(D, "문서 정리", "a/c")];
    open();
    await st().clearCategoryNode("a/b", "parent");
    expect(argsOf("move_category")).toMatchObject({ from: "a/b", to: "a", allowMerge: true });
  });

  it("백엔드가 합치기를 찾으면 해제 폼도 confirmMerge — 다시 누르면 허락해 보낸다", async () => {
    vault = [task(A, "결제 점검", "a/b"), task(B, "결제 설계", "a/b/c", true)];
    open();
    st().setCatEdit({ mode: "remove", to: "parent", confirmMerge: false });
    clash = true;

    await st().clearCategoryNode("a/b", "parent");
    expect(argsOf("move_category").allowMerge).toBe(false);
    expect(mgr().edit).toEqual({ mode: "remove", to: "parent", confirmMerge: true });

    await st().clearCategoryNode("a/b", "parent");
    expect(argsOf("move_category", 1).allowMerge).toBe(true);
  });
});
