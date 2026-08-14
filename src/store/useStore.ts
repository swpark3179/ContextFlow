import { create } from "zustand";
import * as api from "../lib/api";
import type { TaskMeta, TemplateMeta, Recommendation } from "../lib/api";
import type { FileEntry } from "../lib/tree";
import { TOAST } from "../lib/design";
import { daysSince, hhmm, joinPath } from "../lib/format";
import { sanitizeFolderName } from "../lib/vaultPaths";
import { aiRecommend } from "../lib/aiRecommend";
import { activeRun, useAi } from "./aiStore";

/** Mirrors `SNAPSHOT_FILE` in src-tauri/src/vault.rs. */
const SNAPSHOT_FILE = ".context_snapshot.json";

export type Screen = "workspace" | "templates" | "archive" | "settings";
/** `text` = 편집기, 나머지는 읽기 전용 뷰어. 같은 파일은 한 번에 한 모드로만 열린다. */
export type TabMode = "md" | "text" | "html";

export interface Tab {
  path: string;
  mode: TabMode;
}

/** 확장자별로 준비된 뷰어. 없으면 텍스트 편집기만 쓸 수 있다. */
export function viewerFor(path: string): Exclude<TabMode, "text"> | null {
  const ext = path.includes(".") ? (path.split(".").pop() as string).toLowerCase() : "";
  if (ext === "md") return "md";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

export interface Doc {
  /** Current buffer, including unsaved edits. */
  text: string;
  /** Last text written to disk — `text !== saved` means dirty. */
  saved: string;
}

/** Everything restored when the user comes back to a task. */
export interface TaskUi {
  openTabs: Tab[];
  activeTab: string;
  sel: string;
  notepad: string;
  colPct: number;
  rowPct: number;
  treeOpen: Record<string, boolean>;
  docs: Record<string, Doc>;
  extOpened: Record<string, string>;
}

export interface Settings {
  vault: string;
  /**
   * 같은 패턴으로 접는 기준(%). AI 경로에서는 프롬프트에 실리고, 로컬 유사도에서는
   * 클러스터 임계값으로 쓰인다.
   *
   * AI 연결 설정(엔드포인트 · 키 · 모델)은 여기 없다 — `ai.json` 을 Rust 가 소유하고
   * `aiStore` 가 그 사본을 든다(`src/store/aiStore.ts`).
   */
  threshold: number;
  archDays: number;
  archMode: "tag" | "move";
  mdDefault: "markdown" | "text";
  archMoc: boolean;
  autoSnap: boolean;
  restoreView: boolean;
  wikiIndex: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  vault: "",
  threshold: 85,
  archDays: 14,
  archMode: "tag",
  mdDefault: "markdown",
  archMoc: true,
  autoSnap: true,
  restoreView: true,
  wikiIndex: true,
};

export interface Toast {
  id: number;
  title: string;
  sub: string;
  color: string;
}

export interface CtxTarget {
  path: string;
  name: string;
  ext: string;
  isDir: boolean;
  bin: boolean;
  count: number;
  x: number;
  y: number;
}

export interface MkState {
  kind: "file" | "folder";
  parent: string;
  name: string;
}

export interface DelState {
  path: string;
  name: string;
  isDir: boolean;
  files: number;
  dirs: number;
  confirm: string;
}

export interface DropState {
  paths: string[];
  names: string[];
  mode: "copy" | "link";
  target: string;
}

export interface OwState {
  path: string;
  ext: string;
  pick: number;
  always: boolean;
}

/**
 * 탐색기에서 길게 눌러 시작한 드래그. HTML5 드래그가 아니라 포인터 캡처를 쓴다 —
 * WebView 밖으로 파일을 넘기는 API 가 Tauri 에 없어서, 창을 벗어난 드롭은 좌표로만
 * 판정하고 바탕화면 반출로 처리하기 때문이다.
 */
export interface FileDrag {
  path: string;
  name: string;
  isDir: boolean;
  x: number;
  y: number;
  /** 드롭 대상 폴더의 상대 경로(루트는 `""`). 창 밖이면 `null`. */
  over: string | null;
  /** 포인터가 창 밖으로 나갔다 — 놓으면 바탕화면으로 간다. */
  outside: boolean;
  /** Alt 를 누르고 있다 — 복사 대신 심볼릭 링크. */
  alt: boolean;
}

export interface NewTaskState {
  title: string;
  summary: string;
  tags: string;
  template: string;
}

export interface MergeState {
  rec: Recommendation;
  sel: Record<number, boolean>;
  primary: number;
}

/** 업무 리스트를 끌어 옮기는 중. 탐색기의 `fileDrag` 와 같은 자리에 사는 이유도 같다. */
export interface TaskDrag {
  /** 끌고 있는 업무의 폴더 경로. */
  folder: string;
  y: number;
  /**
   * 놓으면 들어갈 자리 — 화면에 보이는 목록 기준의 삽입 인덱스다. `0` 은 맨 위,
   * 목록 길이는 맨 아래를 뜻한다.
   */
  at: number;
}

export interface RenameState {
  /** 이름을 바꿀 업무의 폴더 경로 — 확정되면 이 경로 자체가 바뀐다. */
  folder: string;
  title: string;
}

export interface TemplateDraft {
  name: string;
  desc: string;
  sections: string;
  fromTask: boolean;
  /** `sections` = 헤딩만 있는 노트 한 장, `folder` = 고른 폴더를 통째로 복사해 등록. */
  mode: "sections" | "folder";
  /** 폴더 모드에서 고른 원본 폴더의 절대 경로. */
  src: string;
}

function emptyUi(): TaskUi {
  return {
    openTabs: [],
    activeTab: "",
    sel: "",
    notepad: "",
    colPct: 64,
    rowPct: 62,
    treeOpen: {},
    docs: {},
    extOpened: {},
  };
}

/**
 * [Obsidian] 계열 버튼의 결과를 토스트로 옮긴다.
 *
 * Obsidian 이 떴으면 아무것도 띄우지 않는다 — 창이 뜨는 것 자체가 결과다. 알릴 값어치가
 * 있는 것은 떠야 할 것이 안 떴을 때뿐이고, 그중 `unregistered` 는 사용자가 손쓸 수 있는
 * 유일한 경우라 무엇을 하면 되는지까지 적어 준다. 업무 노트와 Archive MOC 두 호출 지점이
 * 같은 문구를 쓰도록 여기 한 곳에 둔다.
 */
export function reportObsidianOpen(res: api.OpenOutcome): void {
  const { toast } = useStore.getState();
  if (res.opened === "obsidian") return;
  if (res.opened === "unregistered") {
    toast(
      "Obsidian에 등록되지 않은 Vault입니다",
      `탐색기에서 열었습니다 · Obsidian에서 [폴더를 vault로 열기]로 ${res.detail} 를 한 번 등록하세요`,
      TOAST.warn,
    );
    return;
  }
  toast("탐색기에서 열었습니다", res.detail, TOAST.muted);
}

/** Mirrors `is_archived` in src-tauri/src/lib.rs so both agree on the rule. */
export function isArchived(t: TaskMeta, archDays: number): boolean {
  if (t.archived !== null) return t.archived;
  if (archDays <= 0 || t.status !== "completed" || !t.completedAt) return false;
  return daysSince(t.completedAt) >= archDays;
}

interface State {
  ready: boolean;
  bootError: string;
  settings: Settings;
  obsidianOk: boolean;

  tasks: TaskMeta[];
  templates: TemplateMeta[];
  activeFolder: string;

  screen: Screen;
  filter: string;
  query: string;
  archQuery: string;
  archScope: "title" | "full";
  archYear: string;
  /** `"all"` 또는 `"01"`..`"12"`. 연도를 고른 뒤에만 의미가 있다. */
  archMonth: string;
  /**
   * 보관함에서 상세로 들어간 업무의 폴더 경로. 값이 있으면 보관함 화면이 목록 대신
   * 그 업무의 작업공간을 그린다 — **화면은 여전히 보관함**이다.
   */
  archOpen: string;

  sidebarW: number;
  sidebarMin: boolean;
  explorerMin: boolean;
  noteMin: boolean;
  statusMenuOpen: boolean;

  files: FileEntry[];
  ui: TaskUi;
  uiCache: Record<string, TaskUi>;
  snapAt: string;
  caret: { ln: number; col: number };

  toasts: Toast[];
  ctx: CtxTarget | null;
  mk: MkState | null;
  del: DelState | null;
  drop: DropState | null;
  dragOver: boolean;
  ow: OwState | null;
  fileDrag: FileDrag | null;
  taskDrag: TaskDrag | null;

  newOpen: boolean;
  nt: NewTaskState;
  ntRecs: Recommendation[];
  ntLoading: boolean;
  ntEngine: string;
  ntNote: string;
  recTag: Record<string, string>;
  /** [참고만 하기] 로 고른 업무들의 폴더 경로. `createTask` 가 이 파일들을 복사해 온다. */
  ntRefs: string[];
  /**
   * 업무 생성이 도는 중. 모달은 생성이 **끝난 뒤에야** 닫히므로, 그 사이에 Enter 나
   * [업무 생성] 이 한 번 더 들어오면 같은 업무가 두 개 만들어진다(이름만 `(2)` 로 갈린다).
   */
  ntBusy: boolean;
  expanded: Record<string, boolean>;
  merge: MergeState | null;
  ren: RenameState | null;
  tplNew: TemplateDraft | null;
  openTpl: Record<string, boolean>;
}

interface Actions {
  boot: () => Promise<void>;
  toast: (title: string, sub?: string, color?: string) => void;
  dropToast: (id: number) => void;
  fail: (e: unknown, title?: string) => void;

  patchSettings: (patch: Partial<Settings>) => void;
  chooseVault: () => Promise<void>;
  reloadVault: (keepActive?: boolean) => Promise<void>;

  selectTask: (folder: string, opts?: { keepScreen?: boolean }) => Promise<void>;
  renameTask: (folder: string, title: string) => Promise<void>;
  setStatus: (status: string) => Promise<void>;
  archiveNow: (folder: string) => Promise<void>;
  restoreTask: (folder: string) => Promise<void>;
  peekArchived: (folder: string) => Promise<void>;
  closeArchived: () => void;
  openTaskInObsidian: (folder: string) => Promise<void>;
  reorderTask: (folder: string, at: number) => Promise<void>;
  clearTaskOrder: () => Promise<void>;

  setScreen: (s: Screen) => void;
  setUi: (patch: Partial<TaskUi>) => void;
  set: <K extends keyof State>(patch: Pick<State, K> | Partial<State>) => void;

  refreshFiles: () => Promise<void>;
  openFile: (path: string, mode: TabMode) => Promise<void>;
  defaultOpen: (path: string, bin: boolean) => Promise<void>;
  setTabMode: (path: string, from: TabMode, to: TabMode) => Promise<void>;
  closeTab: (key: string) => void;
  editDoc: (path: string, text: string) => void;
  saveDoc: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  persistSnapshot: (folder?: string) => Promise<void>;

  commitMk: () => Promise<void>;
  askDelete: (target: CtxTarget) => Promise<void>;
  commitDelete: () => Promise<void>;
  beginDrop: (paths: string[]) => void;
  commitImport: () => Promise<void>;
  openWith: (path: string) => void;
  confirmOpenWith: () => Promise<void>;
  moveFile: (rel: string, targetDir: string) => Promise<void>;
  exportToDesktop: (rel: string, mode: "copy" | "link") => Promise<void>;

  runRecommend: () => Promise<void>;
  createTask: () => Promise<void>;
  doMerge: () => Promise<void>;

  reloadTemplates: () => Promise<void>;
  createTemplate: () => Promise<void>;
  syncMoc: () => Promise<void>;
}

let toastSeq = 0;
let saveTimer: number | undefined;
let recTimer: number | undefined;

export const useStore = create<State & Actions>((set, get) => ({
  ready: false,
  bootError: "",
  settings: DEFAULT_SETTINGS,
  obsidianOk: false,

  tasks: [],
  templates: [],
  activeFolder: "",

  screen: "workspace",
  filter: "all",
  query: "",
  archQuery: "",
  archScope: "title",
  archYear: "all",
  archMonth: "all",
  archOpen: "",

  sidebarW: 250,
  sidebarMin: false,
  explorerMin: false,
  noteMin: false,
  statusMenuOpen: false,

  files: [],
  ui: emptyUi(),
  uiCache: {},
  snapAt: hhmm(),
  caret: { ln: 1, col: 1 },

  toasts: [],
  ctx: null,
  mk: null,
  del: null,
  drop: null,
  dragOver: false,
  ow: null,
  fileDrag: null,
  taskDrag: null,

  newOpen: false,
  nt: { title: "", summary: "", tags: "", template: "(없음)" },
  ntRecs: [],
  ntLoading: false,
  ntEngine: "local",
  ntNote: "",
  recTag: {},
  ntRefs: [],
  ntBusy: false,
  expanded: {},
  merge: null,
  ren: null,
  tplNew: null,
  openTpl: {},

  set: (patch) => set(patch as Partial<State>),

  /**
   * 토스트는 **결과가 화면에 드러나지 않거나 되돌릴 수 없을 때만** 띄운다.
   *
   * 파일 트리 · 탭 · 상태 배지가 즉시 바뀌어 보이는 일(파일 열기 · 업무 전환 · 상태 변경 ·
   * 저장 · 폴더 생성)은 토스트로 중복해 알리지 않는다. 남은 것은 세 부류다:
   * 실패(`fail`), 눈에 보이지 않는 부수효과(클립보드 복사 · Obsidian 대신 탐색기로 폴백),
   * 그리고 되돌리기 어려운 조작(영구 삭제 · 병합 · Vault 교체 · 폴더 실제 이동).
   */
  toast: (title, sub = "", color = TOAST.info) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, title, sub, color }] }));
    window.setTimeout(() => get().dropToast(id), 2800);
  },
  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  fail: (e, title = "작업을 완료하지 못했습니다") => {
    get().toast(title, api.errMessage(e), TOAST.danger);
  },

  // -------------------------------------------------------------------------

  boot: async () => {
    try {
      const stored = (await api.loadSettings()) as Partial<Settings> | null;
      let settings: Settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
      if (!settings.vault) {
        settings = { ...settings, vault: await api.defaultVaultRoot() };
      }
      // A brand-new vault gets its folder skeleton and one sample task so the
      // first launch is not an empty screen.
      const fresh = !(await api.pathExists(joinPath(settings.vault, "Tasks")));
      await api.initVault(settings.vault, fresh);
      await api.saveSettings(settings);
      const obsidianOk = await api.obsidianAvailable();
      set({ settings, obsidianOk });
      await get().reloadVault(false);
      await get().reloadTemplates();
      set({ ready: true });
    } catch (e) {
      set({ ready: true, bootError: api.errMessage(e) });
    }
  },

  patchSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void api.saveSettings(settings).catch((e) => get().fail(e, "설정을 저장하지 못했습니다"));
  },

  chooseVault: async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "Vault Root 선택" });
    if (typeof picked !== "string") return;
    const vault = picked.replace(/\\/g, "/");
    get().patchSettings({ vault });
    try {
      await api.initVault(vault, false);
      set({ activeFolder: "", uiCache: {}, ui: emptyUi(), files: [] });
      await get().reloadVault(false);
      await get().reloadTemplates();
      get().toast("Vault를 변경했습니다", vault, TOAST.ok);
    } catch (e) {
      get().fail(e, "Vault를 열지 못했습니다");
    }
  },

  reloadVault: async (keepActive = true) => {
    const { settings, activeFolder } = get();
    try {
      const tasks = await api.scanVault(settings.vault);
      set({ tasks });
      const stillThere = tasks.some((t) => t.folder === activeFolder);
      if (keepActive && stillThere) return;
      const live = tasks.filter((t) => !isArchived(t, settings.archDays));
      const next = (live[0] ?? tasks[0])?.folder;
      if (next) await get().selectTask(next);
      else set({ activeFolder: "", files: [], ui: emptyUi(), archOpen: "" });
    } catch (e) {
      get().fail(e, "Vault를 읽지 못했습니다");
    }
  },

  // -------------------------------------------------------------------------

  /**
   * 업무를 연다. 기본은 워크스페이스로 넘어가는 것이지만, 보관함에서 상세를 열 때는
   * `keepScreen` 으로 화면을 그대로 둔다 — 보관된 업무는 왼쪽 업무 리스트에 없어서
   * 워크스페이스로 넘기면 아무것도 고르지 않은 것처럼 보인다(`peekArchived`).
   */
  selectTask: async (folder, opts) => {
    const { activeFolder, settings } = get();
    // 이미 열려 있어도 화면은 맞춰 준다 — 보관함 상세에서 [재개] 한 업무가 그 자리에
    // 남아 버리면, 목록에 다시 나타난 업무를 상세 화면에서 보고 있게 된다.
    if (folder === activeFolder) {
      if (!opts?.keepScreen) set({ screen: "workspace", archOpen: "" });
      return;
    }

    if (activeFolder) {
      await get().saveAll();
      await get().persistSnapshot(activeFolder);
    }

    // Restore from the in-memory cache first, then from disk.
    let ui = get().uiCache[folder];
    if (!ui) {
      ui = emptyUi();
      if (settings.restoreView) {
        try {
          const snap = (await api.loadSnapshot(folder)) as Partial<TaskUi> | null;
          if (snap) ui = { ...ui, ...snap, docs: snap.docs ?? {} };
        } catch {
          /* a corrupt snapshot must not block opening the task */
        }
      }
    }

    set({
      activeFolder: folder,
      ui,
      statusMenuOpen: false,
      ctx: null,
      mk: null,
      ...(opts?.keepScreen ? {} : { screen: "workspace" as Screen, archOpen: "" }),
      snapAt: hhmm(),
    });
    await get().refreshFiles();

    // Nothing restored? Fall back to the task's own note.
    const cur = get().ui;
    if (!cur.openTabs.length) {
      const hasIndex = get().files.some((f) => f.p === "index.md");
      if (hasIndex) await get().openFile("index.md", "text");
      else if (get().files.length) set({ ui: { ...get().ui, sel: get().files[0].p } });
    } else {
      // Re-read any file whose buffer was not carried in the snapshot.
      for (const tab of cur.openTabs) {
        if (!get().ui.docs[tab.path]) await get().openFile(tab.path, tab.mode);
      }
      set({ ui: { ...get().ui, activeTab: cur.activeTab || get().ui.activeTab } });
    }
  },

  /**
   * 업무명 변경. frontmatter 의 `title` 과 디스크 폴더 이름이 함께 바뀌므로, 앱 전역에서
   * 업무의 기본키로 쓰이는 **폴더 경로가 달라진다**. 그래서 단순 재조회로는 부족하고
   * `uiCache` 키까지 옮겨 줘야 열어 둔 탭과 미저장 버퍼가 살아남는다.
   */
  renameTask: async (folder, title) => {
    try {
      await get().saveAll();
      await get().persistSnapshot(folder);
      const updated = await api.renameTask(get().settings.vault, folder, title);
      const wasActive = get().activeFolder === folder;
      set((s) => {
        const { [folder]: moved, ...rest } = s.uiCache;
        return {
          uiCache: moved ? { ...rest, [updated.folder]: moved } : rest,
          activeFolder: wasActive ? updated.folder : s.activeFolder,
          ren: null,
        };
      });
      // 열린 탭 · 미저장 버퍼는 폴더 상대 경로라 그대로 살아 있다. 새 경로를 이미
      // activeFolder 에 넣었으므로 재조회는 목록만 새로 읽고(keepActive) 파일 트리만 다시 센다.
      await get().reloadVault(true);
      if (wasActive) await get().refreshFiles();
      await get().reloadTemplates();
      await get().syncMoc();
    } catch (e) {
      set({ ren: null });
      get().fail(e, "이름을 바꾸지 못했습니다");
    }
  },

  setStatus: async (status) => {
    const { settings, activeFolder } = get();
    if (!activeFolder) return;
    try {
      await get().saveAll();
      const updated = await api.setTaskStatus(settings.vault, activeFolder, status);
      set((s) => ({
        tasks: s.tasks.map((t) => (t.folder === activeFolder ? updated : t)),
        statusMenuOpen: false,
        snapAt: hhmm(),
      }));
      await get().persistSnapshot(activeFolder);
      // 바뀐 상태는 헤더의 상태 배지에 즉시 나타난다.
      await get().reloadTemplates();
      await get().syncMoc();
    } catch (e) {
      get().fail(e, "상태를 바꾸지 못했습니다");
    }
  },

  archiveNow: async (folder) => {
    const { settings, tasks } = get();
    const target = tasks.find((t) => t.folder === folder);
    try {
      const updated = await api.setTaskArchived(
        settings.vault,
        folder,
        true,
        settings.archMode,
        false,
      );
      set((s) => ({
        tasks: s.tasks.map((t) => (t.folder === folder ? updated : t)),
        statusMenuOpen: false,
      }));
      // 'move' 는 디스크에서 폴더를 실제로 옮긴다 — 어디로 갔는지는 화면에 나오지 않는다.
      // 'tag' 는 파일을 건드리지 않고 목록에서 사라지는 것으로 충분히 드러난다.
      if (settings.archMode === "move") {
        get().toast("Archive 폴더로 이동", target?.title ?? "", TOAST.muted);
      }
      // The folder may have moved, so re-scan and land on a live task.
      await get().reloadVault(false);
      await get().syncMoc();
    } catch (e) {
      get().fail(e, "보관하지 못했습니다");
    }
  },

  restoreTask: async (folder) => {
    const { settings } = get();
    try {
      const updated = await api.setTaskArchived(
        settings.vault,
        folder,
        false,
        settings.archMode,
        true,
      );
      set((s) => ({ tasks: s.tasks.map((t) => (t.folder === folder ? updated : t)) }));
      set({ archQuery: "", query: "" });
      await get().reloadVault(false);
      await get().selectTask(updated.folder);
      await get().reloadTemplates();
      await get().syncMoc();
    } catch (e) {
      get().fail(e, "재개하지 못했습니다");
    }
  },

  /**
   * 보관된 업무를 연다. **화면은 보관함에 머문다.**
   *
   * 예전에는 워크스페이스로 넘겼는데, 보관된 업무는 왼쪽 업무 리스트에 없으므로 넘어간
   * 화면에서는 아무것도 선택되지 않은 것처럼 보였다. 게다가 목록으로 돌아와 같은 항목을
   * 다시 눌러도 이미 활성 업무라 아무 일도 일어나지 않았다 — 한 번 열면 다시 열 수 없는
   * 항목이 되는 셈이다. 이제 보관함 화면이 `archOpen` 을 보고 목록 대신 상세를 그리고,
   * 상세 위쪽의 [보관함 목록] 버튼이 돌아가는 길이 된다.
   *
   * 보관 상태 자체는 상세 상단 바가 상시 표시하므로 여는 순간을 토스트로 알리지 않는다.
   */
  peekArchived: async (folder) => {
    set({ screen: "archive", archOpen: folder, ctx: null, statusMenuOpen: false });
    await get().selectTask(folder, { keepScreen: true });
  },

  /** 상세에서 보관함 목록으로. 연 업무는 그대로 두므로 다시 누르면 즉시 열린다. */
  closeArchived: () => set({ archOpen: "", ctx: null, statusMenuOpen: false }),

  openTaskInObsidian: async (folder) => {
    const { settings } = get();
    try {
      reportObsidianOpen(await api.openInObsidian(settings.vault, joinPath(folder, "index.md")));
    } catch (e) {
      get().fail(e, "Obsidian에서 열지 못했습니다");
    }
  },

  // 화면을 직접 고르면 보관함은 언제나 목록에서 다시 시작한다.
  setScreen: (s) => set({ screen: s, ctx: null, statusMenuOpen: false, archOpen: "" }),

  setUi: (patch) => {
    const ui = { ...get().ui, ...patch };
    const folder = get().activeFolder;
    set({ ui, uiCache: { ...get().uiCache, [folder]: ui } });
  },

  // -------------------------------------------------------------------------

  refreshFiles: async () => {
    const folder = get().activeFolder;
    if (!folder) return set({ files: [] });
    try {
      set({ files: await api.listTaskFiles(folder) });
    } catch (e) {
      get().fail(e, "파일 목록을 읽지 못했습니다");
    }
  },

  openFile: async (path, mode) => {
    const { activeFolder } = get();
    if (!activeFolder) return;
    const key = `${mode}|${path}`;
    try {
      // 뷰어는 저장된 내용을 보여 준다 — HTML 뷰어는 디스크의 파일을 그대로 읽는다.
      // 편집 중이던 버퍼가 있으면 `setTabMode` 와 같은 규칙으로 먼저 저장한다.
      const buf = get().ui.docs[path];
      if (mode !== "text" && buf && buf.text !== buf.saved) await get().saveDoc(path);
      const ui = get().ui;
      let docs = ui.docs;
      if (!docs[path]) {
        const text = await api.readTextFile(joinPath(activeFolder, path));
        docs = { ...docs, [path]: { text, saved: text } };
      }
      // 한 파일은 한 탭이다. 이미 다른 모드로 열려 있으면 그 탭의 모드를 갈아 끼운다 —
      // 뷰어와 편집기를 오갈 때 같은 파일의 탭이 둘로 늘어나는 것이 혼란의 원인이었다.
      // 자리를 그대로 두는 것이 중요하다: 탭 순서가 바뀌면 옮겨 간 것처럼 보인다.
      const exists = ui.openTabs.some((t) => `${t.mode}|${t.path}` === key);
      const same = exists ? -1 : ui.openTabs.findIndex((t) => t.path === path);
      const openTabs = exists
        ? ui.openTabs
        : same >= 0
          ? ui.openTabs.map((t, i) => (i === same ? { path, mode } : t))
          : [...ui.openTabs, { path, mode }];
      get().setUi({ docs, openTabs, activeTab: key, sel: path });
      set({ ctx: null });
    } catch (e) {
      get().fail(e, "파일을 열지 못했습니다");
    }
  },

  defaultOpen: async (path, bin) => {
    if (bin) return get().openWith(path);
    const { settings } = get();
    const viewer = viewerFor(path);
    // .md 만 사용자 설정을 탄다 — 나머지 뷰어는 그 설정이 만들어질 때 없던 것이고,
    // 확장자마다 기본값을 하나씩 늘리는 것보다 뷰어 우선이 예측 가능하다.
    if (viewer === "md") return get().openFile(path, settings.mdDefault === "text" ? "text" : "md");
    return get().openFile(path, viewer ?? "text");
  },

  /**
   * 뷰어 ↔ 편집기 전환. 탭을 새로 만들지 않고 **열려 있는 탭의 모드만 바꾼다**.
   * `docs` 가 모드가 아니라 경로로 키잉돼 있어(openFile) 버퍼는 그대로 쓰면 된다.
   *
   * 편집기에서 나갈 때는 먼저 저장하고, 저장이 끝나지 않았으면 전환하지 않는다 —
   * 뷰어는 디스크가 아니라 버퍼를 그리므로 화면은 같겠지만, 저장 실패를 눈치채지
   * 못한 채 읽기 전용 화면으로 넘어가는 편이 더 나쁘다.
   */
  setTabMode: async (path, from, to) => {
    if (from === to) return;
    if (from === "text") {
      await get().saveDoc(path);
      const doc = get().ui.docs[path];
      if (doc && doc.text !== doc.saved) return;
    }
    const ui = get().ui;
    const fromKey = `${from}|${path}`;
    const toKey = `${to}|${path}`;
    const exists = ui.openTabs.some((t) => `${t.mode}|${t.path}` === toKey);
    const openTabs = exists
      ? ui.openTabs.filter((t) => `${t.mode}|${t.path}` !== fromKey)
      : ui.openTabs.map((t) => (`${t.mode}|${t.path}` === fromKey ? { path, mode: to } : t));
    get().setUi({ openTabs, activeTab: toKey, sel: path });
  },

  closeTab: (key) => {
    const ui = get().ui;
    const openTabs = ui.openTabs.filter((t) => `${t.mode}|${t.path}` !== key);
    const activeTab =
      ui.activeTab === key
        ? openTabs.length
          ? `${openTabs[openTabs.length - 1].mode}|${openTabs[openTabs.length - 1].path}`
          : ""
        : ui.activeTab;
    get().setUi({ openTabs, activeTab });
  },

  editDoc: (path, text) => {
    const ui = get().ui;
    const prev = ui.docs[path] ?? { text: "", saved: "" };
    get().setUi({ docs: { ...ui.docs, [path]: { ...prev, text } } });
    // Debounced write-through; Ctrl+S and task switches flush immediately.
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().saveDoc(path), 900);
  },

  saveDoc: async (path) => {
    const { activeFolder, ui } = get();
    const doc = ui.docs[path];
    if (!activeFolder || !doc || doc.text === doc.saved) return;
    try {
      await api.writeTextFile(joinPath(activeFolder, path), doc.text);
      const cur = get().ui;
      const now = cur.docs[path];
      get().setUi({ docs: { ...cur.docs, [path]: { text: now.text, saved: doc.text } } });
      set({ snapAt: hhmm() });
      // index.md carries the frontmatter, so its metadata may have changed.
      if (path === "index.md") {
        const tasks = await api.scanVault(get().settings.vault);
        set({ tasks });
      }
    } catch (e) {
      get().fail(e, "저장하지 못했습니다");
    }
  },

  saveAll: async () => {
    window.clearTimeout(saveTimer);
    const paths = Object.keys(get().ui.docs);
    for (const p of paths) await get().saveDoc(p);
  },

  persistSnapshot: async (folder) => {
    const target = folder ?? get().activeFolder;
    if (!target || !get().settings.autoSnap) return;
    const ui = get().uiCache[target] ?? (target === get().activeFolder ? get().ui : null);
    if (!ui) return;
    // Only unsaved buffers are worth carrying; saved text is on disk already.
    const docs: Record<string, Doc> = {};
    for (const [p, d] of Object.entries(ui.docs)) {
      if (d.text !== d.saved) docs[p] = d;
    }
    try {
      await api.saveSnapshot(target, { ...ui, docs });
    } catch {
      /* snapshots are best-effort; never surface as a blocking error */
    }
  },

  // -------------------------------------------------------------------------

  commitMk: async () => {
    const { mk, activeFolder } = get();
    if (!mk) return;
    const name = mk.name.trim();
    if (!name) return set({ mk: null });
    try {
      // 만들어진 파일·폴더는 트리에 곧바로 나타난다 — 성공은 알리지 않는다.
      if (mk.kind === "folder") {
        const rel = await api.createTaskDir(activeFolder, mk.parent + name);
        set({ mk: null });
        await get().refreshFiles();
        get().setUi({ treeOpen: { ...get().ui.treeOpen, [rel]: true } });
      } else {
        const rel = await api.createTaskFile(activeFolder, mk.parent + name);
        set({ mk: null });
        await get().refreshFiles();
        await get().openFile(rel, "text");
      }
    } catch (e) {
      get().toast(
        api.errKind(e) === "already_exists" ? "이미 있는 이름입니다" : "만들지 못했습니다",
        api.errMessage(e),
        TOAST.warn,
      );
    }
  },

  askDelete: async (target) => {
    const folder = get().activeFolder;
    try {
      const preview = await api.previewDelete(folder, target.path);
      set({
        ctx: null,
        del: {
          path: target.path,
          name: target.name,
          isDir: target.isDir,
          files: preview.files,
          dirs: preview.dirs,
          confirm: "",
        },
      });
    } catch (e) {
      get().fail(e, "삭제 대상을 확인하지 못했습니다");
    }
  },

  commitDelete: async () => {
    const { del, activeFolder, ui } = get();
    if (!del || del.confirm.trim() !== del.name) return;
    const task = get().tasks.find((t) => t.folder === activeFolder);
    try {
      await api.deleteTaskPath(activeFolder, del.path);
      const gone = (p: string) => (del.isDir ? p.startsWith(del.path) : p === del.path);
      const openTabs = ui.openTabs.filter((t) => !gone(t.path));
      const docs = Object.fromEntries(Object.entries(ui.docs).filter(([p]) => !gone(p)));
      const activeTab = openTabs.some((t) => `${t.mode}|${t.path}` === ui.activeTab)
        ? ui.activeTab
        : openTabs.length
          ? `${openTabs[openTabs.length - 1].mode}|${openTabs[openTabs.length - 1].path}`
          : "";
      get().setUi({ openTabs, docs, activeTab, sel: "" });
      set({ del: null });
      await get().refreshFiles();
      const rest = get().files.filter((f) => !f.dir);
      get().setUi({ sel: rest.length ? rest[0].p : "" });
      get().toast(
        del.isDir ? "폴더를 완전히 삭제했습니다" : "파일을 완전히 삭제했습니다",
        `${task?.relFolder ?? ""}${del.path}${
          del.isDir && del.files ? ` · 파일 ${del.files}개 포함` : ""
        }`,
        TOAST.danger,
      );
    } catch (e) {
      set({ del: null });
      get().fail(e, "삭제하지 못했습니다");
    }
  },

  beginDrop: (paths) => {
    const sel = get().ui.sel;
    const dir = sel ? sel.split("/").slice(0, -1).join("/") : "";
    set({
      dragOver: false,
      drop: {
        paths,
        names: paths.map((p) => p.replace(/\\/g, "/").split("/").pop() ?? p),
        mode: "copy",
        target: dir ? dir + "/" : "",
      },
    });
  },

  commitImport: async () => {
    const { drop, activeFolder } = get();
    if (!drop) return;
    try {
      const res = await api.importIntoTask(activeFolder, drop.target, drop.paths, drop.mode);
      set({ drop: null });
      await get().refreshFiles();
      if (res.added.length) get().setUi({ sel: res.added[0] });
      // 가져온 항목은 트리에 바로 보인다. 알려야 하는 것은 **요청과 다르게 처리된** 경우다.
      if (res.fellBackToCopy.length) {
        get().toast(
          "심볼릭 링크를 만들 수 없어 복사했습니다",
          `${res.fellBackToCopy.join(", ")} · Windows 개발자 모드 또는 관리자 권한이 필요합니다`,
          TOAST.warn,
        );
      }
    } catch (e) {
      set({ drop: null });
      get().fail(e, "가져오지 못했습니다");
    }
  },

  openWith: (path) => {
    const ext = path.includes(".") ? (path.split(".").pop() as string).toLowerCase() : "";
    set({ ow: { path, ext, pick: 0, always: false }, ctx: null });
    get().setUi({ sel: path });
  },

  confirmOpenWith: async () => {
    const { ow, activeFolder } = get();
    if (!ow) return;
    const abs = joinPath(activeFolder, ow.path);
    set({ ow: null });
    try {
      // "항상 이 앱으로" is an OS-level association, so we hand off to the
      // Windows chooser rather than pretending we can set it ourselves.
      if (ow.always) {
        await api.openPathWithDialog(abs);
        get().toast(
          "Windows 연결 프로그램 창을 열었습니다",
          `여기서 '항상 이 앱 사용'을 선택하면 .${ow.ext} 기본 앱이 바뀝니다`,
          TOAST.muted,
        );
      } else {
        // 앱이 떴으면 눈에 보인다.
        await api.openPathDefault(abs);
      }
      get().setUi({ extOpened: { ...get().ui.extOpened, [ow.path]: "OS" } });
    } catch (e) {
      get().fail(e, "열지 못했습니다");
    }
  },

  /**
   * 업무 폴더 안에서 파일·폴더를 옮긴다(탐색기 드래그).
   *
   * 열린 탭 · 미저장 버퍼 · 트리 펼침 상태는 전부 **상대 경로를 키로** 들고 있어서,
   * 디스크만 옮기면 그 전부가 사라진 파일을 가리키게 된다. 그래서 접두사를 새 위치로
   * 갈아 끼운 뒤에야 파일 목록을 다시 읽는다.
   */
  moveFile: async (rel, targetDir) => {
    const { activeFolder, ui } = get();
    if (!activeFolder || !rel) return;
    const isDir = rel.endsWith("/");
    const src = rel.replace(/\/$/, "");
    const parent = src.includes("/") ? src.slice(0, src.lastIndexOf("/") + 1) : "";
    const dest = targetDir ? targetDir.replace(/\/?$/, "/") : "";
    if (dest === parent) return; // 이미 그 폴더에 있다
    if (isDir && dest.startsWith(rel)) return; // 자기 자신 아래로는 옮길 수 없다
    try {
      const next = await api.moveTaskPath(activeFolder, rel, dest);
      const rewrite = (p: string) =>
        p === rel ? next : isDir && p.startsWith(rel) ? next + p.slice(rel.length) : p;
      const [mode, path] = ui.activeTab.split("|");
      get().setUi({
        openTabs: ui.openTabs.map((t) => ({ ...t, path: rewrite(t.path) })),
        activeTab: path ? `${mode}|${rewrite(path)}` : ui.activeTab,
        sel: rewrite(ui.sel),
        docs: Object.fromEntries(Object.entries(ui.docs).map(([p, d]) => [rewrite(p), d])),
        treeOpen: Object.fromEntries(Object.entries(ui.treeOpen).map(([p, v]) => [rewrite(p), v])),
        extOpened: Object.fromEntries(
          Object.entries(ui.extOpened).map(([p, v]) => [rewrite(p), v]),
        ),
      });
      await get().refreshFiles();
    } catch (e) {
      get().fail(e, "옮기지 못했습니다");
    }
  },

  /**
   * 업무 리스트에서 `folder` 를 화면상 `at` 번째 자리로 옮긴다.
   *
   * 프런트는 원하는 최종 순서만 만들어 넘기고 `order` 값 계산은 Rust 가 한다.
   * **보이는 목록이 아니라 살아 있는 업무 전체**로 순서를 만든다 — 필터나 검색이 걸린
   * 채로 보이는 것만 넘기면 화면에 없는 업무들의 자리가 조용히 뒤섞인다(사이드바가
   * 그럴 때 아예 드래그를 막지만, 규칙을 여기서도 지킨다).
   */
  reorderTask: async (folder, at) => {
    const { settings, tasks } = get();
    const live = tasks.filter((t) => !isArchived(t, settings.archDays));
    const from = live.findIndex((t) => t.folder === folder);
    if (from < 0) return;
    // 자기 자신을 뺀 자리 기준으로 삽입 지점을 다시 센다.
    const rest = live.filter((t) => t.folder !== folder);
    const to = Math.max(0, Math.min(at > from ? at - 1 : at, rest.length));
    if (to === from) return;
    const next = [...rest.slice(0, to), live[from], ...rest.slice(to)];
    try {
      set({ tasks: await api.reorderTasks(settings.vault, next.map((t) => t.folder)) });
    } catch (e) {
      get().fail(e, "순서를 바꾸지 못했습니다");
    }
  },

  /** 수동 정렬을 버리고 최근 수정순으로 되돌린다. 노트에서 `order` 키를 지운다. */
  clearTaskOrder: async () => {
    const { settings, tasks } = get();
    if (!tasks.some((t) => t.order !== null)) {
      get().toast("이미 최근 수정순입니다", "수동으로 정한 순서가 없습니다", TOAST.muted);
      return;
    }
    try {
      set({ tasks: await api.clearTaskOrder(settings.vault) });
      // 목록이 통째로 다시 늘어서는데 그 이유가 화면에 드러나지 않는다.
      get().toast("정렬을 초기화했습니다", "다시 최근 수정순으로 정렬합니다", TOAST.ok);
    } catch (e) {
      get().fail(e, "정렬을 초기화하지 못했습니다");
    }
  },

  /**
   * 창 밖으로 끌어다 놓았을 때의 바탕화면 반출. 결과가 앱 화면에 전혀 드러나지 않으므로
   * (파일은 다른 창에 생긴다) 성공도 토스트로 알린다.
   */
  exportToDesktop: async (rel, mode) => {
    const { activeFolder } = get();
    if (!activeFolder || !rel) return;
    try {
      const res = await api.exportToDesktop(activeFolder, rel, mode);
      if (res.fellBackToCopy) {
        get().toast(
          "심볼릭 링크를 만들 수 없어 복사했습니다",
          `${res.name} · Windows 개발자 모드 또는 관리자 권한이 필요합니다`,
          TOAST.warn,
        );
      } else {
        get().toast(
          mode === "link" ? "바탕화면에 링크를 만들었습니다" : "바탕화면으로 복사했습니다",
          res.name,
          TOAST.ok,
        );
      }
    } catch (e) {
      get().fail(e, "바탕화면으로 보내지 못했습니다");
    }
  },

  // -------------------------------------------------------------------------

  runRecommend: async () => {
    const { nt, settings, tasks } = get();
    const query = `${nt.title} ${nt.summary}`.trim();
    if (nt.title.trim().length < 2) {
      set({ ntRecs: [], ntLoading: false });
      return;
    }
    const candidates: api.RecCandidate[] = tasks.map((t) => ({
      id: t.folder,
      title: t.title,
      tags: t.tags,
      path: `${t.relFolder}index.md`,
      date: t.completedAt ?? t.updated.slice(0, 10),
      text: t.tagline,
    }));

    // 로컬 유사도를 항상 먼저 낸다. 두 가지 역할을 한다: AI 가 없거나 실패할 때의 답이고,
    // AI 에게 보낼 후보를 추려 주는 1차 필터다(Vault 가 커지면 전부 실을 수 없다).
    let local: api.RecommendResult;
    try {
      local = await api.recommendTasks(query, candidates, settings.threshold);
    } catch (e) {
      set({ ntRecs: [], ntLoading: false, ntNote: api.errMessage(e) });
      return;
    }

    const active = activeRun(useAi.getState());
    if (!active) {
      set({
        ntRecs: local.items,
        ntLoading: false,
        ntEngine: local.engine,
        ntNote: local.note,
      });
      return;
    }

    // 로컬 결과를 먼저 보여 주되 엔진은 AI 로 표시한다 — 지금 도는 것이 그쪽이고,
    // 화면의 "분석 중" 라벨도 이 값에서 나온다.
    set({ ntRecs: local.items, ntEngine: active.agentId, ntNote: "AI 추천 중…" });

    const ai = await aiRecommend({ active, query, candidates, threshold: settings.threshold });
    if (ai) {
      set({ ntRecs: ai.items, ntLoading: false, ntEngine: ai.engine, ntNote: ai.note });
    } else {
      // 폴백. 이미 손에 있는 로컬 결과를 그대로 쓰고 사유만 덧붙인다.
      set({
        ntRecs: local.items,
        ntLoading: false,
        ntEngine: local.engine,
        ntNote: `${local.note} · AI 추천 실패로 대체`,
      });
    }
  },

  createTask: async () => {
    const { nt, settings, ntRefs, tasks, ntBusy } = get();
    const title = nt.title.trim();
    if (!title || ntBusy) return;
    set({ ntBusy: true });
    const tags = nt.tags
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      const created = await api.createTask(
        settings.vault,
        title,
        nt.summary,
        tags,
        nt.template === "(없음)" ? null : nt.template,
      );

      set({ newOpen: false, ntRecs: [], recTag: {}, ntRefs: [] });

      // [참고만 하기] 로 고른 업무들의 파일을 새 업무 안으로 복사한다. 추천 카드의 `id` 는
      // 그 업무의 절대 폴더 경로이고(`runRecommend` 가 그렇게 만든다), `importIntoTask` 는
      // 원본으로 절대 경로를 받으므로 새 백엔드 명령 없이 기존 경로를 그대로 쓴다.
      // 실패해도 업무 생성 자체는 되돌리지 않는다 — 폴더는 이미 만들어졌다.
      try {
        for (const refFolder of ntRefs) {
          const src = tasks.find((t) => t.folder === refFolder);
          const entries = await api.listTaskFiles(refFolder);
          // 최상위만 넘기면 하위 폴더는 재귀 복사로 따라온다. 원본의 index.md 는 일부러
          // 포함한다 — 개요 · 체크리스트 · Run Log 가 참조의 알맹이다. 스냅샷 파일만 뺀다:
          // 그 업무의 열린 탭과 미저장 버퍼라 새 업무에 들어가면 안 된다.
          const top = entries
            .filter((e) => !e.p.includes("/") && e.p !== SNAPSHOT_FILE)
            .map((e) => joinPath(refFolder, e.p));
          if (!top.length) continue;
          await api.importIntoTask(
            created.folder,
            `reference/${sanitizeFolderName(src?.title ?? "참조")}`,
            top,
            "copy",
          );
        }
      } catch (e) {
        get().fail(e, "참조 파일을 복사하지 못했습니다");
      }

      await get().reloadVault(false);
      // selectTask 가 파일 트리까지 다시 읽으므로 복사된 reference/ 도 여기서 드러난다.
      await get().selectTask(created.folder);
      await get().reloadTemplates();
    } catch (e) {
      get().fail(e, "업무를 만들지 못했습니다");
    } finally {
      set({ ntBusy: false });
    }
  },

  doMerge: async () => {
    const { merge, settings } = get();
    if (!merge?.rec.cluster) return;
    const picked = merge.rec.cluster.filter((_, i) => merge.sel[i]);
    if (picked.length < 2) {
      get().toast("대표 노드 외 1개 이상을 선택하세요", "", TOAST.warn);
      return;
    }
    const primary = merge.rec.cluster[merge.primary] ?? merge.rec.cluster[0];
    try {
      await api.mergeTasks(
        settings.vault,
        primary.id,
        picked.map((c) => c.id),
        settings.archMode,
      );
      set((s) => ({
        merge: null,
        recTag: { ...s.recTag, [merge.rec.id]: "merged" },
        expanded: { ...s.expanded, [merge.rec.id]: false },
      }));
      await get().reloadVault(false);
      await get().reloadTemplates();
      await get().syncMoc();
      get().toast(
        `${picked.length - 1}개 노드를 대표 노드로 병합`,
        `검색 노이즈 ${picked.length - 1}건 감소 · Run Log로 접힘`,
        TOAST.violet,
      );
    } catch (e) {
      set({ merge: null });
      get().fail(e, "병합하지 못했습니다");
    }
  },

  // -------------------------------------------------------------------------

  reloadTemplates: async () => {
    try {
      set({ templates: await api.scanTemplates(get().settings.vault) });
    } catch (e) {
      get().fail(e, "템플릿을 읽지 못했습니다");
    }
  },

  createTemplate: async () => {
    const { tplNew, settings } = get();
    if (!tplNew?.name.trim()) return;
    if (tplNew.mode === "folder" && !tplNew.src) return;
    try {
      if (tplNew.mode === "folder") {
        await api.createTemplateFromFolder(
          settings.vault,
          tplNew.name.trim(),
          tplNew.desc,
          tplNew.src,
        );
      } else {
        await api.createTemplate(
          settings.vault,
          tplNew.name.trim(),
          tplNew.desc,
          tplNew.sections,
        );
      }
      set({ tplNew: null });
      // 등록된 템플릿은 목록에 곧바로 나타난다.
      await get().reloadTemplates();
    } catch (e) {
      get().toast(
        api.errKind(e) === "already_exists" ? "이미 있는 템플릿입니다" : "등록하지 못했습니다",
        api.errMessage(e),
        TOAST.warn,
      );
    }
  },

  syncMoc: async () => {
    const { settings } = get();
    if (!settings.archMoc) return;
    try {
      await api.writeArchiveMoc(settings.vault, settings.archDays);
    } catch {
      /* the MOC is a convenience index; failing to refresh it is not fatal */
    }
  },
}));

/** Debounced recommendation trigger used by the new-task title field. */
/**
 * 입력이 멎으면 추천을 돌린다. `ntLoading` 은 호출부가 세우고
 * `runRecommend` 의 모든 종료 경로가 내린다 — AI 경로는 자식 프로세스나 원격 스트림을
 * 타므로 몇 초가 걸리고, 그 사이 패널에 스피너가 돌아야 한다.
 */
export function scheduleRecommend(): void {
  window.clearTimeout(recTimer);
  recTimer = window.setTimeout(() => void useStore.getState().runRecommend(), 650);
}
