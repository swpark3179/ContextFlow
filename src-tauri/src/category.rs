//! 업무 카테고리 — `프로젝트/ContextFlow/UI` 처럼 1~3단계로 업무를 묶는 경로.
//!
//! * **키 하나, 메타데이터뿐이다.** 값은 업무 `index.md` frontmatter 의 `category` 하나에
//!   산다. 미분류는 키가 없는 것이다 — `null` 이나 "미분류" 를 적지 않는다. 카테고리 목록을
//!   따로 두는 파일도 없다. 업무들이 들고 있는 값이 곧 목록이다.
//! * **폴더는 절대 옮기지 않는다.** 프런트는 업무를 폴더 절대 경로로 기억하고(열린 업무 ·
//!   캐시 · 오늘의 한일 · 추천), `scan` 은 `Tasks/*` · `Archive/*/*` 한 단계만 본다.
//!   카테고리를 폴더로 표현하면 그 전부가 깨진다.
//! * **값은 항상 큰따옴표로 쓴다.** 따옴표 없는 값은 `frontmatter::unquote` 가 ` #` 뒤를
//!   주석으로 잘라 내고, `quote_if_needed` 는 `#` 을 보지 않는다(`!` · `@` 도). 정규화가
//!   `"` 와 `\` 를 남기지 않으므로 따옴표 안에서 이스케이프할 것도 없다.
//!
//! 정규화 규칙은 프런트(`src/lib/category.ts`)와 글자 하나까지 같아야 한다. 두 쪽이 같은
//! fixture(`src/lib/category.cases.json`)로 테스트한다.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, Result};
use crate::frontmatter::Doc;
use crate::vault::{self, TaskMeta};

pub const KEY: &str = "category";
/// 경로 깊이의 상한.
const MAX_DEPTH: usize = 3;
/// 단계 하나의 글자 수 상한. UTF-16 이 아니라 코드포인트로 센다 — 프런트도 그렇게 센다.
const MAX_SEGMENT: usize = 30;
/// 키가 없는 업무의 표시 이름. 그래서 맨 앞 단계의 이름으로는 쓸 수 없다.
const UNCATEGORIZED: &str = "미분류";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// 앱이 쓰는 값 — 규칙을 어기면 거절한다.
    Write,
    /// Obsidian 에서 손으로 고친 값 — 최대한 살려 읽고, 오류를 내지 않는다.
    Read,
}

/// 공백으로 치는 문자. 프런트와 **같은 목록**이어야 해서 `char::is_whitespace` 에 기대지
/// 않고 적어 둔다(그쪽에는 BOM 이 없다).
fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{85}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// 단계 하나를 다듬는다. 금지 문자는 Windows 파일 이름과 Obsidian 위키링크를 깨는 것들이다
/// (`vault::sanitize_name` 의 목록에 `[ ] ,` 를 더했다).
fn clean_segment(raw: &str) -> String {
    let mapped: String = raw
        .chars()
        .map(|c| match c {
            c if is_space(c) => ' ',
            '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' => '-',
            ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']' | ',' => '-',
            c => c,
        })
        .collect();
    let collapsed = mapped.split(' ').filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    let head: String = collapsed.trim_matches([' ', '.']).chars().take(MAX_SEGMENT).collect();
    // 자른 자리에 공백이나 점이 걸리면 한 번 더 다듬는다.
    head.trim_matches([' ', '.']).to_string()
}

/// 정규화의 본체. 거절 사유는 fixture 가 쓰는 코드(`depth` · `reserved`)로 돌려준다.
fn normalize_code(raw: &str, mode: Mode) -> std::result::Result<Option<String>, &'static str> {
    // `›` 는 화면에 보이는 구분자다 — 라벨을 그대로 붙여 넣어도 같은 경로가 된다.
    let mut segs: Vec<String> =
        raw.split(['/', '\\', '›']).map(clean_segment).filter(|seg| !seg.is_empty()).collect();

    if segs.first().map(String::as_str) == Some(UNCATEGORIZED) {
        if segs.len() == 1 {
            return Ok(None);
        }
        if mode == Mode::Write {
            return Err("reserved");
        }
        let lead = segs.iter().take_while(|seg| *seg == UNCATEGORIZED).count();
        segs.drain(..lead);
    }
    // YAML 의 빈 값(`null` · `~`)은 다듬고 `미분류` 를 걷어 낸 **뒤에** 본다. `null/` ·
    // `Null.` · `미분류/null` 을 그대로 두면 되읽을 때 빈 값으로 읽혀, 쓴 값과 읽은 값이 어긋난다.
    match segs.as_slice() {
        [] => return Ok(None),
        [only] if matches!(only.to_lowercase().as_str(), "null" | "~") => return Ok(None),
        _ => {}
    }

    if segs.len() > MAX_DEPTH {
        if mode == Mode::Write {
            return Err("depth");
        }
        // 손으로 더 깊게 적은 경로는 버리지 않고 셋째 단계에 접는다.
        let tail = segs.split_off(MAX_DEPTH - 1).join(" · ");
        segs.push(tail);
    }
    Ok(Some(segs.join("/")))
}

/// 입력을 저장 형식으로 정규화한다. `Ok(None)` 은 미분류다.
pub fn normalize(raw: &str, mode: Mode) -> Result<Option<String>> {
    normalize_code(raw, mode).map_err(|code| {
        let message = match code {
            "depth" => "카테고리는 3단계까지입니다",
            _ => "‘미분류’는 카테고리 이름으로 쓸 수 없습니다",
        };
        AppError::new("invalid", message)
    })
}

/// 노트의 카테고리. Obsidian 에서 손으로 고친 모양도 받는다 — 따옴표 없음 · 작은따옴표 ·
/// 뒤에 붙은 ` # 주석` · 목록(인라인이든 블록이든 첫 항목). 돌려주는 값은 읽기 규칙으로
/// 정리된 것이고, 파일의 원문은 카테고리를 다시 지정할 때까지 그대로다.
pub fn read(doc: &Doc) -> Option<String> {
    let inline = doc.get(KEY)?.trim();
    let raw = if inline.is_empty() || inline.starts_with('[') {
        doc.get_list(KEY).into_iter().next()?
    } else if let Some(quoted) = quoted_head(inline) {
        quoted.to_string()
    } else {
        doc.get_str(KEY)?
    };
    normalize(&raw, Mode::Read).ok().flatten()
}

/// 따옴표로 시작하는 값의 따옴표 안쪽. 닫는 따옴표 뒤는 버린다 — `"운영" # 임시` 는 끝이
/// 따옴표가 아니라서 `unquote` 가 따옴표 · 주석째 돌려준다. 닫는 따옴표가 없으면 `None`.
fn quoted_head(inline: &str) -> Option<&str> {
    let quote = inline.chars().next().filter(|c| matches!(c, '"' | '\''))?;
    let rest = &inline[1..];
    rest.find(quote).map(|end| &rest[..end])
}

