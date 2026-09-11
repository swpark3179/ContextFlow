import { create } from "zustand";
import * as api from "../lib/api";
import type { TaskMeta, TemplateMeta, Recommendation } from "../lib/api";
import type { FileEntry } from "../lib/tree";
import { normalizeStatus, TOAST } from "../lib/design";
import { basename, daysSince, hhmm, joinPath, nowStamp, today } from "../lib/format";
import { splitFrontmatter, toggleTaskLine } from "../lib/markdown";
import {
  composeDiscardBody,
  EMPTY_LOG,
  forgetLegacyLog,
  readLegacyLog,
  relocateEntries,
  removeEntry,
  rollDay,
  upsertEntry,
  type DayLog,
} from "../lib/daylog";
import { BSTORM_EXT, seedBstorm } from "../lib/bstorm";
import { reorderedList } from "../lib/reorder";
import { keepTabs, tabKey } from "../lib/tabs";
import { sanitizeFolderName } from "../lib/vaultPaths";
import { aiRecommend } from "../lib/aiRecommend";
import { activeRun, useAi } from "./aiStore";

/** Mirrors `SNAPSHOT_FILE` in src-tauri/src/vault.rs. */
const SNAPSHOT_FILE = ".context_snapshot.json";

export type Screen = "workspace" | "templates" | "archive" | "settings";
/** `text` = 편집기, 나머지는 읽기 전용 뷰어. 같은 파일은 한 번에 한 모드로만 열린다. */
export type TabMode = "md" | "text" | "html" | "bstorm";

export interface Tab {
  path: string;
  mode: TabMode;
}

/** 확장자별로 준비된 뷰어. 없으면 텍스트 편집기만 쓸 수 있다. */
export function viewerFor(path: string): Exclude<TabMode, "text"> | null {
  // `.bs.md` 는 `.md` 로도 끝난다 — 마크다운 검사보다 **먼저** 봐야 캔버스가 잡힌다.
  if (path.toLowerCase().endsWith(BSTORM_EXT)) return "bstorm";
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
  /**
   * 브레인스토밍 캔버스의 보기 상태. 경로로 키잉하는 것은 `docs` · `treeOpen` 과 같다.
   * 문서가 아니라 **보기**라서 `.bs.md` 가 아니라 스냅샷에 실린다 — 줌과 접힘은
   * 파일을 열어 본 사람마다 다르고, 잃어도 문서가 상하지 않는다.
   */
  bsView: Record<string, BsView>;
}

export type BsViewKind = "canvas" | "outline" | "decision";

export interface BsView {
  /** 캔버스는 생각을 뻗는 곳, 개요와 결정 로그는 쌓인 것을 읽는 곳이다. */
  view: BsViewKind;
  zoom: number;
  panX: number;
  panY: number;
  /** 고른 노드의 트리 경로(`"0.1.2"`). 빈 문자열이면 아무것도 고르지 않았다. */
  sel: string;
  collapsed: Record<string, boolean>;
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
  kind: "file" | "folder" | "bstorm";
  parent: string;
  name: string;
}

/** 트리 안에서 이름을 고치는 중인 항목. 한 번에 하나만 고칠 수 있다. */
export interface FileRenameState {
  /** 대상의 업무 폴더 기준 상대 경로 — 폴더는 `/` 로 끝난다. */
  path: string;
  /** 입력 중인 새 이름. 처음에는 지금 이름 그대로 채워 둔다. */
  name: string;
  isDir: boolean;
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

/** 탭 우클릭 메뉴. `key` 는 그 탭의 식별자(`lib/tabs.ts` 의 `tabKey`)다. */
export interface TabCtx {
  key: string;
  x: number;
  y: number;
}

/**
 * 업무 편입 대화상자 — `source` 업무의 폴더 전체를 `target` 업무 안으로 옮긴다.
 *
 * `error` 를 상태로 드는 이유는 실패가 이 기능의 **일상적인 결과**이기 때문이다. 파일이
 * 다른 프로그램에 열려 있으면 옮기기가 막히는데, 토스트는 2.8초 뒤 사라지므로 무엇을
 * 닫아야 하는지 읽을 시간이 모자란다. 모달을 열어 둔 채 사유를 붙여 두면 파일을 닫고
 * 그 자리에서 다시 누를 수 있다.
 */
export interface AbsorbState {
  /** 편입되는 업무의 폴더 경로 — 업무 리스트에서 사라지는 쪽이다. */
  source: string;
  /** 받는 업무의 폴더 경로. 빈 문자열이면 아직 고르지 않았다. */
  target: string;
  /** 받는 업무 안에서 쓸 폴더 이름. 기본은 원본 폴더 이름 그대로다. */
  name: string;
  /** 받는 업무를 찾는 검색어. */
  query: string;
  busy: boolean;
  error: string;
}

/** 업무 분할 대화상자. 고른 최상위 항목이 새 업무로 **옮겨** 간다(복사가 아니다). */
export interface SplitState {
  /** 분할할 업무의 폴더 경로. 항목 목록은 `files`(열려 있는 업무의 트리)에서 읽는다. */
  source: string;
  /** 고른 최상위 항목 — 키는 `files` 의 상대 경로이고 폴더는 `/` 로 끝난다. */
  sel: Record<string, boolean>;
  title: string;
  summary: string;
  tags: string;
  busy: boolean;
  error: string;
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
    bsView: {},
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
  todayMin: boolean;
  statusMenuOpen: boolean;

  /**
   * **오늘** 손댄 업무들. 저장소는 Vault 밖 SQLite 이고(`src-tauri/src/daylog.rs`), 이것은
   * 그중 오늘 하루를 화면에 들고 있는 투영이다(`src/lib/daylog.ts`). 어제와 그제를 보는
   * 곳은 도크가 아니라 팝업이다.
   *
   * 이름을 `today` 로 하지 않는 이유는 `format.ts` 의 `today()` 함수와 부딪히기 때문이다 —
   * `const { today } = s;` 가 그 함수를 가려 버린다.
   */
  dayLog: DayLog;

