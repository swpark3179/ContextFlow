/** Typed wrappers over the Rust commands in src-tauri/src/lib.rs. */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { DayEntry } from "./daylog";
import type { FileEntry } from "./tree";
import type {
  AgentInfo,
  AiSettings,
  DetectedAgent,
  FabrixConfig,
  PromptPack,
  RunArgs,
  RunEvent,
} from "./ai";

export { Channel };

export interface TaskMeta {
  id: string;
  title: string;
  status: string;
  tags: string[];
  /** `프로젝트/ContextFlow` 처럼 `/` 로 이은 1~3단계. `null` = 미분류. 백엔드가 정규화해 준다. */
  category: string | null;
  created: string;
  updated: string;
  parentTask: string | null;
  templateRef: string | null;
  completedAt: string | null;
  archived: boolean | null;
  archivedAt: string | null;
  runs: number;
  /** 사용자가 끌어 정한 자리. `null` = 아직 손대지 않았고, 그때는 최근 수정순이다. */
  order: number | null;
  folder: string;
  relFolder: string;
  indexPath: string;
  tagline: string;
}

export interface TemplateRun {
  date: string;
  text: string;
}

export interface TemplateMeta {
  id: string;
  name: string;
  desc: string;
  /** `note` = `Templates/<id>.md` 한 장, `folder` = `Templates/<id>/` 폴더 통째. */
  kind: "note" | "folder";
  path: string;
  relPath: string;
  uses: number;
  last: string;
  saved: number;
  runs: TemplateRun[];
}

export interface DeletePreview {
  files: number;
  dirs: number;
}

export interface ImportResult {
  added: string[];
  fellBackToCopy: string[];
}

export interface ExportResult {
  /** 바탕화면에 실제로 만들어진 이름 — 같은 이름이 있으면 `name (2).ext` 가 된다. */
  name: string;
  /** 심볼릭 링크를 요청했지만 권한이 없어 복사로 처리했다. */
  fellBackToCopy: boolean;
}

export interface OpenOutcome {
  /**
   * `unregistered` = 노트가 Obsidian 에 등록된 어느 vault 에도 들어 있지 않아 URL 을
   * 쏘지 않고 탐색기로 열었다. 이때 `detail` 은 등록해야 할 Vault 루트 경로다.
   */
  opened: "obsidian" | "explorer" | "unregistered";
  detail: string;
  /** `unregistered` 일 때 Obsidian 이 아는 vault 경로들 — 어느 경로와 어긋났는지 보여 준다. */
  known?: string[];
}

export interface VaultStatus {
  /** Obsidian 의 vault 목록 자체를 읽었는지. false 면 `registered` 는 판단하지 않은 값이다. */
  registryFound: boolean;
  registered: boolean;
  vaultName: string | null;
  /** Obsidian 이 아는 vault 경로들. */
  known: string[];
}

export interface RecCandidate {
  id: string;
  title: string;
  tags: string[];
  path: string;
  date: string;
  text: string;
}

export interface ClusterItem {
  id: string;
  date: string;
  title: string;
  path: string;
  sim: number;
}

export interface Recommendation {
  id: string;
  sim: number;
  title: string;
  path: string;
  cluster: ClusterItem[] | null;
}

export interface RecommendResult {
  /** `"local"` (로컬 유사도) 또는 추천을 만든 AI 에이전트의 id. */
  engine: string;
  note: string;
  items: Recommendation[];
}

export interface AppError {
  kind: string;
  message: string;
}

/** Commands reject with the serialised `AppError`; normalise it to a string. */
export function errMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as AppError).message);
  return String(e);
}

export function errKind(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) return String((e as AppError).kind);
  return "unknown";
}

// -- settings ---------------------------------------------------------------

export const loadSettings = () => invoke<unknown>("load_settings");
export const saveSettings = (value: unknown) => invoke<void>("save_settings", { value });
export const defaultVaultRoot = () => invoke<string>("default_vault_root");

// -- vault ------------------------------------------------------------------

export const initVault = (root: string, seed: boolean) =>
  invoke<void>("init_vault", { root, seed });
export const scanVault = (root: string) => invoke<TaskMeta[]>("scan_vault", { root });
export const createTask = (
  root: string,
  title: string,
  summary: string,
  tags: string[],
  template: string | null,
  category: string | null,
) => invoke<TaskMeta>("create_task", { root, title, summary, tags, template, category });
export const renameTask = (root: string, folder: string, title: string) =>
  invoke<TaskMeta>("rename_task", { root, folder, title });
