//! The Obsidian vault is the single source of truth. Task metadata lives in the
//! `index.md` frontmatter of each task folder — there is no sidecar database, so
//! anything Obsidian shows is what ContextFlow shows.

use crate::error::{AppError, Result};
use crate::frontmatter::{append_run_log, Doc};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const TASKS_DIR: &str = "Tasks";
pub const TEMPLATES_DIR: &str = "Templates";
pub const ARCHIVE_DIR: &str = "Archive";
pub const INDEX_DIR: &str = "_index";
pub const SNAPSHOT_FILE: &str = ".context_snapshot.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMeta {
    pub id: String,
    pub title: String,
    pub status: String,
    pub tags: Vec<String>,
    pub created: String,
    pub updated: String,
    pub parent_task: Option<String>,
    pub template_ref: Option<String>,
    pub completed_at: Option<String>,
    /// `None` = never explicitly set, so the age-based rule decides.
    pub archived: Option<bool>,
    pub archived_at: Option<String>,
    pub runs: u32,
    /// Absolute path to the task folder.
    pub folder: String,
    /// Vault-relative folder path, e.g. `Tasks/[2026-08] 제목/`.
    pub rel_folder: String,
    /// Absolute path to `index.md`.
    pub index_path: String,
    pub tagline: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRun {
    pub date: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMeta {
    pub id: String,
    pub name: String,
    pub desc: String,
    /// `note` = `Templates/<id>.md` 한 장, `folder` = `Templates/<id>/` 폴더 통째.
    /// 폴더 템플릿은 업무 생성 시 파일이 실제로 복사된다.
    pub kind: String,
    pub path: String,
    pub rel_path: String,
    pub uses: u32,
    pub last: String,
    /// Run-log entries that did NOT become their own note.
    pub saved: u32,
    pub runs: Vec<TemplateRun>,
}

pub fn now_stamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M").to_string()
}

pub fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn month_prefix() -> String {
    Local::now().format("%Y-%m").to_string()
}

/// Windows forbids `\ / : * ? " < > |` in file names; Obsidian additionally
/// chokes on `#` and `^` inside links.
pub fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' => '-',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.').trim().to_string();
    if cleaned.is_empty() {
        "제목 없음".to_string()
    } else {
        cleaned
    }
}

fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// First meaningful body line, used as the one-line summary in the task list.
fn derive_tagline(body: &str) -> String {
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("---") {
            continue;
        }
        let line = line
            .trim_start_matches("- [ ]")
            .trim_start_matches("- [x]")
            .trim_start_matches("- [X]")
            .trim_start_matches(['-', '*', '>', '·'])
            .trim();
        if line.is_empty() {
            continue;
        }
        return line.chars().take(60).collect();
    }
    String::new()
}

fn count_run_log(body: &str) -> u32 {
    let Some(pos) = body.find(crate::frontmatter::RUN_LOG_HEADING) else {
        return 0;
    };
    body[pos..]
        .lines()
        .skip(1)
        // Stop at the next heading so we only count this section.
        .take_while(|l| !l.trim_start().starts_with("## "))
        .filter(|l| l.trim_start().starts_with("- "))
        .count() as u32
}

fn parse_run_log(body: &str) -> Vec<TemplateRun> {
    let Some(pos) = body.find(crate::frontmatter::RUN_LOG_HEADING) else {
        return Vec::new();
    };
    body[pos..]
        .lines()
        .skip(1)
        .take_while(|l| !l.trim_start().starts_with("## "))
        .filter_map(|l| {
            let entry = l.trim().strip_prefix("- ")?;
            match entry.split_once('·') {
                Some((date, text)) => Some(TemplateRun {
                    date: date.trim().to_string(),
                    text: text.trim().to_string(),
                }),
                None => Some(TemplateRun { date: String::new(), text: entry.trim().to_string() }),
            }
        })
        .collect()
}

pub fn read_task(root: &Path, index_path: &Path) -> Result<TaskMeta> {
    let src = fs::read_to_string(index_path)?;
    let doc = Doc::parse(&src);
    let folder = index_path
        .parent()
        .ok_or_else(|| AppError::io("index.md 의 상위 폴더를 찾을 수 없습니다"))?;
    let folder_name = folder.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();

    // Folder name is `[YYYY-MM] 제목` — strip the prefix for the fallback title.
    let fallback_title = match folder_name.split_once("] ") {
        Some((prefix, rest)) if prefix.starts_with('[') => rest.to_string(),
        _ => folder_name.clone(),
    };

    let mut rel_folder = rel_of(root, folder);
    if !rel_folder.ends_with('/') {
        rel_folder.push('/');
    }

    Ok(TaskMeta {
        id: doc.get_str("id").unwrap_or_else(|| folder_name.clone()),
        title: doc.get_str("title").unwrap_or(fallback_title),
        status: doc.get_str("status").unwrap_or_else(|| "in-progress".into()),
        tags: doc.get_list("tags"),
        created: doc.get_str("created").unwrap_or_default(),
        updated: doc.get_str("updated").unwrap_or_default(),
        parent_task: doc.get_str("parent_task"),
        template_ref: doc.get_str("template_ref"),
        completed_at: doc.get_str("completed_at"),
        archived: doc.get_bool("archived"),
        archived_at: doc.get_str("archived_at"),
        runs: doc.get_u32("runs").unwrap_or_else(|| count_run_log(&doc.body).max(1)),
        folder: folder.to_string_lossy().to_string(),
        rel_folder,
        index_path: index_path.to_string_lossy().to_string(),
        tagline: derive_tagline(&doc.body),
    })
}

