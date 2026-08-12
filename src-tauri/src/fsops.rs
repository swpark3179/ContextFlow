//! File-tree listing and mutation inside a single task folder.
//!
//! Every path crossing the IPC boundary is relative to the task folder and is
//! re-joined + canonicalised here, so a crafted `../..` cannot escape the vault.

use crate::error::{AppError, Result};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Extensions we render in the built-in text editor. Superset of the design's
/// `TEXTY` list — anything else falls back to the binary placeholder card.
const TEXT_EXT: &[&str] = &[
    "md", "txt", "csv", "json", "ts", "sql", "ps1", "log", "tsx", "js", "jsx", "mjs", "cjs", "py",
    "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cs", "rb", "php", "toml", "yaml", "yml",
    "xml", "html", "htm", "css", "scss", "ini", "cfg", "conf", "env", "sh", "bash", "bat", "cmd",
    "gitignore", "editorconfig", "properties", "tsv", "diff", "patch",
];

#[derive(Debug, Clone, Serialize)]
pub struct FileNode {
    /// Task-folder-relative path. Directories carry a trailing `/`.
    pub p: String,
    pub name: String,
    pub dir: bool,
    pub size: String,
    pub bytes: u64,
    pub bin: bool,
    /// Resolved target when the entry is a symlink, otherwise `None`.
    pub link: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DeletePreview {
    pub files: u32,
    pub dirs: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub added: Vec<String>,
    /// Names that fell back to copying because a symlink could not be created.
    pub fell_back_to_copy: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// The name actually written, which may carry a ` (2)` suffix.
    pub name: String,
    pub fell_back_to_copy: bool,
}

pub fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((head, ext)) if !head.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

pub fn is_text(name: &str) -> bool {
    let e = ext_of(name);
    !e.is_empty() && TEXT_EXT.contains(&e.as_str())
}

pub fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= MB {
        format!("{:.1} MB", b / MB)
    } else {
        format!("{:.1} KB", b / KB)
    }
}

/// Rejects absolute paths, drive letters and any `..` segment.
pub fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches('/');
    let candidate = Path::new(rel);
    for c in candidate.components() {
        match c {
            Component::Normal(_) => {}
            Component::CurDir => {}
            _ => {
                return Err(AppError::new(
                    "invalid_path",
                    format!("업무 폴더 밖을 가리키는 경로입니다: {}", rel),
                ))
            }
        }
    }
    Ok(base.join(candidate))
}

/// Recursive listing. Hidden files and our own snapshot file are skipped so the
/// tree matches what the user put there.
pub fn list_tree(folder: &Path) -> Result<Vec<FileNode>> {
    let mut out = Vec::new();
    walk(folder, folder, &mut out, 0)?;
    out.sort_by(|a, b| a.p.to_lowercase().cmp(&b.p.to_lowercase()));
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<FileNode>, depth: usize) -> Result<()> {
    if depth > 12 {
        return Ok(()); // guards against symlink loops
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // .context_snapshot.json, .obsidian, ...
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let link = fs::read_link(&path)
            .ok()
            .map(|t| t.to_string_lossy().to_string());
        let mut rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        if meta.is_dir() {
            let is_link = link.is_some();
            rel.push('/');
            out.push(FileNode {
                p: rel,
                name,
                dir: true,
                size: String::new(),
                bytes: 0,
                bin: false,
                link,
            });
            // Do not follow symlinked directories — that is how you get loops.
            if !is_link {
                walk(root, &path, out, depth + 1)?;
            }
        } else {
            out.push(FileNode {
                bin: !is_text(&name),
                size: human_size(meta.len()),
                bytes: meta.len(),
                p: rel,
                name,
                dir: false,
                link,
            });
        }
    }
    Ok(())
}

pub fn create_file(folder: &Path, rel: &str) -> Result<String> {
    let mut rel = rel.trim().to_string();
    // Design rule: a name without an extension becomes a markdown note.
    if !rel.contains('.') {
        rel.push_str(".md");
    }
    let path = safe_join(folder, &rel)?;
    if path.exists() {
        return Err(AppError::new("already_exists", format!("같은 이름의 파일이 이미 있습니다: {}", rel)));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, "")?;
    Ok(rel)
}

pub fn create_dir(folder: &Path, rel: &str) -> Result<String> {
    let rel = rel.trim().trim_end_matches('/').to_string();
    let path = safe_join(folder, &rel)?;
    if path.exists() {
        return Err(AppError::new("already_exists", format!("같은 이름의 폴더가 이미 있습니다: {}", rel)));
    }
    fs::create_dir_all(&path)?;
    Ok(format!("{}/", rel))
}