export const setTaskStatus = (root: string, folder: string, status: string) =>
  invoke<TaskMeta>("set_task_status", { root, folder, status });
export const appendTaskRun = (root: string, folder: string, text: string) =>
  invoke<TaskMeta>("append_task_run", { root, folder, text });
/** `folders` 는 원하는 **최종 순서 전체**다. 값 계산과 최소 쓰기는 Rust 가 한다. */
export const reorderTasks = (root: string, folders: string[]) =>
  invoke<TaskMeta[]>("reorder_tasks", { root, folders });
export const clearTaskOrder = (root: string) => invoke<TaskMeta[]>("clear_task_order", { root });
export const setTaskArchived = (
  root: string,
  folder: string,
  archived: boolean,
  mode: string,
  reopen: boolean,
) => invoke<TaskMeta>("set_task_archived", { root, folder, archived, mode, reopen });
export const mergeTasks = (root: string, primary: string, sources: string[], mode: string) =>
  invoke<TaskMeta>("merge_tasks", { root, primary, sources, mode });

export interface AbsorbResult {
  /** 편입을 받은 업무의 새 메타데이터. */
  task: TaskMeta;
  /** 편입된 폴더의 **받는 업무 폴더 기준** 상대 경로 — 폴더이므로 `/` 로 끝난다. */
  rel: string;
  /** 편입된 업무의 제목. */
  title: string;
}

/**
 * 업무 하나를 다른 업무의 하위 폴더로 옮긴다(편입). `name` 을 생략하면 원본 폴더
 * 이름 그대로 들어간다. 실패하면 아무것도 옮기지 않고, 사유에 막은 파일 이름이 실린다.
 */
export const absorbTask = (
  root: string,
  source: string,
  target: string,
  name?: string | null,
) => invoke<AbsorbResult>("absorb_task", { root, source, target, name: name ?? null });

export interface SplitResult {
  /** 갈라져 나온 새 업무. */
  task: TaskMeta;
  /** 실제로 옮겨진 최상위 항목들. 폴더는 `/` 로 끝난다. */
  moved: string[];
}

/**
 * 업무를 둘로 나눈다 — 고른 **최상위** 항목을 새 업무로 옮긴다. 폴더를 고르면 그 아래는
 * 통째로 따라온다. 하나라도 실패하면 옮긴 것을 되돌린 뒤 오류가 온다.
 */
export const splitTask = (
  root: string,
  source: string,
  title: string,
  summary: string,
  tags: string[],
  items: string[],
  category: string | null,
) => invoke<SplitResult>("split_task", { root, source, title, summary, tags, items, category });

/** 카테고리를 지정하지 못한 업무 하나. 나머지는 그대로 진행된다. */
export interface CategoryIssue {
  folder: string;
  title: string;
  reason: string;
}

export interface CategoryChange {
  /** 지정한 뒤 새로 읽은 업무 목록 전체. */
  tasks: TaskMeta[];
  /** `index.md` 를 실제로 고쳐 쓴 폴더 — 이미 같은 값이던 업무는 빠진다. */
  changed: string[];
  failed: CategoryIssue[];
}

/**
 * 여러 업무에 카테고리 하나를 지정한다(`null` = 해제). 값은 한 번 검증하고, 업무마다의
 * 실패는 `failed` 로 모은다. `updated` 는 바뀌지 않는다 — 정리는 작업이 아니다.
 */
export const setTaskCategory = (root: string, folders: string[], category: string | null) =>
  invoke<CategoryChange>("set_task_category", { root, folders, category });
/**
 * 카테고리 `from`(키 — 하위 포함)의 경로를 `to` 로 바꾼다(`null` = 최상위로 올리기). 쓰기 전에
 * 전부 검사해 한 건이라도 규칙을 어기면 아무것도 쓰지 않는다. 이미 있는 카테고리와 합쳐지면
 * `allowMerge` 없이는 `already_exists` 로 거절한다.
 *
 * `only` 는 다시 시도할 업무 폴더다 — 그 사이 카테고리가 바뀐 업무는 건너뛰므로, 이미 옮긴
 * 업무를 두 번 옮기지 않는다.
 */
