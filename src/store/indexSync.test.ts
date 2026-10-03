/**
 * Obsidian 색인 노트(보관함 MOC · 카테고리 허브)의 자동 갱신 — 언제 쓰고 언제 쓰지 않는가.
 *
 * 호출 지점마다 `syncMoc()` 을 부르던 것을 서명 구독으로 바꿨다. 그래서 약속은 "어느 변화가 쓰기를
 * 일으키는가" 다 — 너무 자주 쓰면 Vault 전체를 훑는 쓰기가 타자 · 끌기마다 돌고, 놓치면 Obsidian
 * 의 목록이 낡는다. 커맨드 모킹과 가짜 타이머로 지킨다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMeta, WikiPageMeta, WikiStatus } from "../lib/api";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
/** 커맨드 → 이것이 풀릴 때까지 응답을 붙든다. 쓰기가 오래 도는 사이를 흉내 낸다. */
let holds: Record<string, Promise<void>> = {};
/** 커맨드 → 다음 한 번 던질 오류. */
let fails: Record<string, unknown> = {};
/** 다음 `write_category_hubs` 가 돌려줄 충돌. */
let conflicts: string[] = [];

/** 붙들어 둘 약속과 그것을 푸는 손잡이. */
function hold(cmd: string): () => void {
  let release!: () => void;
  holds[cmd] = new Promise((r) => (release = r));
  return release;
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    await holds[cmd];
    if (cmd in fails) {
      const e = fails[cmd];
      delete fails[cmd];
      throw e;
    }
    switch (cmd) {
      case "write_archive_moc":
        return `${args.root}/_index/Archive.md`;
      case "write_category_hubs":
        return { written: 1, removed: 0, conflicts };
      default:
        return undefined;
    }
  },
}));

// 스토어와 구독은 `window` 의 타이머를 쓴다. 가짜 타이머를 켠 뒤에도 그것을 타도록 부를 때마다
// 전역 `setTimeout` 을 찾는다(`category.test.ts` 와 같다).
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms: number) => (vi.isFakeTimers() ? setTimeout(fn, ms) : 0),
  clearTimeout: (id: number) => clearTimeout(id),
});

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");
const { useWiki } = await import("./wikiStore");
const { startIndexSync } = await import("./indexSync");
const { TOAST } = await import("../lib/design");

function task(n: number, over: Partial<TaskMeta> = {}): TaskMeta {
  const folder = `/v/Tasks/[2026-09] 업무 ${n}`;
  return {
    id: `task-${n}`,
    title: `업무 ${n}`,
    status: "in-progress",
    tags: [],
    category: null,
    created: `2026-09-0${n} 09:00`,
    updated: `2026-09-0${n} 09:00`,
    parentTask: null,
    templateRef: null,
    completedAt: null,
    archived: null,
    archivedAt: null,
    runs: 1,
    order: null,
    folder,
    relFolder: `Tasks/[2026-09] 업무 ${n}/`,
    indexPath: `${folder}/index.md`,
    tagline: "",
    ...over,
  };
}

/** 진행 중 업무와 보관된 업무 하나씩. */
const LIVE = task(1, { category: "운영" });
const DONE = task(2, {
  status: "completed",
  category: "프로젝트",
  completedAt: "2026-09-03",
  archived: true,
  archivedAt: "2026-09-03",
});

