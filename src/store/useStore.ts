import { create } from "zustand";
import * as api from "../lib/api";
import type { TaskMeta, TemplateMeta, Recommendation } from "../lib/api";
import type { FileEntry } from "../lib/tree";
import { TOAST } from "../lib/design";
import { daysSince, hhmm, joinPath } from "../lib/format";
import { aiRecommend } from "../lib/aiRecommend";
import { activeRun, useAi } from "./aiStore";

export type Screen = "workspace" | "templates" | "archive" | "settings";
export type TabMode = "md" | "text";

export interface Tab {
  path: string;
  mode: TabMode;
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

  newOpen: boolean;
  nt: NewTaskState;
  ntRecs: Recommendation[];
  ntLoading: boolean;
  ntEngine: string;
  ntNote: string;
  recTag: Record<string, string>;
  expanded: Record<string, boolean>;
  merge: MergeState | null;
  tplNew: { name: string; desc: string; sections: string; fromTask: boolean } | null;
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

  selectTask: (folder: string, quiet?: boolean) => Promise<void>;
  setStatus: (status: string) => Promise<void>;
  archiveNow: (folder: string) => Promise<void>;
  restoreTask: (folder: string) => Promise<void>;
  peekArchived: (folder: string) => Promise<void>;
  openTaskInObsidian: (folder: string) => Promise<void>;

  setScreen: (s: Screen) => void;
  setUi: (patch: Partial<TaskUi>) => void;
  set: <K extends keyof State>(patch: Pick<State, K> | Partial<State>) => void;

  refreshFiles: () => Promise<void>;
  openFile: (path: string, mode: TabMode, quiet?: boolean) => Promise<void>;
  defaultOpen: (path: string, bin: boolean) => Promise<void>;
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

  newOpen: false,
  nt: { title: "", summary: "", tags: "", template: "(없음)" },
  ntRecs: [],
  ntLoading: false,
  ntEngine: "local",
  ntNote: "",
  recTag: {},
  expanded: {},
  merge: null,
  tplNew: null,
  openTpl: {},