export const moveCategory = (
  root: string,
  from: string,
  to: string | null,
  allowMerge: boolean,
  only?: string[],
) => invoke<CategoryChange>("move_category", { root, from, to, allowMerge, only: only ?? null });
/** 카테고리 `from`(키 — 하위 포함)의 업무를 모두 미분류로 돌린다. `only` 는 `moveCategory` 와 같다. */
export const clearCategory = (root: string, from: string, only?: string[]) =>
  invoke<CategoryChange>("clear_category", { root, from, only: only ?? null });
/**
 * 업무 폴더를 통째로 지운다. 파일을 하나도 붙이지 않은 업무를 완료했을 때만 부르며,
 * 제목과 내용은 그 전에 오늘의 한일에 적어 둔다(`useStore.logAndDiscard`).
 */
export const discardTask = (root: string, folder: string) =>
  invoke<void>("discard_task", { root, folder });

// -- files ------------------------------------------------------------------

export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });
export const writeTextFile = (path: string, content: string) =>
  invoke<void>("write_text_file", { path, content });
export const listTaskFiles = (folder: string) => invoke<FileEntry[]>("list_task_files", { folder });
export const createTaskFile = (folder: string, rel: string) =>
  invoke<string>("create_task_file", { folder, rel });
/**
 * 붙여넣은 이미지를 노트(`note`, 업무 폴더 기준) 옆에 저장하고 파일 이름을 돌려준다.
 * 바이트는 본문 그대로 가고(JSON 배열로 부풀리지 않는다) 나머지는 머리글로 간다 —
 * 머리글에는 ASCII 만 실리므로 한글 경로를 퍼센트 인코딩한다.
 */
export const savePastedImage = (folder: string, note: string, ext: string, bytes: Uint8Array) =>
  invoke<string>("save_pasted_image", bytes, {
    headers: {
      "x-cf-folder": encodeURIComponent(folder),
      "x-cf-note": encodeURIComponent(note),
      "x-cf-ext": ext,
    },
  });
export const createTaskDir = (folder: string, rel: string) =>
  invoke<string>("create_task_dir", { folder, rel });
export const previewDelete = (folder: string, rel: string) =>
  invoke<DeletePreview>("preview_delete", { folder, rel });
export const deleteTaskPath = (folder: string, rel: string) =>
  invoke<void>("delete_task_path", { folder, rel });
export const importIntoTask = (
  folder: string,
  target: string,
  sources: string[],
  mode: string,
) => invoke<ImportResult>("import_into_task", { folder, target, sources, mode });
/** 업무 폴더 안에서 옮긴다. 새 상대 경로를 돌려주며, 폴더는 입력과 같이 `/` 로 끝난다. */
export const moveTaskPath = (folder: string, rel: string, targetDir: string) =>
  invoke<string>("move_task_path", { folder, rel, targetDir });
/** 업무 폴더 안에서 이름만 바꾼다. 새 상대 경로를 돌려주며, 폴더는 `/` 로 끝난다. */
export const renameTaskPath = (folder: string, rel: string, name: string) =>
  invoke<string>("rename_task_path", { folder, rel, name });
export const exportToDesktop = (folder: string, rel: string, mode: string) =>
  invoke<ExportResult>("export_to_desktop", { folder, rel, mode });

// -- snapshots --------------------------------------------------------------

export const loadSnapshot = (folder: string) =>
  invoke<Record<string, unknown> | null>("load_snapshot", { folder });
export const saveSnapshot = (folder: string, value: unknown) =>
  invoke<void>("save_snapshot", { folder, value });

// -- shell ------------------------------------------------------------------

export const openPathDefault = (path: string) => invoke<void>("open_path_default", { path });
export const openPathWithDialog = (path: string) => invoke<void>("open_path_with_dialog", { path });
export const openPathWithApp = (exe: string, path: string) =>
  invoke<void>("open_path_with_app", { exe, path });
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
export const obsidianAvailable = () => invoke<boolean>("obsidian_available");
export const openInObsidian = (root: string, path: string) =>
  invoke<OpenOutcome>("open_in_obsidian", { root, path });
export const obsidianVaultStatus = (root: string) =>
  invoke<VaultStatus>("obsidian_vault_status", { root });

// -- templates & archive ----------------------------------------------------

