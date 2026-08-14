/** Typed wrappers over the Rust commands in src-tauri/src/lib.rs. */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./tree";
import type {
  AgentInfo,
  AiProConfig,
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
  created: string;
  updated: string;
  parentTask: string | null;
  templateRef: string | null;
  completedAt: string | null;
  archived: boolean | null;
  archivedAt: string | null;
  runs: number;
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
}

export interface VaultStatus {
  /** Obsidian 의 vault 목록 자체를 읽었는지. false 면 `registered` 는 판단하지 않은 값이다. */
  registryFound: boolean;
  registered: boolean;
  vaultName: string | null;
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
) => invoke<TaskMeta>("create_task", { root, title, summary, tags, template });
export const renameTask = (root: string, folder: string, title: string) =>
  invoke<TaskMeta>("rename_task", { root, folder, title });
export const setTaskStatus = (root: string, folder: string, status: string) =>
  invoke<TaskMeta>("set_task_status", { root, folder, status });
export const appendTaskRun = (root: string, folder: string, text: string) =>
  invoke<TaskMeta>("append_task_run", { root, folder, text });
export const setTaskArchived = (
  root: string,
  folder: string,
  archived: boolean,
  mode: string,
  reopen: boolean,
) => invoke<TaskMeta>("set_task_archived", { root, folder, archived, mode, reopen });
export const mergeTasks = (root: string, primary: string, sources: string[], mode: string) =>
  invoke<TaskMeta>("merge_tasks", { root, primary, sources, mode });

// -- files ------------------------------------------------------------------

export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });
export const writeTextFile = (path: string, content: string) =>
  invoke<void>("write_text_file", { path, content });
export const listTaskFiles = (folder: string) => invoke<FileEntry[]>("list_task_files", { folder });
export const createTaskFile = (folder: string, rel: string) =>
  invoke<string>("create_task_file", { folder, rel });
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
export const writeArchiveMoc = (root: string, archiveDays: number) =>
  invoke<string>("write_archive_moc", { root, archiveDays });

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
export const setAiProConfig = (config: AiProConfig | null) =>
  invoke<AiSettings>("set_aipro_config", { config });
export const setFabrixConfig = (config: FabrixConfig | null) =>
  invoke<AiSettings>("set_fabrix_config", { config });
export const setActiveAi = (agentId: string, model: string) =>
  invoke<AiSettings>("set_active_ai", { agentId, model });

export const probeAiPro = () => invoke<string>("probe_aipro");
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

export interface SearchHit {
  folder: string;
  snippet: string;
}

export const searchFullText = (root: string, query: string) =>
  invoke<SearchHit[]>("search_full_text", { root, query });

export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });
