mod error;
mod frontmatter;
mod fsops;
mod recommend;
mod shell;
mod snapshot;
mod vault;

use chrono::NaiveDate;
use error::{AppError, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn p(s: &str) -> PathBuf {
    PathBuf::from(s)
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

#[tauri::command]
fn recommend_tasks(
    query: String,
    candidates: Vec<recommend::Candidate>,
    threshold: u32,
    llm: Option<recommend::LlmConfig>,
) -> Result<recommend::RecommendResult> {
    recommend::recommend(&query, &candidates, threshold, llm, 3)
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
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            default_vault_root,
            init_vault,
            scan_vault,
            create_task,
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
            write_archive_moc,
            recommend_tasks,
            search_full_text,
            path_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextFlow");
}
