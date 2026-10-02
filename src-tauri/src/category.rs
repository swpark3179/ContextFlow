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
    /// 다 쓴 뒤 새로 훑은 업무 전체.
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

    let mut changed = Vec::new();
    let mut failed = Vec::new();
    for folder in folders {
        let path = Path::new(folder);
        let outcome =
            vault::ensure_task_folder(root, path, "카테고리를 바꿀 대상").and_then(|_| {
                vault::edit_index_inner(root, path, false, |doc| write(doc, value.as_deref()))
            });
        match outcome {
            Ok((_, true)) => changed.push(folder.clone()),
            Ok((_, false)) => {}
            Err(e) => failed.push(CategoryIssue {
                folder: folder.clone(),
                title: title_of(root, path),
                reason: e.message,
            }),
        }
    }
    Ok(CategoryChange { tasks: vault::scan(root)?, changed, failed })
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

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
}