export const scanTemplates = (root: string) => invoke<TemplateMeta[]>("scan_templates", { root });
export const createTemplate = (root: string, name: string, desc: string, sections: string) =>
  invoke<string>("create_template", { root, name, desc, sections });
/** 폴더 하나를 통째로 표준 패턴으로 등록한다. 원본은 Vault 밖이어도 되며 복사해 온다. */
export const createTemplateFromFolder = (
  root: string,
  name: string,
  desc: string,
  source: string,
) => invoke<string>("create_template_from_folder", { root, name, desc, source });
/**
 * 보관함 MOC 를 다시 쓴다. 보관한 업무가 없고 파일도 없으면 만들지 않는데, `force` 면 그래도
 * 만든다 — 사용자가 직접 열 때 열 노트가 있어야 한다.
 */
export const writeArchiveMoc = (root: string, archiveDays: number, force = false) =>
  invoke<string>("write_archive_moc", { root, archiveDays, force });

/** 카테고리 허브 자동 갱신의 결과(src-tauri/src/hub.rs `HubReport`). */
export interface HubReport {
  /** 바이트가 바뀌어 실제로 쓴 허브 수. */
  written: number;
  /** 지운 표식 있는 옛 허브 수(카테고리가 사라졌거나 철자가 바뀌었다). */
  removed: number;
  /** 표식 없는 사용자 노트가 자리를 차지해 쓰지 않은 허브 — Vault 기준 `/` 경로, 정렬됨. */
  conflicts: string[];
}

/**
 * `_index/카테고리.md` · `_index/카테고리/` 의 허브 노트를 다시 쓴다(자동 갱신). 카테고리를 한 번도
 * 쓰지 않은 Vault 에는 만들지 않는다. 바이트가 같은 허브는 건드리지 않는다.
 */
export const writeCategoryHubs = (root: string, archDays: number) =>
  invoke<HubReport>("write_category_hubs", { root, archDays });
/**
 * 허브 하나를 열기 위해 모든 허브를 쓰고 그 절대 경로를 돌려준다. `key` 는 `null` = 전체 허브,
 * `""` = 미분류, 그 밖은 카테고리 키(`keyOf`)다. 업무가 없는 노드면 `not_found`, 자리에 사용자
 * 노트가 있으면 `already_exists` 로 거절한다.
 */
export const categoryHubPath = (root: string, archDays: number, key: string | null) =>
  invoke<string>("category_hub_path", { root, archDays, key });

// -- recommendation ---------------------------------------------------------

/**
 * 로컬 유사도 추천. AI 경로가 없거나 실패했을 때의 폴백이며 언제나 동작한다.
 *
 * `maxItems` 를 생략하면 화면용 3건. AI 경로는 후보를 추리는 1차 필터로도 이 커맨드를
 * 쓰면서 더 큰 값을 준다.
 */
export const recommendTasks = (
  query: string,
  candidates: RecCandidate[],
  threshold: number,
  maxItems?: number,
) => invoke<RecommendResult>("recommend_tasks", { query, candidates, threshold, maxItems });

// -- AI 연결 ---------------------------------------------------------------

export const listAgents = () => invoke<AgentInfo[]>("list_agents");
export const detectAgent = (id: string, force = false) =>
  invoke<DetectedAgent>("detect_agent", { id, force });

export const getAiSettings = () => invoke<AiSettings>("get_ai_settings");
export const setAgentBin = (id: string, path: string | null) =>
  invoke<AiSettings>("set_agent_bin", { id, path });
export const setFabrixConfig = (config: FabrixConfig | null) =>
  invoke<AiSettings>("set_fabrix_config", { config });
export const setActiveAi = (agentId: string, model: string) =>
  invoke<AiSettings>("set_active_ai", { agentId, model });
/** 빈 `agentId` = 지정 해제(기본 연결을 따른다). */
export const setAiRoute = (feature: string, agentId: string, model: string) =>
  invoke<AiSettings>("set_ai_route", { feature, agentId, model });

export const probeFabrix = () => invoke<string>("probe_fabrix");

// -- 프롬프트 팩 -----------------------------------------------------------

export const listPromptPacks = () => invoke<PromptPack[]>("list_prompt_packs");
export const promptDirPath = () => invoke<string>("prompt_dir_path");
export const openPromptDir = () => invoke<void>("open_prompt_dir");
export const setPromptHook = (stage: string, files: string[]) =>
  invoke<AiSettings>("set_prompt_hook", { stage, files });

