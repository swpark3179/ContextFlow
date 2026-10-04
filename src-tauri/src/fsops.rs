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

/// 옮기기가 막혔을 때 **왜** 막혔는지 짚어 본다 — 다른 프로그램이 쥐고 있는 파일들의
/// `root` 기준 상대 경로를 `limit` 개까지 돌려준다.
///
/// Windows 는 열려 있는 파일을 쥔 채로는 그 파일도, 그것을 담은 폴더도 옮기지 못한다
/// (공유 위반). 그것이 사용자가 손쓸 수 있는 거의 유일한 사유이므로, "옮길 수 없습니다"
/// 로 끝내지 않고 **어느 파일을 닫아야 하는지**까지 말해 준다. 쓰기로 열어 보는 것이
/// 그 판정이고, 열렸으면 아무것도 쓰지 않고 곧바로 닫는다(`write(true)` 는 자르지 않는다).
///
/// **실패한 뒤에만** 부른다. 미리 훑어 막는 데 쓰면 읽기 전용 속성처럼 이동과 무관한
/// 것까지 걸려 멀쩡한 조작을 막는다. 강제 락이 없는 Unix 에서는 보통 빈 목록이고,
/// 그래도 부르는 쪽이 OS 오류 메시지를 함께 싣기 때문에 사유가 비지는 않는다.
pub(crate) fn busy_files(root: &Path, limit: usize) -> Vec<String> {
    let probe = |path: &Path| -> bool {
        match fs::OpenOptions::new().write(true).open(path) {
            Ok(_) => false,
            // 이미 없는 파일은 이동을 막는 이유가 아니다.
            Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        }
    };

    if root.is_file() {
        let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        return if probe(root) { vec![name] } else { Vec::new() };
    }

    let mut out = Vec::new();
    for e in walkdir::WalkDir::new(root).min_depth(1).into_iter().flatten() {
        if out.len() >= limit {
            break;
        }
        if e.file_type().is_file() && probe(e.path()) {
            out.push(
                e.path()
                    .strip_prefix(root)
                    .unwrap_or(e.path())
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
    out
}

/// 붙여넣기로 받을 수 있는 이미지 확장자. 웹뷰가 클립보드에서 내주는 형식이 이 범위다.
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// 스크린샷 한 장으로는 넉넉하고, 실수로 거대한 데이터를 업무 폴더에 쏟지 않을 상한.
const IMAGE_MAX: usize = 32 * 1024 * 1024;

/// 붙여넣은 이미지가 모이는 폴더. 업무 폴더 최상위 바로 아래이며, 없으면 만든다.
const IMAGE_DIR: &str = "images";

/// 클립보드에서 붙여넣은 이미지를 **업무 폴더 최상위의 `images/`** 에 저장하고, 업무 폴더
/// 기준 경로(`images/image-….png`)를 돌려준다. 노트에서 가리키는 상대 경로는 노트가 어느
/// 폴더에 있느냐에 따라 달라지므로 부르는 쪽(`relativeFromNote`)이 만든다.
///
/// `note_rel` 은 저장 위치를 정하지 않지만, 업무 폴더 밖을 가리키는 노트에서 온 요청은
/// 그대로 거절한다.
///
/// 이름은 `image-YYYYMMDD-HHMMSS.png` 다. 공백도 한글도 넣지 않는다 — 마크다운 링크의
/// 경로에 그대로 들어가므로, 인코딩 없이 Obsidian 과 이 뷰어 양쪽에서 똑같이 읽혀야 한다.
/// 같은 초에 두 장을 붙이면 `-2`, `-3` 을 붙인다(`unique_dest` 의 ` (2)` 는 공백이 든다).
/// 이미 있는 파일은 절대 덮어쓰지 않는다(`create_new`).
pub fn save_image(folder: &Path, note_rel: &str, ext: &str, bytes: &[u8]) -> Result<String> {
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if !IMAGE_EXT.contains(&ext.as_str()) {
        return Err(AppError::new("invalid_image", format!("지원하지 않는 이미지 형식입니다: {}", ext)));
    }
    if bytes.is_empty() {
        return Err(AppError::new("invalid_image", "이미지 데이터가 비어 있습니다"));
    }
    if bytes.len() > IMAGE_MAX {
        return Err(AppError::new(
            "invalid_image",
            format!("이미지가 너무 큽니다 ({})", human_size(bytes.len() as u64)),
        ));
    }
    safe_join(folder, note_rel)?;
    let dir = folder.join(IMAGE_DIR);
    fs::create_dir_all(&dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    for n in 1..1000 {
        let name = if n == 1 {
            format!("image-{}.{}", stamp, ext)
        } else {
            format!("image-{}-{}.{}", stamp, n, ext)
        };
        let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(dir.join(&name)) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        };
        use std::io::Write;
        if let Err(e) = file.write_all(bytes) {
            drop(file);
            let _ = fs::remove_file(dir.join(&name));
            return Err(e.into());
        }
        return Ok(format!("{}/{}", IMAGE_DIR, name));
    }
    Err(AppError::new("already_exists", "이미지 파일 이름을 정하지 못했습니다"))
}

/// First free `dir/name`, appending ` (2)`, ` (3)`… before the extension.
/// Shared by every write that must not clobber an existing entry.
pub(crate) fn unique_dest(dir: &Path, name: &str) -> PathBuf {
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

/// 임시 파일에 쓴 뒤 이름을 바꾼다 — 쓰는 도중 앱이 죽어도 반쯤 쓴 노트가 남지 않는다.
/// 앱이 통째로 만드는 노트(위키 · 색인 · 허브 · 보관함 MOC)가 쓴다.
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, text)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

/// 지금 바이트와 다를 때만 쓴다(`write_atomic`). 돌려주는 값은 실제로 썼는지다 — 수정
/// 시각만 바뀌어도 OneDrive · Git 같은 동기화 도구는 바뀐 파일로 잡는다.
pub(crate) fn write_if_changed(path: &Path, text: &str) -> Result<bool> {
    if fs::read(path).is_ok_and(|bytes| bytes == text.as_bytes()) {
        return Ok(false);
    }
    write_atomic(path, text)?;
    Ok(true)
}

/// 사용자가 손으로도 고치는 노트(업무 `index.md` · 편집기 저장 · 설정)를 **원자적으로** 바꿔 쓴다.
/// 같은 폴더의 숨김 임시 파일에 다 쓰고 `fsync` 한 뒤 이름을 바꿔 끼운다 — 쓰다 끊겨도(앱 종료 ·
/// 정전 · 동기화 도구) 원본은 옛 내용 그대로 남고, 반쯤 쓴 파일이 생기지 않는다.
///
/// `write_atomic` 과 다른 점은 **실패해도 오늘보다 나빠지지 않는다**는 것이다. 바꿔 끼울 수 없는
/// 대상(`swap_target`)이거나 임시 파일 쓰기 · 이름 바꾸기가 막히면 임시 파일을 지우고 예전처럼 그
/// 자리에서 쓴다(`fs::write`). 돌려주는 오류도 그 쓰기의 것이라, 오류 종류 · 문구가 예전과 같고
/// 예전에 되던 쓰기가 실패로 바뀌지 않는다. 앱이 통째로 만드는 노트는 계속 `write_atomic` 을 쓴다 —
/// 허브 · 위키 테스트가 그쪽의 실패 동작에 기댄다.
pub(crate) fn replace_text(path: &Path, text: &str) -> Result<()> {
    if let Some(meta) = swap_target(path) {
        if swap_in(path, &meta, text.as_bytes()).is_ok() {
            return Ok(());
        }
    }
    fs::write(path, text)?;
    Ok(())
}

/// 바꿔 끼워도 되는 파일이면 그 메타데이터를, 아니면 `None`(그 자리에서 쓴다)을 돌려준다.
///
/// * 없는 파일 — 지킬 원본이 없다.
/// * 심볼릭 링크(Windows junction · WSL 링크 포함) — 바꿔 끼우면 링크가 일반 파일이 되어 대상과
///   끊어진다. 그 자리에서 쓰면 대상에 쓰인다.
/// * 일반 파일이 아닌 것 — 폴더 · 장치. 오류도 `fs::write` 가 예전 그대로 낸다.
/// * 쓰기로 열리지 않는 파일 — 읽기 전용 · 다른 프로그램이 쥔 파일. 바꿔 끼우면 예전에 막히던
///   쓰기가 몰래 통과한다. 자르지 않고(`write(true)`) 열어 보기만 하고 곧바로 닫는다.
/// * 하드 링크(Unix `nlink > 1`) — 바꿔 끼우면 다른 이름들이 옛 내용에 남는다.
/// * 숨김 · 시스템 · 암호화(EFS) 속성(Windows) — 바꿔 끼운 파일은 그 속성을 잃는다.
fn swap_target(path: &Path) -> Option<fs::Metadata> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    fs::OpenOptions::new().write(true).open(path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return None;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        const FILE_ATTRIBUTE_ENCRYPTED: u32 = 0x4000;
        let keep = FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_ENCRYPTED;
        if meta.file_attributes() & keep != 0 {
            return None;
        }
    }
    Some(meta)
}

/// 임시 파일 이름의 일련번호 — 같은 프로세스가 같은 파일을 겹쳐 써도 이름이 부딪히지 않는다.
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// `path` 옆의 임시 파일 이름 `.{파일이름}.{pid}-{n}.tmp`. 점으로 시작하므로 파일 트리(`list_tree`) ·
/// 위키 훑기 · Obsidian 이 모두 건너뛴다 — 쓰다 죽어 남더라도 눈에 띄지 않는다.
fn tmp_sibling(path: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let n = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    path.with_file_name(format!(".{}.{}-{}.tmp", name.to_string_lossy(), std::process::id(), n))
}

/// 임시 파일에 쓰고 원본 자리로 바꿔 끼운다. 어디서 막히든 임시 파일을 지우고 오류를 돌려준다.
fn swap_in(path: &Path, meta: &fs::Metadata, bytes: &[u8]) -> std::io::Result<()> {
    let name =
        path.file_name().ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // 이미 있는 이름은 절대 덮어쓰지 않는다(`create_new`) — 다른 쓰기의 임시 파일일 수 있다.
    let mut made = None;
    for _ in 0..8 {
        let tmp = tmp_sibling(path, name);
        match fs::OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => {
                made = Some((tmp, file));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    let (tmp, file) =
        made.ok_or_else(|| std::io::Error::from(std::io::ErrorKind::AlreadyExists))?;
    let done = fill_tmp(file, meta, bytes).and_then(|()| rename_retrying(&tmp, path));
    if done.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    done
}

/// 임시 파일에 내용을 쓰고 원본의 메타데이터를 옮긴다. 핸들은 여기서 닫힌다.
///
/// `sync_all` 은 맨 끝이다 — 권한 · 만든 시각까지 디스크에 내려간 뒤에 이름을 바꿔야, 바꾼 직후
/// 끊겨도 내용과 메타데이터가 함께 남는다.
fn fill_tmp(mut file: fs::File, meta: &fs::Metadata, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    file.write_all(bytes)?;
    // 새 파일은 쓰는 사람의 소유 · umask 기본 권한으로 생긴다. 원래 소유자를 먼저 옮기고(chown 이
    // setuid 같은 비트를 지울 수 있어 권한보다 앞이다) 0o640 같은 권한 비트를 옮긴다. 남의 파일이라
    // 소유자를 옮길 수 없으면 여기서 실패해 그 자리 쓰기로 돌아간다 — 소유자가 바뀌지 않는다.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::os::unix::fs::fchown(&file, Some(meta.uid()), Some(meta.gid()))?;
        file.set_permissions(meta.permissions())?;
    }
    // 바꿔 끼운 파일은 새 파일이라 만든 시각이 지금이 된다. 그러면 Obsidian 의 "만든 시각" 정렬이
    // 저장할 때마다 바뀌므로 원본의 값을 옮긴다(Windows · macOS 만 만든 시각을 고칠 수 있다).
    #[cfg(any(windows, target_os = "macos"))]
    {
        #[cfg(target_os = "macos")]
        use std::os::macos::fs::FileTimesExt;
        #[cfg(windows)]
        use std::os::windows::fs::FileTimesExt;
        if let Ok(created) = meta.created() {
            file.set_times(fs::FileTimes::new().set_created(created))?;
        }
    }
    file.sync_all()
}

/// 임시 파일을 원본 자리로 옮긴다. Windows 에서는 OneDrive · 백신이 갓 쓴 파일이나 원본을 잠깐
/// 쥐고 있으면 접근 거부(5) · 공유 위반(32) · 잠금 위반(33) 이 나므로 20 · 50 · 100ms 쉬며 세 번
/// 다시 시도한다. 그래도 막히면 부르는 쪽이 그 자리 쓰기로 돌아간다.
fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        for wait in [20, 50, 100] {
            match fs::rename(from, to) {
                Err(e) if matches!(e.raw_os_error(), Some(5 | 32 | 33)) => {
                    std::thread::sleep(std::time::Duration::from_millis(wait));
                }
                done => return done,
            }
        }
    }
    fs::rename(from, to)
}

/// 마크다운 링크 경로의 퍼센트 인코딩. 한글은 그대로 두고 링크를 끊는 문자만 바꾼다 —
/// Obsidian 과 이 앱의 뷰어가 둘 다 그대로 읽는다.
pub(crate) fn encode_link(path: &str) -> String {
    let mut out = String::new();
    for c in path.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '[' => out.push_str("%5B"),
            ']' => out.push_str("%5D"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            c => out.push(c),
        }
    }
    out
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

/// 이름에 쓸 수 없는 글자. Windows 가 막는 것들에 경로 구분자를 더한다 — 여기서 받는
/// 것은 **이름 하나**이지 경로가 아니다.
const BAD_NAME_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

/// 업무 폴더 안에서 파일·폴더의 **이름만** 바꾼다. 있던 자리는 그대로다.
///
/// 돌려주는 새 상대 경로는 `move_path` 와 같은 규약을 따른다 — 폴더는 `/` 로 끝난다.
/// 이름을 고쳐 쓰지 않고 **거절하는** 쪽을 고른 이유는, 조용히 다른 이름으로 만들어 두면
/// 사용자가 적은 이름과 트리에 나타난 이름이 갈라지기 때문이다.
pub fn rename_path(folder: &Path, rel: &str, new_name: &str) -> Result<String> {
    // 끝의 점과 공백은 Windows 가 파일 이름에서 잘라 버린다 — 적힌 대로 만들어지지
    // 않을 이름이라 여기서 미리 다듬는다.
    let name = new_name.trim().trim_end_matches('.').trim();
    if name.is_empty() {
        return Err(AppError::new("invalid", "새 이름이 비어 있습니다"));
    }
    if name.contains(BAD_NAME_CHARS) || name.chars().any(|c| (c as u32) < 0x20) {
        return Err(AppError::new(
            "invalid_path",
            r#"이름에 \ / : * ? " < > | 는 쓸 수 없습니다."#,
        ));
    }
    // 점으로 시작하는 이름은 `list_tree` 가 건너뛴다 — 바꾸는 순간 트리에서 사라진다.
    if name.starts_with('.') {
        return Err(AppError::new(
            "invalid_path",
            "점으로 시작하는 이름은 탐색기에 나타나지 않습니다.",
        ));
    }

    let trimmed = rel.trim_end_matches('/');
    let src = safe_join(folder, trimmed)?;
    if !src.exists() {
        return Err(AppError::new("not_found", format!("대상을 찾을 수 없습니다: {}", rel)));
    }
    // index.md 는 업무의 메타데이터 노트다. 이름이 바뀌면 `scan` 이 그 업무를 통째로
    // 놓치므로 삭제·이동과 같은 이유로 막는다.
    if src.file_name().and_then(|n| n.to_str()) == Some("index.md") && src.parent() == Some(folder) {
        return Err(AppError::new(
            "protected",
            "index.md 는 업무의 메타데이터 노트라 이름을 바꿀 수 없습니다.",
        ));
    }

    let current = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| AppError::io(format!("이름을 읽을 수 없습니다: {}", rel)))?;
    if current == name {
        return Ok(rel.to_string()); // 바뀐 것이 없다
    }
    let parent = src
        .parent()
        .ok_or_else(|| AppError::io(format!("상위 폴더를 찾을 수 없습니다: {}", rel)))?;
    let dest = parent.join(name);
    // 대소문자만 바꾸는 것은 자기 자신을 가리킨다. 대소문자를 구분하지 않는
    // 파일시스템(Windows)에서는 `exists()` 가 참이 되지만 막을 이유가 없다.
    if dest.exists() && !current.eq_ignore_ascii_case(name) {
        return Err(AppError::new(
            "already_exists",
            format!("같은 이름이 이미 있습니다: {}", name),
        ));
    }
    let is_dir = src.is_dir();
    fs::rename(&src, &dest)?;

    let mut out = dest
        .strip_prefix(folder)
        .unwrap_or(&dest)
        .to_string_lossy()
        .replace('\\', "/");
    if is_dir {
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
    fn write_if_changed_leaves_identical_bytes_alone() {
        let d = TempDir::new("write-if-changed");
        let path = d.path().join("새 폴더/노트.md");
        assert!(write_if_changed(&path, "하나\n").unwrap());
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        assert!(!write_if_changed(&path, "하나\n").unwrap());
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old);
        assert!(write_if_changed(&path, "둘\n").unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "둘\n");
        assert!(!path.with_extension("md.tmp").exists());
    }

    // -- replace_text --------------------------------------------------------

    /// 폴더에 든 이름들. 임시 파일이 남았는지 본다.
    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[cfg(unix)]
    fn ino(path: &Path) -> u64 {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(path).unwrap().ino()
    }

    #[test]
    fn replace_text_swaps_the_file_in_and_leaves_no_temp_file() {
        let d = TempDir::new("replace");
        let path = d.path().join("노트.md");
        // 없는 파일은 그 자리에서 만든다.
        replace_text(&path, "하나\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "하나\n");
        #[cfg(unix)]
        let before = ino(&path);

        replace_text(&path, "둘\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "둘\n");
        assert_eq!(names_in(d.path()), ["노트.md"]);
        // 다른 inode — 그 자리 쓰기가 아니라 바꿔 끼웠다.
        #[cfg(unix)]
        assert_ne!(ino(&path), before);
    }

    /// 쓰다 죽어 임시 파일이 남아도 파일 트리에는 나타나지 않는다(점으로 시작한다).
    #[test]
    fn a_stray_temp_file_never_shows_in_the_tree() {
        let d = TempDir::new("replace-tree");
        let path = d.path().join("회의록.md");
        fs::write(&path, "본문").unwrap();
        let tmp = tmp_sibling(&path, path.file_name().unwrap());
        let name = tmp.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with(".회의록.md.") && name.ends_with(".tmp"), "{name}");
        assert_eq!(tmp.parent(), path.parent());
        fs::write(&tmp, "반쯤 쓴 내용").unwrap();

        let rows = list_tree(d.path()).unwrap();
        let paths: Vec<&str> = rows.iter().map(|r| r.p.as_str()).collect();
        assert_eq!(paths, ["회의록.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn replace_text_writes_a_symlinked_note_through_to_its_target() {
        let d = TempDir::new("replace-link");
        let target = d.path().join("원본.md");
        let link = d.path().join("링크.md");
        fs::write(&target, "옛 내용").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        replace_text(&link, "새 내용").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "새 내용");
        assert_eq!(names_in(d.path()), ["링크.md", "원본.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn replace_text_keeps_the_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let d = TempDir::new("replace-mode");
        let path = d.path().join("설정.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let before = ino(&path);

        replace_text(&path, "{\"a\":1}").unwrap();
        assert_ne!(ino(&path), before, "바꿔 끼운 길을 지나야 권한 복사를 시험한다");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");
    }

    /// 바꿔 끼운 파일도 원래 소유자 그대로다. 남의 파일을 옮길 수 있는 건 루트뿐이라 루트일 때만 본다
    /// (루트가 아니면 소유자를 옮길 일이 없다 — 남의 파일은 그 자리 쓰기로 돌아간다).
    #[cfg(unix)]
    #[test]
    fn replace_text_keeps_the_owner() {
        use std::os::unix::fs::MetadataExt;
        let d = TempDir::new("replace-owner");
        let path = d.path().join("노트.md");
        fs::write(&path, "옛 내용").unwrap();
        if std::os::unix::fs::chown(&path, Some(54321), Some(54322)).is_err() {
            return;
        }
        let before = ino(&path);

        replace_text(&path, "새 내용").unwrap();
        let meta = fs::metadata(&path).unwrap();
        assert_ne!(ino(&path), before, "바꿔 끼운 길을 지나야 소유자 복사를 시험한다");
        assert_eq!((meta.uid(), meta.gid()), (54321, 54322));
        assert_eq!(fs::read_to_string(&path).unwrap(), "새 내용");
    }

    /// 하드 링크를 바꿔 끼우면 다른 이름이 옛 내용에 남는다 — 그 자리에서 쓴다.
    #[cfg(unix)]
    #[test]
    fn replace_text_writes_hard_links_in_place() {
        let d = TempDir::new("replace-hardlink");
        let a = d.path().join("a.md");
        let b = d.path().join("b.md");
        fs::write(&a, "옛 내용").unwrap();
        fs::hard_link(&a, &b).unwrap();
        let before = ino(&a);

        replace_text(&a, "새 내용").unwrap();
        assert_eq!(ino(&a), before);
        assert_eq!(fs::read_to_string(&b).unwrap(), "새 내용");
        assert_eq!(names_in(d.path()), ["a.md", "b.md"]);
    }

    /// 폴더에 쓸 수 없으면 임시 파일을 만들지 못한다 — 그 자리 쓰기로 돌아간다. 루트로 돌면 폴더
    /// 권한이 막지 못해 바꿔 끼우는 길로 가지만, 어느 쪽이든 내용이 맞고 임시 파일이 없어야 한다.
    #[cfg(unix)]
    #[test]
    fn replace_text_falls_back_in_place_in_a_read_only_folder() {
        use std::os::unix::fs::PermissionsExt;
        struct Unlock(PathBuf);
        impl Drop for Unlock {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }

        let d = TempDir::new("replace-ro-dir");
        let dir = d.path().join("잠긴 폴더");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("노트.md");
        fs::write(&path, "옛 내용").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let _unlock = Unlock(dir.clone());

        replace_text(&path, "새 내용").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "새 내용");
        assert_eq!(names_in(&dir), ["노트.md"]);
    }

    /// 임시 파일 이름이 너무 길어 만들 수 없을 때도 그 자리 쓰기로 돌아간다 — 권한과 상관없이
    /// 되돌아가는 길을 지나는 경우다.
    #[test]
    fn replace_text_falls_back_in_place_when_the_temp_name_is_too_long() {
        let d = TempDir::new("replace-long");
        // 249 바이트 — 파일 이름으로는 되지만 `.{이름}.{pid}-{n}.tmp` 는 pid · 일련번호가 한 자리여도
        // 258 바이트라 255 를 넘는다(더 짧으면 pid 가 짧은 날에만 임시 이름이 들어가 흔들린다).
        let path = d.path().join(format!("{}.md", "가".repeat(82)));
        fs::write(&path, "옛 내용").unwrap();
        #[cfg(unix)]
        let before = ino(&path);

        replace_text(&path, "새 내용").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "새 내용");
        assert_eq!(names_in(d.path()).len(), 1);
        #[cfg(unix)]
        assert_eq!(ino(&path), before);
    }

    /// 쓰기로 열리지 않는 파일은 바꿔 끼우지 않는다 — 예전 `fs::write` 와 같은 결과 · 오류다.
    /// 읽기 전용 파일을 이름 바꾸기로 몰래 덮지 않는다(루트는 둘 다 쓴다).
    #[cfg(unix)]
    #[test]
    fn replace_text_does_not_sneak_past_a_read_only_file() {
        use std::os::unix::fs::PermissionsExt;
        let d = TempDir::new("replace-ro-file");
        let path = d.path().join("잠긴 노트.md");
        fs::write(&path, "옛 내용").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let writable = fs::OpenOptions::new().write(true).open(&path).is_ok();

        match replace_text(&path, "새 내용") {
            Ok(()) => {
                assert!(writable);
                assert_eq!(fs::read_to_string(&path).unwrap(), "새 내용");
            }
            Err(e) => {
                assert!(!writable);
                assert_eq!(e.kind, "permission_denied");
                assert_eq!(fs::read_to_string(&path).unwrap(), "옛 내용");
            }
        }
        assert_eq!(names_in(d.path()), ["잠긴 노트.md"]);
    }

    /// 위키 · 허브 · 보관함 MOC 가 함께 쓴다 — 한글은 그대로, 링크를 끊는 글자만 바꾼다.
    #[test]
    fn encode_link_escapes_only_link_breakers() {
        assert_eq!(
            encode_link("../Tasks/[2026-10] 보고서 (초안)#1 100%/index.md"),
            "../Tasks/%5B2026-10%5D%20보고서%20%28초안%29%231%20100%25/index.md"
        );
    }

    #[test]
    fn pasted_images_land_in_top_level_images_without_clobbering() {
        let d = TempDir::new("img");
        assert!(!d.path().join("images").exists());
        let a = save_image(d.path(), "refs/회의록.md", "PNG", b"one").unwrap();
        let b = save_image(d.path(), "refs/회의록.md", ".png", b"two").unwrap();
        assert!(a.starts_with("images/image-") && a.ends_with(".png") && !a.contains(' '));
        assert_ne!(a, b);
        assert_eq!(fs::read(d.path().join(&a)).unwrap(), b"one");
        assert_eq!(fs::read(d.path().join(&b)).unwrap(), b"two");
        assert!(!d.path().join("refs").exists());
        let top = save_image(d.path(), "index.md", "jpg", b"x").unwrap();
        assert!(top.starts_with("images/") && d.path().join(&top).is_file());
    }

    #[test]
    fn pasted_images_refuse_odd_types_empty_data_and_escapes() {
        let d = TempDir::new("img-bad");
        assert_eq!(save_image(d.path(), "a.md", "exe", b"x").unwrap_err().kind, "invalid_image");
        assert_eq!(save_image(d.path(), "a.md", "png", b"").unwrap_err().kind, "invalid_image");
        assert!(save_image(d.path(), "../a.md", "png", b"x").is_err());
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
    fn rename_keeps_the_entry_where_it_is() {
        let d = TempDir::new("ren");
        fs::create_dir_all(d.path().join("refs")).unwrap();
        fs::write(d.path().join("refs/a.md"), "본문").unwrap();

        assert_eq!(rename_path(d.path(), "refs/a.md", "회의록.md").unwrap(), "refs/회의록.md");
        assert!(!d.path().join("refs/a.md").exists());
        assert_eq!(fs::read_to_string(d.path().join("refs/회의록.md")).unwrap(), "본문");
    }

    #[test]
    fn rename_reports_folders_with_a_trailing_slash_and_carries_children() {
        let d = TempDir::new("rendir");
        fs::create_dir_all(d.path().join("refs/deep")).unwrap();
        fs::write(d.path().join("refs/deep/b.md"), "b").unwrap();

        assert_eq!(rename_path(d.path(), "refs/", "참고자료").unwrap(), "참고자료/");
        assert!(d.path().join("참고자료/deep/b.md").is_file());
        assert!(!d.path().join("refs").exists());
    }

    #[test]
    fn rename_onto_an_existing_name_is_refused_not_overwritten() {
        let d = TempDir::new("renclash");
        fs::write(d.path().join("a.md"), "새 내용").unwrap();
        fs::write(d.path().join("b.md"), "이미 있는 내용").unwrap();

        assert_eq!(rename_path(d.path(), "a.md", "b.md").unwrap_err().kind, "already_exists");
        assert_eq!(fs::read_to_string(d.path().join("a.md")).unwrap(), "새 내용");
        assert_eq!(fs::read_to_string(d.path().join("b.md")).unwrap(), "이미 있는 내용");
    }

    #[test]
    fn rename_refuses_the_index_note_and_unusable_names() {
        let d = TempDir::new("renguard");
        fs::write(d.path().join("index.md"), "메타데이터").unwrap();
        fs::write(d.path().join("a.md"), "본문").unwrap();

        assert_eq!(rename_path(d.path(), "index.md", "메모.md").unwrap_err().kind, "protected");
        assert!(d.path().join("index.md").is_file());

        // 경로 구분자가 섞이면 이름이 아니라 이동이다 — 여기서는 받지 않는다.
        assert_eq!(rename_path(d.path(), "a.md", "refs/a.md").unwrap_err().kind, "invalid_path");
        // 점으로 시작하면 `list_tree` 가 건너뛰어 트리에서 사라진다.
        assert_eq!(rename_path(d.path(), "a.md", ".hidden.md").unwrap_err().kind, "invalid_path");
        assert_eq!(rename_path(d.path(), "a.md", "   ").unwrap_err().kind, "invalid");
        assert!(d.path().join("a.md").is_file());
    }

    #[test]
    fn rename_to_the_same_name_is_a_no_op() {
        let d = TempDir::new("rensame");
        fs::write(d.path().join("a.md"), "본문").unwrap();

        assert_eq!(rename_path(d.path(), "a.md", "a.md").unwrap(), "a.md");
        // 끝의 점과 공백은 Windows 가 어차피 잘라낸다 — 같은 이름으로 본다.
        assert_eq!(rename_path(d.path(), "a.md", " a.md. ").unwrap(), "a.md");
        assert_eq!(fs::read_to_string(d.path().join("a.md")).unwrap(), "본문");
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