function page(path: string, over: Partial<WikiPageMeta> = {}): WikiPageMeta {
  return {
    path,
    stem: path.replace(/^.*\//, "").replace(/\.md$/, ""),
    kind: "procedure",
    title: path,
    summary: "",
    tags: [],
    sources: [DONE.id],
    created: "",
    updated: "",
    taskId: null,
    taskPath: null,
    sourceSig: null,
    links: [],
    hash: "",
    ...over,
  };
}

function wikiStatus(pages: WikiPageMeta[]): WikiStatus {
  return { dir: "/v/Wiki", exists: true, pages, tasks: [], orphans: [], moved: [], logTail: [] };
}

/** 충돌로 쓰지 못한 허브(Vault 기준 경로) — 사용자 노트가 자리를 차지했거나 읽지 못했다. */
const PATH = "_index/카테고리/카테고리 · 운영.md";

const MOC = "write_archive_moc";
const HUB = "write_category_hubs";
const count = (cmd: string) => calls.filter((c) => c.cmd === cmd).length;
const argsOf = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const setTasks = (tasks: TaskMeta[]) => useStore.setState({ tasks });
/** 보관된 업무의 제목을 바꾼다 — MOC 와 허브 둘 다에 실리는 변화. */
const touchArchived = (title: string) => setTasks([LIVE, { ...DONE, title }]);

/** 화면에 띄운 토스트(사라진 것도). 토스트는 2.8초 뒤 목록에서 빠지므로 따로 모은다. */
const shown: { title: string; sub: string; color: string }[] = [];
useStore.subscribe((s, p) => {
  if (s.toasts.length > p.toasts.length) shown.push(s.toasts[s.toasts.length - 1]);
});

let stop: (() => void) | null = null;
const start = () => (stop = startIndexSync());
/** 구독을 시작하고 시작할 때의 첫 쓰기까지 마친 뒤, 기록을 비운다. */
async function startSynced() {
  start();
  await vi.advanceTimersByTimeAsync(800);
  calls.length = 0;
  shown.length = 0;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  calls.length = 0;
  shown.length = 0;
  holds = {};
  fails = {};
  conflicts = [];
  useStore.setState({
    ready: true,
    bootError: "",
    settings: { ...DEFAULT_SETTINGS, vault: "/v" },
    tasks: [LIVE, DONE],
    toasts: [],
  });
  useWiki.setState({ status: null, running: false });
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("타이밍", () => {
  it("변화 뒤 799ms 에는 쓰지 않고 800ms 에 한 번 쓴다", async () => {
    await startSynced();
    touchArchived("고친 제목");

    await vi.advanceTimersByTimeAsync(799);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    // 커맨드마다 Rust 의 인자 이름에 맞춘다 — MOC 는 `archive_days`, 허브는 `arch_days`.
    expect(argsOf(MOC)).toEqual([{ root: "/v", archiveDays: 14, force: false }]);
    expect(argsOf(HUB)).toEqual([{ root: "/v", archDays: 14 }]);
  });

  it("연달아 바뀌면 마지막 변화 뒤 한 번만 쓴다", async () => {
    await startSynced();
    touchArchived("하나");
    await vi.advanceTimersByTimeAsync(500);
    touchArchived("둘");
    await vi.advanceTimersByTimeAsync(500);
    expect(count(MOC)).toBe(0);

    await vi.advanceTimersByTimeAsync(300);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(1);
  });

  it("시작할 때 한 번 쓰고, 그 뒤 같은 목록을 다시 읽어도 쓰지 않는다", async () => {
    start();
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(1);

    // 저장할 때마다 업무 목록을 다시 읽는다 — 새 배열이지만 값은 같다.
    setTasks([{ ...LIVE }, { ...DONE }]);
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(1);
  });
});

describe("걸러지는 변화", () => {
  it("updated · order 만 바뀌어 순서가 달라져도 쓰지 않는다", async () => {
    await startSynced();
    setTasks([
      { ...DONE, updated: "2026-10-01 10:00", order: 0 },
      { ...LIVE, updated: "2026-10-01 11:00", order: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(0);
  });

  it("catClosed · threshold 를 패치해도 쓰지 않는다", async () => {
    await startSynced();
    useStore.getState().patchSettings({ catClosed: ["운영"] });
    useStore.getState().patchSettings({ threshold: 90 });
    // 서명이 같아 쓰지 않는 것만으로는 모자란다 — 구독이 타이머부터 걸지 않아야 끌기 · 타자처럼
    // 잇따르는 `set` 이 서명 계산을 되풀이하거나 기다리던 쓰기를 뒤로 밀지 않는다.
    expect(vi.getTimerCount()).toBe(0);
    useStore.setState((s) => ({ sidebarMin: !s.sidebarMin }));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(0);
  });

  it("진행 중 업무만 바뀌면 MOC 는 쓰지 않고 허브만 쓴다", async () => {
    await startSynced();
    setTasks([{ ...LIVE, title: "고친 제목", category: "운영/점검" }, DONE]);
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(1);
  });

  it("위키 페이지가 바뀌면 허브만 쓴다", async () => {
    await startSynced();
    useWiki.setState({ status: wikiStatus([page("procedures/배포 절차.md")]) });
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(1);

    // 다시 읽은 카탈로그가 같으면 쓰지 않는다.
    useWiki.setState({ status: wikiStatus([page("procedures/배포 절차.md")]) });
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(1);
  });
});

describe("문턱", () => {
  it("ready 전에는 쓰지 않고, ready 가 첫 쓰기를 깨운다", async () => {
    useStore.setState({ ready: false });
    start();
    await vi.advanceTimersByTimeAsync(800);
    touchArchived("boot 중");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(0);

    useStore.setState({ ready: true });
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(1);
  });

  it("bootError 면 쓰지 않는다", async () => {
    useStore.setState({ bootError: "Vault를 열지 못했습니다" });
    start();
    await vi.advanceTimersByTimeAsync(800);
    touchArchived("고친 제목");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(0);
  });
});

describe("설정", () => {
  it("archDays 를 바꾸면 쓴다 — 설정 칩의 syncMoc 을 대신한다", async () => {
    await startSynced();
    useStore.getState().patchSettings({ archDays: 30 });
    await vi.advanceTimersByTimeAsync(800);
    expect(argsOf(MOC)).toEqual([{ root: "/v", archiveDays: 30, force: false }]);
    expect(argsOf(HUB)).toEqual([{ root: "/v", archDays: 30 }]);
  });

  it("Vault 를 바꾸면 새 Vault 에 쓴다", async () => {
    await startSynced();
    useStore.getState().patchSettings({ vault: "/w" });
    await vi.advanceTimersByTimeAsync(800);
    expect(argsOf(MOC)).toEqual([{ root: "/w", archiveDays: 14, force: false }]);
    expect(argsOf(HUB)).toEqual([{ root: "/w", archDays: 14 }]);
  });

  it("catHubs 가 꺼져 있으면 허브를 쓰지 않는다", async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, vault: "/v", catHubs: false } });
    start();
    await vi.advanceTimersByTimeAsync(800);
    touchArchived("고친 제목");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(2);
    expect(count(HUB)).toBe(0);
  });

  it("archMoc 이 꺼져 있으면 MOC 를 쓰지 않는다", async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, vault: "/v", archMoc: false } });
    start();
    await vi.advanceTimersByTimeAsync(800);
    touchArchived("고친 제목");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(2);
  });

  it("껐다가 다시 켜면 목록이 그대로여도 곧 쓴다", async () => {
    await startSynced();
    useStore.getState().patchSettings({ archMoc: false, catHubs: false });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.filter((c) => c.cmd === MOC || c.cmd === HUB)).toEqual([]);

    useStore.getState().patchSettings({ archMoc: true, catHubs: true });
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(1);
  });
});