  /** 오늘의 한일 팝업이 보고 있는 날짜 `YYYY-MM-DD`. `null` = 닫힘. */
  dayLogOpen: string | null;

  files: FileEntry[];
  ui: TaskUi;
  uiCache: Record<string, TaskUi>;
  snapAt: string;
  caret: { ln: number; col: number };

  toasts: Toast[];
  ctx: CtxTarget | null;
  mk: MkState | null;
  fileRen: FileRenameState | null;
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
  tabCtx: TabCtx | null;
  absorb: AbsorbState | null;
  split: SplitState | null;
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
  /** `close` 를 생략하면 지금 열려 있는 업무일 때만 창을 닫는다. */
  archiveNow: (folder: string, opts?: { close?: boolean }) => Promise<void>;
  restoreTask: (folder: string) => Promise<void>;
  peekArchived: (folder: string) => Promise<void>;
  closeArchived: () => void;
  closeTask: () => void;
  openTaskInObsidian: (folder: string) => Promise<void>;
  /**
   * `at` 은 **화면에 보이던 목록** 기준의 삽입 인덱스이고, `scope` 는 그 목록의 폴더
   * 경로들이다. 상태 필터가 걸려 있으면 보이는 것이 전체의 부분집합이라 둘이 함께
   * 와야 자리를 옳게 읽을 수 있다. 생략하면 살아 있는 업무 전체가 곧 그 목록이다.
   */
  reorderTask: (folder: string, at: number, scope?: string[]) => Promise<void>;
  clearTaskOrder: () => Promise<void>;

  setScreen: (s: Screen) => void;
  setUi: (patch: Partial<TaskUi>) => void;
  set: <K extends keyof State>(patch: Pick<State, K> | Partial<State>) => void;

  refreshFiles: () => Promise<void>;
  openFile: (path: string, mode: TabMode) => Promise<void>;
  defaultOpen: (path: string, bin: boolean) => Promise<void>;
  setTabMode: (path: string, from: TabMode, to: TabMode) => Promise<void>;
  closeTab: (key: string) => void;
  /** 열려 있는 탭을 전부 닫는다. 미저장 버퍼는 먼저 내려쓴다. */
  closeAllTabs: () => Promise<void>;
  /** `key` 탭 하나만 남기고 닫는다. */
  closeOtherTabs: (key: string) => Promise<void>;
  editDoc: (path: string, text: string) => void;
  /** 마크다운 뷰어에서 체크박스를 눌렀다. `line` 은 **문서** 기준 줄 번호다. */
  toggleTask: (path: string, line: number) => Promise<void>;
  saveDoc: (path: string) => Promise<void>;
  saveAll: () => Promise<void>;
  persistSnapshot: (folder?: string) => Promise<void>;

  commitMk: () => Promise<void>;
  commitFileRename: () => Promise<void>;
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

  /** 이 업무를 다른 업무에 편입하는 대화상자를 연다. */
  openAbsorb: (folder: string) => Promise<void>;
  /** 편입 실행 — 업무 폴더 전체를 받는 업무 아래로 옮긴다. */
  doAbsorb: () => Promise<void>;
  /** 이 업무를 둘로 나누는 대화상자를 연다. */
  openSplit: (folder: string) => Promise<void>;
  /** 분할 실행 — 고른 최상위 항목을 새 업무로 옮긴다. */
  doSplit: () => Promise<void>;

  reloadTemplates: () => Promise<void>;
  createTemplate: () => Promise<void>;
  syncMoc: () => Promise<void>;