// -- AI 실행 ---------------------------------------------------------------

/** `runId` 를 즉시 돌려주고 `onEvent` 로 스트리밍한다. */
export const runAgent = (args: RunArgs, onEvent: Channel<RunEvent>) =>
  invoke<string>("run_agent", { args, onEvent });
export const cancelRun = (runId: string) => invoke<void>("cancel_run", { runId });

// -- 웹 검색 (PC 의 브라우저) -------------------------------------------------
//
// Rust 는 `src-tauri/src/browser.rs`. 브라우저는 전용 프로필로 띄워 DevTools 프로토콜로
// 조종하고, 할 수 있는 일은 검색 결과 읽기와 결과 페이지 본문 읽기 둘뿐이다.

export type WebEngine = "google" | "bing" | "duckduckgo" | "naver";

/** Rust `BrowserOptions` 와 1:1 — 설정(`settings.json`)의 웹 검색 항목에서 만든다. */
export interface BrowserOptions {
  /** 직접 지정한 실행 파일. 비우면 Chrome → Edge → PATH 순으로 찾는다. */
  path: string | null;
  show: boolean;
  engine: WebEngine;
}

export interface BrowserInfo {
  path: string | null;
  name: string | null;
  source: "custom" | "auto" | "not-found";
  running: boolean;
}

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SerpResult {
  query: string;
  engine: string;
  url: string;
  results: WebResult[];
}

export interface WebPage {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
}

export const browserDetect = (path: string | null) => invoke<BrowserInfo>("browser_detect", { path });
export const webSearch = (opts: BrowserOptions, query: string) =>
  invoke<SerpResult>("web_search", { opts, query });
export const webRead = (opts: BrowserOptions, url: string) => invoke<WebPage>("web_read", { opts, url });
export const browserClose = () => invoke<void>("browser_close");

/** 웹 주소를 사용자의 기본 브라우저로 연다(AI 가 조종하는 전용 창이 아니라). */
export async function openWebUrl(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export interface SearchHit {
  folder: string;
  snippet: string;
}

export const searchFullText = (root: string, query: string) =>
  invoke<SearchHit[]>("search_full_text", { root, query });

export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });

// -- 오늘의 한일 -------------------------------------------------------------
//
// 저장소는 `~/.contextflow/today.db` 이고 Rust 쪽은 `src-tauri/src/daylog.rs` 다.
// 실패를 삼키는 쪽은 여기가 아니라 부르는 자리다 — 업무를 손댈 때의 기록은 스토어가
// 조용히 흘리고(파일 저장마다 경고가 뜨면 안 된다), 사용자가 직접 연 팝업에서는 보여야 한다.

export interface DaySummary {
  day: string;
  count: number;
}

/** 그 날짜의 기록을 최신 먼저. */
export const dayEntries = (vault: string, day: string) =>
  invoke<DayEntry[]>("day_entries", { vault, day });

/** 기록이 있는 날짜와 건수를 최신 먼저. `from`/`to` 는 양끝을 포함한다. */
export const dayIndex = (vault: string, from: string, to: string) =>
  invoke<DaySummary[]>("day_index", { vault, from, to });

/**
 * 기록 한 줄을 올린다. `folder` 가 있으면 같은 날 같은 업무는 한 줄로 접히고 시각만 새로
 * 적힌다. `body` 를 `null` 로 주면 **기존 내용을 건드리지 않는다** — 업무를 다시 손댔다고
 * 팝업에서 적어 둔 내용이 지워지면 안 된다.
 */
export const noteDayEntry = (
  vault: string,
  day: string,
  at: string,
  folder: string | null,
  title: string,
  body: string | null,
) => invoke<DayEntry>("note_day_entry", { vault, day, at, folder, title, body });

/** 팝업에서 제목과 내용을 고친다. 그날 목록의 순서는 바뀌지 않는다. */
export const editDayEntry = (id: number, title: string, body: string) =>
  invoke<DayEntry>("edit_day_entry", { id, title, body });

/** 기록 한 줄을 지운다. 이미 없는 줄이어도 오류가 아니다. */
export const removeDayEntry = (id: number) => invoke<void>("remove_day_entry", { id });

/** 업무 폴더 경로가 바뀐 것을 **과거 날짜의 줄까지** 반영한다. */
export const relocateDayEntries = (vault: string, from: string, to: string, title: string) =>
  invoke<void>("relocate_day_entries", { vault, from, to, title });