describe("위키 반영 중", () => {
  it("반영이 도는 동안 MOC 는 쓰고 허브는 미룬다. 끝나면 허브를 한 번 쓴다", async () => {
    await startSynced();
    useWiki.setState({ running: true });
    // [완료] → 보관 → 반영 큐가 도는 사이다. 방금 보관한 업무는 곧바로 MOC 에 실린다.
    touchArchived("방금 완료");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(0);

    // 반영 큐는 업무마다 카탈로그를 다시 읽는다 — 그래도 미룬다.
    useWiki.setState({ status: wikiStatus([page("sources/방금 완료.md", { kind: "source" })]) });
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(0);

    // 반영이 끝나면 타이머를 기다리지 않고 쓴다.
    useWiki.setState({ running: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(count(HUB)).toBe(1);
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(1);
    expect(count(MOC)).toBe(1);
  });

  it("미뤄 둔 것이 없으면 반영이 끝나도 곧바로 쓰지 않는다 — 걸려 있던 타이머를 따른다", async () => {
    await startSynced();
    useWiki.setState({ running: true });
    useWiki.setState({ running: false });
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(0);

    useWiki.setState({ running: true });
    touchArchived("반영 중에 고침");
    await vi.advanceTimersByTimeAsync(100);
    useWiki.setState({ running: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(0);
    await vi.advanceTimersByTimeAsync(700);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(1);
  });
});

describe("재실행 · 실패", () => {
  it("쓰는 중에 바뀌면 끝난 뒤 한 번 더 쓴다", async () => {
    await startSynced();
    const release = hold(HUB);
    touchArchived("하나");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(1);

    // 첫 쓰기가 아직 돈다. 그 사이에 바뀐 것은 겹쳐 쓰지 않고 기다린다.
    touchArchived("둘");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(count(HUB)).toBe(2);
    expect(count(MOC)).toBe(2);
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(2);
  });

  it("실패하면 혼자 다시 시도하지 않고, 다음 변화 때 다시 쓴다", async () => {
    await startSynced();
    fails[HUB] = { kind: "io", message: "쓸 수 없습니다" };
    touchArchived("고친 제목");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(1);
    expect(console.warn).toHaveBeenCalled();
    expect(shown).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(count(HUB)).toBe(1);

    // 값이 같은 목록을 다시 읽었을 뿐이다. 성공한 MOC 는 그대로 두고, 실패한 허브만 다시 쓴다.
    setTasks([...useStore.getState().tasks]);
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(2);
    expect(count(MOC)).toBe(1);
  });
});

describe("충돌 토스트", () => {
  it("같은 충돌은 한 번만 알린다 — 개수와 첫 경로", async () => {
    conflicts = ["_index/카테고리/카테고리 · 프로젝트.md", PATH];
    start();
    await vi.advanceTimersByTimeAsync(800);
    // 충돌에는 읽지 못한 앱의 허브도 든다(hub.rs) — 사용자 노트가 있다고 단정하지 않는다.
    expect(shown).toEqual([
      {
        id: expect.any(Number),
        title: "카테고리 허브 2개를 쓰지 못했습니다",
        sub: `같은 이름의 노트가 있거나 읽을 수 없습니다 · ${PATH}`,
        color: TOAST.warn,
      },
    ]);

    touchArchived("고친 제목");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(2);
    expect(shown.length).toBe(1);
  });

  it("비었다가 다시 생기면 또 알린다", async () => {
    conflicts = [PATH];
    start();
    await vi.advanceTimersByTimeAsync(800);
    expect(shown.length).toBe(1);

    conflicts = [];
    touchArchived("하나");
    await vi.advanceTimersByTimeAsync(800);
    expect(shown.length).toBe(1);

    conflicts = [PATH];
    touchArchived("둘");
    await vi.advanceTimersByTimeAsync(800);
    expect(shown.length).toBe(2);
    expect(shown[1].sub).toBe(`같은 이름의 노트가 있거나 읽을 수 없습니다 · ${PATH}`);
  });

  it("Vault 가 바뀌면 같은 경로라도 다시 알린다", async () => {
    conflicts = [PATH];
    start();
    await vi.advanceTimersByTimeAsync(800);
    useStore.getState().patchSettings({ vault: "/w" });
    await vi.advanceTimersByTimeAsync(800);
    expect(shown.length).toBe(2);
  });
});

describe("정지", () => {
  it("stop() 뒤로는 쓰지 않는다", async () => {
    await startSynced();
    stop?.();
    touchArchived("고친 제목");
    useWiki.setState({ status: wikiStatus([page("procedures/배포 절차.md")]) });
    useStore.getState().patchSettings({ archDays: 30 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count(MOC)).toBe(0);
    expect(count(HUB)).toBe(0);
  });

  it("쓰는 중에 stop() 하면 다시 쓰지 않고 알리지도 않는다", async () => {
    conflicts = [PATH];
    const release = hold(HUB);
    start();
    await vi.advanceTimersByTimeAsync(800);
    expect(count(HUB)).toBe(1);
    touchArchived("쓰는 중");
    await vi.advanceTimersByTimeAsync(800);

    stop?.();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(1);
    expect(shown).toEqual([]);
  });

  it("start → stop → start 면 정확히 한 번 쓴다", async () => {
    const first = startIndexSync();
    first();
    start();
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(1);
    expect(count(HUB)).toBe(1);

    // 앞의 구독이 남아 있으면 변화마다 두 번씩 쓴다.
    touchArchived("고친 제목");
    await vi.advanceTimersByTimeAsync(800);
    expect(count(MOC)).toBe(2);
    expect(count(HUB)).toBe(2);
  });
});