/// Scans `Tasks/` and `Archive/**` one task-folder deep.
pub fn scan(root: &Path) -> Result<Vec<TaskMeta>> {
    let mut out = Vec::new();

    let mut visit = |dir: PathBuf| -> Result<()> {
        if !dir.is_dir() {
            return Ok(());
        }
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let index = entry.path().join("index.md");
            if index.is_file() {
                match read_task(root, &index) {
                    Ok(t) => out.push(t),
                    // A single malformed note must not blank the whole list.
                    Err(e) => eprintln!("[vault] skipping {}: {}", index.display(), e),
                }
            }
        }
        Ok(())
    };

    visit(root.join(TASKS_DIR))?;

    // Archive/<year>/<task>/ when the vault uses the "move" archive mode.
    let archive = root.join(ARCHIVE_DIR);
    if archive.is_dir() {
        for entry in fs::read_dir(&archive)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                visit(entry.path())?;
            }
        }
    }

    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(out)
}

pub fn ensure_layout(root: &Path) -> Result<()> {
    for dir in [TASKS_DIR, TEMPLATES_DIR, INDEX_DIR] {
        fs::create_dir_all(root.join(dir))?;
    }
    Ok(())
}

pub struct NewTask<'a> {
    pub title: &'a str,
    pub summary: &'a str,
    pub tags: &'a [String],
    pub template: Option<&'a str>,
}

/// 템플릿이 없을 때의 골격 — 개요 한 섹션뿐이다. 새 업무의 첫 화면을 남의 골격으로
/// 채우지 않는다. Run Log 는 첫 회차를 기록할 때 `append_run_log` 가 만들어 붙인다.
const DEFAULT_SKELETON: &str = "## 개요\n";

/// 템플릿 하나가 가리키는 실체. 폴더 템플릿이 우선한다 — 같은 이름의 노트와 폴더가
/// 동시에 있으면 `create_template*` 이 애초에 거부하므로 실제로는 한쪽만 존재한다.
enum TemplateSource {
    Note(PathBuf),
    Folder(PathBuf),
}

fn resolve_template(root: &Path, template: Option<&str>) -> Option<TemplateSource> {
    let id = template.filter(|t| !t.is_empty())?;
    let dir = root.join(TEMPLATES_DIR);
    let folder = dir.join(id);
    if folder.is_dir() {
        return Some(TemplateSource::Folder(folder));
    }
    let note = dir.join(format!("{}.md", id));
    note.is_file().then_some(TemplateSource::Note(note))
}

/// 새 업무 본문의 골격을 템플릿에서 읽는다. 노트 템플릿은 그 파일의 body, 폴더 템플릿은
/// 폴더 안 `index.md` 의 body 다. 비어 있으면 기본 골격으로 떨어진다.
fn skeleton_of(src: &TemplateSource) -> Option<String> {
    let path = match src {
        TemplateSource::Note(p) => p.clone(),
        TemplateSource::Folder(dir) => dir.join("index.md"),
    };
    let body = Doc::parse(&fs::read_to_string(path).ok()?).body;
    (!body.trim().is_empty()).then_some(body)
}

/// 사용자가 적은 개요를 본문의 `## 개요` 아래에 넣는다. 템플릿에 그 섹션이 없으면 맨 앞에
/// 만든다 — 개요 첫 줄은 `derive_tagline` 이 업무 목록에 뽑아 쓰므로 어디든 있어야 한다.
fn insert_summary(body: &str, summary: &str) -> String {
    let mut out = String::with_capacity(body.len() + summary.len() + 16);
    let mut done = false;
    for line in body.lines() {
        out.push_str(line);
        out.push('\n');
        if !done && line.trim_end() == "## 개요" {
            out.push_str(summary);
            out.push('\n');
            done = true;
        }
    }
    if done {
        out
    } else {
        format!("## 개요\n{}\n\n{}", summary, out.trim_start_matches('\n'))
    }
}

/// 골격과 개요를 합쳐 최종 본문을 만든다.
///
/// **템플릿에서 온 골격에만 Run Log 를 붙인다.** 그 섹션은 장식이 아니라 `count_run_log` 와
/// `append_run` 이 찾는 앵커여서, 표준 패턴이 빠뜨리면 회차 기록이 조용히 죽기 때문이다.
/// 기본 골격은 개요 한 줄로 시작하고, 첫 회차를 기록하는 순간 `append_run_log` 가 없는
/// 섹션을 만들어 붙인다 — 앵커는 그때 생겨도 늦지 않다.
fn compose_body(skeleton: Option<String>, summary: &str, stamp: &str) -> String {
    match skeleton {
        Some(base) => append_run_log(&insert_summary(&base, summary), stamp, "업무 생성"),
        None => insert_summary(DEFAULT_SKELETON, summary),
    }
}

pub fn create_task(root: &Path, spec: NewTask<'_>) -> Result<TaskMeta> {
    ensure_layout(root)?;
    let title = sanitize_name(spec.title);
    let base = format!("[{}] {}", month_prefix(), title);

    // Never silently write into an existing task folder.
    let mut folder = root.join(TASKS_DIR).join(&base);
    let mut n = 2;
    while folder.exists() {
        folder = root.join(TASKS_DIR).join(format!("{} ({})", base, n));
        n += 1;
    }
    fs::create_dir_all(folder.join("attachments"))?;

    let stamp = now_stamp();
    let id = format!(
        "task-{}-{}",
        Local::now().format("%Y-%m%d"),
        Local::now().format("%H%M%S")
    );
    // 개요를 비워 두면 비운 채로 만든다. 예전에는 "(개요를 입력하세요)" 를 넣었는데,
    // 지우는 손이 한 번 더 가는 데다 `derive_tagline` 이 그 문구를 업무 목록의 한 줄
    // 설명으로 그대로 뽑아 썼다.
    let summary = spec.summary.trim();
    let source = resolve_template(root, spec.template);
    let body = compose_body(source.as_ref().and_then(skeleton_of), summary, &stamp);

    let mut doc = Doc::parse("");
    doc.set("id", &id);
    doc.set("title", crate::frontmatter::quote_if_needed(&title));
    doc.set("status", "in-progress");
    doc.set_list("tags", spec.tags);
    doc.set("created", &stamp);
    doc.set("updated", &stamp);
    doc.set("parent_task", "null");
    doc.set(
        "template_ref",
        match spec.template {
            Some(t) if !t.is_empty() => format!("\"[[{}/{}]]\"", TEMPLATES_DIR, t),
            _ => "null".to_string(),
        },
    );
    doc.set("runs", "1");
    doc.set_body(body);

    // 기본 노트는 `index.md` 하나뿐이다. 예전에는 빈 `notes.md` 도 함께 만들었지만
    // 아무 데서도 읽지 않는 빈 파일이었고, 자유 메모 자리는 워크스페이스 하단의
    // 메모장 패널이 갖고 있다. 폴더 템플릿이 `notes.md` 를 담고 있으면 아래에서
    // 그대로 복사돼 온다 — 그 경우에만 생긴다.
    fs::write(folder.join("index.md"), doc.render())?;

    // 폴더 템플릿의 파일을 실제로 가져온다. `index.md` 만 빼는데, 그 body 는 이미 위에서
    // 본문 골격으로 썼고 frontmatter 는 이 업무의 것이어야 하기 때문이다.
    if let Some(TemplateSource::Folder(dir)) = &source {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_name() == "index.md" {
                continue;
            }
            crate::fsops::copy_recursive(&entry.path(), &folder.join(entry.file_name()))?;
        }
    }

    read_task(root, &folder.join("index.md"))
}

