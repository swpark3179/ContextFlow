//! LLM 위키 — 완료한 업무를 지식으로 쌓는 저장소 계층.
//!
//! 카파시의 "LLM Wiki" 패턴을 이 앱의 Vault 에 맞춘 것이다. 층이 셋이다.
//!
//! * **원본(raw)** — 업무 폴더. 위키는 여기에 **아무것도 쓰지 않는다**. 반영 여부도 업무
//!   쪽 frontmatter 가 아니라 위키 쪽 소스 페이지가 기억한다(`source_sig`).
//! * **위키** — `<Vault>/Wiki/` 의 마크다운. LLM 이 본문을 쓰고, 앱이 경로 · frontmatter ·
//!   색인 · 기록을 맡는다. Obsidian 에서 그대로 그래프로 보인다.
//! * **규약** — `Wiki/SCHEMA.md`. 최초 1회 씨앗을 깔고, 그 뒤로는 사용자의 파일이다. 반영
//!   프롬프트에 "규약" 으로 실린다(출력 형식과 부딪히면 형식이 이긴다).
//!
//! 이 모듈이 지키는 약속:
//!
//! * **경로는 모델이 정하지 않는다.** 모델은 `type` 과 `title` 만 주고, 파일 이름은 여기서
//!   만든다(`stem_of`). 모델이 적은 경로를 그대로 쓰면 `../` 하나로 Vault 밖에 쓰거나, 같은
//!   개념이 철자만 다른 두 장으로 갈라진다.
//! * **쓰기는 한 번에.** 반영 한 건의 LLM 호출이 전부 끝난 뒤 `wiki_apply` 한 번으로 쓴다.
//!   중간에 실패하거나 취소하면 아무것도 쓰지 않은 채로 남고, 그 업무는 "반영 대기" 다.
//! * **덮어쓴 것은 남긴다.** 고치기 전의 페이지를 `.history/` 에 둔다(점 폴더라 Obsidian ·
//!   탐색기 트리에 보이지 않는다). LLM 이 기존 내용을 잃어버리는 사고의 안전망이다.
//! * **색인(index.md)과 기록(log.md)은 앱이 쓴다.** 둘 다 frontmatter 와 적용 결과에서
//!   결정적으로 만들 수 있는 것이라, 모델에게 맡겨 토큰을 쓰고 어긋날 위험을 질 이유가 없다.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::frontmatter::{unquote, Doc};
use crate::vault::{self, TaskMeta};

pub const WIKI_DIR: &str = "Wiki";
const HISTORY_DIR: &str = ".history";
/// `.history/` 에 남기는 적용 회차 수.
const HISTORY_KEEP: usize = 30;
const LOG_TAIL: usize = 20;

/// 원본 번들의 상한(글자). 프롬프트에 그대로 실리므로 모델의 입력 창과 FabriX 게이트웨이의
/// 요청 크기를 함께 생각한 값이다. 파일 하나가 전부를 먹지 않게 파일당 상한을 따로 둔다.
const INDEX_CAP: usize = 6_000;
const FILE_CAP: usize = 4_000;
const TOTAL_CAP: usize = 16_000;
/// 이보다 큰 파일은 읽지도 않는다(로그 덤프 · 내보낸 데이터).
const READ_LIMIT: u64 = 2_000_000;
/// 페이지 본문 하나의 상한. 모델이 폭주해도 Vault 에 수 MB 짜리 노트가 생기지 않게.
const BODY_CAP: usize = 200_000;

/// 페이지 유형 → 폴더. 순서가 색인의 순서다 — 절차를 맨 앞에 두는 것은 "그 일 어떻게 했더라"
/// 가 이 위키에 가장 자주 묻는 질문이라서다.
const KINDS: [(&str, &str, &str); 5] = [
    ("procedure", "procedures", "절차"),
    ("topic", "topics", "주제"),
    ("entity", "entities", "시스템 · 도구"),
    ("source", "sources", "업무 소스"),
    ("answer", "answers", "질의 답변"),
];

/// 소스 페이지 꼬리말의 시작 표시. 그 아래는 앱 소유라 업무가 옮겨지면 통째로 다시 쓴다.
/// HTML 주석이라 Obsidian 읽기 화면에는 보이지 않는다.
const SOURCE_FOOTER: &str = "<!-- contextflow:source -->";

const SCHEMA_SEED: &str = r#"---
type: schema
---
# 위키 규약

> 이 파일은 ContextFlow 가 처음 한 번만 만들고, 그 뒤로는 **사용자가 고치는 파일**입니다.
> 내용은 위키 반영 · 질의 요청에 "규약" 으로 그대로 실립니다. 단, 앱이 정한 응답 형식과
> 부딪히면 형식이 우선합니다.

## 이 위키가 하는 일

완료한 업무(Tasks · Archive 의 업무 폴더)를 원본으로 삼아, 다음에 비슷한 일을 할 때 **어떻게
했는지 · 왜 그렇게 했는지 · 무엇을 조심해야 하는지**를 바로 찾을 수 있게 정리한다.

## 페이지 유형

- `sources/` — 업무 1건 = 1장. 그 업무에서 한 일 · 결정 · 절차 · 산출물 · 문제와 해결.
- `procedures/` — 반복해서 하는 일의 절차(How-to). 여러 업무에서 배운 것을 합친다.
- `topics/` — 주제 · 개념 · 배경 지식.
- `entities/` — 시스템 · 서비스 · 도구 · 저장소. **사람 페이지는 만들지 않는다.**
- `answers/` — 위키에 물어 얻은 답 중 남길 만한 것.

## 쓰는 법

