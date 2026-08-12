mod agents;
mod ai_settings;
mod aipro;
mod detect;
mod error;
mod exec;
mod fabrix;
mod frontmatter;
mod fsops;
mod prompts;
mod recommend;
mod resolve;
mod run;
mod shell;
mod snapshot;
mod vault;

use agents::AgentKind;
use ai_settings::{AiProConfig, AiSettings, FabrixConfig};
use chrono::NaiveDate;
use detect::{AgentInfo, DetectedAgent};
use error::{AppError, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn p(s: &str) -> PathBuf {
    PathBuf::from(s)
}

// ---------------------------------------------------------------------------
// AI 데이터 루트
// ---------------------------------------------------------------------------

/// AI 커맨드의 오류 타입. 기존 커맨드는 `kind` 로 분기하는 `AppError` 를 쓰지만 AI
/// 쪽은 사유를 그대로 보여 주는 문자열이면 충분하다. `error::Result` 는 제네릭이
/// 하나뿐이라 여기서 재사용할 수 없어 별칭을 따로 둔다.
type AiResult<T> = std::result::Result<T, String>;

/// AI 연결 설정과 프롬프트 팩이 사는 폴더 — `~/.contextflow/`.
///
/// Vault 는 사용자가 고른 경로에, 앱 설정(`settings.json`)은 Tauri 의 `app_config_dir`
/// 에 있다. AI 쪽만 홈 루트를 쓰는 이유는 **사용자가 직접 파일을 넣는 폴더**
/// (`prompts/`)가 여기 있기 때문이다 — `%APPDATA%` 깊숙한 곳이면 찾지 못한다.
pub(crate) fn app_home() -> AiResult<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(|h| PathBuf::from(h).join(".contextflow"))
        .map_err(|_| "홈 디렉터리를 찾을 수 없습니다 (USERPROFILE/HOME 미설정)".to_string())
}