/// 정규화된 값을 쓴다. 키가 있으면 그 자리에서 고치고, 없으면 `tags` 바로 뒤에 넣는다.
/// 손으로 두 번 적은 줄은 지정이면 첫 줄만 남기고, 해제(`None`)면 모두 지운다.
pub fn write(doc: &mut Doc, value: Option<&str>) {
    match value {
        Some(v) => {
            doc.insert_after(KEY, format!("\"{v}\""), "tags");
            doc.keep_first(KEY);
        }
        None => doc.remove(KEY),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryIssue {
    pub folder: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryChange {
    /// 다 쓴 뒤 새로 훑은 업무 전체. 폴더를 읽다 막히면 읽힌 업무만 든다.
    pub tasks: Vec<TaskMeta>,
    /// 실제로 다시 쓴 업무 폴더(받은 문자열 그대로). 이미 그 값이던 업무는 빠진다.
    pub changed: Vec<String>,
    /// 쓰지 못한 업무와 사유. 하나가 막혀도 나머지는 계속한다.
    pub failed: Vec<CategoryIssue>,
}

/// 여러 업무에 카테고리를 지정(`Some`)하거나 해제(`None`)한다.
///
/// 값은 한 번만 정규화하고, 규칙에 어긋나면 아무것도 쓰지 않고 거절한다. 정리는 작업이
/// 아니라서 `updated` 는 그대로 두고 Run Log 에도 적지 않는다(`reorder_tasks` 와 같다).
/// 이미 그 값인 노트는 다시 쓰지 않는다 — `edit_index_inner` 가 고친 결과가 고치기 전과
/// 같으면 건너뛴다.
pub fn set_category(
    root: &Path,
    folders: &[String],
    category: Option<&str>,
) -> Result<CategoryChange> {
    let value = category.map(|raw| normalize(raw, Mode::Write)).transpose()?.flatten();
    Ok(rewrite(root, folders.iter().map(|f| (f.as_str(), value.as_deref())), |value, doc| {
        write(doc, *value);
        Ok(())
    }))
}

/// 업무마다 index.md 를 고친다. `edit` 가 사유를 돌려주면 그 업무는 쓰지 않고 실패로
/// 남긴다. 쓰기가 막혀도(잠긴 파일) 나머지는 계속한다 — 하나 때문에 전부를 물릴 수는 없다.
///
/// 쓰기를 시작한 뒤에는 오류로 끝나지 않는다. 다 쓴 뒤 다시 훑다 폴더가 막혀도 읽힌 업무만
/// 돌려준다 — 오류로 보이면 사용자가 노드째 다시 시도해 이미 옮긴 업무를 또 옮긴다(`a/b/b →
/// a/b`). 못 읽은 폴더가 다음에 목록을 읽을 때까지 빠지는 것은 `scan` 이 깨진 노트를 건너뛰는
/// 것과 같은 규칙이다.
fn rewrite<'a, T>(
    root: &Path,
    items: impl IntoIterator<Item = (&'a str, T)>,
    mut edit: impl FnMut(&T, &mut Doc) -> std::result::Result<(), &'static str>,
) -> CategoryChange {
    let mut changed = Vec::new();
    let mut failed = Vec::new();
    for (folder, item) in items {
        let path = Path::new(folder);
        let mut skipped = None;
        let outcome =
            vault::ensure_task_folder(root, path, "카테고리를 바꿀 대상").and_then(|_| {
                vault::edit_index_inner(root, path, false, |doc| skipped = edit(&item, doc).err())
            });
        let reason = match (outcome, skipped) {
            (Ok((_, true)), _) => {
                changed.push(folder.to_string());
                continue;
            }
            (Ok(_), None) => continue,
            (Ok(_), Some(reason)) => reason.to_string(),
            (Err(e), _) => e.message,
        };
        failed.push(CategoryIssue {
            folder: folder.to_string(),
            title: title_of(root, path),
            reason,
        });
    }
    CategoryChange { tasks: vault::scan_best_effort(root), changed, failed }
}

/// 실패 목록에 보일 이름. 노트를 읽을 수 없으면 폴더 이름으로 대신한다.
fn title_of(root: &Path, folder: &Path) -> String {
    match vault::read_task(root, &folder.join("index.md")) {
        Ok(t) => t.title,
        Err(_) => folder
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| folder.display().to_string()),
    }
}

// ---------------------------------------------------------------------------
// 카테고리 관리 — 노드 하나(하위 포함)를 옮기거나 해제한다
//
// 앱에서 유일한 일괄 재작성이라 원칙이 둘이다. 쓰기 전에 전부 검사해 하나라도 문제면
// 아무것도 쓰지 않는다. 그리고 실패한 업무만 다시 시도해도 안전하다 — 대상은 언제나 새로
// 훑은 업무에서 정하고, 쓰기 직전에 값을 다시 읽어 계획할 때와 견준다.
// ---------------------------------------------------------------------------

/// 같은 카테고리인지 가르는 키 — 대소문자만 다른 것은 같은 카테고리다(프런트 `keyOf`).
fn key_of(cat: &str) -> String {
    cat.to_lowercase()
}

/// `cat` 이 `from`(키) 노드이거나 그 하위인가. 단계 단위로 견준다 — `a/bc` 는 `a/b` 안이
/// 아니고, 키의 글자 수만큼 잘라 견주면 소문자에서 길이가 바뀌는 글자(`İ` · 켈빈 기호)에서
/// 어긋난다.
fn within(cat: &str, from: &str) -> bool {
    let depth = from.split('/').count();
    let segs: Vec<&str> = cat.split('/').collect();
    segs.len() >= depth
        && segs[..depth].iter().map(|s| key_of(s)).collect::<Vec<_>>().join("/") == from
}

/// `a/B/c` 의 접두 경로들 — `a` · `a/B` · `a/B/c`. 철자 그대로다.
fn prefixes(cat: &str) -> impl Iterator<Item = &str> {
    cat.match_indices('/').map(|(i, _)| &cat[..i]).chain(std::iter::once(cat))
}

/// 노드를 옮겼을 때 업무 하나의 새 값.
#[derive(Debug, PartialEq)]
enum Retarget {
    /// 옮기는 노드 밖이다.
    Outside,
    /// 새 값. `None` 은 미분류다.
    To(Option<String>),
    /// 옮기면 규칙에 어긋난다 — `normalize_code` 와 같은 코드.
    Err(&'static str),
}

/// `from`(키) 노드를 `to` 로 옮긴 뒤 `cat` 의 값. `to` 의 단계 뒤에 업무 자신의 꼬리(노드
/// 아래 단계들)를 이어 쓰기 규칙으로 정규화한다 — 꼬리는 업무가 쓴 철자 그대로다. `to` 가
/// `None` 이면 최상위로 올리기다: 노드 자신의 업무는 미분류, 하위는 최상위가 된다.
///
/// 프런트(`src/lib/category.ts`)와 같은 fixture(`src/lib/category.move.json`)로 시험한다.
fn retarget(cat: Option<&str>, from: &str, to: Option<&str>) -> Retarget {
    let Some(cat) = cat.filter(|c| within(c, from)) else {
        return Retarget::Outside;
    };
    let tail: Vec<&str> = cat.split('/').skip(from.split('/').count()).collect();
    // 손으로 4단계 이상 적어 셋째 단계에 접힌 꼬리(`c · d`)는 30자를 넘을 수 있다. 쓰기 규칙은
    // 그것을 몰래 잘라 버리므로 4단계로 친다 — 접힌 노드 자신을 짧은 이름으로 옮기면 풀린다.
    if tail.iter().any(|seg| seg.chars().count() > MAX_SEGMENT) {
        return Retarget::Err("depth");
    }
    let joined: Vec<&str> = to.into_iter().chain(tail.iter().copied()).collect();
    match normalize_code(&joined.join("/"), Mode::Write) {
        // `a/미분류` · `a/null` 을 최상위로 올린 것이다. 몰래 미분류로 보내지 않는다.
        Ok(None) if !tail.is_empty() => Retarget::Err("reserved"),
        Ok(value) => Retarget::To(value),
        Err(code) => Retarget::Err(code),
    }
}

/// 옮기거나 해제할 노드의 키. 정규화하지 않는다 — 손으로 쓴 4단계 이상은 읽을 때 셋째
/// 단계에 접히는데(`c · d`), 그 긴 단계를 다시 다듬으면 30자에서 잘려 엉뚱한 노드가 된다.
fn node_key(from: &str) -> Result<String> {
    let key = key_of(from.trim());
    if key.split('/').any(str::is_empty) {
        return Err(AppError::new("invalid", "옮길 카테고리가 없습니다"));
    }
    Ok(key)
}

/// 노드(하위 포함)에 든 업무 — 진행 중과 보관을 가리지 않는다. `only` 가 있으면 그 폴더들로
/// 한정한다(다시 시도). 없는데 0건이면 화면이 낡은 목록을 보고 있는 것이라 거절한다.
fn targets<'a>(
    tasks: &'a [TaskMeta],
    from: &str,
    only: Option<&[String]>,
) -> Result<Vec<&'a TaskMeta>> {
    let found: Vec<&TaskMeta> = tasks
        .iter()
        .filter(|t| t.category.as_deref().is_some_and(|c| within(c, from)))
        .filter(|t| only.map_or(true, |only| only.contains(&t.folder)))
        .collect();
    if found.is_empty() && only.is_none() {
        return Err(AppError::new("invalid", "그 카테고리의 업무가 없습니다"));
    }
    Ok(found)
}

/// 계획한 쓰기 하나. 계획할 때 읽은 값은 `task.category` 다.
struct Step<'a> {
    task: &'a TaskMeta,
    new: Option<String>,
}