  set: (patch) => set(patch as Partial<State>),

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
      if (next) await get().selectTask(next, true);
      else set({ activeFolder: "", files: [], ui: emptyUi() });
    } catch (e) {
      get().fail(e, "Vault를 읽지 못했습니다");
    }
  },

  // -------------------------------------------------------------------------

  selectTask: async (folder, quiet = false) => {
    const { activeFolder, settings, tasks } = get();
    if (folder === activeFolder) return;

    const prev = tasks.find((t) => t.folder === activeFolder);
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
      screen: "workspace",
      snapAt: hhmm(),
    });
    await get().refreshFiles();

    // Nothing restored? Fall back to the task's own note.
    const cur = get().ui;
    if (!cur.openTabs.length) {
      const hasIndex = get().files.some((f) => f.p === "index.md");
      if (hasIndex) await get().openFile("index.md", "text", true);
      else if (get().files.length) set({ ui: { ...get().ui, sel: get().files[0].p } });
    } else {
      // Re-read any file whose buffer was not carried in the snapshot.
      for (const tab of cur.openTabs) {
        if (!get().ui.docs[tab.path]) await get().openFile(tab.path, tab.mode, true);
      }
      set({ ui: { ...get().ui, activeTab: cur.activeTab || get().ui.activeTab } });
    }

    const next = get().tasks.find((t) => t.folder === folder);
    if (!quiet && settings.autoSnap && prev && next) {
      get().toast(
        "컨텍스트 스냅샷 저장 · 복원",
        `"${prev.title}" → "${next.title}" · 열린 파일/탭 그대로 복원`,
        TOAST.info,
      );
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
      if (status === "on-hold")
        get().toast("보류 처리 · 스냅샷 기록", "탭 위치 / 스크롤 / 미저장 텍스트 보존됨", TOAST.warn);
      else if (status === "completed")
        get().toast("완료 처리", "Run Log가 템플릿 이력에 누적됩니다", TOAST.ok);
      else if (status === "reopened")
        get().toast("업무 재개", "새 노드를 만들지 않고 기존 노드에서 이어서 진행", TOAST.violet);
      else get().toast("진행 중으로 전환", "", TOAST.info);
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
      get().toast(
        "보관함으로 이동",
        `${target?.title ?? ""} · ${
          settings.archMode === "move"
            ? "Archive 폴더로 이동됨"
            : "파일은 그대로, frontmatter에 archived 표시"
        }`,
        TOAST.muted,
      );
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
      await get().selectTask(updated.folder, true);
      get().toast(
        "보관함에서 재개",
        "새 노드를 만들지 않고 기존 노드에 회차를 추가했습니다",
        TOAST.violet,
      );
      await get().reloadTemplates();
      await get().syncMoc();
    } catch (e) {
      get().fail(e, "재개하지 못했습니다");
    }
  },

  peekArchived: async (folder) => {
    await get().selectTask(folder, true);
    get().toast(
      "보관된 업무를 열었습니다",
      "읽기 참조용 · 이어서 작업하려면 [재개]를 누르세요",
      TOAST.muted,
    );
  },

  openTaskInObsidian: async (folder) => {
    const { settings } = get();
    try {
      const res = await api.openInObsidian(settings.vault, joinPath(folder, "index.md"));
      if (res.opened === "obsidian")
        get().toast("Obsidian에서 열었습니다", res.detail, TOAST.violet);
      else get().toast("탐색기에서 열었습니다", res.detail, TOAST.muted);
    } catch (e) {
      get().fail(e, "Obsidian에서 열지 못했습니다");
    }
  },

  setScreen: (s) => set({ screen: s, ctx: null, statusMenuOpen: false }),

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

  openFile: async (path, mode, quiet = false) => {
    const { activeFolder, ui, tasks } = get();
    if (!activeFolder) return;
    const key = `${mode}|${path}`;
    try {
      let docs = ui.docs;
      if (!docs[path]) {
        const text = await api.readTextFile(joinPath(activeFolder, path));
        docs = { ...docs, [path]: { text, saved: text } };
      }
      const exists = ui.openTabs.some((t) => `${t.mode}|${t.path}` === key);
      get().setUi({
        docs,
        openTabs: exists ? ui.openTabs : [...ui.openTabs, { path, mode }],
        activeTab: key,
        sel: path,
      });
      set({ ctx: null });
      if (!quiet) {
        const task = tasks.find((t) => t.folder === activeFolder);
        get().toast(
          mode === "md" ? "마크다운 뷰어로 열기" : "텍스트 에디터로 열기",
          `${task?.relFolder ?? ""}${path}`,
          mode === "md" ? TOAST.violet : TOAST.info,
        );
      }
    } catch (e) {
      get().fail(e, "파일을 열지 못했습니다");
    }
  },

  defaultOpen: async (path, bin) => {
    if (bin) return get().openWith(path);
    const { settings } = get();
    if (path.toLowerCase().endsWith(".md"))
      return get().openFile(path, settings.mdDefault === "text" ? "text" : "md");
    return get().openFile(path, "text");
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
    const task = get().tasks.find((t) => t.folder === activeFolder);
    try {
      if (mk.kind === "folder") {
        const rel = await api.createTaskDir(activeFolder, mk.parent + name);
        set({ mk: null });
        await get().refreshFiles();
        get().setUi({ treeOpen: { ...get().ui.treeOpen, [rel]: true } });
        get().toast("폴더를 만들었습니다", `${task?.relFolder ?? ""}${rel}`, TOAST.ok);
      } else {
        const rel = await api.createTaskFile(activeFolder, mk.parent + name);
        set({ mk: null });
        await get().refreshFiles();
        get().toast("파일을 만들었습니다", `${task?.relFolder ?? ""}${rel}`, TOAST.ok);
        await get().openFile(rel, "text", true);
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
    const task = get().tasks.find((t) => t.folder === activeFolder);
    try {
      const res = await api.importIntoTask(activeFolder, drop.target, drop.paths, drop.mode);
      set({ drop: null });
      await get().refreshFiles();
      if (res.added.length) get().setUi({ sel: res.added[0] });
      get().toast(
        drop.mode === "copy"
          ? `${res.added.length}개 파일을 복사했습니다`
          : `${res.added.length}개 항목을 링크로 연결했습니다`,
        `${task?.relFolder ?? ""}${drop.target} · ${
          drop.mode === "copy" ? "Vault 내부 사본" : "원본 위치 참조"
        }`,
        TOAST.ok,
      );
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
        await api.openPathDefault(abs);
        get().toast("연결 프로그램으로 열었습니다", ow.path, TOAST.ok);
      }
      get().setUi({ extOpened: { ...get().ui.extOpened, [ow.path]: "OS" } });
    } catch (e) {
      get().fail(e, "열지 못했습니다");
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
    const { nt, settings } = get();
    const title = nt.title.trim();
    if (!title) return;
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
      set({ newOpen: false, ntRecs: [], recTag: {} });
      await get().reloadVault(false);
      await get().selectTask(created.folder, true);
      await get().reloadTemplates();
      get().toast("업무 폴더 생성됨", `${created.relFolder}index.md`, TOAST.ok);
    } catch (e) {
      get().fail(e, "업무를 만들지 못했습니다");
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
    try {
      const path = await api.createTemplate(
        settings.vault,
        tplNew.name.trim(),
        tplNew.desc,
        tplNew.sections,
      );
      set({ tplNew: null });
      await get().reloadTemplates();
      get().toast("표준 패턴을 등록했습니다", path, TOAST.ok);
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