/// 업무명 변경. frontmatter 의 `title` 과 디스크 폴더 이름을 함께 바꾼다 — 둘이 갈라지면
/// Obsidian 에서 보이는 것과 앱에서 보이는 것이 달라진다. 생성 월을 뜻하는 `[YYYY-MM]`
/// 접두사는 이름이 바뀌어도 그대로 둔다.
pub fn rename_task(root: &Path, folder: &Path, title: &str) -> Result<TaskMeta> {
    // 빈 제목은 거절한다. `sanitize_name` 은 비면 "제목 없음" 으로 채우는데(:92), 새 업무를
    // 만들 때와 달리 이름 변경에서는 그 대체가 멀쩡한 이름을 지우는 결과가 된다.
    if title.trim().is_empty() {
        return Err(AppError::new("invalid", "업무 제목이 비어 있습니다"));
    }
    let safe = sanitize_name(title);
    let current = folder
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| AppError::io("업무 폴더 이름을 읽을 수 없습니다"))?;
    let parent = folder
        .parent()
        .ok_or_else(|| AppError::io("업무 폴더의 상위 경로를 찾을 수 없습니다"))?;

    // "[2026-08] " 처럼 닫는 대괄호와 공백까지가 접두사다.
    let prefix = match (current.starts_with('['), current.find("] ")) {
        (true, Some(end)) => &current[..end + 2],
        _ => "",
    };

    let mut dest = parent.join(format!("{}{}", prefix, safe));
    // 대소문자만 바꾸는 이름 변경은 Windows 에서 `exists()` 가 참이라 충돌로 오인된다.
    // 지금 폴더 자신이면 충돌 루프를 건너뛴다.
    let same_folder = |p: &Path| {
        p.file_name()
            .zip(Some(current.as_str()))
            .map(|(a, b)| a.to_string_lossy().eq_ignore_ascii_case(b))
            .unwrap_or(false)
    };
    if !same_folder(&dest) {
        let mut n = 2;
        while dest.exists() {
            dest = parent.join(format!("{}{} ({})", prefix, safe, n));
            n += 1;
        }
    }
    if dest != folder {
        fs::rename(folder, &dest)?;
    }
    edit_index(root, &dest, |doc| {
        doc.set("title", crate::frontmatter::quote_if_needed(&safe));
    })
}

fn edit_index<F>(root: &Path, folder: &Path, mut f: F) -> Result<TaskMeta>
where
    F: FnMut(&mut Doc),
{
    let index = folder.join("index.md");
    let src = fs::read_to_string(&index)?;
    let mut doc = Doc::parse(&src);
    f(&mut doc);
    doc.set("updated", now_stamp());
    fs::write(&index, doc.render())?;
    read_task(root, &index)
}

pub fn set_status(root: &Path, folder: &Path, status: &str) -> Result<TaskMeta> {
    edit_index(root, folder, |doc| {
        doc.set("status", status);
        if status == "completed" {
            doc.set("completed_at", today());
        } else {
            // Reopening clears the completion date and un-archives.
            doc.remove("completed_at");
            doc.set("archived", "false");
            doc.remove("archived_at");
        }
    })
}

/// Run Log 에 한 줄 적고 `runs` 를 맞춘다.
///
/// 회차는 원칙적으로 Run Log 의 줄 수다. 그런데 기본 골격에는 그 섹션이 아예 없고
/// (`DEFAULT_SKELETON`) frontmatter 만 `runs: 1` 을 들고 있어서, 그런 노트의 첫 기록에서는
/// 세어 나온 값이 1 이라 회차가 2 로 오르지 않고 제자리에 선다. 세어 나온 값과
/// "직전 값 + 1" 중 큰 쪽을 써서 회차가 뒷걸음치거나 멈추지 않게 한다.
fn record_run(doc: &mut Doc, stamp: &str, text: &str) {
    let next = append_run_log(&doc.body, stamp, text);
    let runs = count_run_log(&next).max(doc.get_u32("runs").unwrap_or(0) + 1);
    doc.set_body(next);
    doc.set("runs", runs.to_string());
}

pub fn append_run(root: &Path, folder: &Path, text: &str) -> Result<TaskMeta> {
    let stamp = now_stamp();
    edit_index(root, folder, |doc| record_run(doc, &stamp, text))
}