pub fn preview_delete(folder: &Path, rel: &str) -> Result<DeletePreview> {
    let path = safe_join(folder, rel.trim_end_matches('/'))?;
    let mut files = 0u32;
    let mut dirs = 0u32;
    if path.is_dir() {
        for e in walkdir::WalkDir::new(&path).min_depth(1).into_iter().flatten() {
            if e.file_type().is_dir() {
                dirs += 1;
            } else {
                files += 1;
            }
        }
    } else if path.exists() {
        files = 1;
    }
    Ok(DeletePreview { files, dirs })
}

pub fn delete_path(folder: &Path, rel: &str) -> Result<()> {
    let path = safe_join(folder, rel.trim_end_matches('/'))?;
    if !path.exists() {
        return Err(AppError::new("not_found", format!("대상을 찾을 수 없습니다: {}", rel)));
    }
    // Deleting the task's own index.md would orphan the folder from the vault.
    if path.file_name().and_then(|n| n.to_str()) == Some("index.md")
        && path.parent() == Some(folder)
    {
        return Err(AppError::new(
            "protected",
            "index.md 는 업무의 메타데이터 노트라 삭제할 수 없습니다.",
        ));
    }
    if path.is_dir() {
        fs::remove_dir_all(&path)?;
    } else {
        fs::remove_file(&path)?;
    }
    Ok(())
}

#[cfg(windows)]
fn make_symlink(src: &Path, dest: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::os::windows::fs::symlink_dir(src, dest)
    } else {
        std::os::windows::fs::symlink_file(src, dest)
    }
}

#[cfg(not(windows))]
fn make_symlink(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dest)
}

/// 재귀 복사. `import_files` 외에 폴더 템플릿 등록과 업무 생성(`vault.rs`)도 쓴다.
pub(crate) fn copy_recursive(src: &Path, dest: &Path) -> Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dest)?;
    }
    Ok(())
}

/// First free `dir/name`, appending ` (2)`, ` (3)`… before the extension.
/// Shared by every write that must not clobber an existing entry.
fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let mut dest = dir.join(name);
    if !dest.exists() {
        return dest;
    }
    let as_path = Path::new(name);
    let stem = as_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = as_path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let mut n = 2;
    while dest.exists() {
        dest = dir.join(format!("{} ({}){}", stem, n, ext));
        n += 1;
    }
    dest
}

/// 업무 폴더 안에서 파일·폴더를 옮긴다. 돌려주는 새 상대 경로는 입력과 같은 규약을
/// 따른다 — 폴더는 `/` 로 끝난다(`list_tree` 와 프론트의 트리가 그렇게 읽는다).
pub fn move_path(folder: &Path, rel: &str, target_dir: &str) -> Result<String> {
    let trimmed = rel.trim_end_matches('/');
    let src = safe_join(folder, trimmed)?;
    if !src.exists() {
        return Err(AppError::new("not_found", format!("대상을 찾을 수 없습니다: {}", rel)));
    }
    // index.md 는 업무의 메타데이터 노트다. 하위 폴더로 내려가면 `scan_vault` 가
    // 업무를 못 찾으므로 삭제와 같은 이유로 막는다.
    if src.file_name().and_then(|n| n.to_str()) == Some("index.md") && src.parent() == Some(folder) {
        return Err(AppError::new(
            "protected",
            "index.md 는 업무의 메타데이터 노트라 옮길 수 없습니다.",
        ));
    }

    let dir = safe_join(folder, target_dir.trim_end_matches('/'))?;
    if !dir.is_dir() {
        return Err(AppError::new("not_found", format!("폴더를 찾을 수 없습니다: {}", target_dir)));
    }
    // 폴더를 자기 자신이나 자기 하위로 옮기면 트리가 사라진다.
    if src.is_dir() && dir.starts_with(&src) {
        return Err(AppError::new("invalid_path", "폴더를 자기 자신 아래로 옮길 수 없습니다."));
    }
    if dir == src.parent().map(|p| p.to_path_buf()).unwrap_or_default() {
        return Ok(rel.to_string()); // 이미 그 폴더에 있다
    }

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| AppError::io(format!("이름을 읽을 수 없습니다: {}", rel)))?;
    let dest = unique_dest(&dir, &name);
    fs::rename(&src, &dest)?;

    let mut out = dest
        .strip_prefix(folder)
        .unwrap_or(&dest)
        .to_string_lossy()
        .replace('\\', "/");
    if dest.is_dir() {
        out.push('/');
    }
    Ok(out)
}