/// 옮기기를 계획한다. 쓰기 전에 전부 본다 — 어느 업무 하나라도 규칙에 어긋나거나, 허락
/// 없이 이미 있는 카테고리와 합쳐지면 아무것도 쓰지 않고 거절한다.
fn plan_move<'a>(
    tasks: &'a [TaskMeta],
    from: &str,
    to: Option<&str>,
    allow_merge: bool,
    only: Option<&[String]>,
) -> Result<Vec<Step<'a>>> {
    // 명시적인 `None` 만 최상위로 올리기다. 비운 입력이 미분류로 읽혀 노드째 해제되면 안 된다.
    let to = match to {
        Some(raw) => Some(normalize(raw, Mode::Write)?.ok_or_else(|| {
            AppError::new("invalid", "옮길 경로를 입력하세요 — 미분류로 돌리려면 [해제] 를 쓰세요")
        })?),
        None => None,
    };
    // 같은 키(철자만 고치기)는 된다.
    if to.as_deref().is_some_and(|t| key_of(t).starts_with(&format!("{from}/"))) {
        return Err(AppError::new("invalid", "자기 하위 카테고리로는 옮길 수 없습니다"));
    }

    let mut steps = Vec::new();
    let mut broken = Vec::new();
    for task in targets(tasks, from, only)? {
        match retarget(task.category.as_deref(), from, to.as_deref()) {
            Retarget::To(new) => steps.push(Step { task, new }),
            Retarget::Err(code) => broken.push((task.title.as_str(), code)),
            // 대상은 모두 노드 안이다.
            Retarget::Outside => {}
        }
    }
    if !broken.is_empty() {
        return Err(broken_error(&broken));
    }
    if !allow_merge {
        if let Some(e) = merge_conflict(tasks, &steps, from, to.as_deref()) {
            return Err(e);
        }
    }
    Ok(steps)
}

/// 옮기면 규칙에 어긋나는 업무들. 무엇을 먼저 고쳐야 하는지 보이게 이름을 세 개까지 싣는다.
fn broken_error(broken: &[(&str, &str)]) -> AppError {
    let reasons = [
        // 4단계를 넘는 것도 있다 — 3단계 노드를 3단계 아래로 옮기면 5단계다.
        ("depth", "4단계 이상이 됩니다 — 카테고리는 3단계까지입니다"),
        ("reserved", "최상위에서 ‘미분류’ 가 됩니다"),
    ];
    let lines: Vec<String> = reasons
        .iter()
        .filter_map(|(code, what)| {
            let titles: Vec<&str> =
                broken.iter().filter(|(_, c)| c == code).map(|(title, _)| *title).collect();
            if titles.is_empty() {
                return None;
            }
            let mut names =
                titles.iter().take(3).map(|t| format!("‘{t}’")).collect::<Vec<_>>().join(" · ");
            if titles.len() > 3 {
                names.push_str(&format!(" 외 {}건", titles.len() - 3));
            }
            Some(format!("{names} 이(가) {what}"))
        })
        .collect();
    AppError::new("invalid", lines.join("\n"))
}

/// 옮긴 결과가 이미 있는 카테고리와 겹치는가(합치기). 겹치면 가장 얕은 그 카테고리를,
/// 그것을 가진 첫 업무의 철자로 알린다.
///
/// 견주는 것은 접두 키 전부다 — 대상이 아닌 업무들이 이루는 노드와 새 값들이 이루는 노드.
/// 다만 옮겨 가는 자리의 조상은 원래 있던 노드라 겹쳐도 합치기가 아니다(있는 부모 아래로
/// 옮기기). 상위로 올리면(`to` 가 `from` 의 조상이거나 최상위) `to` 자신도 그렇다 — 노드가
/// 부모 안으로 녹아드는 것이 그 동작이다. 그래도 하위끼리 겹치면(`a/b/c → a/c` 와 기존
/// `a/c`) 합치기다.
fn merge_conflict(
    tasks: &[TaskMeta],
    steps: &[Step],
    from: &str,
    to: Option<&str>,
) -> Option<AppError> {
    // 겹쳐도 합치기가 아닌 노드 — 옮겨 가는 자리의 조상, 상위로 올리면 `to` 자신까지.
    let mut kept: Vec<String> = to.into_iter().flat_map(prefixes).map(key_of).collect();
    if to.is_some_and(|t| !from.starts_with(&format!("{}/", key_of(t)))) {
        kept.pop();
    }
    let moved: HashSet<&str> = steps.iter().map(|s| s.task.folder.as_str()).collect();
    // 키 → 처음 본 철자. 훑은 순서대로라 첫 업무의 철자가 남는다.
    let mut existing: HashMap<String, &str> = HashMap::new();
    for cat in tasks
        .iter()
        .filter(|t| !moved.contains(t.folder.as_str()))
        .filter_map(|t| t.category.as_deref())
    {
        for prefix in prefixes(cat) {
            existing.entry(key_of(prefix)).or_insert(prefix);
        }
    }
    let clash = steps
        .iter()
        .filter_map(|s| s.new.as_deref())
        .flat_map(prefixes)
        .map(key_of)
        .filter(|key| !kept.contains(key))
        .filter_map(|key| existing.get(&key).copied())
        .min_by_key(|spelled| spelled.split('/').count())?;
    Some(AppError::new(
        "already_exists",
        format!("‘{}’ 카테고리가 이미 있습니다", clash.replace('/', " › ")),
    ))
}