/// AI 실행의 작업 폴더. 빈 값이면 전용 폴더로 해석한다.
///
/// `~/.contextflow/runs/current` 는 **빈 폴더**라 CLAUDE.md 자동 탐색에 오염되지 않는다.
/// Vault 안에서 CLI 를 띄우면 업무 노트가 컨텍스트로 빨려 들어간다.
pub(crate) fn resolve_cwd(raw: &str) -> AiResult<String> {
    let path = if raw.trim().is_empty() {
        app_home()?.join("runs").join("current")
    } else {
        PathBuf::from(raw.trim())
    };
    std::fs::create_dir_all(&path).map_err(|e| format!("작업 폴더를 만들 수 없다: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::io(format!("설정 폴더를 찾을 수 없습니다: {}", e)))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Value> {
    let path = settings_path(&app)?;
    if !path.is_file() {
        return Ok(Value::Null);
    }
    let text = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, value: Value) -> Result<()> {
    let path = settings_path(&app)?;
    std::fs::write(&path, serde_json::to_string_pretty(&value)?)?;
    Ok(())
}

#[tauri::command]
fn default_vault_root(app: tauri::AppHandle) -> Result<String> {
    let docs = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| AppError::io(format!("문서 폴더를 찾을 수 없습니다: {}", e)))?;
    Ok(docs.join("ContextFlow Vault").to_string_lossy().replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

#[tauri::command]
fn init_vault(root: String, seed: bool) -> Result<()> {
    let root = p(&root);
    vault::ensure_layout(&root)?;
    if seed {
        vault::seed_sample(&root)?;
    }
    Ok(())
}

#[tauri::command]
fn scan_vault(root: String) -> Result<Vec<vault::TaskMeta>> {
    vault::scan(&p(&root))
}

#[tauri::command]
fn create_task(
    root: String,
    title: String,
    summary: String,
    tags: Vec<String>,
    template: Option<String>,
) -> Result<vault::TaskMeta> {
    vault::create_task(
        &p(&root),
        vault::NewTask {
            title: &title,
            summary: &summary,
            tags: &tags,
            template: template.as_deref().filter(|t| !t.is_empty()),
        },
    )
}

#[tauri::command]
fn rename_task(root: String, folder: String, title: String) -> Result<vault::TaskMeta> {
    vault::rename_task(&p(&root), &p(&folder), &title)
}

#[tauri::command]
fn set_task_status(root: String, folder: String, status: String) -> Result<vault::TaskMeta> {
    vault::set_status(&p(&root), &p(&folder), &status)
}

#[tauri::command]
fn append_task_run(root: String, folder: String, text: String) -> Result<vault::TaskMeta> {
    vault::append_run(&p(&root), &p(&folder), &text)
}

#[tauri::command]
fn set_task_archived(
    root: String,
    folder: String,
    archived: bool,
    mode: String,
    reopen: bool,
) -> Result<vault::TaskMeta> {
    vault::set_archived(&p(&root), &p(&folder), archived, &mode, reopen)
}

#[tauri::command]
fn merge_tasks(
    root: String,
    primary: String,
    sources: Vec<String>,
    mode: String,
) -> Result<vault::TaskMeta> {
    let sources: Vec<PathBuf> = sources.iter().map(|s| p(s)).collect();
    vault::merge_tasks(&p(&root), &p(&primary), &sources, &mode)
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

#[tauri::command]
fn read_text_file(path: String) -> Result<String> {
    let bytes = std::fs::read(p(&path))?;
    // Lossy so a stray non-UTF-8 byte shows a replacement char instead of
    // failing the whole open.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<()> {
    let path = p(&path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

#[tauri::command]
fn list_task_files(folder: String) -> Result<Vec<fsops::FileNode>> {
    fsops::list_tree(&p(&folder))
}

#[tauri::command]
fn create_task_file(folder: String, rel: String) -> Result<String> {
    fsops::create_file(&p(&folder), &rel)
}

#[tauri::command]
fn create_task_dir(folder: String, rel: String) -> Result<String> {
    fsops::create_dir(&p(&folder), &rel)
}

#[tauri::command]
fn preview_delete(folder: String, rel: String) -> Result<fsops::DeletePreview> {
    fsops::preview_delete(&p(&folder), &rel)
}

#[tauri::command]
fn delete_task_path(folder: String, rel: String) -> Result<()> {
    fsops::delete_path(&p(&folder), &rel)
}

#[tauri::command]
fn import_into_task(
    folder: String,
    target: String,
    sources: Vec<String>,
    mode: String,
) -> Result<fsops::ImportResult> {
    fsops::import_files(&p(&folder), &target, &sources, &mode)
}

#[tauri::command]
fn move_task_path(folder: String, rel: String, target_dir: String) -> Result<String> {
    fsops::move_path(&p(&folder), &rel, &target_dir)
}

#[tauri::command]
fn export_to_desktop(
    app: tauri::AppHandle,
    folder: String,
    rel: String,
    mode: String,
) -> Result<fsops::ExportResult> {
    // 바탕화면은 OS 마다 다른 곳에 있고 리다이렉트(OneDrive 등)되기도 한다 —
    // 경로를 추측하지 말고 Tauri 의 리졸버에 묻는다. 없으면 홈 아래를 쓴다.
    let desktop = app
        .path()
        .desktop_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Desktop")))
        .map_err(|e| AppError::io(format!("바탕화면 폴더를 찾을 수 없습니다: {}", e)))?;
    fsops::export_path(&p(&folder), &rel, &desktop, &mode)
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

#[tauri::command]
fn load_snapshot(folder: String) -> Result<Option<Value>> {
    snapshot::load(&p(&folder))
}

#[tauri::command]
fn save_snapshot(folder: String, value: Value) -> Result<()> {
    snapshot::save(&p(&folder), &value)
}

// ---------------------------------------------------------------------------
// Shell / Obsidian
// ---------------------------------------------------------------------------

#[tauri::command]
fn open_path_default(path: String) -> Result<()> {
    shell::open_default(&p(&path))
}

#[tauri::command]
fn open_path_with_dialog(path: String) -> Result<()> {
    shell::open_with_dialog(&p(&path))
}

#[tauri::command]
fn open_path_with_app(exe: String, path: String) -> Result<()> {
    shell::open_with_app(&exe, &p(&path))
}

#[tauri::command]
fn reveal_path(path: String) -> Result<()> {
    shell::reveal(&p(&path))
}

#[tauri::command]
fn obsidian_available() -> bool {
    shell::obsidian_installed()
}

#[tauri::command]
fn open_in_obsidian(root: String, path: String) -> Result<shell::OpenOutcome> {
    shell::open_in_obsidian(&p(&root), &p(&path))
}

// ---------------------------------------------------------------------------
// Templates & archive index
// ---------------------------------------------------------------------------

#[tauri::command]
fn scan_templates(root: String) -> Result<Vec<vault::TemplateMeta>> {
    let root = p(&root);
    let tasks = vault::scan(&root)?;
    vault::scan_templates(&root, &tasks)
}

#[tauri::command]
fn create_template(
    root: String,
    name: String,
    desc: String,
    sections: String,
) -> Result<String> {
    let path = vault::create_template(&p(&root), &name, &desc, &sections)?;
    Ok(path.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn create_template_from_folder(
    root: String,
    name: String,
    desc: String,
    source: String,
) -> Result<String> {
    let path = vault::create_template_from_folder(&p(&root), &name, &desc, &p(&source))?;
    Ok(path.to_string_lossy().replace('\\', "/"))
}

/// Mirrors the frontend's archive rule so the MOC matches what the app shows.
fn is_archived(t: &vault::TaskMeta, archive_days: i64) -> bool {
    if let Some(flag) = t.archived {
        return flag;
    }
    if archive_days <= 0 || t.status != "completed" {
        return false;
    }
    let Some(done) = t.completed_at.as_deref() else { return false };
    let Ok(date) = NaiveDate::parse_from_str(done, "%Y-%m-%d") else { return false };
    (chrono::Local::now().date_naive() - date).num_days() >= archive_days
}

#[tauri::command]
fn write_archive_moc(root: String, archive_days: i64) -> Result<String> {
    let root = p(&root);
    let tasks = vault::scan(&root)?;
    let archived: Vec<vault::TaskMeta> =
        tasks.into_iter().filter(|t| is_archived(t, archive_days)).collect();
    let path = vault::write_archive_moc(&root, &archived)?;
    Ok(path.to_string_lossy().replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/// 로컬 유사도 추천. AI 연결이 없거나 AI 경로가 실패했을 때의 폴백이며, 외부 통신이
/// 없으므로 언제나 동작한다. AI 경로는 프런트가 `run_agent` 로 직접 돈다.
///
/// `max_items` 는 화면에 낼 카드 수(기본 3)이지만, AI 경로는 후보를 추리는 1차 필터로도
/// 이 커맨드를 써서 더 큰 값을 준다 — Vault 가 커지면 후보 전부를 프롬프트에 실을 수 없다.
#[tauri::command]
fn recommend_tasks(
    query: String,
    candidates: Vec<recommend::Candidate>,
    threshold: u32,
    max_items: Option<usize>,
) -> Result<recommend::RecommendResult> {
    recommend::recommend(&query, &candidates, threshold, max_items.unwrap_or(3).max(1))
}

// ---------------------------------------------------------------------------
// AI 연결 · 탐지
// ---------------------------------------------------------------------------

/// 탐지 없이 레지스트리만 — 설정 화면이 카드를 먼저 그리고 탐지 결과를 나중에 채운다.
#[tauri::command]
fn list_agents() -> Vec<AgentInfo> {
    agents::all()
        .iter()
        .map(|d| AgentInfo {
            id: d.id.to_string(),
            name: d.name.to_string(),
            kind: match d.kind {
                AgentKind::Local => "local".to_string(),
                AgentKind::Remote => "remote".to_string(),
            },
            env_var: d.env_var.map(str::to_string),
        })
        .collect()
}

/// 라이브로 받은 원격 모델 목록을 백엔드 소유 캐시에 반영한다(프런트는 보내지 않는다).
fn cache_live_models(root: &Path, id: &str, models: &[detect::ModelOption]) {
    let mut s = ai_settings::load(root);
    let slot = match id {
        "aipro" => s.aipro.as_mut().map(|a| &mut a.models),
        "fabrix" => s.fabrix.as_mut().map(|f| &mut f.models),
        _ => None,
    };
    if let Some(slot) = slot {
        *slot = models.to_vec();
        let _ = ai_settings::save(root, &s);
    }
}

/// 한 서비스를 탐지한다. `force` 는 원격의 모델 목록을 캐시 대신 라이브로 다시 받는다.
#[tauri::command]
async fn detect_agent(id: String, force: Option<bool>) -> AiResult<DetectedAgent> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let def =
            agents::find(&id).ok_or_else(|| format!("알 수 없는 AI 서비스입니다: {id}"))?;
        let root = app_home()?;
        let s = ai_settings::load(&root);

        let agent = match def.id {
            "aipro" => aipro::detect_aipro(s.aipro.clone(), force),
            "fabrix" => fabrix::detect_fabrix(s.fabrix.clone(), force),
            _ => detect::detect_local(def, s.agent_custom_bin(def.id).as_deref()),
        };
        if agent.models_source == "live" {
            cache_live_models(&root, def.id, &agent.models);
        }
        Ok::<DetectedAgent, String>(agent)
    })
    .await
    .map_err(|e| format!("탐지가 중단되었습니다: {e}"))?
}

/// AI 설정을 읽는다. `ai.json` 이 아직 없으면 임베딩 시절의 `settings.json` 필드에서
/// 1회 마이그레이션한다.
#[tauri::command]
fn get_ai_settings(app: tauri::AppHandle) -> AiResult<AiSettings> {
    let root = app_home()?;
    let legacy = load_settings(app).unwrap_or(Value::Null);
    Ok(ai_settings::migrate_from_legacy(&root, &legacy))
}

/// 사용자 지정 실행 파일 경로를 저장(`Some`)하거나 해제(`None`)한다.
#[tauri::command]
fn set_agent_bin(id: String, path: Option<String>) -> AiResult<AiSettings> {
    let root = app_home()?;
    let mut s = ai_settings::load(&root);
    s.set_agent_bin(&id, ai_settings::normalize_secret(path));
    ai_settings::save(&root, &s)?;
    Ok(s)
}

/// 한 주입 지점에 붙일 프롬프트 팩 목록을 통째로 교체한다.
#[tauri::command]
fn set_prompt_hook(stage: String, files: Vec<String>) -> AiResult<AiSettings> {
    let root = app_home()?;
    let mut s = ai_settings::load(&root);
    s.set_prompt_hook(&stage, files)?;
    ai_settings::save(&root, &s)?;
    Ok(s)
}

/// 추천에 쓸 연결과 모델. 빈 `agent_id` 는 "AI 를 쓰지 않는다" 는 뜻이다.
#[tauri::command]
fn set_active_ai(agent_id: String, model: String) -> AiResult<AiSettings> {
    let root = app_home()?;
    let mut s = ai_settings::load(&root);
    s.active = ai_settings::ActiveChoice {
        agent_id: agent_id.trim().to_string(),
        model: model.trim().to_string(),
    };
    ai_settings::save(&root, &s)?;
    Ok(s)
}

/// AI Pro 연결을 저장하거나(빈 엔드포인트면) 해제한다.
///
/// 모델 목록은 소유자가 둘로 갈린다. `models`(라이브 조회 캐시)는 백엔드 것이라
/// 연결 정보가 그대로면 이월하고 바뀌면 버린다. `custom_models`(사용자가 직접 적은 id)는
/// 프런트 것이므로 받은 값을 그대로 쓴다 — 엔드포인트를 고쳤다고 사용자가 적은 값을
/// 앱이 임의로 지우면 왜 사라졌는지 알 방법이 없다.
#[tauri::command]
fn set_aipro_config(config: Option<AiProConfig>) -> AiResult<AiSettings> {
    let root = app_home()?;
    let mut s = ai_settings::load(&root);
    let prev = s.aipro.clone();

    s.aipro = match config {
        Some(mut c) if !c.endpoint_url.trim().is_empty() => {
            c.endpoint_url = ai_settings::normalize_endpoint(&c.endpoint_url);
            c.api_key = ai_settings::normalize_secret(c.api_key);
            c.models = match &prev {
                Some(p) if p.endpoint_url == c.endpoint_url && p.api_key == c.api_key => {
                    p.models.clone()
                }
                _ => Vec::new(),
            };
            Some(c)
        }
        _ => None,
    };
    ai_settings::save(&root, &s)?;
    Ok(s)
}

/// FabriX 연결을 저장하거나(빈 엔드포인트면) 해제한다.
#[tauri::command]
fn set_fabrix_config(config: Option<FabrixConfig>) -> AiResult<AiSettings> {
    let root = app_home()?;
    let mut s = ai_settings::load(&root);
    let prev = s.fabrix.clone();

    s.fabrix = match config {
        Some(mut c) if !c.endpoint_url.trim().is_empty() => {
            c.endpoint_url = ai_settings::normalize_endpoint(&c.endpoint_url);
            c.client = ai_settings::normalize_secret(c.client);
            c.openapi_token = ai_settings::normalize_secret(c.openapi_token);
            c.models = match &prev {
                Some(p)
                    if p.endpoint_url == c.endpoint_url
                        && p.client == c.client
                        && p.openapi_token == c.openapi_token =>
                {
                    p.models.clone()
                }
                _ => Vec::new(),
            };
            Some(c)
        }
        _ => None,
    };
    ai_settings::save(&root, &s)?;
    Ok(s)
}

#[tauri::command]
fn search_full_text(root: String, query: String) -> Result<Vec<vault::SearchHit>> {
    let root = p(&root);
    let tasks = vault::scan(&root)?;
    Ok(vault::search_full_text(&tasks, &query))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(run::RunRegistry::default())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            default_vault_root,
            init_vault,
            scan_vault,
            create_task,
            rename_task,
            set_task_status,
            append_task_run,
            set_task_archived,
            merge_tasks,
            read_text_file,
            write_text_file,
            list_task_files,
            create_task_file,
            create_task_dir,
            preview_delete,
            delete_task_path,
            import_into_task,
            move_task_path,
            export_to_desktop,
            load_snapshot,
            save_snapshot,
            open_path_default,
            open_path_with_dialog,
            open_path_with_app,
            reveal_path,
            obsidian_available,
            open_in_obsidian,
            scan_templates,
            create_template,
            create_template_from_folder,
            write_archive_moc,
            recommend_tasks,
            search_full_text,
            path_exists,
            list_agents,
            detect_agent,
            get_ai_settings,
            set_agent_bin,
            set_aipro_config,
            set_fabrix_config,
            set_active_ai,
            set_prompt_hook,
            prompts::list_prompt_packs,
            prompts::prompt_dir_path,
            prompts::open_prompt_dir,
            aipro::probe_aipro,
            fabrix::probe_fabrix,
            run::run_agent,
            run::cancel_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextFlow");
}