/// `mode` is `tag` (frontmatter only, files stay put — Obsidian links survive)
/// or `move` (relocate to `Archive/<year>/`).
pub fn set_archived(
    root: &Path,
    folder: &Path,
    archived: bool,
    mode: &str,
    reopen_note: bool,
) -> Result<TaskMeta> {
    let stamp = now_stamp();
    let meta = edit_index(root, folder, |doc| {
        doc.set("archived", if archived { "true" } else { "false" });
        if archived {
            doc.set("archived_at", today());
        } else {
            doc.remove("archived_at");
            if reopen_note {
                // 재개한 업무는 그냥 진행 중이다. 예전에는 `reopened` 라는 상태를 따로 두었지만
                // 필터도 카운트도 그것을 진행 중으로 접어 세고 있어서 배지 색만 달랐고,
                // "다시 손댄 업무" 라는 사실은 아래 Run Log 줄과 `runs` 회차가 이미 말해 준다.
                doc.set("status", "in-progress");
                doc.remove("completed_at");
                record_run(doc, &stamp, "보관함에서 재개");
            }
        }
    })?;

    if mode != "move" {
        return Ok(meta);
    }

    // "move" mode physically relocates the folder.
    let name = folder
        .file_name()
        .ok_or_else(|| AppError::io("업무 폴더 이름을 읽을 수 없습니다"))?;
    let dest_parent = if archived {
        let year = meta
            .completed_at
            .as_deref()
            .or(meta.archived_at.as_deref())
            .unwrap_or("")
            .get(0..4)
            .unwrap_or("unknown")
            .to_string();
        root.join(ARCHIVE_DIR).join(year)
    } else {
        root.join(TASKS_DIR)
    };
    fs::create_dir_all(&dest_parent)?;
    let dest = dest_parent.join(name);
    if dest != folder {
        if dest.exists() {
            return Err(AppError::new(
                "already_exists",
                format!("이동 대상에 같은 이름의 폴더가 이미 있습니다: {}", dest.display()),
            ));
        }
        fs::rename(folder, &dest)?;
        return read_task(root, &dest.join("index.md"));
    }
    Ok(meta)
}

/// Folds `sources` into `primary`: their Run Log lines move into the primary
/// note and the source folders are archived (never deleted).
pub fn merge_tasks(root: &Path, primary: &Path, sources: &[PathBuf], mode: &str) -> Result<TaskMeta> {
    let mut collected: Vec<String> = Vec::new();
    for src in sources {
        if src == primary {
            continue;
        }
        let index = src.join("index.md");
        let Ok(text) = fs::read_to_string(&index) else { continue };
        let doc = Doc::parse(&text);
        let title = doc.get_str("title").unwrap_or_default();
        for run in parse_run_log(&doc.body) {
            collected.push(format!("- {} · {} — {}", run.date, title, run.text));
        }
    }

    let index = primary.join("index.md");
    let src = fs::read_to_string(&index)?;
    let mut doc = Doc::parse(&src);
    let needle = format!("{}\n", crate::frontmatter::RUN_LOG_HEADING);
    let block = collected.join("\n");
    let merged_body = if collected.is_empty() {
        doc.body.clone()
    } else if let Some(pos) = doc.body.find(&needle) {
        let cut = pos + needle.len();
        format!("{}{}\n{}", &doc.body[..cut], block, &doc.body[cut..])
    } else {
        format!(
            "{}\n\n{}\n{}\n",
            doc.body.trim_end(),
            crate::frontmatter::RUN_LOG_HEADING,
            block
        )
    };
    let runs = count_run_log(&merged_body);
    doc.set_body(merged_body);
    doc.set("runs", runs.to_string());
    doc.set("merged_from", (sources.len().saturating_sub(1)).to_string());
    doc.set("updated", now_stamp());
    fs::write(&index, doc.render())?;

    for s in sources {
        if s != primary {
            let _ = set_archived(root, s, true, mode, false);
        }
    }
    read_task(root, &index)
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/// Template stats are derived from the tasks that reference them, so the
/// "만들지 않은 중복 노트" figure reflects the real vault rather than a counter.
pub fn scan_templates(root: &Path, tasks: &[TaskMeta]) -> Result<Vec<TemplateMeta>> {
    let dir = root.join(TEMPLATES_DIR);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();

        // 템플릿은 두 모양이다: 노트 한 장(`x.md`)이거나 폴더 통째(`x/`). 폴더 쪽은
        // 안에 있는 `index.md` 의 frontmatter 를 이름·설명으로 쓰되, 없어도 폴더 이름만으로
        // 성립한다 — 사용자가 탐색기에서 폴더를 툭 던져 넣어도 템플릿이 되어야 한다.
        let is_dir = path.is_dir();
        if !is_dir && path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        // `.obsidian` 같은 숨김 항목은 템플릿이 아니다.
        if path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
            continue;
        }
        let (stem, meta_path, kind, rel_path) = if is_dir {
            let stem = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let rel = format!("{}/{}/", TEMPLATES_DIR, stem);
            (stem, path.join("index.md"), "folder", rel)
        } else {
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let rel = format!("{}/{}.md", TEMPLATES_DIR, stem);
            (stem, path.clone(), "note", rel)
        };
        let text = fs::read_to_string(&meta_path).unwrap_or_default();
        let doc = Doc::parse(&text);
        let name = doc.get_str("template").unwrap_or_else(|| stem.clone());
        let desc = doc.get_str("purpose").unwrap_or_default();

        let link = format!("[[{}/{}]]", TEMPLATES_DIR, stem);
        let users: Vec<&TaskMeta> = tasks
            .iter()
            .filter(|t| t.template_ref.as_deref().map(|r| r.contains(&link) || r.contains(&stem)).unwrap_or(false))
            .collect();

        let mut runs: Vec<TemplateRun> = Vec::new();
        for t in &users {
            let body = fs::read_to_string(&t.index_path)
                .map(|s| Doc::parse(&s).body)
                .unwrap_or_default();
            for r in parse_run_log(&body) {
                runs.push(TemplateRun {
                    date: r.date,
                    text: format!("{} — {}", t.title, r.text),
                });
            }
        }
        runs.sort_by(|a, b| b.date.cmp(&a.date));

        let uses = runs.len() as u32;
        let last = runs.first().map(|r| r.date.clone()).unwrap_or_else(|| "—".into());
        let saved = uses.saturating_sub(users.len() as u32);

        out.push(TemplateMeta {
            id: stem.clone(),
            name,
            desc,
            kind: kind.to_string(),
            path: path.to_string_lossy().to_string(),
            rel_path,
            uses,
            last,
            saved,
            runs,
        });
    }
    out.sort_by(|a, b| b.last.cmp(&a.last));
    Ok(out)
}