/// 계획대로 쓴다. 업무마다 쓰기 직전에 값을 다시 읽어 계획할 때와 견준다.
///
/// * 이미 새 값이면 손대지 않는다 — 손으로 쓴 주석 · 목록 모양이 남고 `changed` 에도 들지 않는다.
/// * 계획할 때와 같은 카테고리(키)면 쓴다.
/// * 그 밖이면 그사이 누가(Obsidian · 다른 창) 바꾼 것이다. 덮어쓰지 않고 실패로 남긴다.
fn apply(root: &Path, steps: &[Step]) -> CategoryChange {
    rewrite(root, steps.iter().map(|s| (s.task.folder.as_str(), s)), |step, doc| {
        let cur = read(doc);
        if cur == step.new {
            return Ok(());
        }
        if cur.as_deref().map(key_of) != step.task.category.as_deref().map(key_of) {
            return Err("그사이 카테고리가 바뀌어 건너뛰었습니다");
        }
        write(doc, step.new.as_deref());
        Ok(())
    })
}

/// 카테고리 노드 하나(하위 포함)의 경로를 바꾼다 — 이름 바꾸기 · 다른 카테고리 아래로 ·
/// 합치기. `to` 가 `None` 이면 최상위로 올린다. `from` 은 노드의 키다.
///
/// 이미 있는 카테고리와 겹치면 `allow_merge` 가 없을 때 `already_exists` 로 거절한다. 다시
/// 시도는 `only` 에 실패한 폴더만 담고 `allow_merge` 를 켜서 보낸다 — 이미 확정한 이동이고,
/// 노드 안에 남은 다른 업무(`a/b/b → a/b`)는 이미 옮겨진 것이라 또 옮기면 안 된다.
pub fn move_category(
    root: &Path,
    from: &str,
    to: Option<&str>,
    allow_merge: bool,
    only: Option<&[String]>,
) -> Result<CategoryChange> {
    let from = node_key(from)?;
    // 계획은 엄격하게 훑는다 — 못 읽은 폴더가 있으면 대상과 합치기 판정이 빠진다. 쓰기 전이라
    // 거절해도 아무것도 바뀌지 않는다.
    let tasks = vault::scan(root)?;
    let steps = plan_move(&tasks, &from, to, allow_merge, only)?;
    Ok(apply(root, &steps))
}