/// 업무 폴더 밖(바탕화면)으로 복사하거나 심볼릭 링크를 건다. 링크를 만들 수 없으면
/// `import_files` 와 같은 이유로 복사로 떨어지고, 그 사실을 함께 돌려준다.
pub fn export_path(folder: &Path, rel: &str, dest_dir: &Path, mode: &str) -> Result<ExportResult> {
    let src = safe_join(folder, rel.trim_end_matches('/'))?;
    if !src.exists() {
        return Err(AppError::new("not_found", format!("대상을 찾을 수 없습니다: {}", rel)));
    }
    fs::create_dir_all(dest_dir)?;
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| AppError::io(format!("이름을 읽을 수 없습니다: {}", rel)))?;
    let dest = unique_dest(dest_dir, &name);

    let mut fell_back = false;
    if mode == "link" {
        if make_symlink(&src, &dest).is_err() {
            copy_recursive(&src, &dest)?;
            fell_back = true;
        }
    } else {
        copy_recursive(&src, &dest)?;
    }

    Ok(ExportResult {
        name: dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name),
        fell_back_to_copy: fell_back,
    })
}

/// `mode` is `copy` or `link`. Creating a symlink on Windows needs Developer
/// Mode or elevation; rather than failing the whole import we copy instead and
/// report which items fell back so the UI can say so plainly.
pub fn import_files(
    folder: &Path,
    target_rel: &str,
    sources: &[String],
    mode: &str,
) -> Result<ImportResult> {
    let target = safe_join(folder, target_rel)?;
    fs::create_dir_all(&target)?;

    let mut added = Vec::new();
    let mut fell_back = Vec::new();

    for src in sources {
        let src_path = PathBuf::from(src);
        let name = src_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| AppError::io(format!("파일 이름을 읽을 수 없습니다: {}", src)))?;

        let dest = unique_dest(&target, &name);

        if mode == "link" {
            match make_symlink(&src_path, &dest) {
                Ok(()) => {}
                Err(_) => {
                    copy_recursive(&src_path, &dest)?;
                    fell_back.push(name.clone());
                }
            }
        } else {
            copy_recursive(&src_path, &dest)?;
        }

        let rel = dest
            .strip_prefix(folder)
            .unwrap_or(&dest)
            .to_string_lossy()
            .replace('\\', "/");
        added.push(rel);
    }

    Ok(ImportResult { added, fell_back_to_copy: fell_back })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_text_and_binary_by_extension() {
        assert!(is_text("index.md"));
        assert!(is_text("tauri.conf.json"));
        assert!(is_text("backup.ps1"));
        assert!(!is_text("shot.png"));
        assert!(!is_text("guide.pdf"));
        assert!(!is_text("noextension"));
    }

    #[test]
    fn formats_sizes_like_the_design() {
        assert_eq!(human_size(2150), "2.1 KB");
        assert_eq!(human_size(0), "0.0 KB");
        assert_eq!(human_size(2_411_724), "2.3 MB");
    }

    #[test]
    fn safe_join_blocks_escapes() {
        let base = Path::new("C:/vault/Tasks/x");
        assert!(safe_join(base, "refs/a.md").is_ok());
        assert!(safe_join(base, "../../../etc/passwd").is_err());
        assert!(safe_join(base, "..").is_err());
        assert!(safe_join(base, "C:/Windows/system32").is_err());
    }

    // -- on-disk behaviour ---------------------------------------------------

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "contextflow-fs-{}-{}",
                tag,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn extensionless_names_become_markdown_notes() {
        let d = TempDir::new("mk");
        assert_eq!(create_file(d.path(), "회의록").unwrap(), "회의록.md");
        assert_eq!(create_file(d.path(), "data.csv").unwrap(), "data.csv");
        assert!(d.path().join("회의록.md").is_file());
    }

    #[test]
    fn creating_over_an_existing_name_is_refused_not_overwritten() {
        let d = TempDir::new("clash");
        fs::write(d.path().join("index.md"), "원본 내용").unwrap();
        let err = create_file(d.path(), "index.md").unwrap_err();
        assert_eq!(err.kind, "already_exists");
        assert_eq!(fs::read_to_string(d.path().join("index.md")).unwrap(), "원본 내용");
    }

    #[test]
    fn nested_paths_create_their_parent_directories() {
        let d = TempDir::new("nested");
        create_file(d.path(), "refs/deep/note.md").unwrap();
        assert!(d.path().join("refs/deep/note.md").is_file());
    }

    #[test]
    fn tree_listing_nests_and_flags_binaries_and_hidden_files() {
        let d = TempDir::new("tree");
        fs::create_dir_all(d.path().join("refs")).unwrap();
        fs::write(d.path().join("index.md"), "x").unwrap();
        fs::write(d.path().join("refs/shot.png"), [0u8; 16]).unwrap();
        fs::write(d.path().join(".context_snapshot.json"), "{}").unwrap();

        let rows = list_tree(d.path()).unwrap();
        let paths: Vec<&str> = rows.iter().map(|r| r.p.as_str()).collect();
        assert!(paths.contains(&"index.md"));
        assert!(paths.contains(&"refs/"));
        assert!(paths.contains(&"refs/shot.png"));
        // Our own snapshot file must never show up in the user's tree.
        assert!(!paths.iter().any(|p| p.starts_with(".context_snapshot")));

        let png = rows.iter().find(|r| r.p == "refs/shot.png").unwrap();
        assert!(png.bin);
        assert!(!rows.iter().find(|r| r.p == "index.md").unwrap().bin);
        assert!(rows.iter().find(|r| r.p == "refs/").unwrap().dir);
    }

    #[test]
    fn delete_counts_children_before_removing_them() {
        let d = TempDir::new("del");
        fs::create_dir_all(d.path().join("refs/deep")).unwrap();
        fs::write(d.path().join("refs/a.md"), "a").unwrap();
        fs::write(d.path().join("refs/deep/b.md"), "b").unwrap();

        let preview = preview_delete(d.path(), "refs/").unwrap();
        assert_eq!(preview.files, 2);
        assert_eq!(preview.dirs, 1);

        delete_path(d.path(), "refs/").unwrap();
        assert!(!d.path().join("refs").exists());
    }

    #[test]
    fn the_task_index_note_cannot_be_deleted() {
        let d = TempDir::new("protect");
        fs::write(d.path().join("index.md"), "메타데이터").unwrap();
        let err = delete_path(d.path(), "index.md").unwrap_err();
        assert_eq!(err.kind, "protected");
        assert!(d.path().join("index.md").is_file());
    }

    #[test]
    fn move_relocates_into_a_folder_and_disambiguates_clashes() {
        let d = TempDir::new("move");
        fs::create_dir_all(d.path().join("refs")).unwrap();
        fs::write(d.path().join("a.md"), "새 내용").unwrap();
        fs::write(d.path().join("refs/a.md"), "이미 있는 내용").unwrap();

        assert_eq!(move_path(d.path(), "a.md", "refs/").unwrap(), "refs/a (2).md");
        assert!(!d.path().join("a.md").exists());
        assert_eq!(fs::read_to_string(d.path().join("refs/a.md")).unwrap(), "이미 있는 내용");
        assert_eq!(fs::read_to_string(d.path().join("refs/a (2).md")).unwrap(), "새 내용");
    }

    #[test]
    fn move_reports_folders_with_a_trailing_slash_and_carries_children() {
        let d = TempDir::new("movedir");
        fs::create_dir_all(d.path().join("refs/deep")).unwrap();
        fs::create_dir_all(d.path().join("attachments")).unwrap();
        fs::write(d.path().join("refs/deep/b.md"), "b").unwrap();

        assert_eq!(move_path(d.path(), "refs/", "attachments/").unwrap(), "attachments/refs/");
        assert!(d.path().join("attachments/refs/deep/b.md").is_file());
    }

    #[test]
    fn move_refuses_the_index_note_and_self_nesting() {
        let d = TempDir::new("moveguard");
        fs::create_dir_all(d.path().join("refs/deep")).unwrap();
        fs::write(d.path().join("index.md"), "메타데이터").unwrap();

        assert_eq!(move_path(d.path(), "index.md", "refs/").unwrap_err().kind, "protected");
        assert!(d.path().join("index.md").is_file());

        assert_eq!(move_path(d.path(), "refs/", "refs/deep/").unwrap_err().kind, "invalid_path");
        assert!(d.path().join("refs/deep").is_dir());
    }

    #[test]
    fn move_to_an_empty_target_lands_at_the_task_root() {
        let d = TempDir::new("moveroot");
        fs::create_dir_all(d.path().join("refs")).unwrap();
        fs::write(d.path().join("refs/a.md"), "내용").unwrap();

        assert_eq!(move_path(d.path(), "refs/a.md", "").unwrap(), "a.md");
        assert!(d.path().join("a.md").is_file());
        assert!(!d.path().join("refs/a.md").exists());
    }

    #[test]
    fn move_into_the_current_folder_is_a_no_op() {
        let d = TempDir::new("movesame");
        fs::create_dir_all(d.path().join("refs")).unwrap();
        fs::write(d.path().join("refs/a.md"), "내용").unwrap();

        assert_eq!(move_path(d.path(), "refs/a.md", "refs/").unwrap(), "refs/a.md");
        assert_eq!(fs::read_to_string(d.path().join("refs/a.md")).unwrap(), "내용");
    }

    #[test]
    fn export_copies_out_of_the_task_without_touching_the_original() {
        let task = TempDir::new("exp");
        let desk = TempDir::new("desk");
        fs::write(task.path().join("보고서.md"), "본문").unwrap();
        fs::write(desk.path().join("보고서.md"), "바탕화면에 이미 있던 것").unwrap();

        let res = export_path(task.path(), "보고서.md", desk.path(), "copy").unwrap();
        assert_eq!(res.name, "보고서 (2).md");
        assert!(!res.fell_back_to_copy);
        assert!(task.path().join("보고서.md").is_file());
        assert_eq!(fs::read_to_string(desk.path().join("보고서 (2).md")).unwrap(), "본문");
    }

    #[test]
    fn export_link_mode_lands_the_file_even_without_symlink_privilege() {
        let task = TempDir::new("explink");
        let desk = TempDir::new("desklink");
        fs::write(task.path().join("a.md"), "본문").unwrap();

        let res = export_path(task.path(), "a.md", desk.path(), "link").unwrap();
        // 링크가 만들어졌든 복사로 떨어졌든, 바탕화면에서 내용이 읽혀야 한다.
        assert_eq!(fs::read_to_string(desk.path().join(&res.name)).unwrap(), "본문");
    }

    #[test]
    fn import_copies_files_and_disambiguates_name_clashes() {
        let src = TempDir::new("src");
        let dest = TempDir::new("dest");
        fs::write(src.path().join("기획서.md"), "외부 내용").unwrap();
        fs::write(dest.path().join("기획서.md"), "이미 있는 내용").unwrap();

        let sources = vec![src.path().join("기획서.md").to_string_lossy().to_string()];
        let res = import_files(dest.path(), "", &sources, "copy").unwrap();

        assert_eq!(res.added, vec!["기획서 (2).md"]);
        // The pre-existing file is untouched.
        assert_eq!(fs::read_to_string(dest.path().join("기획서.md")).unwrap(), "이미 있는 내용");
        assert_eq!(fs::read_to_string(dest.path().join("기획서 (2).md")).unwrap(), "외부 내용");
    }

    #[test]
    fn import_into_a_subfolder_creates_it() {
        let src = TempDir::new("src2");
        let dest = TempDir::new("dest2");
        fs::write(src.path().join("shot.png"), [0u8; 8]).unwrap();
        let sources = vec![src.path().join("shot.png").to_string_lossy().to_string()];

        let res = import_files(dest.path(), "attachments/", &sources, "copy").unwrap();
        assert_eq!(res.added, vec!["attachments/shot.png"]);
        assert!(dest.path().join("attachments/shot.png").is_file());
        assert!(res.fell_back_to_copy.is_empty());
    }

    #[test]
    fn link_mode_always_lands_the_file_even_without_symlink_privilege() {
        let src = TempDir::new("src3");
        let dest = TempDir::new("dest3");
        fs::write(src.path().join("공용자료.md"), "원본").unwrap();
        let sources = vec![src.path().join("공용자료.md").to_string_lossy().to_string()];

        let res = import_files(dest.path(), "", &sources, "link").unwrap();
        assert_eq!(res.added, vec!["공용자료.md"]);
        // Either a symlink was made or we copied — either way the file resolves,
        // and a fallback is reported rather than silently swallowed.
        assert_eq!(fs::read_to_string(dest.path().join("공용자료.md")).unwrap(), "원본");
        assert!(res.fell_back_to_copy.is_empty() || res.fell_back_to_copy == vec!["공용자료.md"]);
    }
}