/// 노트와 폴더는 같은 id 네임스페이스를 쓴다(`template_ref` 위키링크가 하나뿐이므로).
/// 그래서 어느 쪽을 만들든 두 모양 다 비어 있어야 한다.
fn claim_template_name(root: &Path, name: &str) -> Result<(String, PathBuf)> {
    ensure_layout(root)?;
    if name.trim().is_empty() {
        return Err(AppError::new("invalid", "템플릿 이름이 비어 있습니다"));
    }
    let safe = sanitize_name(name);
    let dir = root.join(TEMPLATES_DIR);
    if dir.join(format!("{}.md", safe)).exists() || dir.join(&safe).exists() {
        return Err(AppError::new(
            "already_exists",
            format!("같은 이름의 템플릿이 이미 있습니다: {}", safe),
        ));
    }
    Ok((safe, dir))
}

/// 폴더 하나를 통째로 표준 패턴으로 등록한다. 원본은 Vault 밖일 수 있으므로 복사해 온다 —
/// 경로만 참조하면 원본이 옮겨지는 순간 템플릿이 깨지고 Obsidian 에서도 보이지 않는다.
pub fn create_template_from_folder(
    root: &Path,
    name: &str,
    desc: &str,
    source: &Path,
) -> Result<PathBuf> {
    if !source.is_dir() {
        return Err(AppError::new("not_found", format!("폴더를 찾을 수 없습니다: {}", source.display())));
    }
    let (safe, dir) = claim_template_name(root, name)?;
    let path = dir.join(&safe);
    crate::fsops::copy_recursive(source, &path)?;

    // 이름·설명은 폴더 안 `index.md` 의 frontmatter 에 산다. 원본이 이미 `index.md` 를
    // 갖고 있으면 본문은 그대로 두고 키만 얹는다 — 그 본문이 곧 새 업무의 골격이 된다.
    let index = path.join("index.md");
    let existing = fs::read_to_string(&index).unwrap_or_default();
    let mut doc = Doc::parse(&existing);
    doc.set("template", crate::frontmatter::quote_if_needed(&safe));
    doc.set("purpose", crate::frontmatter::quote_if_needed(desc));
    if doc.get_str("created").is_none() {
        doc.set("created", now_stamp());
    }
    fs::write(&index, doc.render())?;
    Ok(path)
}

pub fn create_template(root: &Path, name: &str, desc: &str, sections: &str) -> Result<PathBuf> {
    let (safe, dir) = claim_template_name(root, name)?;
    let path = dir.join(format!("{}.md", safe));
    let body: String = sections
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| format!("## {}\n\n", l))
        .collect();
    let mut doc = Doc::parse("");
    doc.set("template", crate::frontmatter::quote_if_needed(&safe));
    doc.set("purpose", crate::frontmatter::quote_if_needed(desc));
    doc.set("created", now_stamp());
    doc.set_body(body);
    fs::write(&path, doc.render())?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Archive MOC — keeps the archive browsable from inside Obsidian too
// ---------------------------------------------------------------------------

pub fn write_archive_moc(root: &Path, archived: &[TaskMeta]) -> Result<PathBuf> {
    fs::create_dir_all(root.join(INDEX_DIR))?;
    let path = root.join(INDEX_DIR).join("Archive.md");

    let mut md = String::new();
    md.push_str("# 보관함\n\n");
    md.push_str("> ContextFlow가 자동으로 갱신합니다. 직접 수정한 내용은 다음 갱신 때 덮어써집니다.\n\n");
    md.push_str("```dataview\nTABLE completed_at, runs\nFROM \"Tasks\"\nWHERE archived = true\nSORT completed_at DESC\n```\n\n");
    md.push_str("## 목록\n\n| 업무 | 완료 | 회차 | 태그 |\n| --- | --- | --- | --- |\n");
    for t in archived {
        let link = format!("{}index", t.rel_folder);
        md.push_str(&format!(
            "| [[{}\\|{}]] | {} | ×{} | {} |\n",
            link,
            t.title,
            t.completed_at.as_deref().unwrap_or("—"),
            t.runs,
            t.tags.iter().map(|x| format!("#{}", x)).collect::<Vec<_>>().join(" ")
        ));
    }
    md.push_str(&format!("\n_최종 갱신 {}_\n", now_stamp()));
    fs::write(&path, md)?;
    Ok(path)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub folder: String,
    pub snippet: String,
}

/// Full-text search across every text file inside each task folder. Powers the
/// archive screen's [본문 전문] scope, which the title/tag filter cannot reach.
pub fn search_full_text(tasks: &[TaskMeta], query: &str) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for t in tasks {
        let mut snippet = String::new();
        'files: for entry in walkdir::WalkDir::new(&t.folder)
            .max_depth(4)
            .into_iter()
            .flatten()
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !crate::fsops::is_text(&name) {
                continue;
            }
            // Skip anything large enough that scanning it would stall the UI.
            if entry.metadata().map(|m| m.len() > 2_000_000).unwrap_or(false) {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else { continue };
            for line in text.lines() {
                if line.to_lowercase().contains(&q) {
                    snippet = line.trim().chars().take(96).collect();
                    break 'files;
                }
            }
        }
        if !snippet.is_empty() {
            out.push(SearchHit { folder: t.folder.clone(), snippet });
        }
    }
    out
}