/** `localStorage` 에 있던 옛 목록을 옮긴다. 부팅 때 한 번만. 옮긴 줄 수를 돌려준다. */
export const importDayLog = (
  vault: string,
  day: string,
  rows: { folder: string; title: string; at: string }[],
) => invoke<number>("import_day_log", { vault, day, rows });

// -- LLM 위키 (src-tauri/src/wiki.rs) ---------------------------------------

/** 페이지 유형. 순서가 색인의 순서다(절차가 맨 앞). */
export type WikiKind = "procedure" | "topic" | "entity" | "source" | "answer";

export interface WikiPageMeta {
  /** `Wiki/` 기준 경로. 예: `procedures/배포 절차.md` */
  path: string;
  /** 확장자를 뺀 파일 이름 — 위키링크의 대상. */
  stem: string;
  kind: WikiKind;
  title: string;
  summary: string;
  tags: string[];
  /** 이 페이지를 뒷받침하는 업무 id. */
  sources: string[];
  created: string;
  updated: string;
  taskId: string | null;
  taskPath: string | null;
  sourceSig: string | null;
  /** 본문에서 나가는 위키링크의 대상. */
  links: string[];
  hash: string;
}

export interface WikiSourceState {
  taskId: string;
  title: string;
  folder: string;
  relFolder: string;
  completedAt: string | null;
  /** `fresh` = 반영됨 · `stale` = 반영 뒤 업무가 바뀜 · `missing` = 아직 반영 안 됨 */
  state: "fresh" | "stale" | "missing";
  page: string | null;
}

export interface WikiStatus {
  dir: string;
  exists: boolean;
  pages: WikiPageMeta[];
  /** 보관된 업무만. */
  tasks: WikiSourceState[];
  orphans: string[];
  moved: string[];
  logTail: string[];
}

export interface WikiSourceFile {
  rel: string;
  chars: number;
  text: string | null;
  truncated: boolean;
  skipped: string | null;
}

export interface WikiSourceBundle {
  task: TaskMeta;
  sig: string;
  sourcePath: string;
  sourceStem: string;
  reingest: boolean;
  files: WikiSourceFile[];
  totalChars: number;
}

export interface WikiPage {
  path: string;
  content: string;
  hash: string;
}

export interface WikiHit {
  path: string;
  stem: string;
  kind: WikiKind;
  title: string;
  summary: string;
  score: number;
  snippet: string;
}

export interface WikiPageWrite {
  kind: WikiKind;
  title: string;
  body: string;
  summary?: string | null;
  tags?: string[];
  sources?: string[];
  /** 모델에게 보여 준 기존 내용의 해시. 없는데 같은 이름이 있으면 백엔드가 덧붙인다. */
  baseHash?: string | null;
}

export interface WikiApplyReq {
  op: "ingest" | "query" | "lint";
  title: string;
  taskId?: string | null;
  pages: WikiPageWrite[];
  log?: string[];
}

export interface WikiApplyResult {
  written: { path: string; stem: string; title: string; action: "created" | "updated" | "appended" }[];
  skipped: { title: string; reason: string }[];
}

export interface WikiLintIssue {
  kind: string;
  path: string;
  detail: string;
}

export const wikiInit = (root: string) =>
  invoke<{ dir: string; seeded: boolean }>("wiki_init", { root });
export const wikiStatus = (root: string, archDays: number) =>
  invoke<WikiStatus>("wiki_status", { root, archDays });
export const wikiReadSource = (root: string, taskId: string) =>
  invoke<WikiSourceBundle>("wiki_read_source", { root, taskId });
export const wikiReadPages = (root: string, paths: string[]) =>
  invoke<WikiPage[]>("wiki_read_pages", { root, paths });
export const wikiSearch = (root: string, query: string, limit?: number) =>
  invoke<WikiHit[]>("wiki_search", { root, query, limit });
export const wikiApply = (root: string, req: WikiApplyReq) =>
  invoke<WikiApplyResult>("wiki_apply", { root, req });
export const wikiRelink = (root: string, archDays: number) =>
  invoke<number>("wiki_relink", { root, archDays });
export const wikiLintLocal = (root: string, archDays: number) =>
  invoke<WikiLintIssue[]>("wiki_lint_local", { root, archDays });