- 한국어로, 짧고 구체적으로. 다시 할 때 그대로 따라 할 수 있는 수준으로 적는다.
- 사실에는 출처 업무를 붙인다: `([[task-…]])`.
- 새 내용이 기존 내용과 부딪히면 지우지 말고 `> [!warning] 상충` 으로 남긴다.
- 링크는 `[[페이지 이름|보이는 글]]`. 업무 폴더로 직접 링크하지 않는다(소스 페이지가 다리다).
- 비밀번호 · 토큰 · 개인 연락처 같은 민감 정보는 옮기지 않는다.
"#;

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiInfo {
    pub dir: String,
    /// 이번 호출로 씨앗 파일을 하나라도 새로 깔았는가.
    pub seeded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    /// `Wiki/` 기준 경로. 예: `procedures/배포 절차.md`
    pub path: String,
    /// 확장자를 뺀 파일 이름 — 위키링크의 대상.
    pub stem: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    /// 이 페이지를 뒷받침하는 업무 id.
    pub sources: Vec<String>,
    pub created: String,
    pub updated: String,
    /// 소스 페이지만: 원본 업무 id · Vault 상대 경로 · 반영 당시 서명.
    pub task_id: Option<String>,
    pub task_path: Option<String>,
    pub source_sig: Option<String>,
    /// 본문에서 나가는 위키링크의 대상(중복 제거). AI 점검이 "빠진 링크" 를 요약만 보고
    /// 짐작하지 않도록 함께 보낸다 — 사내망에서 돌려 보니 이미 있는 링크를 빠졌다고 했다.
    pub links: Vec<String>,
    /// 파일 내용의 해시 — 읽은 뒤 다른 곳에서 바뀌었는지 판단하는 데 쓴다.
    pub hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceState {
    pub task_id: String,
    pub title: String,
    pub folder: String,
    pub rel_folder: String,
    pub completed_at: Option<String>,
    /// `fresh` = 반영됨 · `stale` = 반영 뒤 업무 내용이 바뀜 · `missing` = 아직 반영 안 됨
    pub state: String,
    pub page: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiStatus {
    pub dir: String,
    pub exists: bool,
    pub pages: Vec<PageMeta>,
    /// 보관된 업무만.
    pub tasks: Vec<SourceState>,
    /// 원본 업무가 사라진 소스 페이지.
    pub orphans: Vec<String>,
    /// 원본 업무가 옮겨져(보관 'move' · 이름 변경) 경로가 어긋난 소스 페이지의 업무 id.
    pub moved: Vec<String>,
    /// log.md 의 최근 항목 머리줄(새 것이 앞).
    pub log_tail: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub rel: String,
    pub chars: usize,
    pub text: Option<String>,
    pub truncated: bool,
    /// 본문을 싣지 않은 사유(바이너리 · 분량 상한 · 참고 사본 …).
    pub skipped: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBundle {
    pub task: TaskMeta,
    pub sig: String,
    /// 이 업무의 소스 페이지 경로와 stem — 다른 페이지가 인용할 때 `[[stem]]` 으로 쓴다.
    pub source_path: String,
    pub source_stem: String,
    /// 이미 반영된 적이 있는가(재반영이면 프롬프트 문구가 달라진다).
    pub reingest: bool,
    pub files: Vec<SourceFile>,
    pub total_chars: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPage {
    pub path: String,
    pub content: String,
    pub hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiHit {
    pub path: String,
    pub stem: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub score: f64,
    pub snippet: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageWrite {
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 이 페이지를 뒷받침하는 업무 id(반영이면 그 업무는 앱이 알아서 넣는다).
    #[serde(default)]
    pub sources: Vec<String>,
    /// 모델에게 보여 준 기존 내용의 해시. 그 사이 파일이 바뀌었으면 쓰지 않고 건너뛴다.
    /// `None` 인데 같은 이름의 페이지가 이미 있으면 덮어쓰지 않고 **덧붙인다** — 모델이 본
    /// 적 없는 내용을 지울 수는 없다.
    #[serde(default)]
    pub base_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReq {
    /// `ingest` · `query` · `lint`
    pub op: String,
    /// log 항목의 제목.
    pub title: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub pages: Vec<PageWrite>,
    /// log 항목에 덧붙일 줄(글머리 없이).
    #[serde(default)]
    pub log: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub path: String,
    pub stem: String,
    pub title: String,
    /// `created` · `updated` · `appended`
    pub action: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub written: Vec<Written>,
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LintIssue {
    pub kind: String,
    pub path: String,
    pub detail: String,
}

// ---------------------------------------------------------------------------
// 작은 도구들
// ---------------------------------------------------------------------------

/// FNV-1a 64. 암호학적 해시가 필요 없고(바뀌었나만 본다) 크레이트를 늘리지 않으려는 것.
/// `DefaultHasher` 는 Rust 판마다 값이 달라질 수 있어 파일에 남기는 서명으로 못 쓴다.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= *b as u64;
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }
    fn hex(&self) -> String {
        format!("{:016x}", self.0)
    }
}

/// 내용 해시. 줄끝을 맞춘 뒤 잰다 — Git 이나 편집기가 CRLF 로 바꿔 놓았다고 "바뀐 파일"
/// 이 되면 충돌 검사가 멀쩡한 쓰기를 막는다.
fn content_hash(text: &str) -> String {
    let mut h = Fnv::new();
    h.write(text.replace("\r\n", "\n").as_bytes());
    h.hex()
}

fn wiki_dir(root: &Path) -> PathBuf {
    root.join(WIKI_DIR)
}

fn kind_folder(kind: &str) -> Option<&'static str> {
    KINDS
        .iter()
        .find(|(k, _, _)| *k == kind)
        .map(|(_, f, _)| *f)
}

fn kind_of_folder(folder: &str) -> Option<&'static str> {
    KINDS
        .iter()
        .find(|(_, f, _)| *f == folder)
        .map(|(k, _, _)| *k)
}

/// Windows 가 거부하는 장치 이름. 확장자가 붙어도(`CON.md`) 열리지 않는다.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 제목 → 파일 이름(확장자 제외).
///
/// `vault::sanitize_name` 의 규칙에 더해 `[ ]` 를 지운다 — 위키링크 `[[…]]` 안에서 괄호가
/// 링크를 끊는다(README 의 `[YYYY-MM]` 접두사 문제와 같다). 공백은 하나로 접고 60자에서
/// 자른다. 루트 파일(index · log · SCHEMA)과 같은 이름은 링크가 갈라지므로 피한다.
pub fn stem_of(title: &str) -> String {
    let base = vault::sanitize_name(&title.replace(['[', ']'], " "));
    let mut s: String = base.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_start_matches('.').to_string();
    s = s
        .chars()
        .take(60)
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .trim()
        .to_string();
    if s.is_empty() {
        s = "제목 없음".to_string();
    }
    let upper = s.to_ascii_uppercase();
    if RESERVED.contains(&upper.as_str()) || ["INDEX", "LOG", "SCHEMA"].contains(&upper.as_str()) {
        s.push('_');
    }
    s
}

/// frontmatter 문자열 값을 항상 큰따옴표로 감싼다. `quote_if_needed` 는 `#` 이나 맨 앞의
/// `-` 같은 YAML 특수 문자를 놓쳐서, 모델이 쓴 요약 한 줄이 Obsidian 에서 깨질 수 있다.
fn yaml_quote(v: &str) -> String {
    let one_line = v.replace(['\r', '\n'], " ");
    format!(
        "\"{}\"",
        one_line.trim().replace('\\', "\\\\").replace('"', "\\\"")
    )
}

/// `yaml_quote` 의 역. 다른 곳(Obsidian · 사람)이 쓴 따옴표 없는 값도 그대로 읽는다.
fn fm_str(doc: &Doc, key: &str) -> Option<String> {
    let raw = doc.get(key)?.trim();
    let v = if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        let inner = &raw[1..raw.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some(n) => out.push(n),
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        unquote(raw)
    };
    Some(v).filter(|v| !v.is_empty() && v != "null" && v != "~")
}

/// 태그 위생 — `#` 접두사 · 공백 · 목록 문법 문자를 걷어낸다.
fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t: String = t
            .trim()
            .trim_start_matches('#')
            .chars()
            .map(|c| if c.is_whitespace() { '-' } else { c })
            .filter(|c| !matches!(c, '[' | ']' | ',' | ':' | '"' | '\''))
            .collect();
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// 마크다운 링크 경로의 퍼센트 인코딩. 한글은 그대로 두고 링크를 끊는 문자만 바꾼다 —
/// Obsidian 과 이 앱의 뷰어가 둘 다 그대로 읽는다.
fn encode_link(path: &str) -> String {
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

/// 임시 파일에 쓴 뒤 이름을 바꾼다 — 쓰는 도중 앱이 죽어도 반쯤 쓴 노트가 남지 않는다.
fn write_atomic(path: &Path, text: &str) -> Result<()> {
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

/// `[[대상|별칭]]` 들의 대상. `#제목` · `^블록` 은 떼어 낸다.
pub fn link_targets(md: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = md;
    while let Some(i) = rest.find("[[") {
        let after = &rest[i + 2..];
        let Some(j) = after.find("]]") else { break };
        let inner = &after[..j];
        if !inner.contains('\n') {
            let target = inner.split('|').next().unwrap_or("");
            let target = target.split(['#', '^']).next().unwrap_or("").trim();
            if !target.is_empty() {
                out.push(target.to_string());
            }
        }
        rest = &after[j + 2..];
    }
    out
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

fn page_meta(rel: &str, text: &str) -> PageMeta {
    let doc = Doc::parse(text);
    let stem = Path::new(rel)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let folder = rel.split('/').next().unwrap_or("");
    let kind = fm_str(&doc, "type")
        .filter(|k| kind_folder(k).is_some())
        .or_else(|| kind_of_folder(folder).map(str::to_string))
        .unwrap_or_else(|| "topic".to_string());
    PageMeta {
        path: rel.to_string(),
        title: fm_str(&doc, "title").unwrap_or_else(|| stem.clone()),
        stem,
        kind,
        summary: fm_str(&doc, "summary").unwrap_or_default(),
        tags: doc.get_list("tags"),
        sources: doc.get_list("sources"),
        created: fm_str(&doc, "created").unwrap_or_default(),
        updated: fm_str(&doc, "updated").unwrap_or_default(),
        task_id: fm_str(&doc, "task_id"),
        task_path: fm_str(&doc, "task_path"),
        source_sig: fm_str(&doc, "source_sig"),
        links: {
            let mut seen = Vec::new();
            for t in link_targets(&doc.body) {
                if !seen.contains(&t) {
                    seen.push(t);
                }
            }
            seen
        },
        hash: content_hash(text),
    }
}

/// 유형 폴더들의 페이지. 루트 파일(index · log · SCHEMA)과 다른 폴더는 보지 않는다 —
/// 사용자가 `Wiki/` 아래에 따로 둔 메모까지 색인이 먹어 버리지 않게.
fn load_pages(root: &Path) -> Vec<(PageMeta, String)> {
    let dir = wiki_dir(root);
    let mut out = Vec::new();
    for (_, folder, _) in KINDS {
        let Ok(entries) = fs::read_dir(dir.join(folder)) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !name.to_lowercase().ends_with(".md") {
                continue;
            }
            if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let Ok(text) = fs::read_to_string(e.path()) else {
                continue;
            };
            let rel = format!("{folder}/{name}");
            out.push((page_meta(&rel, &text), text));
        }
    }
    out.sort_by(|a, b| a.0.path.to_lowercase().cmp(&b.0.path.to_lowercase()));
    out
}

/// 업무 폴더의 파일 목록 — 번들과 서명이 같은 규칙을 쓴다(그래야 "번들에 실린 것이 바뀌면
/// 서명이 바뀐다" 가 성립한다).
struct Entry {
    rel: String,
    path: PathBuf,
    size: u64,
    mtime: u64,
    /// `reference/` — [참고만 하기] 로 가져온 다른 업무의 사본. 본문을 싣지 않는다.
    reference: bool,
}

fn walk_task(folder: &Path) -> Vec<Entry> {
    fn go(base: &Path, dir: &Path, depth: usize, out: &mut Vec<Entry>) {
        if depth > 8 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue; // .context_snapshot.json · .obsidian …
            }
            let Ok(meta) = fs::symlink_metadata(e.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue; // 밖을 가리키는 링크를 따라가 남의 파일을 싣지 않는다
            }
            let rel = e
                .path()
                .strip_prefix(base)
                .unwrap_or(&e.path())
                .to_string_lossy()
                .replace('\\', "/");
            if meta.is_dir() {
                if depth == 0 && name == "reference" {
                    out.push(Entry {
                        rel: format!("{rel}/"),
                        path: e.path(),
                        size: 0,
                        mtime: 0,
                        reference: true,
                    });
                    continue;
                }
                go(base, &e.path(), depth + 1, out);
            } else if meta.is_file() {
                if depth == 0 && name == "index.md" {
                    continue; // 본문을 따로 다룬다
                }
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                out.push(Entry {
                    rel,
                    path: e.path(),
                    size: meta.len(),
                    mtime,
                    reference: false,
                });
            }
        }
    }
    let mut out = Vec::new();
    go(folder, folder, 0, &mut out);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    out
}

fn index_body(folder: &Path) -> String {
    fs::read_to_string(folder.join("index.md"))
        .map(|t| Doc::parse(&t).body)
        .unwrap_or_default()
}

/// 업무 내용의 서명. index.md 는 **본문만** 잰다 — 보관하면 frontmatter(`archived` ·
/// `archived_at`)가 바뀌는데, 그것까지 세면 보관하는 순간 모든 업무가 "바뀜" 이 된다.
/// 나머지 파일은 내용을 읽지 않고 경로 · 크기 · 수정 시각만 잰다(보관 업무 전부를 매번
/// 훑어도 가볍게).
pub fn source_sig(folder: &Path) -> String {
    let mut h = Fnv::new();
    h.write(index_body(folder).replace("\r\n", "\n").as_bytes());
    for e in walk_task(folder) {
        h.write(b"\0");
        h.write(e.rel.as_bytes());
        h.write(format!(":{}:{}", e.size, e.mtime).as_bytes());
    }
    h.hex()
}

fn source_rel(task_id: &str) -> String {
    format!("sources/{}.md", stem_of(task_id))
}

fn take_chars(s: &str, n: usize) -> (String, bool) {
    let mut it = s.chars();
    let head: String = it.by_ref().take(n).collect();
    let cut = it.next().is_some();
    (head, cut)
}

fn find_task(root: &Path, task_id: &str) -> Result<TaskMeta> {
    vault::scan(root)?
        .into_iter()
        .find(|t| t.id == task_id)
        .ok_or_else(|| AppError::new("not_found", format!("업무를 찾지 못했습니다: {task_id}")))
}

pub fn read_source(root: &Path, task_id: &str) -> Result<SourceBundle> {
    let task = find_task(root, task_id)?;
    let folder = PathBuf::from(&task.folder);
    let mut files = Vec::new();
    let mut total = 0usize;

    let body = index_body(&folder);
    let (text, cut) = take_chars(body.trim(), INDEX_CAP);
    total += text.chars().count();
    files.push(SourceFile {
        rel: "index.md".into(),
        chars: body.chars().count(),
        text: Some(text),
        truncated: cut,
        skipped: None,
    });

    for e in walk_task(&folder) {
        let skip = |why: &str| SourceFile {
            rel: e.rel.clone(),
            chars: 0,
            text: None,
            truncated: false,
            skipped: Some(why.to_string()),
        };
        if e.reference {
            files.push(skip("다른 업무에서 참고로 가져온 사본 — 본문 생략"));
            continue;
        }
        let name = e.rel.rsplit('/').next().unwrap_or(&e.rel);
        if !crate::fsops::is_text(name) {
            files.push(skip("바이너리 · 문서 파일 — 이름만"));
            continue;
        }
        if e.size > READ_LIMIT {
            files.push(skip("파일이 커서 읽지 않음"));
            continue;
        }
        if total >= TOTAL_CAP {
            files.push(skip("분량 상한에 닿아 생략"));
            continue;
        }
        let Ok(bytes) = fs::read(&e.path) else {
            files.push(skip("읽지 못함"));
            continue;
        };
        let raw = String::from_utf8_lossy(&bytes);
        let room = FILE_CAP.min(TOTAL_CAP - total);
        let (text, cut) = take_chars(raw.trim(), room);
        total += text.chars().count();
        files.push(SourceFile {
            rel: e.rel.clone(),
            chars: raw.chars().count(),
            text: Some(text),
            truncated: cut,
            skipped: None,
        });
    }

    let source_path = source_rel(&task.id);
    let reingest = wiki_dir(root).join(&source_path).is_file();
    Ok(SourceBundle {
        sig: source_sig(&folder),
        source_stem: stem_of(&task.id),
        source_path,
        reingest,
        files,
        total_chars: total,
        task,
    })
}

fn log_tail(root: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(wiki_dir(root).join("log.md")) else {
        return Vec::new();
    };
    let mut heads: Vec<String> = text
        .lines()
        .filter(|l| l.starts_with("## ["))
        .map(|l| l.trim_start_matches("## ").to_string())
        .collect();
    heads.reverse();
    heads.truncate(LOG_TAIL);
    heads
}

pub fn status(root: &Path, arch_days: i64) -> Result<WikiStatus> {
    let dir = wiki_dir(root);
    let pages: Vec<PageMeta> = load_pages(root).into_iter().map(|(m, _)| m).collect();
    let tasks = vault::scan(root)?;

    let by_task: HashMap<&str, &PageMeta> = pages
        .iter()
        .filter(|p| p.kind == "source")
        .filter_map(|p| p.task_id.as_deref().map(|id| (id, p)))
        .collect();

    let mut states = Vec::new();
    let mut moved = Vec::new();
    for t in tasks.iter().filter(|t| vault::is_archived(t, arch_days)) {
        let page = by_task.get(t.id.as_str());
        let state = match page {
            None => "missing",
            Some(p) if p.source_sig.as_deref() == Some(&source_sig(Path::new(&t.folder))) => {
                "fresh"
            }
            Some(_) => "stale",
        };
        if let Some(p) = page {
            if p.task_path.as_deref() != Some(t.rel_folder.as_str()) {
                moved.push(t.id.clone());
            }
        }
        states.push(SourceState {
            task_id: t.id.clone(),
            title: t.title.clone(),
            folder: t.folder.clone(),
            rel_folder: t.rel_folder.clone(),
            completed_at: t.completed_at.clone(),
            state: state.to_string(),
            page: page.map(|p| p.path.clone()),
        });
    }
    let known: HashSet<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
    let orphans = pages
        .iter()
        .filter(|p| p.kind == "source")
        .filter(|p| {
            p.task_id
                .as_deref()
                .map(|id| !known.contains(id))
                .unwrap_or(true)
        })
        .map(|p| p.path.clone())
        .collect();

    Ok(WikiStatus {
        dir: dir.to_string_lossy().replace('\\', "/"),
        exists: dir.is_dir(),
        pages,
        tasks: states,
        orphans,
        moved,
        log_tail: log_tail(root),
    })
}

/// `Wiki/` 기준 상대 경로를 검증해 절대 경로로. `.md` 만, 밖으로 나가는 경로는 거절.
fn page_path(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.replace('\\', "/");
    if !rel.to_lowercase().ends_with(".md") || rel.split('/').any(|s| s.starts_with('.')) {
        return Err(AppError::new(
            "invalid_path",
            format!("위키 페이지 경로가 아닙니다: {rel}"),
        ));
    }
    crate::fsops::safe_join(&wiki_dir(root), &rel)
}

pub fn read_pages(root: &Path, paths: &[String]) -> Result<Vec<WikiPage>> {
    let mut out = Vec::new();
    for rel in paths {
        let path = page_path(root, rel)?;
        if let Ok(content) = fs::read_to_string(&path) {
            out.push(WikiPage {
                path: rel.replace('\\', "/"),
                hash: content_hash(&content),
                content,
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 검색
// ---------------------------------------------------------------------------

fn count_tokens(text: &str) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    for t in crate::recommend::tokens(text) {
        *m.entry(t).or_insert(0) += 1;
    }
    m
}

/// 로컬 검색 — 네트워크 없이 즉시. `recommend::tokens`(영문 단어 + 한글 바이그램) 위의 IDF
/// 가중 점수로, 제목 ×3 · 요약 ×2 · 태그 ×2 · 본문(포화) 를 더한다. 본문은 많이 나올수록
/// 점수가 끝없이 오르지 않게 `tf/(tf+1.5)` 로 눌러 둔다 — 긴 소스 페이지가 짧은 절차
/// 페이지를 밀어내지 않게.
pub fn search(root: &Path, query: &str, limit: usize) -> Vec<WikiHit> {
    let q: Vec<String> = {
        let mut seen = HashSet::new();
        crate::recommend::tokens(query)
            .into_iter()
            .filter(|t| seen.insert(t.clone()))
            .collect()
    };
    if q.is_empty() {
        return Vec::new();
    }
    let pages = load_pages(root);
    struct Doc3 {
        title: HashMap<String, usize>,
        summary: HashMap<String, usize>,
        tags: HashMap<String, usize>,
        body: HashMap<String, usize>,
    }
    let docs: Vec<Doc3> = pages
        .iter()
        .map(|(m, text)| Doc3 {
            title: count_tokens(&m.title),
            summary: count_tokens(&m.summary),
            tags: count_tokens(&m.tags.join(" ")),
            body: count_tokens(&Doc::parse(text).body),
        })
        .collect();
    let n = docs.len().max(1) as f64;
    let idf = |t: &String| {
        let df = docs
            .iter()
            .filter(|d| {
                d.title.contains_key(t)
                    || d.summary.contains_key(t)
                    || d.tags.contains_key(t)
                    || d.body.contains_key(t)
            })
            .count() as f64;
        ((n + 1.0) / (df + 1.0)).ln() + 1.0
    };

    let words: Vec<String> = query
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .filter(|w| w.chars().count() >= 2)
        .collect();

    let mut hits: Vec<WikiHit> = Vec::new();
    for ((meta, text), d) in pages.iter().zip(docs.iter()) {
        let mut score = 0.0;
        for t in &q {
            let present = |m: &HashMap<String, usize>| if m.contains_key(t) { 1.0 } else { 0.0 };
            let tf = *d.body.get(t).unwrap_or(&0) as f64;
            let local = 3.0 * present(&d.title)
                + 2.0 * present(&d.summary)
                + 2.0 * present(&d.tags)
                + tf / (tf + 1.5);
            if local > 0.0 {
                score += idf(t) * local;
            }
        }
        if score <= 0.0 {
            continue;
        }
        let body = Doc::parse(text).body;
        let snippet = body
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("<!--"))
            .find(|l| {
                let low = l.to_lowercase();
                words.iter().any(|w| low.contains(w.as_str()))
            })
            .map(|l| l.chars().take(120).collect())
            .unwrap_or_else(|| meta.summary.chars().take(120).collect());
        hits.push(WikiHit {
            path: meta.path.clone(),
            stem: meta.stem.clone(),
            kind: meta.kind.clone(),
            title: meta.title.clone(),
            summary: meta.summary.clone(),
            score: (score * 100.0).round() / 100.0,
            snippet,
        });
    }
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit.max(1));
    hits
}

// ---------------------------------------------------------------------------
// 쓰기
// ---------------------------------------------------------------------------

pub fn init(root: &Path) -> Result<WikiInfo> {
    let dir = wiki_dir(root);
    for (_, folder, _) in KINDS {
        fs::create_dir_all(dir.join(folder))?;
    }
    let mut seeded = false;
    let schema = dir.join("SCHEMA.md");
    if !schema.exists() {
        fs::write(&schema, SCHEMA_SEED)?;
        seeded = true;
    }
    let log = dir.join("log.md");
    if !log.exists() {
        fs::write(
            &log,
            "# 위키 작업 기록\n\n> append-only — ContextFlow 가 반영 · 질의 · 점검을 할 때마다 아래에 한 항목씩 덧붙입니다.\n> 각 항목은 `## [날짜 시각] 작업 | 제목` 으로 시작합니다.\n",
        )?;
        seeded = true;
    }
    if !dir.join("index.md").exists() {
        rebuild_index(root)?;
        seeded = true;
    }
    Ok(WikiInfo {
        dir: dir.to_string_lossy().replace('\\', "/"),
        seeded,
    })
}

/// 색인 — 유형별로 묶고 제목순. **같은 페이지들이면 몇 번을 다시 만들어도 같은 바이트**다
/// (만든 시각을 넣지 않고 페이지들의 최신 `updated` 를 쓴다). 그래야 Git 이나 동기화 도구가
/// 반영할 때마다 색인을 "바뀐 파일" 로 잡지 않는다.
pub fn rebuild_index(root: &Path) -> Result<PathBuf> {
    let pages: Vec<PageMeta> = load_pages(root).into_iter().map(|(m, _)| m).collect();
    let latest = pages.iter().map(|p| p.updated.as_str()).max().unwrap_or("");
    let sources = pages.iter().filter(|p| p.kind == "source").count();

    let mut md = String::new();
    md.push_str("---\ntype: index\n---\n# 위키 색인\n\n");
    md.push_str("> ContextFlow 가 페이지들의 frontmatter 로 자동 생성합니다. 직접 고치면 다음 반영 때 덮어써집니다.\n");
    md.push_str("> 규약은 [[Wiki/SCHEMA|SCHEMA]], 작업 기록은 [[Wiki/log|log]] 에 있습니다.\n\n");
    md.push_str(&format!(
        "전체 {}페이지 · 업무 소스 {}건{}\n",
        pages.len(),
        sources,
        if latest.is_empty() {
            String::new()
        } else {
            format!(" · 최근 갱신 {latest}")
        }
    ));

    for (kind, _, label) in KINDS {
        let mut group: Vec<&PageMeta> = pages.iter().filter(|p| p.kind == kind).collect();
        if group.is_empty() {
            continue;
        }
        group.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then(a.path.cmp(&b.path))
        });
        md.push_str(&format!("\n## {label} ({})\n\n", group.len()));
        for p in group {
            let mut line = format!("- [[{}|{}]]", p.stem, p.title.replace(['[', ']', '|'], " "));
            if !p.summary.is_empty() {
                line.push_str(&format!(" — {}", p.summary));
            }
            if kind == "source" {
                if let Some(t) = &p.updated.get(..10) {
                    line.push_str(&format!(" · {t}"));
                }
            } else if !p.sources.is_empty() {
                line.push_str(&format!(" · 업무 {}건", p.sources.len()));
            }
            md.push_str(&line);
            md.push('\n');
        }
    }
    let path = wiki_dir(root).join("index.md");
    write_atomic(&path, &md)?;
    Ok(path)
}

fn append_log(root: &Path, head: &str, lines: &[String]) -> Result<()> {
    let path = wiki_dir(root).join("log.md");
    let mut text = fs::read_to_string(&path).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("\n## [{}] {}\n", vault::now_stamp(), head));
    for l in lines {
        text.push_str(&format!("- {}\n", l.replace('\n', " ")));
    }
    write_atomic(&path, &text)
}

/// 소스 페이지의 꼬리말 — 원본 업무로 가는 길. 앱 소유라 업무가 옮겨지면 다시 쓴다.
fn source_footer(task: &TaskMeta) -> String {
    let link = encode_link(&format!("../../{}index.md", task.rel_folder));
    let mut s = format!(
        "{SOURCE_FOOTER}\n## 원본 업무\n\n- [{}]({link})",
        task.title.replace(['[', ']'], " ")
    );
    if let Some(d) = &task.completed_at {
        s.push_str(&format!(" · 완료 {d}"));
    }
    s.push_str(&format!("\n- 경로: `{}`\n", task.rel_folder));
    s
}

fn strip_footer(body: &str) -> &str {
    match body.find(SOURCE_FOOTER) {
        Some(i) => body[..i].trim_end(),
        None => body.trim_end(),
    }
}

/// 본문 맨 앞의 `# 제목` 줄 하나를 걷어 낸다(덧붙이기 · 제목 재삽입용).
fn strip_h1(body: &str) -> &str {
    let t = body.trim_start();
    if t.starts_with("# ") {
        t.split_once('\n')
            .map(|(_, r)| r.trim_start())
            .unwrap_or("")
    } else {
        t
    }
}

fn history_dir(root: &Path) -> PathBuf {
    wiki_dir(root).join(HISTORY_DIR)
}

/// 오래된 백업 회차를 지운다(이름이 시각이라 이름순 = 시간순).
fn prune_history(root: &Path) {
    let Ok(entries) = fs::read_dir(history_dir(root)) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    while dirs.len() > HISTORY_KEEP {
        let old = dirs.remove(0);
        let _ = fs::remove_dir_all(old);
    }
}

pub fn apply(root: &Path, req: &ApplyReq) -> Result<ApplyResult> {
    init(root)?;
    let dir = wiki_dir(root);
    let stamp = vault::now_stamp();
    let task = match &req.task_id {
        Some(id) if req.op == "ingest" => Some(find_task(root, id)?),
        _ => None,
    };

    // stem → 기존 경로(대소문자 무시). 같은 개념이 다른 폴더에 두 장 생기지 않게 한다.
    let existing: Vec<PageMeta> = load_pages(root).into_iter().map(|(m, _)| m).collect();
    let mut stems: HashMap<String, String> = existing
        .iter()
        .map(|p| (p.stem.to_lowercase(), p.path.clone()))
        .collect();

    let backup = {
        let base = history_dir(root).join(chrono::Local::now().format("%Y%m%d-%H%M%S").to_string());
        let mut b = base.clone();
        let mut n = 2;
        while b.exists() {
            b = PathBuf::from(format!("{}-{n}", base.display()));
            n += 1;
        }
        b
    };
    let mut backed_up = false;

    let mut written = Vec::new();
    let mut skipped = Vec::new();

    for w in &req.pages {
        let title = w.title.trim();
        if title.is_empty() || w.body.trim().is_empty() {
            skipped.push(Skipped {
                title: title.to_string(),
                reason: "제목이나 본문이 비어 있습니다".into(),
            });
            continue;
        }
        let Some(folder) = kind_folder(&w.kind) else {
            skipped.push(Skipped {
                title: title.to_string(),
                reason: format!("알 수 없는 유형: {}", w.kind),
            });
            continue;
        };
        // 소스 페이지는 지금 반영 중인 업무의 것만 쓸 수 있다 — 모델이 다른 업무의 소스를
        // 고쳐 쓰면 그 업무의 반영 상태가 거짓이 된다.
        let rel = if w.kind == "source" {
            match &task {
                Some(t) => source_rel(&t.id),
                None => {
                    skipped.push(Skipped {
                        title: title.to_string(),
                        reason: "소스 페이지는 반영 중인 업무만 쓸 수 있습니다".into(),
                    });
                    continue;
                }
            }
        } else if req.op == "query" && w.kind != "answer" {
            skipped.push(Skipped {
                title: title.to_string(),
                reason: "질의는 답변 페이지만 쓸 수 있습니다".into(),
            });
            continue;
        } else {
            let stem = stem_of(title);
            match stems.get(&stem.to_lowercase()) {
                // 소스 페이지의 이름(업무 id)을 다른 유형이 가로챌 수는 없다.
                Some(p) if p.starts_with("sources/") => format!("{folder}/{stem} (페이지).md"),
                Some(p) => p.clone(),
                None => format!("{folder}/{stem}.md"),
            }
        };
        let path = dir.join(&rel);
        let old = fs::read_to_string(&path).ok();

        let mut body = w.body.trim().to_string();
        if body.chars().count() > BODY_CAP {
            body = body.chars().take(BODY_CAP).collect();
        }

        let action;
        let mut doc = match &old {
            Some(text) => Doc::parse(text),
            None => Doc::parse("---\n---\n"),
        };
        if let Some(text) = &old {
            let cur = content_hash(text);
            match &w.base_hash {
                Some(h) if *h != cur && w.kind != "source" => {
                    skipped.push(Skipped {
                        title: title.to_string(),
                        reason: "읽은 뒤 다른 곳에서 바뀌어 덮어쓰지 않았습니다".into(),
                    });
                    continue;
                }
                None if w.kind != "source" => {
                    // 모델이 본 적 없는 내용은 지우지 않는다 — 아래에 덧붙인다.
                    let tag = req
                        .task_id
                        .as_deref()
                        .map(|id| format!(" ([[{}]])", stem_of(id)))
                        .unwrap_or_default();
                    body = format!(
                        "{}\n\n## 추가 — {}{}\n\n{}",
                        Doc::parse(text).body.trim(),
                        &stamp[..10.min(stamp.len())],
                        tag,
                        strip_h1(&body)
                    );
                    action = "appended";
                }
                _ => action = "updated",
            }
            if !backed_up {
                fs::create_dir_all(&backup)?;
                backed_up = true;
            }
            let dest = backup.join(&rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&dest, text)?;
        } else {
            action = "created";
        }
        let action = if old.is_some() && action == "created" {
            "updated"
        } else {
            action
        };

        // 제목 줄이 없으면 붙인다 — Obsidian 에서 열었을 때 무엇에 관한 페이지인지 바로 보이게.
        let mut content = strip_footer(&body).to_string();
        if !content.trim_start().starts_with("# ") {
            content = format!("# {title}\n\n{}", content.trim_start());
        }
        if let (true, Some(t)) = (w.kind == "source", &task) {
            content = format!("{}\n\n{}", content.trim_end(), source_footer(t));
        }

        let mut sources = doc.get_list("sources");
        let mut extra: Vec<String> = w.sources.clone();
        if let Some(t) = &task {
            extra.push(t.id.clone());
        }
        for s in extra {
            let s = s.trim().to_string();
            if !s.is_empty() && !sources.contains(&s) {
                sources.push(s);
            }
        }

        doc.set("type", w.kind.clone());
        doc.set("title", yaml_quote(title));
        let summary = w
            .summary
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| fm_str(&doc, "summary"))
            .unwrap_or_default();
        doc.set(
            "summary",
            yaml_quote(&summary.chars().take(160).collect::<String>()),
        );
        let tags = if w.tags.is_empty() {
            doc.get_list("tags")
        } else {
            clean_tags(&w.tags)
        };
        doc.set_list("tags", &tags);
        doc.set_list("sources", &sources);
        if fm_str(&doc, "created").is_none() {
            doc.set("created", stamp.clone());
        }
        doc.set("updated", stamp.clone());
        if let (true, Some(t)) = (w.kind == "source", &task) {
            doc.set("task_id", yaml_quote(&t.id));
            doc.set("task_title", yaml_quote(&t.title));
            doc.set("task_path", yaml_quote(&t.rel_folder));
            if let Some(d) = &t.completed_at {
                doc.set("completed_at", d.clone());
            }
            doc.set("source_sig", source_sig(Path::new(&t.folder)));
        }
        doc.set_body(format!("\n{}\n", content.trim()));
        write_atomic(&path, &doc.render())?;

        let stem = Path::new(&rel)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        stems.insert(stem.to_lowercase(), rel.clone());
        written.push(Written {
            path: rel,
            stem,
            title: title.to_string(),
            action: action.to_string(),
        });
    }

    rebuild_index(root)?;

    let mut lines: Vec<String> = written
        .iter()
        .map(|w| {
            let verb = match w.action.as_str() {
                "created" => "만듦",
                "appended" => "덧붙임",
                _ => "고침",
            };
            format!(
                "{verb}: [[{}|{}]]",
                w.stem,
                w.title.replace(['[', ']', '|'], " ")
            )
        })
        .collect();
    for s in &skipped {
        lines.push(format!("건너뜀: {} — {}", s.title, s.reason));
    }
    lines.extend(req.log.iter().cloned());
    let head = match &req.task_id {
        Some(id) => format!("{} | {} ({id})", req.op, req.title),
        None => format!("{} | {}", req.op, req.title),
    };
    append_log(root, &head, &lines)?;
    if backed_up {
        prune_history(root);
    }
    Ok(ApplyResult { written, skipped })
}

/// 옮겨진 업무(보관 'move' · 이름 변경)의 소스 페이지가 새 경로를 가리키게 한다. 고친 수를
/// 돌려준다. 본문은 꼬리말만 다시 쓰고 나머지는 건드리지 않는다.
pub fn relink(root: &Path, arch_days: i64) -> Result<usize> {
    let st = status(root, arch_days)?;
    let tasks = vault::scan(root)?;
    let mut fixed = 0;
    for id in &st.moved {
        let Some(t) = tasks.iter().find(|t| &t.id == id) else {
            continue;
        };
        let path = wiki_dir(root).join(source_rel(id));
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let mut doc = Doc::parse(&text);
        doc.set("task_path", yaml_quote(&t.rel_folder));
        let body = format!(
            "\n{}\n\n{}",
            strip_footer(&doc.body).trim(),
            source_footer(t)
        );
        doc.set_body(body);
        write_atomic(&path, &doc.render())?;
        fixed += 1;
    }
    if fixed > 0 {
        append_log(
            root,
            &format!("relink | 옮겨진 업무 {fixed}건의 경로를 고쳤습니다"),
            &[],
        )?;
    }
    Ok(fixed)
}

/// 로컬 점검 — 모델 없이 frontmatter 와 링크만으로 찾을 수 있는 것들.
pub fn lint_local(root: &Path, arch_days: i64) -> Result<Vec<LintIssue>> {
    let st = status(root, arch_days)?;
    let pages = load_pages(root);
    let stems: HashSet<String> = pages.iter().map(|(m, _)| m.stem.to_lowercase()).collect();
    let paths: HashSet<String> = pages
        .iter()
        .map(|(m, _)| m.path.trim_end_matches(".md").to_lowercase())
        .collect();
    let root_files = ["wiki/index", "wiki/log", "wiki/schema"];

    let mut inbound: HashMap<String, usize> = HashMap::new();
    let mut issues = Vec::new();
    for (m, text) in &pages {
        for target in link_targets(&Doc::parse(text).body) {
            let t = target.trim_end_matches(".md").to_lowercase();
            if t == "index" {
                issues.push(LintIssue {
                    kind: "bare-index".into(),
                    path: m.path.clone(),
                    detail: "[[index]] 는 업무마다 있는 index.md 와 이름이 같아 엉뚱한 노트로 갑니다 — [[Wiki/index]] 로 쓰세요".into(),
                });
                continue;
            }
            let t = t.strip_prefix("wiki/").map(str::to_string).unwrap_or(t);
            let resolved = if root_files.contains(&format!("wiki/{t}").as_str()) {
                None
            } else if t.contains('/') {
                paths
                    .contains(&t)
                    .then(|| t.rsplit('/').next().unwrap_or(&t).to_string())
            } else {
                stems.contains(&t).then(|| t.clone())
            };
            match resolved {
                Some(stem) => {
                    if stem != m.stem.to_lowercase() {
                        *inbound.entry(stem).or_insert(0) += 1;
                    }
                }
                None if root_files.contains(&format!("wiki/{t}").as_str()) => {}
                None => issues.push(LintIssue {
                    kind: "broken-link".into(),
                    path: m.path.clone(),
                    detail: format!("[[{target}]] 에 해당하는 페이지가 없습니다"),
                }),
            }
        }
    }

    let source_updated: HashMap<String, String> = pages
        .iter()
        .filter(|(m, _)| m.kind == "source")
        .filter_map(|(m, _)| m.task_id.clone().map(|id| (id, m.updated.clone())))
        .collect();

    for (m, _) in &pages {
        if m.summary.trim().is_empty() {
            issues.push(LintIssue {
                kind: "no-summary".into(),
                path: m.path.clone(),
                detail: "요약(summary)이 비어 색인에 설명이 없습니다".into(),
            });
        }
        // 소스와 답변은 들어오는 링크가 없는 것이 정상이다(색인이 다리다).
        if m.kind != "source" && m.kind != "answer" && !inbound.contains_key(&m.stem.to_lowercase())
        {
            issues.push(LintIssue {
                kind: "orphan".into(),
                path: m.path.clone(),
                detail: "이 페이지로 오는 링크가 없습니다(색인 제외)".into(),
            });
        }
        if m.kind != "source" && m.kind != "answer" {
            let newer: Vec<&String> = m
                .sources
                .iter()
                .filter(|id| {
                    source_updated
                        .get(*id)
                        .map(|u| u.as_str() > m.updated.as_str())
                        .unwrap_or(false)
                })
                .collect();
            if !newer.is_empty() {
                issues.push(LintIssue {
                    kind: "stale-page".into(),
                    path: m.path.clone(),
                    detail: format!(
                        "근거 업무 {}건이 이 페이지보다 나중에 다시 반영됐습니다",
                        newer.len()
                    ),
                });
            }
        }
    }
    for p in &st.orphans {
        issues.push(LintIssue {
            kind: "orphan-source".into(),
            path: p.clone(),
            detail: "원본 업무를 찾을 수 없습니다(삭제되었거나 id 가 바뀜)".into(),
        });
    }
    for id in &st.moved {
        issues.push(LintIssue {
            kind: "moved-source".into(),
            path: source_rel(id),
            detail: "원본 업무가 옮겨졌습니다 — [경로 고치기] 로 바로잡을 수 있습니다".into(),
        });
    }
    for t in st.tasks.iter().filter(|t| t.state == "stale") {
        issues.push(LintIssue {
            kind: "stale-source".into(),
            path: t.page.clone().unwrap_or_default(),
            detail: format!(
                "'{}' 업무가 반영 뒤에 바뀌었습니다 — 다시 반영하세요",
                t.title
            ),
        });
    }
    Ok(issues)
}

// ---------------------------------------------------------------------------
// 커맨드 — 전부 파일을 훑으므로 IPC 스레드를 막지 않게 블로킹 풀에서 돈다.
// ---------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::io(format!("위키 작업이 중단되었습니다: {e}")))?
}

#[tauri::command]
pub async fn wiki_init(root: String) -> Result<WikiInfo> {
    blocking(move || init(Path::new(&root))).await
}

#[tauri::command]
pub async fn wiki_status(root: String, arch_days: i64) -> Result<WikiStatus> {
    blocking(move || status(Path::new(&root), arch_days)).await
}

#[tauri::command]
pub async fn wiki_read_source(root: String, task_id: String) -> Result<SourceBundle> {
    blocking(move || read_source(Path::new(&root), &task_id)).await
}

#[tauri::command]
pub async fn wiki_read_pages(root: String, paths: Vec<String>) -> Result<Vec<WikiPage>> {
    blocking(move || read_pages(Path::new(&root), &paths)).await
}

#[tauri::command]
pub async fn wiki_search(
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<WikiHit>> {
    blocking(move || Ok(search(Path::new(&root), &query, limit.unwrap_or(20)))).await
}

#[tauri::command]
pub async fn wiki_apply(root: String, req: ApplyReq) -> Result<ApplyResult> {
    blocking(move || apply(Path::new(&root), &req)).await
}

#[tauri::command]
pub async fn wiki_relink(root: String, arch_days: i64) -> Result<usize> {
    blocking(move || relink(Path::new(&root), arch_days)).await
}

#[tauri::command]
pub async fn wiki_lint_local(root: String, arch_days: i64) -> Result<Vec<LintIssue>> {
    blocking(move || lint_local(Path::new(&root), arch_days)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{create_task, set_archived, NewTask};

    /// 테스트마다 고유한 Vault. 이름이 겹치면 병렬 테스트가 서로의 파일을 지운다.
    struct TempVault(PathBuf);

    impl TempVault {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("contextflow-wiki-{tag}"));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            vault::ensure_layout(&dir).unwrap();
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

    fn archived_task(root: &Path, title: &str) -> TaskMeta {
        let t = create_task(
            root,
            NewTask {
                title,
                summary: "배포 스크립트를 고쳤다",
                tags: &["dev".into()],
                template: None,
                category: None,
            },
        )
        .unwrap();
        // 업무 id 는 만든 시각(초)으로 정해져서, 한 테스트에서 연달아 만들면 겹친다.
        let index = Path::new(&t.folder).join("index.md");
        let mut doc = Doc::parse(&fs::read_to_string(&index).unwrap());
        doc.set("id", format!("task-{}", stem_of(title).replace(' ', "-")));
        fs::write(&index, doc.render()).unwrap();
        fs::write(
            Path::new(&t.folder).join("notes.md"),
            "# 메모\n배포는 `deploy.ps1` 로 한다.\n",
        )
        .unwrap();
        set_archived(root, Path::new(&t.folder), true, "tag", false).unwrap()
    }

    fn page(kind: &str, title: &str, body: &str) -> PageWrite {
        PageWrite {
            kind: kind.into(),
            title: title.into(),
            body: body.into(),
            summary: Some(format!("{title} 요약")),
            tags: vec![],
            sources: vec![],
            base_hash: None,
        }
    }

    fn ingest(root: &Path, t: &TaskMeta, pages: Vec<PageWrite>) -> ApplyResult {
        apply(
            root,
            &ApplyReq {
                op: "ingest".into(),
                title: t.title.clone(),
                task_id: Some(t.id.clone()),
                pages,
                log: vec![],
            },
        )
        .unwrap()
    }

    #[test]
    fn init_seeds_once_and_never_overwrites_schema() {
        let v = TempVault::new("init");
        let info = init(v.path()).unwrap();
        assert!(info.seeded);
        let schema = wiki_dir(v.path()).join("SCHEMA.md");
        fs::write(&schema, "내 규약").unwrap();
        let again = init(v.path()).unwrap();
        assert!(!again.seeded);
        assert_eq!(fs::read_to_string(&schema).unwrap(), "내 규약");
        for (_, f, _) in KINDS {
            assert!(wiki_dir(v.path()).join(f).is_dir());
        }
    }

    #[test]
    fn stems_are_safe_file_and_link_names() {
        assert_eq!(stem_of("[2026-08] 배포: 절차?"), "2026-08 배포- 절차-");
        assert_eq!(stem_of("  여러   칸  "), "여러 칸");
        assert_eq!(stem_of("con"), "con_");
        assert_eq!(stem_of("Index"), "Index_");
        assert_eq!(stem_of("..숨김"), "숨김");
        assert_eq!(stem_of(""), "제목 없음");
        assert_eq!(stem_of(&"가".repeat(100)).chars().count(), 60);
    }

    #[test]
    fn yaml_values_round_trip_through_quotes() {
        let mut doc = Doc::parse("---\n---\n");
        doc.set("summary", yaml_quote("# 요약: \"따옴표\" \\ 끝\n다음 줄"));
        let back = Doc::parse(&doc.render());
        assert_eq!(
            fm_str(&back, "summary").unwrap(),
            "# 요약: \"따옴표\" \\ 끝 다음 줄"
        );
    }

    #[test]
    fn ingest_writes_source_topic_index_and_log() {
        let v = TempVault::new("ingest");
        let t = archived_task(v.path(), "배포 스크립트 정리");
        let r = ingest(
            v.path(),
            &t,
            vec![
                PageWrite {
                    tags: vec!["#배포".into(), "a b".into()],
                    ..page("source", &t.title, "## 한 일\n- 스크립트를 고쳤다")
                },
                page(
                    "procedure",
                    "배포 절차",
                    "## 순서\n1. deploy.ps1 실행 ([[x]])",
                ),
            ],
        );
        assert_eq!(r.written.len(), 2);
        assert!(r.skipped.is_empty());

        let src_rel = source_rel(&t.id);
        let src = fs::read_to_string(wiki_dir(v.path()).join(&src_rel)).unwrap();
        let doc = Doc::parse(&src);
        assert_eq!(fm_str(&doc, "task_id").as_deref(), Some(t.id.as_str()));
        assert_eq!(
            fm_str(&doc, "task_path").as_deref(),
            Some(t.rel_folder.as_str())
        );
        assert_eq!(doc.get_list("sources"), vec![t.id.clone()]);
        assert_eq!(doc.get_list("tags"), vec!["배포", "a-b"]);
        assert!(doc.body.contains("# 배포 스크립트 정리"));
        assert!(doc.body.contains(SOURCE_FOOTER));
        assert!(
            doc.body.contains("%5B"),
            "업무 폴더의 대괄호는 인코딩된다: {}",
            doc.body
        );

        let index = fs::read_to_string(wiki_dir(v.path()).join("index.md")).unwrap();
        assert!(index.contains("[[배포 절차|배포 절차]]"));
        assert!(index.find("## 절차").unwrap() < index.find("## 업무 소스").unwrap());

        let log = fs::read_to_string(wiki_dir(v.path()).join("log.md")).unwrap();
        let head = log.lines().find(|l| l.starts_with("## [")).unwrap();
        assert!(
            head.contains(&format!("] ingest | 배포 스크립트 정리 ({})", t.id)),
            "{head}"
        );
        assert!(log.contains("- 만듦: [[배포 절차|배포 절차]]"));

        // 원본 업무 폴더에는 아무것도 쓰지 않는다.
        let names: Vec<String> = fs::read_dir(&t.folder)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        let mut names = names;
        names.sort();
        assert_eq!(names, vec!["index.md", "notes.md"]);
    }

    #[test]
    fn index_is_byte_stable() {
        let v = TempVault::new("index-stable");
        let t = archived_task(v.path(), "업무");
        ingest(v.path(), &t, vec![page("source", "업무", "본문")]);
        let a = fs::read(rebuild_index(v.path()).unwrap()).unwrap();
        let b = fs::read(rebuild_index(v.path()).unwrap()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn source_pages_only_for_the_task_being_ingested() {
        let v = TempVault::new("source-guard");
        let t = archived_task(v.path(), "업무");
        let r = apply(
            v.path(),
            &ApplyReq {
                op: "query".into(),
                title: "질문".into(),
                task_id: None,
                pages: vec![page("source", "남의 소스", "x"), page("topic", "주제", "x")],
                log: vec![],
            },
        )
        .unwrap();
        assert!(r.written.is_empty());
        assert_eq!(r.skipped.len(), 2);
        let _ = t;
    }

    #[test]
    fn same_title_in_another_folder_updates_that_page() {
        let v = TempVault::new("stem-collide");
        let t = archived_task(v.path(), "업무");
        ingest(v.path(), &t, vec![page("topic", "배포", "첫 내용")]);
        let pages = read_pages(v.path(), &["topics/배포.md".to_string()]).unwrap();
        let mut w = page("procedure", "배포", "고친 내용");
        w.base_hash = Some(pages[0].hash.clone());
        let r = ingest(v.path(), &t, vec![w]);
        assert_eq!(r.written[0].path, "topics/배포.md");
        assert_eq!(r.written[0].action, "updated");
        assert!(!wiki_dir(v.path()).join("procedures/배포.md").exists());
    }

    #[test]
    fn unseen_existing_page_is_appended_not_overwritten() {
        let v = TempVault::new("append");
        let t = archived_task(v.path(), "업무");
        ingest(
            v.path(),
            &t,
            vec![page("topic", "배포", "사람이 쓴 귀한 내용")],
        );
        let r = ingest(v.path(), &t, vec![page("topic", "배포", "# 배포\n새 내용")]);
        assert_eq!(r.written[0].action, "appended");
        let text = fs::read_to_string(wiki_dir(v.path()).join("topics/배포.md")).unwrap();
        assert!(text.contains("사람이 쓴 귀한 내용"));
        assert!(text.contains("## 추가 — "));
        assert!(text.contains("새 내용"));
    }

    #[test]
    fn changed_since_read_is_skipped_and_overwrites_are_backed_up() {
        let v = TempVault::new("conflict");
        let t = archived_task(v.path(), "업무");
        ingest(v.path(), &t, vec![page("topic", "배포", "v1")]);
        let stale = read_pages(v.path(), &["topics/배포.md".into()]).unwrap()[0]
            .hash
            .clone();
        // 다른 곳(Obsidian)에서 고쳤다.
        let p = wiki_dir(v.path()).join("topics/배포.md");
        let edited = fs::read_to_string(&p).unwrap().replace("v1", "손으로 고침");
        fs::write(&p, &edited).unwrap();

        let mut w = page("topic", "배포", "v2");
        w.base_hash = Some(stale);
        let r = ingest(v.path(), &t, vec![w]);
        assert!(r.written.is_empty());
        assert_eq!(r.skipped.len(), 1);
        assert!(fs::read_to_string(&p).unwrap().contains("손으로 고침"));

        let fresh = read_pages(v.path(), &["topics/배포.md".into()]).unwrap()[0]
            .hash
            .clone();
        let mut w = page("topic", "배포", "v3");
        w.base_hash = Some(fresh);
        ingest(v.path(), &t, vec![w]);
        let backups: Vec<_> = fs::read_dir(history_dir(v.path()))
            .unwrap()
            .flatten()
            .collect();
        assert!(!backups.is_empty());
        let any = backups.iter().any(|d| {
            fs::read_to_string(d.path().join("topics/배포.md"))
                .map(|s| s.contains("손으로 고침"))
                .unwrap_or(false)
        });
        assert!(any, "덮어쓰기 전 내용이 .history 에 남아야 한다");
    }

    #[test]
    fn sources_union_and_created_is_kept() {
        let v = TempVault::new("merge-fm");
        let a = archived_task(v.path(), "업무 A");
        let b = archived_task(v.path(), "업무 B");
        ingest(v.path(), &a, vec![page("topic", "배포", "A")]);
        let created = page_meta(
            "topics/배포.md",
            &fs::read_to_string(wiki_dir(v.path()).join("topics/배포.md")).unwrap(),
        )
        .created;
        let hash = read_pages(v.path(), &["topics/배포.md".into()]).unwrap()[0]
            .hash
            .clone();
        let mut w = page("topic", "배포", "A+B");
        w.base_hash = Some(hash);
        ingest(v.path(), &b, vec![w]);
        let m = page_meta(
            "topics/배포.md",
            &fs::read_to_string(wiki_dir(v.path()).join("topics/배포.md")).unwrap(),
        );
        assert_eq!(m.sources, vec![a.id.clone(), b.id.clone()]);
        assert_eq!(m.created, created);
    }

    #[test]
    fn status_reports_missing_fresh_and_stale() {
        let v = TempVault::new("status");
        let t = archived_task(v.path(), "업무");
        let st = status(v.path(), 0).unwrap();
        assert_eq!(st.tasks.len(), 1);
        assert_eq!(st.tasks[0].state, "missing");

        ingest(v.path(), &t, vec![page("source", "업무", "본문")]);
        assert_eq!(status(v.path(), 0).unwrap().tasks[0].state, "fresh");

        // frontmatter 만 바뀐 것(보관 해제 → 재보관)은 변경이 아니다.
        set_archived(v.path(), Path::new(&t.folder), false, "tag", false).unwrap();
        set_archived(v.path(), Path::new(&t.folder), true, "tag", false).unwrap();
        assert_eq!(status(v.path(), 0).unwrap().tasks[0].state, "fresh");

        // 내용이 바뀌면 stale.
        fs::write(Path::new(&t.folder).join("추가.md"), "새 파일").unwrap();
        assert_eq!(status(v.path(), 0).unwrap().tasks[0].state, "stale");
    }

    #[test]
    fn category_change_keeps_source_fresh() {
        let v = TempVault::new("category-fresh");
        let t = archived_task(v.path(), "분류할 업무");
        ingest(v.path(), &t, vec![page("source", "분류할 업무", "본문")]);
        assert_eq!(status(v.path(), 0).unwrap().tasks[0].state, "fresh");

        // 카테고리는 frontmatter 키 하나다 — 업무 내용이 바뀐 것이 아니므로 다시 반영할 일도 없다.
        let res = crate::category::set_category(v.path(), &[t.folder.clone()], Some("운영/배포"))
            .unwrap();
        assert_eq!(res.changed, vec![t.folder.clone()]);
        let st = status(v.path(), 0).unwrap();
        assert_eq!(st.tasks[0].state, "fresh");
        assert!(st.moved.is_empty());
    }

    #[test]
    fn moved_tasks_are_reported_and_relinked() {
        let v = TempVault::new("relink");
        let t = archived_task(v.path(), "옮길 업무");
        ingest(v.path(), &t, vec![page("source", "옮길 업무", "본문")]);
        // 'move' 보관 방식으로 바꾼 것처럼 폴더를 옮긴다.
        let moved = set_archived(v.path(), Path::new(&t.folder), false, "tag", false).unwrap();
        let moved = set_archived(v.path(), Path::new(&moved.folder), true, "move", false).unwrap();
        assert!(moved.rel_folder.starts_with("Archive/"));

        let st = status(v.path(), 0).unwrap();
        assert_eq!(st.moved, vec![t.id.clone()]);
        assert_eq!(relink(v.path(), 0).unwrap(), 1);
        assert!(status(v.path(), 0).unwrap().moved.is_empty());
        let text = fs::read_to_string(wiki_dir(v.path()).join(source_rel(&t.id))).unwrap();
        assert!(text.contains("Archive/"));
        assert_eq!(text.matches(SOURCE_FOOTER).count(), 1);
    }

    #[test]
    fn bundle_respects_caps_and_exclusions() {
        let v = TempVault::new("bundle");
        let t = archived_task(v.path(), "번들");
        let f = Path::new(&t.folder);
        fs::write(f.join("큰 파일.txt"), "가".repeat(10_000)).unwrap();
        fs::write(f.join("그림.png"), [0u8, 1, 2]).unwrap();
        fs::write(f.join(".context_snapshot.json"), "{}").unwrap();
        fs::create_dir_all(f.join("reference/다른 업무")).unwrap();
        fs::write(f.join("reference/다른 업무/index.md"), "남의 업무").unwrap();

        let b = read_source(v.path(), &t.id).unwrap();
        assert_eq!(b.files[0].rel, "index.md");
        let rels: Vec<&str> = b.files.iter().map(|f| f.rel.as_str()).collect();
        assert!(!rels.iter().any(|r| r.starts_with('.')));
        let big = b.files.iter().find(|f| f.rel == "큰 파일.txt").unwrap();
        assert!(big.truncated);
        assert_eq!(big.text.as_ref().unwrap().chars().count(), FILE_CAP);
        let png = b.files.iter().find(|f| f.rel == "그림.png").unwrap();
        assert!(png.text.is_none() && png.skipped.is_some());
        let r = b.files.iter().find(|f| f.rel == "reference/").unwrap();
        assert!(r.text.is_none());
        assert!(b.total_chars <= TOTAL_CAP);
        assert!(!b.reingest);
        assert_eq!(b.source_stem, stem_of(&t.id));
    }

    #[test]
    fn search_ranks_title_hits_first() {
        let v = TempVault::new("search");
        let t = archived_task(v.path(), "업무");
        ingest(
            v.path(),
            &t,
            vec![
                page("procedure", "배포 절차", "순서를 적는다"),
                page("topic", "회의록", "배포 얘기가 잠깐 나왔다"),
                page("topic", "점심", "메뉴"),
            ],
        );
        let hits = search(v.path(), "배포", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "배포 절차");
        assert!(hits[1].snippet.contains("배포"));
        assert!(search(v.path(), "", 10).is_empty());
    }

    #[test]
    fn page_meta_lists_outbound_links_once() {
        let m = page_meta("topics/a.md", "---\ntitle: A\n---\n[[b]] [[c|씨]] [[b#x]]\n");
        assert_eq!(m.links, vec!["b".to_string(), "c".into()]);
    }

    #[test]
    fn link_targets_strip_alias_and_heading() {
        assert_eq!(
            link_targets("[[a|별칭]] [[b#제목]] [[c^x]] [[  ]] [[\n]]"),
            vec!["a".to_string(), "b".into(), "c".into()]
        );
    }

    #[test]
    fn lint_finds_broken_orphan_bare_index_and_missing_summary() {
        let v = TempVault::new("lint");
        let t = archived_task(v.path(), "업무");
        let mut lonely = page("topic", "외톨이", "[[없는 페이지]] 그리고 [[index]]");
        lonely.summary = None;
        ingest(
            v.path(),
            &t,
            vec![
                page("source", "업무", "[[연결됨]]"),
                page("topic", "연결됨", "[[Wiki/index|색인]]"),
                lonely,
            ],
        );
        let issues = lint_local(v.path(), 0).unwrap();
        let has = |k: &str, p: &str| issues.iter().any(|i| i.kind == k && i.path.ends_with(p));
        assert!(has("broken-link", "외톨이.md"));
        assert!(has("bare-index", "외톨이.md"));
        assert!(has("orphan", "외톨이.md"));
        assert!(has("no-summary", "외톨이.md"));
        assert!(!has("orphan", "연결됨.md"));
        assert!(!issues
            .iter()
            .any(|i| i.kind == "broken-link" && i.path.ends_with("연결됨.md")));
    }

    #[test]
    fn page_paths_cannot_escape_the_wiki() {
        let v = TempVault::new("escape");
        assert!(read_pages(v.path(), &["../Tasks/x.md".into()]).is_err());
        assert!(read_pages(v.path(), &[".history/x.md".into()]).is_err());
        assert!(read_pages(v.path(), &["topics/x.txt".into()]).is_err());
    }
}