  /** 오늘의 한일에 이 업무를 올린다(같은 업무는 한 줄, 시각만 갱신). */
  noteToday: (folder?: string, title?: string) => void;
  /** 기록 한 줄을 지운다. 도크의 ✕ 와 팝업이 함께 쓴다. */
  dropEntry: (id: number) => void;
  /** 오늘 목록에서 이 업무의 줄을 지운다. 병합으로 접힌 업무에 쓴다. */
  dropToday: (folder: string) => void;
  /** 업무 폴더 경로가 바뀐 것을 오늘의 한일에도 반영한다(과거 날짜까지). */
  relocateToday: (from: string, to: string, title: string) => Promise<void>;
  /** 날이 바뀌었으면 화면 목록을 새 날짜로 맞춘다. 자정에 걸어 둔 타이머가 부른다. */
  rollToday: () => Promise<void>;
  /** 지금 Vault 기준으로 오늘 목록을 다시 읽는다. Vault 를 갈아탈 때 부른다. */
  rescopeToday: () => Promise<void>;
  /** 그 날짜의 기록을 읽어 팝업을 연다. 생략하면 오늘. */
  openDayLog: (day?: string) => Promise<void>;
  /**
   * 파일을 안 붙인 업무를 접는다 — 제목과 글을 오늘의 한일에 남기고 폴더를 지운다.
   * `setStatus` 의 완료 분기가 부른다.
   */
  logAndDiscard: (folder: string, memo: string) => Promise<void>;
}

/**
 * 파일이 디스크에서 옮겨지거나 이름이 바뀐 뒤, 그 파일을 가리키던 화면 상태를 새 경로로
 * 갈아 끼운다.
 *
 * 열린 탭 · 미저장 버퍼 · 트리 펼침 · 캔버스 보기 상태는 전부 **업무 폴더 기준 상대
 * 경로를 키로** 들고 있다. 디스크만 건드리면 그 키들이 한꺼번에 없는 파일을 가리키게
 * 되어, 탭 이름은 옛 이름 그대로 남고 미저장 버퍼는 갈 곳을 잃는다.
 *
 * `isDir` 이면 그 아래 모든 경로의 접두사까지 함께 옮긴다 — 폴더 하나를 바꾸면 그 안의
 * 탭이 전부 따라와야 한다.
 */
function relocateUi(ui: TaskUi, from: string, to: string, isDir: boolean): Partial<TaskUi> {
  const rewrite = (p: string) =>
    p === from ? to : isDir && p.startsWith(from) ? to + p.slice(from.length) : p;
  const remap = <T,>(m: Record<string, T>) =>
    Object.fromEntries(Object.entries(m).map(([p, v]) => [rewrite(p), v]));
  const [mode, path] = ui.activeTab.split("|");
  return {
    openTabs: ui.openTabs.map((t) => ({ ...t, path: rewrite(t.path) })),
    activeTab: path ? `${mode}|${rewrite(path)}` : ui.activeTab,
    sel: rewrite(ui.sel),
    docs: remap(ui.docs),
    treeOpen: remap(ui.treeOpen),
    extOpened: remap(ui.extOpened),
    bsView: remap(ui.bsView),
  };
}

/**
 * 파일이 이 업무에서 **없어진** 뒤(삭제 · 분할로 옮겨감), 그것을 가리키던 화면 상태를
 * 걷어낸다. `relocateUi` 의 짝이다 — 저쪽은 새 경로로 옮기고 이쪽은 지운다.
 *
 * `gone(p)` 은 그 상대 경로가 사라졌는지 답한다. 폴더째로 사라진 경우는 부르는 쪽이
 * 접두사로 판정한다 — 여기서 `/` 규약을 한 번 더 해석하면 두 곳이 서로 다른 규칙을
 * 갖게 된다.
 */
function pruneUi(ui: TaskUi, gone: (path: string) => boolean): Partial<TaskUi> {
  const left = <T,>(m: Record<string, T>) =>
    Object.fromEntries(Object.entries(m).filter(([p]) => !gone(p)));
  return {
    ...keepTabs(ui.openTabs, ui.activeTab, (t) => !gone(t.path)),
    sel: gone(ui.sel) ? "" : ui.sel,
    docs: left(ui.docs),
    treeOpen: left(ui.treeOpen),
    extOpened: left(ui.extOpened),
    bsView: left(ui.bsView),
  };
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
  todayMin: false,
  statusMenuOpen: false,

  dayLog: EMPTY_LOG,
  dayLogOpen: null,

  files: [],
  ui: emptyUi(),
  uiCache: {},
  snapAt: hhmm(),
  caret: { ln: 1, col: 1 },

  toasts: [],
  ctx: null,
  mk: null,
  fileRen: null,
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
  tabCtx: null,
  absorb: null,
  split: null,
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
      await migrateLegacyDayLog(settings.vault);
      await get().rescopeToday();
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
      set({ activeFolder: "", uiCache: {}, ui: emptyUi(), files: [], dayLogOpen: null });
      // 기록은 지우지 않는다 — 행마다 Vault 를 들고 있어 새 Vault 의 오늘만 다시 읽으면 된다.
      await get().rescopeToday();
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
      // 아무 업무도 고르지 않은 것도 하나의 상태다 — 완료로 창을 닫은 직후가 그렇고,
      // 그때 목록을 새로 읽는다고 엉뚱한 업무가 열려서는 안 된다.
      const stillThere = tasks.some((t) => t.folder === activeFolder);
      if (keepActive && (stillThere || !activeFolder)) return;
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
          if (snap) ui = { ...ui, ...snap, docs: snap.docs ?? {}, bsView: snap.bsView ?? {} };
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
      fileRen: null,
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
      await get().relocateToday(folder, updated.folder, updated.title);
      get().noteToday(updated.folder, updated.title);
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

  /**
   * 상태를 바꾼다. **완료는 거기서 끝나지 않는다** — 그 자리에서 보관까지 가고 창이 닫힌다.
   *
   * 예전에는 완료로 바꾼 업무가 배지만 초록으로 바뀐 채 목록 맨 위에 남아 있었다.
   * 끝낸 일을 다시 지우는 손이 한 번 더 필요했고, 보관 기준일(`archDays`)이 지나야
   * 조용히 사라졌다 — 그 사이의 목록은 "지금 하는 일"이 아니라 "한 일이 섞인 목록"이다.
   * 완료를 누른 순간이 곧 그 업무를 손에서 놓는 순간이므로, 목록에서 빼고 창도 닫는다.
   * 다시 손대야 할 일이 남았다면 보관함의 [여기서 재개] 가 그대로 있다.
   *
   * **예외는 파일을 하나도 붙이지 않은 업무다** — 그런 업무는 보관하지 않고 오늘의 한일
   * 한 줄로 접는다(`logAndDiscard`).
   */
  setStatus: async (status) => {
    const { settings, activeFolder } = get();
    if (!activeFolder) return;
    try {
      await get().saveAll();

      // 가벼운 업무 판정은 `setTaskStatus` **앞**에 온다 — 곧 지울 폴더의 `index.md` 에
      // `completed_at` 을 써 넣을 이유가 없다.
      if (normalizeStatus(status) === "completed") {
        // 메모는 `closeTask()` 가 `ui` 를 비우기 전에, 지금 읽어야 한다.
        const memo = get().ui.notepad.trim();
        // `list_task_files` 는 점 파일을 건너뛴다(`.context_snapshot.json` 은 세지 않는다)
        // — 그래서 파일을 안 붙인 업무는 정확히 `index.md` 한 줄이다. 목록을 못 읽었으면
        // 판정을 포기하고 기존 경로로 간다: 되돌릴 수 있는 쪽(보관)이 안전하다.
        const files = await api.listTaskFiles(activeFolder).catch(() => null);
        const pristine = !!files && files.length === 1 && files[0].p === "index.md";
        // 메모까지 조건에 넣는 이유는 남길 글이 있어야 지우는 것이 무손실이기 때문이다.
        // 아무것도 쓰지 않은 빈 업무는 예전처럼 보관해 둔다.
        if (pristine && memo) {
          await get().logAndDiscard(activeFolder, memo);
          return;
        }
      }

      const updated = await api.setTaskStatus(settings.vault, activeFolder, status);
      set((s) => ({
        tasks: s.tasks.map((t) => (t.folder === activeFolder ? updated : t)),
        statusMenuOpen: false,
        snapAt: hhmm(),
      }));
      get().noteToday(activeFolder, updated.title);
      await get().persistSnapshot(activeFolder);
      if (normalizeStatus(status) === "completed") {
        await get().archiveNow(activeFolder, { close: true });
        return;
      }
      // 바뀐 상태는 헤더의 상태 배지에 즉시 나타난다.
      await get().reloadTemplates();
      await get().syncMoc();
    } catch (e) {
      get().fail(e, "상태를 바꾸지 못했습니다");
    }
  },

  archiveNow: async (folder, opts) => {
    const { settings, tasks, activeFolder } = get();
    // 고른 업무가 없을 때 메뉴에서 들어오면 빈 경로가 온다 — 백엔드에 물어볼 것이 없다.
    if (!folder) return;
    const target = tasks.find((t) => t.folder === folder);
    // 보관된 업무는 업무 리스트에 없다. 그 창을 열어 둔 채로 두면 목록에서 아무것도
    // 선택되지 않은 화면에 남의 작업공간이 떠 있는 셈이라, 지금 열려 있던 업무를
    // 보관했으면 창까지 닫는다.
    const close = opts?.close ?? folder === activeFolder;
    try {
      if (folder === activeFolder) {
        // 'move' 방식은 디스크에서 폴더를 옮긴다 — 미저장 버퍼와 스냅샷은 그 전에
        // 내려놓아야 옛 경로에 쓰이지 않는다.
        await get().saveAll();
        await get().persistSnapshot(folder);
      }
      const updated = await api.setTaskArchived(
        settings.vault,
        folder,
        true,
        settings.archMode,
        false,
      );
      // 'move' 는 폴더 경로를 바꾼다 — 오늘의 한일과 열어 둔 탭 캐시도 함께 옮긴다.
      await get().relocateToday(folder, updated.folder, updated.title);
      get().noteToday(updated.folder, updated.title);
      set((s) => {
        const { [folder]: moved, ...rest } = s.uiCache;
        return {
          tasks: s.tasks.map((t) => (t.folder === folder ? updated : t)),
          uiCache: moved && updated.folder !== folder ? { ...rest, [updated.folder]: moved } : s.uiCache,
          statusMenuOpen: false,
        };
      });
      // 'move' 는 디스크에서 폴더를 실제로 옮긴다 — 어디로 갔는지는 화면에 나오지 않는다.
      if (settings.archMode === "move") {
        get().toast("Archive 폴더로 이동", target?.title ?? "", TOAST.muted);
      } else if (close) {
        // 창이 닫히는 것은 보이지만, 그 업무가 어디로 갔는지는 화면에 남지 않는다.
        get().toast(
          "보관함으로 옮겼습니다",
          `${target?.title ?? ""} · 보관함에서 다시 열 수 있습니다`,
          TOAST.muted,
        );
      }
      if (close) get().closeTask();
      // 목록만 새로 읽는다. 창을 닫았을 때 `reloadVault(false)` 를 쓰면 살아 있는 업무
      // 하나를 자동으로 골라 열어 버려, 방금 닫은 자리에 엉뚱한 업무가 나타난다.
      await get().reloadVault(close);
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
      await get().relocateToday(folder, updated.folder, updated.title);
      get().noteToday(updated.folder, updated.title);
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

  /**
   * 지금 열려 있는 업무 창을 닫는다 — 아무 업무도 고르지 않은 상태로 되돌린다.
   *
   * `uiCache` 는 비우지 않는다. 열어 둔 탭 · 미저장 버퍼가 그대로 남아 있어야
   * 보관함에서 그 업무를 다시 열었을 때 있던 자리에서 이어진다.
   */
  closeTask: () =>
    set({
      activeFolder: "",
      ui: emptyUi(),
      files: [],
      archOpen: "",
      ctx: null,
      mk: null,
      statusMenuOpen: false,
    }),

  openTaskInObsidian: async (folder) => {
    const { settings } = get();
    if (!folder) return;
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
    get().setUi(keepTabs(ui.openTabs, ui.activeTab, (t) => tabKey(t) !== key));
    set({ tabCtx: null });
  },

  /**
   * 여러 탭을 한꺼번에 닫는다(탭 우클릭 메뉴).
   *
   * **먼저 내려쓴다.** 탭을 닫아도 버퍼는 `docs` 에 남아 있어 글이 사라지지는 않지만,
   * 닫힌 뒤에는 어느 탭이 미저장이었는지 화면에 표시할 자리가 없다. 한 번에 여러 개를
   * 닫는 길에서는 그 표시를 잃는 쪽이 위험해서, 자동 저장이 하던 일을 여기서 앞당긴다.
   */
  closeAllTabs: async () => {
    await get().saveAll();
    const ui = get().ui;
    get().setUi(keepTabs(ui.openTabs, ui.activeTab, () => false));
    set({ tabCtx: null });
  },

  closeOtherTabs: async (key) => {
    await get().saveAll();
    const ui = get().ui;
    get().setUi(keepTabs(ui.openTabs, ui.activeTab, (t) => tabKey(t) === key));
    set({ tabCtx: null });
  },

  editDoc: (path, text) => {
    const ui = get().ui;
    const prev = ui.docs[path] ?? { text: "", saved: "" };
    get().setUi({ docs: { ...ui.docs, [path]: { ...prev, text } } });
    // Debounced write-through; Ctrl+S and task switches flush immediately.
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().saveDoc(path), 900);
  },

  /**
   * 마크다운 뷰어에서 체크박스를 눌렀다. 문서의 그 줄 하나만 고쳐 쓴다.
   *
   * 900ms 자동 저장을 기다리지 않고 곧바로 내려쓴다 — 글자를 치는 것과 달리 체크는
   * **한 번의 완결된 동작**이고, 눌러 놓고 창을 닫았을 때 사라지면 안 된다.
   */
  toggleTask: async (path, line) => {
    const doc = get().ui.docs[path];
    if (!doc) return;
    const next = toggleTaskLine(doc.text, line);
    if (next === null || next === doc.text) return;
    get().editDoc(path, next);
    await get().saveDoc(path);
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
      // 파일이 실제로 쓰였다 — 오늘의 한일에서 가장 흔한 입구다.
      get().noteToday(activeFolder);
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
    if (!activeFolder) return set({ mk: null });
    const name = mk.name.trim();
    if (!name) return set({ mk: null });
    try {
      // 만들어진 파일·폴더는 트리에 곧바로 나타난다 — 성공은 알리지 않는다.
      if (mk.kind === "folder") {
        const rel = await api.createTaskDir(activeFolder, mk.parent + name);
        set({ mk: null });
        get().noteToday(activeFolder);
        await get().refreshFiles();
        get().setUi({ treeOpen: { ...get().ui.treeOpen, [rel]: true } });
      } else if (mk.kind === "bstorm") {
        const stripped = name.toLowerCase().endsWith(BSTORM_EXT)
          ? name.slice(0, -BSTORM_EXT.length)
          : name;
        // 이름이 확장자뿐이면 점으로 시작하는 파일이 된다. `list_tree` 는 점 파일을 건너뛰므로
        // 만들어져도 트리에 영영 나타나지 않는다 — 그 이름은 받지 않는다.
        if (!stripped.trim()) return set({ mk: null });
        const base = stripped.trim();
        const rel = await api.createTaskFile(activeFolder, mk.parent + base + BSTORM_EXT);
        // `create_file` 은 빈 파일을 만든다. 빈 캔버스 대신 중심 생각 하나를 심어 둔다.
        await api.writeTextFile(joinPath(activeFolder, rel), seedBstorm(base, nowStamp()));
        set({ mk: null });
        get().noteToday(activeFolder);
        await get().refreshFiles();
        await get().openFile(rel, "bstorm");
      } else {
        const rel = await api.createTaskFile(activeFolder, mk.parent + name);
        set({ mk: null });
        get().noteToday(activeFolder);
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

  /**
   * 탐색기에서 고른 파일·폴더의 이름을 바꾼다.
   *
   * 자리는 그대로이고 이름만 가는 것이라 백엔드 쪽은 단순하지만, 앱 안에서는 `moveFile`
   * 과 정확히 같은 일이 벌어진다 — 상대 경로가 달라지므로 그 경로를 키로 들고 있던
   * 열린 탭 · 미저장 버퍼 · 트리 펼침을 새 경로로 옮겨야 상단 탭 이름까지 함께 바뀐다.
   */
  commitFileRename: async () => {
    const { fileRen, activeFolder } = get();
    if (!fileRen) return;
    if (!activeFolder) return set({ fileRen: null });
    const name = fileRen.name.trim();
    const current = fileRen.path.replace(/\/$/, "").split("/").pop() ?? "";
    // 빈 이름이나 그대로인 이름은 취소와 같다 — 굳이 오류로 알릴 것이 없다.
    if (!name || name === current) return set({ fileRen: null });
    // 자동 저장은 900ms 뒤에 **경로를 잡아 둔 채** 도는데, 그 사이에 이름이 바뀌면
    // 없는 키를 찾아 아무것도 하지 않는다. 이름을 바꾸기 전에 먼저 내려쓴다.
    await get().saveAll();
    try {
      const next = await api.renameTaskPath(activeFolder, fileRen.path, name);
      set({ fileRen: null });
      get().noteToday(activeFolder);
      get().setUi(relocateUi(get().ui, fileRen.path, next, fileRen.isDir));
      // 바뀐 이름은 트리와 탭에 곧바로 나타난다 — 성공은 알리지 않는다.
      await get().refreshFiles();
    } catch (e) {
      set({ fileRen: null });
      get().toast(
        api.errKind(e) === "already_exists" ? "이미 있는 이름입니다" : "이름을 바꾸지 못했습니다",
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
      get().noteToday(activeFolder);
      const gone = (p: string) => (del.isDir ? p.startsWith(del.path) : p === del.path);
      get().setUi({ ...pruneUi(ui, gone), sel: "" });
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
      get().noteToday(activeFolder);
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
      // 밖에서 고친 것은 앱이 알 수 없다. 연결 프로그램으로 여는 것이 곧 그 파일을
      // 작업하는 것이라, 그 업무는 오늘 건드린 업무다.
      get().noteToday(activeFolder);
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
      get().noteToday(activeFolder);
      get().setUi(relocateUi(ui, rel, next, isDir));
      await get().refreshFiles();
    } catch (e) {
      get().fail(e, "옮기지 못했습니다");
    }
  },

  /**
   * 업무 리스트에서 `folder` 를 화면상 `at` 번째 자리로 옮긴다.
   *
   * 프런트는 원하는 최종 순서만 만들어 넘기고 `order` 값 계산은 Rust 가 한다. 상태
   * 필터가 걸렸을 때 보이던 목록의 자리를 전체 순서로 옮기는 규칙은 `lib/reorder.ts` 에
   * 있다 — 순수 함수라 거기서 따로 시험한다.
   */
  reorderTask: async (folder, at, scope) => {
    const { settings, tasks } = get();
    const live = tasks.filter((t) => !isArchived(t, settings.archDays)).map((t) => t.folder);
    // 끌고 있는 사이에 보관된 업무가 섞여 들어왔을 수 있다 — 살아 있는 것만 남긴다.
    const liveSet = new Set(live);
    const next = reorderedList(live, (scope ?? live).filter((f) => liveSet.has(f)), folder, at);
    if (!next) return;
    try {
      set({ tasks: await api.reorderTasks(settings.vault, next) });
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
      get().noteToday(activeFolder);
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
      get().noteToday(created.folder, created.title);

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
      // 접힌 노드들은 대표 노드 안으로 들어갔다. 오늘의 한일에서도 대표 하나로 합친다 —
      // 'move' 방식에서는 그 폴더들이 Archive 아래로 옮겨져 죽은 줄이 되고, 'tag'
      // 방식에서도 같은 일을 두 줄로 세는 셈이다.
      for (const c of picked) {
        if (c.id !== primary.id) get().dropToday(c.id);
      }
      get().noteToday(primary.id, primary.title);
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

  // -- 업무 편입 · 업무 분할 -------------------------------------------------
  //
  // 둘 다 디스크에서 **폴더를 옮긴다**(`vault::absorb_task` · `vault::split_task`).
  // 그래서 앱 쪽의 일도 같다: 옮기기 전에 미저장 버퍼를 내려쓰고, 옮긴 뒤에 그 경로를
  // 키로 들고 있던 화면 상태(열린 탭 · 버퍼 · 트리 펼침)를 정리한다. 이 순서가 뒤집히면
  // 900ms 뒤에 도는 자동 저장이 없는 경로에 쓰려 들거나, 탭이 사라진 파일을 가리킨다.

  openAbsorb: async (folder) => {
    if (!folder) return;
    // 편입되는 쪽을 먼저 연다. 옮기기 전에 그 업무의 버퍼를 내려쓰려면 그 업무가
    // 열려 있어야 하고(`saveAll` 은 활성 업무의 `docs` 만 본다), 사용자도 무엇이
    // 옮겨 가는지 보면서 대상을 고르게 된다. 이미 열려 있으면 부르지 않는다 —
    // `selectTask` 는 화면을 워크스페이스로 옮기므로, 보관함 상세에서 누른 사용자가
    // 대화상자를 열었다는 이유로 목록 밖으로 끌려 나가지 않게 한다.
    if (get().activeFolder !== folder) await get().selectTask(folder);
    set({
      statusMenuOpen: false,
      absorb: {
        source: folder,
        target: "",
        name: basename(folder),
        query: "",
        busy: false,
        error: "",
      },
      // 편입은 이 업무가 목록에서 사라지는 일이다 — 제목만 바꾸는 대화상자와 겹쳐 두지 않는다.
      ren: null,
    });
  },

  doAbsorb: async () => {
    const { absorb, settings } = get();
    if (!absorb || !absorb.target || absorb.busy) return;
    set({ absorb: { ...absorb, busy: true, error: "" } });
    try {
      // 옮기기 전에 내려쓴다 — 미저장 버퍼가 옛 경로를 잡고 있으면 갈 곳을 잃는다.
      await get().saveAll();
      await get().persistSnapshot(absorb.source);
      const res = await api.absorbTask(
        settings.vault,
        absorb.source,
        absorb.target,
        absorb.name.trim() || null,
      );
      // 편입된 업무의 화면 상태는 그 업무와 함께 사라진다. 폴더는 남지만 업무가 아니고,
      // 그 안의 파일은 받는 업무의 트리에서 제 경로로 다시 열린다.
      set((s) => {
        const { [absorb.source]: _absorbed, ...rest } = s.uiCache;
        return { uiCache: rest, absorb: null };
      });
      // 편입된 업무의 작업공간은 닫는다. 없는 업무의 화면을 열어 둔 채로 두면 그 위에서
      // 자동 저장(`saveAll`)이 옛 경로에 파일을 되살리고, 업무 리스트에 없는 업무의
      // 작업공간이 떠 있는 셈이 된다 — 보관·완료와 같은 이유다.
      if (get().activeFolder === absorb.source) get().closeTask();
      // 기록은 받는 업무로 옮긴다 — 그 일은 이제 이 업무의 일부다. 지난 날짜의 줄까지
      // 따라가므로 눌러서 열 수 있는 줄로 남는다(죽은 경로를 남기지 않는다).
      await get().relocateToday(absorb.source, res.task.folder, res.task.title);
      get().noteToday(res.task.folder, res.task.title);
      // `keepActive` 로 읽는다 — 창을 닫아 둔 상태에서 `false` 를 주면 살아 있는 업무
      // 하나를 자동으로 골라 열어, 받는 업무로 넘어가기 전에 엉뚱한 업무가 한 번 뜬다.
      await get().reloadVault(true);
      await get().selectTask(res.task.folder);
      // 어디로 들어갔는지 보여 주는 것이 곧 결과다 — 그 자리를 펼쳐 두고 고른다.
      get().setUi({ treeOpen: { ...get().ui.treeOpen, [res.rel]: true }, sel: res.rel });
      await get().reloadTemplates();
      await get().syncMoc();
      // 폴더가 디스크에서 실제로 움직였고 업무 하나가 목록에서 사라졌다 — 알린다.
      get().toast(
        "업무를 편입했습니다",
        `${res.title} → ${res.task.title}/${res.rel}`,
        TOAST.violet,
      );
    } catch (e) {
      // 실패는 이 기능의 일상적인 결과다(파일 락). 대화상자를 열어 둔 채 사유를 붙여
      // 두면 그 파일을 닫고 그 자리에서 다시 누를 수 있다.
      const error = api.errMessage(e);
      set((s) => ({ absorb: s.absorb ? { ...s.absorb, busy: false, error } : null }));
      get().fail(e, "편입하지 못했습니다");
    }
  },

  openSplit: async (folder) => {
    if (!folder) return;
    // 나눌 업무를 먼저 연다. 고를 항목은 그 업무의 파일 트리(`files`)에서 읽으므로
    // 열려 있지 않으면 목록을 만들 수 없다. 이미 열려 있으면 화면을 건드리지 않는다.
    if (get().activeFolder !== folder) await get().selectTask(folder);
    const task = get().tasks.find((t) => t.folder === folder);
    set({
      statusMenuOpen: false,
      split: {
        source: folder,
        sel: {},
        title: "",
        summary: "",
        // 갈라져 나온 업무도 같은 결의 일이다 — 태그는 채워 두고 지울 수 있게 한다.
        tags: (task?.tags ?? []).join(", "),
        busy: false,
        error: "",
      },
      ren: null,
    });
  },

  doSplit: async () => {
    const { split, settings } = get();
    if (!split || split.busy) return;
    const items = Object.entries(split.sel)
      .filter(([, on]) => on)
      .map(([p]) => p);
    const title = split.title.trim();
    if (!title || !items.length) return;
    set({ split: { ...split, busy: true, error: "" } });
    try {
      await get().saveAll();
      await get().persistSnapshot(split.source);
      const tags = split.tags
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const res = await api.splitTask(
        settings.vault,
        split.source,
        title,
        split.summary,
        tags,
        items,
      );
      // 옮겨 간 것을 가리키던 탭 · 버퍼 · 트리 상태를 원본에서 걷어낸다. 폴더는 접두사로
      // 판정한다 — 폴더 하나가 가면 그 안의 탭도 전부 따라간다.
      const gone = (p: string) =>
        res.moved.some((m) => (m.endsWith("/") ? p.startsWith(m) : p === m));
      if (get().activeFolder === split.source) get().setUi(pruneUi(get().ui, gone));
      set({ split: null });
      get().noteToday(split.source);
      get().noteToday(res.task.folder, res.task.title);
      await get().reloadVault(true);
      // 새 업무를 연다. 방금 나눈 결과를 보는 것이 다음 할 일이다.
      await get().selectTask(res.task.folder);
      await get().reloadTemplates();
      get().toast(
        "업무를 분할했습니다",
        `${res.moved.length}개 항목을 '${res.task.title}' 로 옮겼습니다`,
        TOAST.violet,
      );
    } catch (e) {
      const error = api.errMessage(e);
      set((s) => ({ split: s.split ? { ...s.split, busy: false, error } : null }));
      get().fail(e, "분할하지 못했습니다");
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

  // -------------------------------------------------------------------------

  /**
   * 오늘의 한일에 이 업무를 올린다.
   *
   * 부르는 자리는 **업무를 고친 지점들**이다 — 파일 저장 · 상태 변경 · 파일 만들기 ·
   * 지우기 · 옮기기 · 가져오기 · 내보내기 · 이름 변경 · 보관 · 재개 · 병합 · 메모.
   * 업무를 **열어 본 것**은 여기 들어오지 않는다: 그것까지 세면 잠깐 확인한 업무가
   * 전부 목록에 쌓여 "오늘 무엇을 했는지"가 아니라 "오늘 무엇을 봤는지"가 된다.
   *
   * **기다리지 않는다.** 부르는 자리가 18곳이고 그중에는 메모장에서 포커스가 떠나는
   * 순간도 있다 — 기록이 화면을 붙잡으면 안 된다. 그러면서 낙관적 갱신도 하지 않는다:
   * 화면에 끼울 줄의 `id` 는 DB 가 정하므로, 임시 id 를 만들어 나중에 맞춰 끼우는
   * 복잡함을 로컬 SQLite 한 번 왕복과 맞바꿀 이유가 없다.
   *
   * `body` 를 `null` 로 보내는 것이 중요하다 — 업무를 다시 손댔다는 이유로 팝업에서
   * 적어 둔 내용이 지워지면 안 된다.
   */
  noteToday: (folder, title) => {
    const target = folder ?? get().activeFolder;
    if (!target) return;
    const name =
      title ?? get().tasks.find((t) => t.folder === target)?.title ?? basename(target);
    const day = today();
    void api
      .noteDayEntry(get().settings.vault, day, hhmm(), target, name, null)
      .then((row) => set({ dayLog: upsertEntry(get().dayLog, day, row) }))
      .catch(() => {
        // 기록을 못 남긴 것으로 앱이 멈추지는 않는다. 토스트도 띄우지 않는다 —
        // 파일을 저장할 때마다 경고가 뜨는 앱이 되면 그것이 더 큰 고장이다.
      });
  },

  dropEntry: (id) => {
    set({ dayLog: removeEntry(get().dayLog, id) });
    void api.removeDayEntry(id).catch((e) => get().fail(e, "기록을 지우지 못했습니다"));
  },

  /**
   * 오늘 목록에서 이 업무의 줄을 지운다. 병합으로 접힌 업무에 쓴다(`doMerge`) — 접힌
   * 쪽을 같은 날 목록에 남겨 두면 한 일을 여러 줄로 세는 것이 된다.
   *
   * 지우는 것은 **오늘 줄 하나**다. 지난 날짜의 줄은 그날 실제로 손댄 기록이라 남긴다.
   */
  dropToday: (folder) => {
    const hit = get().dayLog.entries.find((e) => e.folder === folder);
    if (hit) get().dropEntry(hit.id);
  },

  /**
   * 업무의 폴더 경로가 바뀐 것을 기록에 반영한다(업무명 변경 · Archive 로 이동).
   *
   * **과거 날짜의 줄까지** 따라간다. 경로가 업무의 기본키라 이걸 안 하면 지난주의 그 줄은
   * 없는 업무를 가리키고, 팝업에서 눌러도 아무 일이 일어나지 않는다.
   *
   * 기다리는 이유는 부르는 자리마다 곧바로 `noteToday` 가 새 경로로 따라오기 때문이다 —
   * 순서가 뒤집히면 옮기기가 방금 올린 줄을 덮어쓴다.
   */
  relocateToday: async (from, to, title) => {
    set({ dayLog: relocateEntries(get().dayLog, from, to, title) });
    try {
      await api.relocateDayEntries(get().settings.vault, from, to, title);
    } catch {
      /* 화면은 이미 새 경로를 쓴다. 다음 부팅에서 DB 를 다시 읽으면 제자리로 돌아온다 */
    }
  },

  /**
   * 날이 바뀌면 화면 목록을 새 날짜로 맞춘다. 자정에 걸어 둔 타이머가 부른다
   * (`TodayDock`) — 그것이 없으면 밤을 넘긴 창에는 다시 그릴 일이 없어 어제 목록이
   * 그대로 남는다. 하루 종일 켜 두는 앱이라 드문 경우가 아니다.
   *
   * 옛 이름이 말하던 "비운다" 는 이제 화면에만 해당한다. 어제의 줄은 DB 에 그대로 있고
   * 팝업에서 볼 수 있다.
   */
  rollToday: async () => {
    const day = today();
    if (get().dayLog.day === day) return;
    set({ dayLog: rollDay(get().dayLog, day) });
    await get().rescopeToday();
  },

  /**
   * 지금 Vault 의 오늘 줄을 다시 읽는다. 부팅과 Vault 교체가 부른다.
   *
   * Vault 를 갈아탈 때 **아무것도 지우지 않는다**. 기록은 행마다 Vault 를 들고 있어
   * 남의 Vault 의 줄이 섞여 보이지 않고, 되돌아오면 원래 기록이 그대로 있다. 열어 둔 탭 ·
   * 활성 업무 · 파일 트리를 그때 비우는 것과 이유가 다르다 — 저쪽은 경로가 죽지만
   * 이쪽은 경로째로 보관되어 있다.
   */
  rescopeToday: async () => {
    const day = today();
    try {
      const entries = await api.dayEntries(get().settings.vault, day);
      set({ dayLog: { day, entries } });
    } catch {
      // 저장소를 못 읽으면 목록이 비어 보일 뿐이다.
      set({ dayLog: { day, entries: [] } });
    }
  },

  openDayLog: async (day) => {
    const target = day ?? today();
    set({ dayLogOpen: target });
    // 오늘을 열었으면 도크와 같은 목록을 보는 것이므로 한 번 더 읽어 맞춰 준다.
    if (target === today()) await get().rescopeToday();
  },

  /**
   * 파일을 하나도 붙이지 않은 업무를 접는다 — 제목과 글은 오늘의 한일에 남고 폴더는 지운다.
   *
   * **왜 보관하지 않는가.** 한 줄짜리 메모로 끝난 일까지 보관함에 넣으면 보관함이 돌아볼
   * 값이 없는 폴더로 채워진다. 그런 업무가 남긴 것은 제목과 글뿐이고, 그 둘은 오늘의 한일
   * 한 줄에 그대로 들어간다 — 폴더 하나보다 정확한 기록이다.
   *
   * **순서가 전부다.** 기록을 먼저 쓰고 그 다음에 지운다. 뒤집으면 쓰기가 실패한 순간
   * 사용자의 글이 어디에도 없다. 확인 대화상자를 두지 않는 대신 이 순서와 `index.md` 본문
   * 회수(`composeDiscardBody`)가 삭제를 실질적으로 무손실로 만든다.
   */
  logAndDiscard: async (folder, memo) => {
    const { settings, tasks } = get();
    const task = tasks.find((t) => t.folder === folder);
    const title = task?.title ?? basename(folder);
    try {
      // 1) 폴더가 들고 있던 글을 모은다. `index.md` 를 못 읽어도 메모는 남긴다 —
      //    읽기 실패로 기록 자체를 포기하면 지울 수도 없다.
      const indexText = task ? await api.readTextFile(task.indexPath).catch(() => "") : "";
      const body = composeDiscardBody(memo, splitFrontmatter(indexText).body);

      // 2) 기록을 먼저. `folder` 는 `null` 이다 — 폴더가 곧 사라지므로 경로로 남기면
      //    눌러도 아무 일이 없는 죽은 줄이 된다.
      const day = today();
      const row = await api.noteDayEntry(settings.vault, day, hhmm(), null, title, body);
      set({ dayLog: upsertEntry(get().dayLog, day, row) });

      // 3) 이 업무로 올라가 있던 오늘 줄은 치운다. 새 줄과 같은 일을 두 줄로 세는 것이고,
      //    폴더가 사라진 뒤에는 취소선 그어진 죽은 줄이 된다. 지난 날짜의 줄은 그날 실제로
      //    손댄 기록이라 남긴다.
      get().dropToday(folder);

      // 4) 폴더를 지운다. 안전장치는 `vault::discard_task` 에 있다.
      await api.discardTask(settings.vault, folder);

      // 5) 창을 닫는다. 보관과 같은 이유다 — 업무 리스트에 없는 업무의 작업공간이 떠 있으면
      //    아무것도 고르지 않은 화면에 남의 작업공간이 보이는 셈이다.
      set((s) => {
        const { [folder]: _discarded, ...rest } = s.uiCache;
        return { uiCache: rest, statusMenuOpen: false };
      });
      get().closeTask();
      get().toast(
        "오늘의 한일에 남겼습니다",
        `${title} · 파일이 없어 보관함에 넣지 않았습니다`,
        TOAST.muted,
      );
      // 창을 닫았으므로 `keepActive` 로 읽는다 — `false` 면 살아 있는 업무 하나를 자동으로
      // 골라 열어 방금 닫은 자리에 엉뚱한 업무가 나타난다.
      await get().reloadVault(true);
      // `syncMoc` 은 부르지 않는다. 이 업무는 보관된 적이 없어 Archive MOC 에 실린 적도 없다.
    } catch (e) {
      get().fail(e, "완료 처리를 하지 못했습니다");
    }
  },
}));

/**
 * 오늘의 한일이 `localStorage` 에 살던 시절의 값을 DB 로 옮긴다. 부팅 때 한 번 돈다.
 *
 * 날짜가 과거여도 옮긴다 — 그날 그 일을 한 것은 사실이고, 이제 하루가 지났다고 버릴
 * 이유가 없어졌다. **이관 완료 표시는 키의 부재 그 자체다**: 옮기기가 성공한 뒤에 키를
 * 지우므로, 중간에 실패하면 다음 부팅이 다시 시도하고 DB 쪽 upsert 가 중복을 접어 준다.
 */
async function migrateLegacyDayLog(vault: string): Promise<void> {
  const legacy = readLegacyLog();
  if (!legacy.day || !legacy.rows.length) {
    // 옮길 것이 없으면 키만 치운다(빈 값 · 깨진 값 · 이미 옮긴 뒤).
    forgetLegacyLog();
    return;
  }
  try {
    await api.importDayLog(vault, legacy.day, legacy.rows);
    forgetLegacyLog();
  } catch {
    /* 다음 부팅에서 다시 시도한다 — 키를 남겨 두는 것이 곧 재시도 표시다 */
  }
}

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