/// Seeds one sample task so a brand-new vault does not open on an empty screen.
pub fn seed_sample(root: &Path) -> Result<()> {
    ensure_layout(root)?;

    let tpl = root.join(TEMPLATES_DIR).join("업무 표준절차.md");
    if !tpl.exists() {
        create_template(
            root,
            "업무 표준절차",
            "반복 업무의 기본 골격",
            "배경\n체크리스트\n실행 이력 (Run Log)",
        )?;
    }

    if fs::read_dir(root.join(TASKS_DIR))?.next().is_none() {
        create_task(
            root,
            NewTask {
                title: "ContextFlow 시작하기",
                summary: "왼쪽에서 업무를 고르면 그 업무 전용 작업공간이 열립니다. 오른쪽 탐색기에서 파일을 만들고 더블클릭해 편집해 보세요.",
                tags: &["시작".to_string()],
                template: Some("업무 표준절차"),
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_windows_forbidden_characters() {
        assert_eq!(sanitize_name("API: 연동/버그*수정?"), "API- 연동-버그-수정-");
        assert_eq!(sanitize_name("   "), "제목 없음");
        assert_eq!(sanitize_name("정상 제목"), "정상 제목");
    }

    #[test]
    fn counts_only_the_run_log_section() {
        let body = "## 실행 이력 (Run Log)\n- a · 1\n- b · 2\n\n## 다른 섹션\n- c · 3\n";
        assert_eq!(count_run_log(body), 2);
        assert_eq!(count_run_log("## 개요\n내용"), 0);
    }

    #[test]
    fn parses_run_log_into_date_and_text() {
        let body = "## 실행 이력 (Run Log)\n- 2026-08-03 15:30 · capabilities 초안 작성\n";
        let runs = parse_run_log(body);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].date, "2026-08-03 15:30");
        assert_eq!(runs[0].text, "capabilities 초안 작성");
    }

    #[test]
    fn tagline_skips_headings_and_bullets() {
        assert_eq!(derive_tagline("## 개요\n- [ ] 할 일 항목\n"), "할 일 항목");
        assert_eq!(derive_tagline("## 개요\n실제 설명 문장\n"), "실제 설명 문장");
        assert_eq!(derive_tagline("## 개요\n"), "");
    }

    // -- on-disk lifecycle ---------------------------------------------------

    struct TempVault(PathBuf);

    impl TempVault {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "contextflow-test-{}-{}",
                tag,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            ensure_layout(&dir).unwrap();
            TempVault(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn make(root: &Path, title: &str) -> TaskMeta {
        create_task(
            root,
            NewTask { title, summary: "테스트 개요", tags: &["test".into()], template: None },
        )
        .unwrap()
    }

    #[test]
    fn creates_a_task_folder_matching_the_spec_layout() {
        let v = TempVault::new("create");
        let t = make(v.path(), "Tauri 2.0 마이그레이션");

        let folder = Path::new(&t.folder);
        assert!(folder.join("index.md").is_file());
        // 기본 노트는 index.md 하나다 — 빈 notes.md 를 되살리지 않는다.
        assert!(!folder.join("notes.md").exists());
        assert!(folder.join("attachments").is_dir());
        assert!(t.rel_folder.starts_with("Tasks/["));
        assert!(t.rel_folder.ends_with("Tauri 2.0 마이그레이션/"));

        assert_eq!(t.status, "in-progress");
        assert_eq!(t.tags, vec!["test"]);
        assert_eq!(t.runs, 1);

        // 기본 골격은 개요 한 섹션뿐이다 — 체크리스트도 Run Log 도 미리 만들지 않는다.
        let body = fs::read_to_string(folder.join("index.md")).unwrap();
        assert!(body.contains("## 개요\n테스트 개요"));
        assert!(!body.contains("## 체크리스트"));
        assert!(!body.contains("## 실행 이력 (Run Log)"));
    }

    #[test]
    fn an_empty_summary_stays_empty_rather_than_becoming_a_placeholder() {
        let v = TempVault::new("emptysummary");
        let t = create_task(
            v.path(),
            NewTask { title: "개요 없음", summary: "  ", tags: &[], template: None },
        )
        .unwrap();

        let body = fs::read_to_string(Path::new(&t.folder).join("index.md")).unwrap();
        assert!(body.contains("## 개요"));
        assert!(!body.contains("개요를 입력하세요"));
        // 한 줄 설명은 개요 첫 줄에서 뽑는다. 비었으면 비어 있어야 한다.
        assert_eq!(t.tagline, "");
    }

    #[test]
    fn the_first_run_log_entry_advances_the_count_even_without_a_section() {
        let v = TempVault::new("runbump");
        let t = make(v.path(), "회차 세기");
        assert_eq!(t.runs, 1);
        // 기본 골격에는 Run Log 섹션이 없다. 줄 수만 세면 여기서 1 에 머무른다.
        let after = append_run(v.path(), Path::new(&t.folder), "두 번째 회차").unwrap();
        assert_eq!(after.runs, 2);

        let again = append_run(v.path(), Path::new(&t.folder), "세 번째 회차").unwrap();
        assert_eq!(again.runs, 3);
    }

    #[test]
    fn a_second_task_with_the_same_title_never_overwrites_the_first() {
        let v = TempVault::new("dup");
        let a = make(v.path(), "같은 제목");
        let b = make(v.path(), "같은 제목");
        assert_ne!(a.folder, b.folder);
        assert!(b.folder.ends_with("(2)"));
        assert_eq!(scan(v.path()).unwrap().len(), 2);
    }

    #[test]
    fn scan_reads_back_everything_create_wrote() {
        let v = TempVault::new("scan");
        make(v.path(), "첫 업무");
        make(v.path(), "둘째 업무");
        let tasks = scan(v.path()).unwrap();
        assert_eq!(tasks.len(), 2);
        let titles: Vec<&str> = tasks.iter().map(|t| t.title.as_str()).collect();
        assert!(titles.contains(&"첫 업무"));
        assert!(titles.contains(&"둘째 업무"));
    }

    #[test]
    fn completing_stamps_a_date_and_reopening_clears_it() {
        let v = TempVault::new("status");
        let t = make(v.path(), "상태 전환");
        let folder = PathBuf::from(&t.folder);

        let done = set_status(v.path(), &folder, "completed").unwrap();
        assert_eq!(done.status, "completed");
        assert_eq!(done.completed_at.as_deref(), Some(today().as_str()));

        let back = set_status(v.path(), &folder, "in-progress").unwrap();
        assert_eq!(back.status, "in-progress");
        assert_eq!(back.completed_at, None);
    }

    #[test]
    fn run_log_entries_accumulate_newest_first_and_bump_the_count() {
        let v = TempVault::new("runlog");
        let t = make(v.path(), "회차 누적");
        let folder = PathBuf::from(&t.folder);

        append_run(v.path(), &folder, "첫 회차").unwrap();
        let after = append_run(v.path(), &folder, "둘째 회차").unwrap();
        assert_eq!(after.runs, 3); // creation + two appends

        // 기본 골격에는 Run Log 가 없으므로 생성 시점의 줄도 없다. 회차 수는 frontmatter 가
        // 이어 세고, 섹션은 첫 기록 때 생긴다.
        let body = fs::read_to_string(folder.join("index.md")).unwrap();
        assert!(!body.contains("· 업무 생성"));
        let second = body.find("둘째 회차").unwrap();
        let first = body.find("첫 회차").unwrap();
        assert!(second < first, "newest entry must be on top");
    }

    #[test]
    fn tag_mode_archiving_leaves_the_files_exactly_where_obsidian_expects_them() {
        let v = TempVault::new("archtag");
        let t = make(v.path(), "보관 대상");
        let folder = PathBuf::from(&t.folder);
        set_status(v.path(), &folder, "completed").unwrap();

        let archived = set_archived(v.path(), &folder, true, "tag", false).unwrap();
        assert_eq!(archived.archived, Some(true));
        assert_eq!(archived.archived_at.as_deref(), Some(today().as_str()));
        // The whole point of tag mode: nothing moves.
        assert_eq!(archived.folder, t.folder);
        assert!(folder.join("index.md").is_file());
    }

    #[test]
    fn restoring_adds_a_run_log_entry_instead_of_creating_a_new_note() {
        let v = TempVault::new("restore");
        let t = make(v.path(), "재개 대상");
        let folder = PathBuf::from(&t.folder);
        set_status(v.path(), &folder, "completed").unwrap();
        set_archived(v.path(), &folder, true, "tag", false).unwrap();

        let before = scan(v.path()).unwrap().len();
        let resumed = set_archived(v.path(), &folder, false, "tag", true).unwrap();

        assert_eq!(scan(v.path()).unwrap().len(), before, "no new task node");
        // 재개는 별도 상태를 만들지 않는다 — 그냥 다시 진행 중이다.
        assert_eq!(resumed.status, "in-progress");
        assert_eq!(resumed.archived, Some(false));
        assert_eq!(resumed.completed_at, None);
        assert!(resumed.runs > t.runs);
        // 재개했다는 사실은 Run Log 가 들고 있다.
        let body = fs::read_to_string(folder.join("index.md")).unwrap();
        assert!(body.contains("보관함에서 재개"));
    }

    #[test]
    fn move_mode_archiving_relocates_under_archive_year() {
        let v = TempVault::new("archmove");
        let t = make(v.path(), "이동 대상");
        let folder = PathBuf::from(&t.folder);
        set_status(v.path(), &folder, "completed").unwrap();

        let moved = set_archived(v.path(), &folder, true, "move", false).unwrap();
        assert!(!folder.exists(), "original folder should be gone");
        assert!(moved.rel_folder.starts_with("Archive/"));
        assert!(Path::new(&moved.folder).join("index.md").is_file());
        // Archived tasks must still be discoverable by a scan.
        assert_eq!(scan(v.path()).unwrap().len(), 1);
    }

    #[test]
    fn renaming_moves_the_folder_and_keeps_the_month_prefix() {
        let v = TempVault::new("rename");
        let t = make(v.path(), "옛 이름");
        let old = PathBuf::from(&t.folder);
        let prefix = old.file_name().unwrap().to_string_lossy()[..10].to_string();

        let renamed = rename_task(v.path(), &old, "새 이름").unwrap();

        assert!(!old.exists(), "old folder should be gone");
        assert_eq!(renamed.title, "새 이름");
        assert!(renamed.rel_folder.ends_with(&format!("{}새 이름/", prefix)));
        assert!(Path::new(&renamed.folder).join("attachments").is_dir());
        // frontmatter 와 폴더가 함께 움직였는지 스캔으로 되읽어 확인한다.
        let tasks = scan(v.path()).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "새 이름");
    }

    #[test]
    fn renaming_onto_an_existing_name_never_overwrites_it() {
        let v = TempVault::new("renamedup");
        let a = make(v.path(), "첫 업무");
        let b = make(v.path(), "둘째 업무");

        let renamed = rename_task(v.path(), Path::new(&b.folder), "첫 업무").unwrap();

        assert!(renamed.folder.ends_with("(2)"));
        assert!(Path::new(&a.folder).exists(), "the original keeps its folder");
        assert_eq!(scan(v.path()).unwrap().len(), 2);
    }

    #[test]
    fn renaming_to_a_blank_title_is_refused() {
        let v = TempVault::new("renameblank");
        let t = make(v.path(), "그대로");
        let err = rename_task(v.path(), Path::new(&t.folder), "  ").unwrap_err();
        assert_eq!(err.kind, "invalid");
        assert!(Path::new(&t.folder).exists());
    }

    #[test]
    fn a_note_template_supplies_the_body_of_the_task_it_creates() {
        let v = TempVault::new("tplnote");
        create_template(v.path(), "릴리스 절차", "배포용", "배경\n검증 항목").unwrap();

        let t = create_task(
            v.path(),
            NewTask {
                title: "v1.0 릴리스",
                summary: "첫 배포",
                tags: &[],
                template: Some("릴리스 절차"),
            },
        )
        .unwrap();

        let body = fs::read_to_string(Path::new(&t.folder).join("index.md")).unwrap();
        assert!(body.contains("## 배경"), "template sections reach the task");
        assert!(body.contains("## 검증 항목"));
        // 템플릿에 개요 섹션이 없어도 개요와 Run Log 는 항상 들어간다.
        assert!(body.contains("## 개요\n첫 배포"));
        assert_eq!(t.runs, 1);
        assert!(body.contains("· 업무 생성"));
    }

    #[test]
    fn a_folder_template_is_scanned_and_its_files_are_copied_into_the_task() {
        let v = TempVault::new("tplfolder");
        let src = v.path().join("원본 폴더");
        fs::create_dir_all(src.join("자료")).unwrap();
        fs::write(src.join("index.md"), "---\n---\n## 개요\n\n## 표준 절차\n- [ ] 준비\n").unwrap();
        fs::write(src.join("notes.md"), "템플릿 메모").unwrap();
        fs::write(src.join("자료/체크리스트.md"), "항목").unwrap();

        create_template_from_folder(v.path(), "표준 패키지", "반복 업무용", &src).unwrap();

        let tpls = scan_templates(v.path(), &[]).unwrap();
        let tpl = tpls.iter().find(|t| t.id == "표준 패키지").unwrap();
        assert_eq!(tpl.kind, "folder");
        assert_eq!(tpl.desc, "반복 업무용");
        assert_eq!(tpl.rel_path, "Templates/표준 패키지/");

        let t = create_task(
            v.path(),
            NewTask {
                title: "8월 정기 점검",
                summary: "이번 회차",
                tags: &[],
                template: Some("표준 패키지"),
            },
        )
        .unwrap();
        let folder = PathBuf::from(&t.folder);

        // 파일은 실제로 복사된다 — notes.md 는 이제 템플릿이 준 것만 생긴다.
        assert_eq!(fs::read_to_string(folder.join("notes.md")).unwrap(), "템플릿 메모");
        assert_eq!(fs::read_to_string(folder.join("자료/체크리스트.md")).unwrap(), "항목");

        // 템플릿의 index.md 는 복사되지 않고 *본문 골격*으로만 쓰인다 — frontmatter 는
        // 이 업무의 것이어야 한다.
        let body = fs::read_to_string(folder.join("index.md")).unwrap();
        assert!(body.contains("## 표준 절차"));
        assert!(body.contains("## 개요\n이번 회차"));
        // 템플릿 본문에는 Run Log 앵커를 반드시 붙인다 — 기본 골격과 다른 점이다.
        // 이게 없으면 `count_run_log` 와 `append_run` 이 회차를 놓친다.
        assert!(body.contains("## 실행 이력 (Run Log)"));
        assert!(body.contains("· 업무 생성"));
        assert!(body.contains("template_ref"));
        assert!(!body.contains("template: 표준 패키지"), "template frontmatter must not leak");
        assert!(body.contains("· 업무 생성"));
    }

    #[test]
    fn a_template_name_cannot_be_claimed_twice_across_both_shapes() {
        let v = TempVault::new("tplclash");
        let src = v.path().join("src");
        fs::create_dir_all(&src).unwrap();
        create_template_from_folder(v.path(), "중복", "", &src).unwrap();

        let err = create_template(v.path(), "중복", "", "배경").unwrap_err();
        assert_eq!(err.kind, "already_exists");
    }

    #[test]
    fn merging_folds_run_logs_into_the_primary_and_archives_the_rest() {
        let v = TempVault::new("merge");
        let primary = make(v.path(), "릴리스 노트 v0.3");
        let dup = make(v.path(), "릴리스 노트 v0.2");
        append_run(v.path(), Path::new(&dup.folder), "v0.2 공지 발송").unwrap();

        let merged = merge_tasks(
            v.path(),
            Path::new(&primary.folder),
            &[PathBuf::from(&primary.folder), PathBuf::from(&dup.folder)],
            "tag",
        )
        .unwrap();

        let body = fs::read_to_string(Path::new(&merged.folder).join("index.md")).unwrap();
        assert!(body.contains("v0.2 공지 발송"), "source run log moved into the primary");
        assert!(body.contains("merged_from: 1"));

        // The source is archived, not deleted — no data loss.
        assert!(Path::new(&dup.folder).join("index.md").is_file());
        let src = read_task(v.path(), &Path::new(&dup.folder).join("index.md")).unwrap();
        assert_eq!(src.archived, Some(true));
    }

    #[test]
    fn template_stats_come_from_the_tasks_that_reference_them() {
        let v = TempVault::new("tpl");
        create_template(v.path(), "표준절차", "반복 업무", "배경\n체크리스트").unwrap();
        let t = create_task(
            v.path(),
            NewTask {
                title: "템플릿 사용 업무",
                summary: "요약",
                tags: &[],
                template: Some("표준절차"),
            },
        )
        .unwrap();
        append_run(v.path(), Path::new(&t.folder), "2회차 수행").unwrap();

        let tasks = scan(v.path()).unwrap();
        let templates = scan_templates(v.path(), &tasks).unwrap();
        assert_eq!(templates.len(), 1);
        let tp = &templates[0];
        assert_eq!(tp.name, "표준절차");
        assert_eq!(tp.uses, 2, "creation + one appended run");
        // Two runs across one node = one note that was never created.
        assert_eq!(tp.saved, 1);
        assert!(tp.runs.iter().any(|r| r.text.contains("2회차 수행")));
    }

    #[test]
    fn archive_moc_lists_archived_tasks_with_a_dataview_block() {
        let v = TempVault::new("moc");
        let t = make(v.path(), "보관된 업무");
        let folder = PathBuf::from(&t.folder);
        set_status(v.path(), &folder, "completed").unwrap();
        let archived = set_archived(v.path(), &folder, true, "tag", false).unwrap();

        let path = write_archive_moc(v.path(), &[archived]).unwrap();
        let md = fs::read_to_string(&path).unwrap();
        assert!(md.contains("```dataview"));
        assert!(md.contains("WHERE archived = true"));
        assert!(md.contains("보관된 업무"));
        assert!(path.ends_with("Archive.md"));
    }

    #[test]
    fn full_text_search_finds_content_the_title_filter_cannot() {
        let v = TempVault::new("search");
        let t = make(v.path(), "무관한 제목");
        fs::write(
            Path::new(&t.folder).join("notes.md"),
            "게이트웨이 타임아웃 30초 고정이 원인",
        )
        .unwrap();

        let tasks = scan(v.path()).unwrap();
        let hits = search_full_text(&tasks, "타임아웃");
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("게이트웨이 타임아웃"));
        assert!(search_full_text(&tasks, "존재하지않는단어").is_empty());
    }
}