/// 카테고리 노드 하나(하위 포함)를 해제해 그 업무들을 미분류로 돌린다. 대상을 프런트의
/// 목록이 아니라 새로 훑은 업무로 정하고 `move_category` 와 같은 가드로 쓴다 — 그사이 들어온
/// 업무가 남거나, 그사이 다른 카테고리로 간 업무가 지워지지 않게.
pub fn clear_category(root: &Path, from: &str, only: Option<&[String]>) -> Result<CategoryChange> {
    let from = node_key(from)?;
    let tasks = vault::scan(root)?;
    let steps: Vec<Step> =
        targets(&tasks, &from, only)?.into_iter().map(|task| Step { task, new: None }).collect();
    Ok(apply(root, &steps))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::tests::{make_in, set_updated, TempVault};
    use crate::vault::{absorb_task, read_task, reorder_tasks, scan, set_archived, set_status};
    use serde::Deserialize;
    use std::fs;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct Case {
        note: String,
        input: String,
        mode: String,
        value: Option<String>,
        error: Option<String>,
    }

    /// 프런트와 같은 fixture 를 그대로 돌린다 — 두 쪽 규칙이 어긋나면 여기서 먼저 깨진다.
    #[test]
    fn matches_the_shared_fixture() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../src/lib/category.cases.json")).unwrap();
        assert!(!cases.is_empty());
        let mut wrong = Vec::new();
        for c in &cases {
            let mode = match c.mode.as_str() {
                "write" => Mode::Write,
                "read" => Mode::Read,
                other => panic!("{}: 알 수 없는 mode {other}", c.note),
            };
            let want = match &c.error {
                Some(code) => Err(code.as_str()),
                None => Ok(c.value.clone()),
            };
            let got = normalize_code(&c.input, mode);
            if got != want {
                wrong.push(format!("{} ({:?}): {:?} — 기대 {:?}", c.note, c.input, got, want));
            }
        }
        assert!(wrong.is_empty(), "\n{}", wrong.join("\n"));
    }

    #[test]
    fn write_errors_carry_the_message_the_ui_shows() {
        let e = normalize("a/b/c/d", Mode::Write).unwrap_err();
        assert_eq!(
            (e.kind.as_str(), e.message.as_str()),
            ("invalid", "카테고리는 3단계까지입니다")
        );
        let e = normalize("미분류/x", Mode::Write).unwrap_err();
        assert_eq!(e.kind, "invalid");
        assert_eq!(e.message, "‘미분류’는 카테고리 이름으로 쓸 수 없습니다");
    }

    fn note(lines: &str) -> Doc {
        Doc::parse(&format!("---\ntitle: 업무\n{lines}status: in-progress\n---\n본문\n"))
    }

    #[test]
    fn reads_the_shapes_people_write_by_hand() {
        let cases: [(&str, Option<&str>); 17] = [
            ("category: \"프로젝트/CF\"\n", Some("프로젝트/CF")),
            ("category: 프로젝트/CF\n", Some("프로젝트/CF")),
            ("category: '프로젝트/CF'\n", Some("프로젝트/CF")),
            ("category: 프로젝트/CF # 나중에 정리\n", Some("프로젝트/CF")),
            ("category: \"운영\" # 임시\n", Some("운영")),
            ("category: '운영' # 임시\n", Some("운영")),
            // README 스키마 예시 줄 그대로.
            (
                "category: \"프로젝트/Tauri\"   # 카테고리 — 1~3단계, 없으면 미분류(키 자체가 없다)\n",
                Some("프로젝트/Tauri"),
            ),
            ("category: [프로젝트/CF, 운영]\n", Some("프로젝트/CF")),
            ("category: [\"프로젝트/CF\"]\n", Some("프로젝트/CF")),
            ("category:\n  - 프로젝트/CF\n  - 운영\n", Some("프로젝트/CF")),
            ("category: 프로젝트 ›  CF\n", Some("프로젝트/CF")),
            ("category: a/b/c/d\n", Some("a/b/c · d")),
            ("category: 미분류\n", None),
            ("category: null\n", None),
            ("category:\n", None),
            ("category: []\n", None),
            ("", None),
        ];
        for (lines, want) in cases {
            assert_eq!(read(&note(lines)).as_deref(), want, "{lines:?}");
        }
    }

    #[test]
    fn writing_quotes_the_value_and_puts_it_right_after_tags() {
        let mut doc =
            Doc::parse("---\nid: t\ntags: [a, b]\ncreated: 2026-08-01 10:00\n---\n본문\n");
        write(&mut doc, Some("2026/!긴급"));
        assert_eq!(
            doc.render(),
            "---\nid: t\ntags: [a, b]\ncategory: \"2026/!긴급\"\ncreated: 2026-08-01 10:00\n---\n본문\n"
        );
        // 따옴표 덕에 숫자 · YAML 태그로 읽히지 않고, 되읽으면 같은 값이다.
        assert_eq!(read(&doc).as_deref(), Some("2026/!긴급"));

        // 블록 목록 태그는 항목 줄까지가 한 덩어리다.
        let mut doc = Doc::parse("---\ntags:\n  - a\n  - b\nstatus: s\n---\n");
        write(&mut doc, Some("운영"));
        assert_eq!(doc.render(), "---\ntags:\n  - a\n  - b\ncategory: \"운영\"\nstatus: s\n---\n");

        // `tags` 가 없으면 맨 뒤.
        let mut doc = Doc::parse("---\nid: t\n---\n본문\n");
        write(&mut doc, Some("운영"));
        assert_eq!(doc.render(), "---\nid: t\ncategory: \"운영\"\n---\n본문\n");
    }

    #[test]
    fn an_existing_key_is_edited_where_it_stands() {
        let mut doc =
            Doc::parse("---\nid: t\ncategory: 옛/값 # 메모\ntags: [a]\nupdated: x\n---\n본문\n");
        write(&mut doc, Some("새/값"));
        assert_eq!(
            doc.render(),
            "---\nid: t\ncategory: \"새/값\"\ntags: [a]\nupdated: x\n---\n본문\n"
        );

        // 블록 목록으로 적혀 있었으면 항목 줄도 함께 걷힌다.
        let mut doc = Doc::parse("---\ncategory:\n  - 옛\n  - 값\nupdated: x\n---\n");
        write(&mut doc, Some("새"));
        assert_eq!(doc.render(), "---\ncategory: \"새\"\nupdated: x\n---\n");
    }

    #[test]
    fn setting_keeps_only_the_first_of_hand_made_duplicates() {
        let mut doc = Doc::parse(
            "---\nid: t\ncategory: \"a\"\ntags: [x]\ncategory:\n  - b\ncategory: c\n---\n본문\n",
        );
        write(&mut doc, Some("새"));
        assert_eq!(doc.render(), "---\nid: t\ncategory: \"새\"\ntags: [x]\n---\n본문\n");
        assert_eq!(read(&doc).as_deref(), Some("새"));
    }

    #[test]
    fn clearing_removes_the_key_and_any_hand_made_duplicate() {
        let mut doc =
            Doc::parse("---\nid: t\ncategory: \"a\"\ntags: [x]\ncategory: b\n---\n본문\n");
        write(&mut doc, None);
        assert_eq!(doc.render(), "---\nid: t\ntags: [x]\n---\n본문\n");
        assert_eq!(read(&doc), None);
    }

    #[test]
    fn crlf_notes_stay_crlf_and_every_other_byte_stays_put() {
        let src =
            "---\r\nid: t\r\ntags: [a]\r\nstatus: in-progress # 진행\r\n---\r\n## 개요\r\n본문\r\n";
        let mut doc = Doc::parse(src);
        write(&mut doc, Some("운영"));
        let out = doc.render();
        assert_eq!(
            out,
            "---\r\nid: t\r\ntags: [a]\r\ncategory: \"운영\"\r\nstatus: in-progress # 진행\r\n---\r\n## 개요\r\n본문\r\n"
        );
        let mut doc = Doc::parse(&out);
        write(&mut doc, None);
        assert_eq!(doc.render(), src);
    }

    // -- 카테고리 관리 ---------------------------------------------------------

    #[derive(Deserialize)]
    struct MoveCase {
        note: String,
        cat: Option<String>,
        from: String,
        to: Option<String>,
        result: Option<String>,
        #[serde(default)]
        skip: bool,
        error: Option<String>,
    }

    /// 프런트와 같은 fixture — 화면의 미리보기와 실제로 쓰는 값이 같아야 한다.
    #[test]
    fn retarget_matches_the_shared_fixture() {
        let cases: Vec<MoveCase> =
            serde_json::from_str(include_str!("../../src/lib/category.move.json")).unwrap();
        assert!(!cases.is_empty());
        let mut wrong = Vec::new();
        for c in &cases {
            let want = match (&c.error, c.skip) {
                (_, true) => Retarget::Outside,
                (Some(code), _) => Retarget::Err(match code.as_str() {
                    "depth" => "depth",
                    "reserved" => "reserved",
                    other => panic!("{}: 알 수 없는 error {other}", c.note),
                }),
                (None, _) => Retarget::To(c.result.clone()),
            };
            let got = retarget(c.cat.as_deref(), &c.from, c.to.as_deref());
            if got != want {
                wrong.push(format!("{} ({:?}): {:?} — 기대 {:?}", c.note, c.cat, got, want));
            }
        }
        assert!(wrong.is_empty(), "\n{}", wrong.join("\n"));
    }

    fn cat_of(root: &Path, t: &TaskMeta) -> Option<String> {
        read_task(root, &Path::new(&t.folder).join("index.md")).unwrap().category
    }

    fn cats(root: &Path, tasks: &[&TaskMeta]) -> Vec<Option<String>> {
        tasks.iter().map(|t| cat_of(root, t)).collect()
    }

    fn some(values: &[&str]) -> Vec<Option<String>> {
        values.iter().map(|v| Some(v.to_string())).collect()
    }

    /// Vault 안의 모든 `index.md` — 편입된 노트와 `reference/` 사본까지. 거절된 이동이
    /// 한 바이트도 쓰지 않았는지 본다.
    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.ends_with("index.md") {
                    out.push((path.clone(), fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, &mut out);
        out.sort();
        out
    }

    /// 앱이 쓴 `category:` 줄을 손으로 쓴 모양으로 바꾼다.
    fn hand_write(t: &TaskMeta, lines: &str) -> PathBuf {
        let index = Path::new(&t.folder).join("index.md");
        let text = fs::read_to_string(&index).unwrap();
        let line = text.lines().find(|l| l.starts_with("category:")).unwrap();
        fs::write(&index, text.replacen(&format!("{line}\n"), lines, 1)).unwrap();
        index
    }

    fn mv(root: &Path, from: &str, to: Option<&str>) -> Result<CategoryChange> {
        move_category(root, from, to, false, None)
    }

    fn sorted(mut folders: Vec<String>) -> Vec<String> {
        folders.sort();
        folders
    }

    fn folders(tasks: &[&TaskMeta]) -> Vec<String> {
        sorted(tasks.iter().map(|t| t.folder.clone()).collect())
    }

    #[test]
    fn renaming_a_node_carries_its_subtree_in_each_tasks_own_spelling() {
        let v = TempVault::new("move-rename");
        let root = v.path();
        let a = make_in(root, "가", "프로젝트/CF");
        let b = make_in(root, "나", "프로젝트/CF/UI");
        let c = make_in(root, "다", "프로젝트/cf/api");
        // 앞부분만 같은 형제와 다른 가지는 그대로다.
        let d = make_in(root, "라", "프로젝트/CFX");
        let e = make_in(root, "마", "프로젝트/운영");

        let res = mv(root, "프로젝트/cf", Some("프로젝트/ContextFlow")).unwrap();
        assert_eq!(sorted(res.changed), folders(&[&a, &b, &c]));
        assert!(res.failed.is_empty());
        assert_eq!(
            cats(root, &[&a, &b, &c, &d, &e]),
            some(&[
                "프로젝트/ContextFlow",
                "프로젝트/ContextFlow/UI",
                "프로젝트/ContextFlow/api",
                "프로젝트/CFX",
                "프로젝트/운영",
            ])
        );
        // 돌려준 목록은 다 쓴 뒤 새로 훑은 것이다.
        let listed = res.tasks.iter().find(|t| t.folder == b.folder).unwrap();
        assert_eq!(listed.category.as_deref(), Some("프로젝트/ContextFlow/UI"));
    }

    #[test]
    fn moving_under_an_existing_parent_is_not_a_merge() {
        let v = TempVault::new("move-under");
        let root = v.path();
        let a = make_in(root, "가", "운영");
        let b = make_in(root, "나", "운영/점검");
        let c = make_in(root, "다", "프로젝트/CF");

        mv(root, "운영", Some("프로젝트/운영")).unwrap();
        assert_eq!(
            cats(root, &[&a, &b, &c]),
            some(&["프로젝트/운영", "프로젝트/운영/점검", "프로젝트/CF"])
        );
    }

    #[test]
    fn renaming_onto_an_existing_name_is_a_merge_and_needs_permission() {
        let v = TempVault::new("move-merge");
        let root = v.path();
        let a = make_in(root, "가", "CF");
        let b = make_in(root, "나", "CF/UI");
        let c = make_in(root, "다", "Contextflow/UI");
        let before = snapshot(root);

        // 가장 얕은 겹침을, 그것을 가진 업무의 철자로 알린다.
        let err = mv(root, "cf", Some("ContextFlow")).unwrap_err();
        assert_eq!(err.kind, "already_exists");
        assert_eq!(err.message, "‘Contextflow’ 카테고리가 이미 있습니다");
        assert_eq!(snapshot(root), before);

        let res = move_category(root, "cf", Some("ContextFlow"), true, None).unwrap();
        assert_eq!(sorted(res.changed), folders(&[&a, &b]));
        assert_eq!(
            cats(root, &[&a, &b, &c]),
            some(&["ContextFlow", "ContextFlow/UI", "Contextflow/UI"])
        );
    }

    #[test]
    fn promoting_merges_only_when_a_child_lands_on_an_existing_one() {
        // 형제만 있으면 부모 안으로 녹아들 뿐이다.
        let v = TempVault::new("move-up");
        let root = v.path();
        let a = make_in(root, "가", "a/b");
        let s = make_in(root, "형제", "a/c");
        mv(root, "a/b", Some("a")).unwrap();
        assert_eq!(cats(root, &[&a, &s]), some(&["a", "a/c"]));

        // 하위 `a/b/c → a/c` 가 기존 `a/c` 와 겹치면 합치기다.
        let v = TempVault::new("move-up-merge");
        let root = v.path();
        let a = make_in(root, "가", "a/b");
        let b = make_in(root, "나", "a/b/c");
        let s = make_in(root, "형제", "a/c");
        let err = mv(root, "a/b", Some("a")).unwrap_err();
        assert_eq!(
            (err.kind.as_str(), err.message.as_str()),
            ("already_exists", "‘a › c’ 카테고리가 이미 있습니다")
        );
        move_category(root, "a/b", Some("a"), true, None).unwrap();
        assert_eq!(cats(root, &[&a, &b, &s]), some(&["a", "a/c", "a/c"]));
    }

    #[test]
    fn promoting_to_the_top_level() {
        let v = TempVault::new("move-top");
        let root = v.path();
        let a = make_in(root, "가", "a");
        let b = make_in(root, "나", "a/x");
        let c = make_in(root, "다", "a/y/z");
        let res = mv(root, "a", None).unwrap();
        assert_eq!(res.changed.len(), 3);
        // 노드 자신의 업무는 미분류 — 키가 사라진다.
        assert_eq!(cats(root, &[&a, &b, &c]), [None, Some("x".into()), Some("y/z".into())]);
        assert!(!fs::read_to_string(Path::new(&a.folder).join("index.md"))
            .unwrap()
            .contains("category"));

        let v = TempVault::new("move-top-merge");
        let root = v.path();
        make_in(root, "가", "a/x");
        make_in(root, "기존", "X");
        let err = mv(root, "a", None).unwrap_err();
        assert_eq!(
            (err.kind.as_str(), err.message.as_str()),
            ("already_exists", "‘X’ 카테고리가 이미 있습니다")
        );
    }

    #[test]
    fn a_move_past_three_levels_writes_nothing_and_names_the_tasks() {
        let v = TempVault::new("move-depth");
        let root = v.path();
        make_in(root, "괜찮은 업무", "a");
        for title in ["하나", "둘", "셋", "넷", "다섯"] {
            make_in(root, title, "a/b/c");
        }
        let before = snapshot(root);
        let err = mv(root, "a", Some("x/y")).unwrap_err();
        assert_eq!(err.kind, "invalid");
        assert_eq!(err.message.matches('‘').count(), 3, "{}", err.message);
        assert!(
            err.message
                .ends_with("’ 외 2건 이(가) 4단계 이상이 됩니다 — 카테고리는 3단계까지입니다"),
            "{}",
            err.message
        );
        assert!(!err.message.contains("괜찮은 업무"), "{}", err.message);
        assert_eq!(snapshot(root), before);
    }

    #[test]
    fn a_tail_that_would_become_uncategorized_at_the_top_writes_nothing() {
        let v = TempVault::new("move-reserved");
        let root = v.path();
        make_in(root, "직속", "a");
        make_in(root, "하위", "a/x");
        make_in(root, "꼬리", "a/미분류");
        let before = snapshot(root);
        let err = mv(root, "a", None).unwrap_err();
        assert_eq!(
            (err.kind.as_str(), err.message.as_str()),
            ("invalid", "‘꼬리’ 이(가) 최상위에서 ‘미분류’ 가 됩니다")
        );
        assert_eq!(snapshot(root), before);
    }

    /// 손으로 4단계를 적어 셋째 단계에 접힌 값이 30자를 넘으면, 옮길 때 쓰기 규칙이 그 단계를
    /// 잘라 버린다. 몰래 자르지 않고 업무 이름을 대며 거절한다.
    #[test]
    fn a_long_folded_third_level_blocks_the_move_and_writes_nothing() {
        let v = TempVault::new("move-folded");
        let root = v.path();
        let short = make_in(root, "짧은 업무", "a/x");
        let long = make_in(root, "긴 업무", "a/b/c");
        let (first, second) = ("가".repeat(20), "나".repeat(20));
        hand_write(&long, &format!("category: a/b/{first}/{second}\n"));
        let folded = format!("a/b/{first} · {second}");
        assert_eq!(cat_of(root, &long).as_deref(), Some(folded.as_str()));
        let before = snapshot(root);

        let err = mv(root, "a", Some("z")).unwrap_err();
        assert_eq!(
            (err.kind.as_str(), err.message.as_str()),
            ("invalid", "‘긴 업무’ 이(가) 4단계 이상이 됩니다 — 카테고리는 3단계까지입니다")
        );
        assert_eq!(snapshot(root), before);

        // 빠져나갈 길 — 접힌 노드 자신을 짧은 이름으로 옮기면 그다음 이동은 된다.
        mv(root, &folded, Some("a/b/c")).unwrap();
        mv(root, "a", Some("z")).unwrap();
        assert_eq!(cats(root, &[&short, &long]), some(&["z/x", "z/b/c"]));
    }

    /// 다 쓴 뒤의 목록 읽기가 막혀도 쓴 것을 오류로 돌리지 않는다 — 오류로 끝나면 화면이 같은 이동을
    /// 다시 보내, 상위로 올리는 이동에서는 이미 옮긴 업무를 또 옮긴다. 루트로 돌면 권한으로 폴더를 막을
    /// 수 없어 확인하지 못하니 그냥 지나간다.
    #[cfg(unix)]
    #[test]
    fn a_blocked_folder_after_the_writes_is_not_an_error() {
        use std::os::unix::fs::PermissionsExt;

        struct Unblock(PathBuf);
        impl Drop for Unblock {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }

        let v = TempVault::new("rewrite-blocked");
        let root = v.path();
        let live = make_in(root, "진행 업무", "a");
        let old = make_in(root, "보관 업무", "a");
        let moved = set_archived(root, Path::new(&old.folder), true, "move", false).unwrap();
        let year = Path::new(&moved.folder).parent().unwrap().to_path_buf();
        fs::set_permissions(&year, fs::Permissions::from_mode(0o000)).unwrap();
        let _unblock = Unblock(year.clone());
        if fs::read_dir(&year).is_ok() {
            return;
        }

        assert!(scan(root).is_err(), "막힌 폴더가 있으면 엄격한 훑기는 오류다");
        let res = set_category(root, &[live.folder.clone()], Some("b")).unwrap();
        assert_eq!(res.changed, vec![live.folder.clone()]);
        let listed: Vec<_> = res.tasks.iter().map(|t| t.folder.clone()).collect();
        assert_eq!(listed, vec![live.folder.clone()]);
        assert_eq!(cat_of(root, &live).as_deref(), Some("b"));
    }

    #[test]
    fn refuses_what_cannot_be_a_move() {
        let v = TempVault::new("move-refuse");
        let root = v.path();
        let a = make_in(root, "가", "a/b");
        let before = snapshot(root);
        let refused = |from: &str, to: Option<&str>| {
            let err = mv(root, from, to).unwrap_err();
            assert_eq!(err.kind, "invalid", "{from:?} → {to:?}");
            err.message
        };
        assert_eq!(refused("a", Some("A/b/c")), "자기 하위 카테고리로는 옮길 수 없습니다");
        // 비운 입력 · 미분류는 해제가 아니다 — 최상위로 올리기는 명시적인 `None` 뿐이다.
        for to in ["미분류", "  ", "null", " / "] {
            assert_eq!(
                refused("a", Some(to)),
                "옮길 경로를 입력하세요 — 미분류로 돌리려면 [해제] 를 쓰세요"
            );
        }
        assert_eq!(refused("a", Some("미분류/x")), "‘미분류’는 카테고리 이름으로 쓸 수 없습니다");
        for from in ["", " ", "a//b", "/a"] {
            assert_eq!(refused(from, Some("x")), "옮길 카테고리가 없습니다");
        }
        assert_eq!(refused("없음", Some("x")), "그 카테고리의 업무가 없습니다");
        assert_eq!(refused("a/bc", Some("x")), "그 카테고리의 업무가 없습니다");
        assert_eq!(snapshot(root), before);

        // 앞부분만 같은 이름은 하위가 아니다.
        mv(root, "a", Some("ab")).unwrap();
        assert_eq!(cat_of(root, &a).as_deref(), Some("ab/b"));
    }

    #[test]
    fn fixing_only_the_case_is_not_a_merge() {
        let v = TempVault::new("move-case");
        let root = v.path();
        let a = make_in(root, "가", "proj");
        let b = make_in(root, "나", "proj/X");
        let c = make_in(root, "다", "Proj/y");
        let res = mv(root, "PROJ", Some("Proj")).unwrap();
        // 이미 그 철자인 업무는 다시 쓰지 않는다.
        assert_eq!(sorted(res.changed), folders(&[&a, &b]));
        assert_eq!(cats(root, &[&a, &b, &c]), some(&["Proj", "Proj/X", "Proj/y"]));
    }

    /// 다시 시도의 함정: 노드째 다시 옮기면, 이미 `a/b/b → a/b` 로 옮겨져 노드 안에 남은
    /// 업무가 한 번 더 옮겨진다. 그래서 다시 시도는 실패한 업무만(`only`) 옮긴다.
    #[test]
    fn retrying_moves_only_the_tasks_that_failed() {
        let v = TempVault::new("move-retry");
        let root = v.path();
        let t1 = make_in(root, "겹친 이름", "a/b/b");
        let t2 = make_in(root, "노드 자신", "a/b");
        let t3 = make_in(root, "잠긴 업무", "a/b/c");

        // 계획한 뒤 T3 를 쓰지 못하게 한다 — 다른 프로그램이 쥔 파일처럼 그 업무만 막힌다.
        let tasks = scan(root).unwrap();
        let steps = plan_move(&tasks, "a/b", Some("a"), false, None).unwrap();
        let index = Path::new(&t3.folder).join("index.md");
        let aside = Path::new(&t3.folder).join("index.md.locked");
        fs::rename(&index, &aside).unwrap();
        let res = apply(root, &steps);
        fs::rename(&aside, &index).unwrap();

        assert_eq!(sorted(res.changed), folders(&[&t1, &t2]));
        let failed: Vec<&str> = res.failed.iter().map(|f| f.folder.as_str()).collect();
        assert_eq!(failed, [t3.folder.as_str()]);
        assert_eq!(cats(root, &[&t1, &t2, &t3]), some(&["a/b", "a", "a/b/c"]));

        // 노드째 다시 옮기면 T1 이 또 옮겨진다.
        let tasks = scan(root).unwrap();
        let again = plan_move(&tasks, "a/b", Some("a"), true, None).unwrap();
        assert!(again.iter().any(|s| s.task.folder == t1.folder));

        let only = [t3.folder.clone()];
        let res = move_category(root, "a/b", Some("a"), true, Some(&only)).unwrap();
        assert_eq!(res.changed, only);
        assert!(res.failed.is_empty());
        assert_eq!(cats(root, &[&t1, &t2, &t3]), some(&["a/b", "a", "a/c"]));
    }

    #[test]
    fn the_write_is_guarded_by_what_the_plan_read() {
        let v = TempVault::new("move-guard");
        let root = v.path();
        let a = make_in(root, "그대로 옮길 업무", "옛/값");
        let b = make_in(root, "먼저 옮겨진 업무", "옛/값");
        let c = make_in(root, "다른 데로 간 업무", "옛/값");
        let tasks = scan(root).unwrap();
        let steps = plan_move(&tasks, "옛", Some("새"), false, None).unwrap();

        // 계획한 뒤에 Obsidian 에서 손으로 고쳤다 — 하나는 이미 목적지로, 하나는 다른 곳으로.
        let index = hand_write(&b, "category: 새/값 # 메모\n");
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        fs::File::options().write(true).open(&index).unwrap().set_modified(old).unwrap();
        let bytes = fs::read(&index).unwrap();
        set_category(root, &[c.folder.clone()], Some("딴/데")).unwrap();

        let res = apply(root, &steps);
        assert_eq!(res.changed, [a.folder.as_str()]);
        let failed: Vec<(&str, &str)> =
            res.failed.iter().map(|f| (f.title.as_str(), f.reason.as_str())).collect();
        assert_eq!(failed, [("다른 데로 간 업무", "그사이 카테고리가 바뀌어 건너뛰었습니다")]);
        // 이미 새 값이면 손으로 쓴 주석까지 그대로 — 다시 쓰지 않는다.
        assert_eq!(fs::read(&index).unwrap(), bytes);
        assert_eq!(fs::metadata(&index).unwrap().modified().unwrap(), old);
        assert_eq!(cats(root, &[&a, &b, &c]), some(&["새/값", "새/값", "딴/데"]));
    }

    #[test]
    fn hand_written_shapes_are_rewritten_in_place() {
        let v = TempVault::new("move-shapes");
        let root = v.path();
        let crlf = make_in(root, "CRLF", "a/x");
        let bom = make_in(root, "BOM", "a/x");
        let block = make_in(root, "블록 목록", "a/x");
        let dup = make_in(root, "중복 줄", "a/x");

        let index = Path::new(&crlf.folder).join("index.md");
        let text = fs::read_to_string(&index).unwrap();
        fs::write(&index, text.replace('\n', "\r\n")).unwrap();
        let want_crlf =
            text.replace("category: \"a/x\"", "category: \"z/x\"").replace('\n', "\r\n");

        let index = Path::new(&bom.folder).join("index.md");
        let text = fs::read_to_string(&index).unwrap();
        fs::write(&index, format!("\u{feff}{text}")).unwrap();
        let want_bom = text.replace("category: \"a/x\"", "category: \"z/x\"");

        let text =
            fs::read_to_string(hand_write(&block, "category:\n  - a/x\n  - 운영\n")).unwrap();
        let want_block = text.replace("category:\n  - a/x\n  - 운영\n", "category: \"z/x\"\n");

        let text = fs::read_to_string(hand_write(&dup, "category: a/X # 메모\ncategory: \"b\"\n"))
            .unwrap();
        let want_dup =
            text.replace("category: a/X # 메모\ncategory: \"b\"\n", "category: \"z/X\"\n");

        let res = mv(root, "a", Some("z")).unwrap();
        assert_eq!(res.changed.len(), 4);
        let read =
            |t: &TaskMeta| fs::read_to_string(Path::new(&t.folder).join("index.md")).unwrap();
        assert_eq!(read(&crlf), want_crlf);
        // BOM 은 `Doc` 이 되살리지 못한다 — 다른 쓰기와 같다. 나머지 바이트는 그대로다.
        assert_eq!(read(&bom), want_bom);
        assert_eq!(read(&block), want_block);
        assert_eq!(read(&dup), want_dup);
    }

    #[test]
    fn moving_keeps_updated_order_and_body() {
        let v = TempVault::new("move-stamps");
        let root = v.path();
        let a = make_in(root, "가", "a");
        let b = make_in(root, "나", "a/x");
        reorder_tasks(root, &[b.folder.clone(), a.folder.clone()]).unwrap();
        set_updated(&a.folder, "2026-08-14 10:00");
        set_updated(&b.folder, "2026-08-15 11:00");
        let before = scan(root).unwrap();

        let res = mv(root, "a", Some("z")).unwrap();
        for (old, new) in before.iter().zip(&res.tasks) {
            assert_eq!(old.folder, new.folder, "순서가 그대로다");
            assert_eq!((&old.updated, old.order, old.runs), (&new.updated, new.order, new.runs));
            assert_eq!(old.tagline, new.tagline);
        }
        assert_eq!(cats(root, &[&a, &b]), some(&["z", "z/x"]));
    }

    #[test]
    fn archived_tasks_move_with_the_node_in_both_archive_modes() {
        let v = TempVault::new("move-archive");
        let root = v.path();
        let live = make_in(root, "진행 중", "a/x");
        let tagged = make_in(root, "태그 보관", "a");
        let moved = make_in(root, "이동 보관", "a/y");
        for (t, mode) in [(&tagged, "tag"), (&moved, "move")] {
            set_status(root, Path::new(&t.folder), "completed").unwrap();
            set_archived(root, Path::new(&t.folder), true, mode, false).unwrap();
        }
        let res = mv(root, "a", Some("b")).unwrap();
        assert_eq!(res.changed.len(), 3);
        let mut got: Vec<(&str, &str, Option<&str>)> = res
            .tasks
            .iter()
            .map(|t| {
                (t.title.as_str(), t.rel_folder.split('/').next().unwrap(), t.category.as_deref())
            })
            .collect();
        got.sort();
        assert_eq!(
            got,
            [
                ("이동 보관", "Archive", Some("b/y")),
                ("진행 중", "Tasks", Some("b/x")),
                ("태그 보관", "Tasks", Some("b")),
            ]
        );
        assert_eq!(cat_of(root, &live).as_deref(), Some("b/x"));
    }

    /// 편입된 노트(다른 업무의 하위 폴더)와 `reference/` 사본은 `scan` 밖이다 — 옛 카테고리를
    /// 그대로 둔다(의도). 업무 리스트에 서지 않는 노트라 고칠 이유도 없다.
    #[test]
    fn absorbed_notes_and_reference_copies_keep_their_old_category() {
        let v = TempVault::new("move-absorbed");
        let root = v.path();
        let parent = make_in(root, "받는 업무", "a");
        let child = make_in(root, "편입될 업무", "a/x");
        absorb_task(root, Path::new(&child.folder), Path::new(&parent.folder), None).unwrap();
        let copy = Path::new(&parent.folder).join("reference/다른 업무");
        fs::create_dir_all(&copy).unwrap();
        fs::write(copy.join("index.md"), "---\ntitle: 다른 업무\ncategory: \"a/y\"\n---\n")
            .unwrap();
        let parent_index = Path::new(&parent.folder).join("index.md");
        let others: Vec<_> =
            snapshot(root).into_iter().filter(|(path, _)| *path != parent_index).collect();
        assert_eq!(others.len(), 2);

        let res = mv(root, "a", Some("b")).unwrap();
        assert_eq!(res.changed, [parent.folder.as_str()]);
        assert_eq!(cat_of(root, &parent).as_deref(), Some("b"));
        for (path, bytes) in others {
            assert_eq!(fs::read(&path).unwrap(), bytes, "{path:?}");
        }
    }

    #[test]
    fn clearing_a_node_uncategorizes_its_subtree_behind_the_same_guard() {
        let v = TempVault::new("clear");
        let root = v.path();
        let a = make_in(root, "가", "a");
        let b = make_in(root, "나", "A/x");
        let c = make_in(root, "다", "ab");
        let res = clear_category(root, "a", None).unwrap();
        assert_eq!(sorted(res.changed), folders(&[&a, &b]));
        assert_eq!(cats(root, &[&a, &b, &c]), [None, None, Some("ab".into())]);

        // 다시 시도는 고른 폴더만.
        let d = make_in(root, "라", "b/x");
        let e = make_in(root, "마", "b/y");
        let only = [e.folder.clone()];
        let res = clear_category(root, "b", Some(&only)).unwrap();
        assert_eq!(res.changed, only);
        assert_eq!(cats(root, &[&d, &e]), [Some("b/x".into()), None]);

        // 계획한 뒤 서브트리를 벗어난 업무는 지우지 않는다.
        let tasks = scan(root).unwrap();
        let steps: Vec<Step> = targets(&tasks, "b", None)
            .unwrap()
            .into_iter()
            .map(|task| Step { task, new: None })
            .collect();
        set_category(root, &[d.folder.clone()], Some("딴/데")).unwrap();
        let res = apply(root, &steps);
        assert!(res.changed.is_empty());
        assert_eq!(res.failed.len(), 1);
        assert_eq!(cat_of(root, &d).as_deref(), Some("딴/데"));

        let err = clear_category(root, "없음", None).unwrap_err();
        assert_eq!(
            (err.kind.as_str(), err.message.as_str()),
            ("invalid", "그 카테고리의 업무가 없습니다")
        );
        let err = clear_category(root, "", None).unwrap_err();
        assert_eq!(err.message, "옮길 카테고리가 없습니다");
    }
}
