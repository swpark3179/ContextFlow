//! 카테고리 허브 노트 — Obsidian 에서 카테고리별로 업무와 위키를 보는 `_index/` 의 노트들.
//!
//! * **앱 소유, 플러그인 없이 읽힌다.** 업무 목록과 위키 페이지의 frontmatter 로 결정적으로
//!   만든다. 표식(`type: category-hub` · `generator: contextflow`)이 있는 파일만 고치거나
//!   지우고, 같은 자리의 사용자 노트는 건드리지 않고 `conflicts` 로 알린다.
//! * **바이트가 고정된다.** 시각 · `updated` · `order` · 회차를 넣지 않고, 트리는 `BTreeMap`
//!   으로 만들고(`category::known_categories`), 바뀐 파일만 쓴다. 동기화 도구가 갱신 때마다
//!   "바뀐 파일" 로 잡지 않게.
//! * **링크는 Vault 루트 기준 전체 경로다.** 허브 · 위키 페이지는 위키링크(`Wiki/index.md` 의
//!   `[[Wiki/SCHEMA|…]]` 와 같다 — `카테고리.md` 같은 흔한 이름이 사용자 노트와 겹쳐도 맞게
//!   간다). 업무는 `[YYYY-MM]` 괄호 때문에 인코딩한 마크다운 링크다(소스 페이지 꼬리말과 같다).
//! * 업무 폴더 · 위키 페이지에는 아무것도 쓰지 않는다. 위키와의 연결은 그때그때 계산한다 —
//!   소스 페이지는 `task_id`, 나머지 페이지는 `sources` 에 그 서브트리의 업무 id 가 든 것.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use crate::category::{self, Node, UNCATEGORIZED};
use crate::error::{AppError, Result};
use crate::frontmatter::Doc;
use crate::fsops::{encode_link, write_if_changed};
use crate::vault::{self, TaskMeta, INDEX_DIR};
use crate::wiki::{self, PageMeta, KINDS, WIKI_DIR};

/// 전체 허브(`_index/카테고리.md`)의 위키링크 대상. `Wiki/index.md` 의 허브 줄도 쓴다.
pub(crate) const OVERALL_LINK: &str = "_index/카테고리";
const OVERALL_FILE: &str = "카테고리.md";
/// 노드 허브가 모이는 폴더 — `_index/카테고리/`.
const HUB_DIR: &str = "카테고리";
/// 노드 허브 파일 이름의 머리. 위키 페이지와 이름이 겹치지 않게 한다.
const PREFIX: &str = "카테고리 · ";
/// 화면에 보이는 경로 구분자(프런트 `label` 과 같다).
const SEP: &str = " › ";
/// 모든 허브의 frontmatter. 지울지 · 고칠지는 이 두 줄로 판정한다.
const MARKER: &str = "---\ntype: category-hub\ngenerator: contextflow\n---\n";
const NOTICE: &str =
    "> ContextFlow 가 업무의 카테고리로 자동 생성합니다. 직접 고치면 다음 갱신 때 덮어써집니다.\n";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubReport {
    /// 실제로 다시 쓴 허브 수. 바이트가 같아 건너뛴 것은 세지 않는다.
    pub written: usize,
    /// 지운 옛 허브 수 — 카테고리가 사라졌거나 표시 철자가 바뀐 것.
    pub removed: usize,
    /// 같은 자리에 표식 없는 노트가 있거나 읽지 못해 쓰지 않은 허브. Vault 기준 상대 경로(`/`),
    /// 정렬해서 준다.
    pub conflicts: Vec<String>,
}

/// `_index/*` 쓰기(허브 · 보관함 MOC)를 한 줄로 세운다. 자동 갱신과 직접 열기가 겹치면 같은
/// 파일을 동시에 고치게 된다. 잠금 순서는 이것 → `wiki::rebuild_index` 의 색인 잠금이다.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// `INDEX_LOCK` 을 잡는다. 앞선 쓰기가 패닉으로 끝났어도 지킬 데이터가 없으니 그대로 쓴다.
pub(crate) fn lock_index() -> MutexGuard<'static, ()> {
    INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 앱이 만든 허브인가 — frontmatter 의 표식 두 줄.
fn is_marked(text: &str) -> bool {
    let doc = Doc::parse(text);
    doc.get_str("type").as_deref() == Some("category-hub")
        && doc.get_str("generator").as_deref() == Some("contextflow")
}

fn overall_path(root: &Path) -> PathBuf {
    root.join(INDEX_DIR).join(OVERALL_FILE)
}

/// 앱이 만든 전체 허브가 있는가. 같은 이름의 사용자 노트는 치지 않는다.
pub(crate) fn has_overall_hub(root: &Path) -> bool {
    fs::read_to_string(overall_path(root)).is_ok_and(|text| is_marked(&text))
}

/// 노드 허브 이름(확장자 없이)의 바이트 상한. ext4 · APFS 는 이름 하나가 255바이트까지라
/// 한글 30자 × 3단계면 넘는다. 임시 파일(`.md.tmp`, 7바이트)까지 그 안에 들게 둔다. UTF-16
/// 단위로 재는 NTFS 도 단위 수가 바이트 수보다 크지 않아 함께 지켜진다.
const MAX_STEM: usize = 240;

/// 표시 경로(`a/B`)의 노드 허브 이름(확장자 없이) — `카테고리 · a › B`. 단계는 이미 파일 이름을
/// 깨는 글자를 뺀 값이라 `stem_of`(60자에서 자른다)를 거치지 않는다. `MAX_STEM` 을 넘을 때만
/// 글자 경계에서 자르고 경로의 해시를 붙인다 — 잘린 앞부분이 같은 형제와도 겹치지 않고,
/// 바이트도 고정된다. 파일 이름 · 위키링크 · 상대 경로가 모두 이것을 쓴다.
fn hub_stem(path: &str) -> String {
    let stem = format!("{PREFIX}{}", path.replace('/', SEP));
    if stem.len() <= MAX_STEM {
        return stem;
    }
    // FNV-1a 32. `DefaultHasher` 는 Rust 판마다 값이 달라질 수 있어 파일 이름에 못 쓴다.
    let hash =
        path.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193));
    let tail = format!("… {hash:08x}");
    let mut end = MAX_STEM - tail.len();
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{tail}", stem[..end].trim_end_matches([' ', '›']))
}

fn file_name(path: &str) -> String {
    format!("{}.md", hub_stem(path))
}

/// 노드 허브의 위키링크 대상(확장자 없이).
fn hub_link(path: &str) -> String {
    format!("{OVERALL_LINK}/{}", hub_stem(path))
}

fn node_rel(path: &str) -> String {
    format!("{INDEX_DIR}/{HUB_DIR}/{}", file_name(path))
}

fn overall_rel() -> String {
    format!("{INDEX_DIR}/{OVERALL_FILE}")
}

/// 링크 글자 — `[ ] |` 가 링크를 끊으므로 공백으로 바꾼다(`rebuild_index` 와 같다).
fn link_text(s: &str) -> String {
    s.replace(['[', ']', '|'], " ")
}

/// 업무 노트로 가는 링크. 허브는 `_index/카테고리/` 에 있어 두 단계 올라간다.
fn task_link(t: &TaskMeta) -> String {
    format!(
        "[{}]({})",
        link_text(&t.title),
        encode_link(&format!("../../{}index.md", t.rel_folder))
    )
}

/// 위키 페이지의 위키링크 대상 — `Wiki/procedures/배포 절차`.
fn page_link(p: &PageMeta) -> String {
    let stem = p.path.get(..p.path.len().saturating_sub(3)).unwrap_or(&p.path);
    format!("{WIKI_DIR}/{stem}")
}

/// 업무의 카테고리가 든 노드의 키 — 단계마다 소문자로(`known_categories` 와 같은 방식).
fn node_key(cat: &str) -> String {
    cat.split('/').map(category::key_of).collect::<Vec<_>>().join("/")
}

/// 허브를 만드는 데 필요한 것을 한 번 모아 둔 것.
struct View<'a> {
    /// 업무와 그 업무가 보관됐는지.
    tasks: Vec<(&'a TaskMeta, bool)>,
    nodes: &'a [Node],
    /// 노드 키 → 표시 경로.
    spelled: HashMap<&'a str, &'a str>,
    /// 업무 id → 소스 페이지.
    sources: HashMap<&'a str, &'a PageMeta>,
    /// 소스가 아닌 페이지. `KINDS` 순, 그다음 제목 소문자, 그다음 경로(`rebuild_index` 와 같다).
    pages: Vec<&'a PageMeta>,
    /// Vault 가 곧 Obsidian vault 인가 — 그때만 Dataview 경로가 맞는다.
    dataview: bool,
}

impl<'a> View<'a> {
    fn new(
        root: &Path,
        tasks: &'a [TaskMeta],
        nodes: &'a [Node],
        pages: &'a [PageMeta],
        arch_days: i64,
    ) -> Self {
        let rank =
            |kind: &str| KINDS.iter().position(|(k, _, _)| *k == kind).unwrap_or(KINDS.len());
        let mut others: Vec<&PageMeta> = pages.iter().filter(|p| p.kind != "source").collect();
        others.sort_by(|a, b| {
            rank(&a.kind)
                .cmp(&rank(&b.kind))
                .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
                .then(a.path.cmp(&b.path))
        });
        View {
            tasks: tasks.iter().map(|t| (t, vault::is_archived(t, arch_days))).collect(),
            nodes,
            spelled: nodes.iter().map(|n| (n.key.as_str(), n.path.as_str())).collect(),
            // `wiki::status` 와 같은 짝짓기. 페이지가 경로순이라 겹치면 늘 같은 쪽이 남는다.
            sources: pages
                .iter()
                .filter(|p| p.kind == "source")
                .filter_map(|p| p.task_id.as_deref().map(|id| (id, p)))
                .collect(),
            pages: others,
            dataview: root.join(".obsidian").is_dir(),
        }
    }

    fn has_uncategorized(&self) -> bool {
        self.tasks.iter().any(|(t, _)| t.category.is_none())
    }

    /// 노드(하위 포함)에 든 업무. `None` 은 미분류다.
    fn members(&self, key: Option<&str>) -> Vec<(&'a TaskMeta, bool)> {
        self.tasks
            .iter()
            .filter(|(t, _)| match (key, t.category.as_deref()) {
                (None, cat) => cat.is_none(),
                (Some(key), Some(cat)) => category::within(cat, key),
                (Some(_), None) => false,
            })
            .copied()
            .collect()
    }

    /// 업무들에서 나온 위키 페이지 — `sources` 에 그 업무 id 가 하나라도 든 것. 페이지는 경로마다
    /// 한 장이라 여러 업무가 가리켜도 한 번만 든다.
    fn wiki_of(&self, members: &[(&TaskMeta, bool)]) -> Vec<&'a PageMeta> {
        let ids: HashSet<&str> = members.iter().map(|(t, _)| t.id.as_str()).collect();
        self.pages
            .iter()
            .filter(|p| p.sources.iter().any(|s| ids.contains(s.as_str())))
            .copied()
            .collect()
    }

    /// `업무 12 (진행 3 · 보관 9) · 위키 9`
    fn tally(&self, members: &[(&TaskMeta, bool)]) -> String {
        let archived = members.iter().filter(|(_, a)| *a).count();
        format!(
            "업무 {} (진행 {} · 보관 {archived}) · 위키 {}",
            members.len(),
            members.len() - archived,
            self.wiki_of(members).len()
        )
    }

    /// 하위 노드에 든 업무에 붙이는 상대 경로 라벨(` · UI › Mobile`). 노드 자신의 업무는 없다.
    fn sub_label(&self, node: Option<&Node>, t: &TaskMeta) -> String {
        let (Some(node), Some(cat)) = (node, t.category.as_deref()) else {
            return String::new();
        };
        let key = node_key(cat);
        let path = self.spelled.get(key.as_str()).copied().unwrap_or(cat);
        let tail: Vec<&str> = path.split('/').skip(node.depth).collect();
        if tail.is_empty() {
            String::new()
        } else {
            format!(" · {}", tail.join(SEP))
        }
    }

    /// `_index/카테고리.md` — 트리만 보인다. 업무 링크가 없어 `../` 깊이를 따질 일도 없다.
    fn overall(&self) -> String {
        let archived = self.tasks.iter().filter(|(_, a)| *a).count();
        let mut md = format!("{MARKER}# 카테고리\n\n{NOTICE}\n");
        md.push_str(&format!(
            "업무 {} (진행 {} · 보관 {archived}) · 카테고리 {}\n",
            self.tasks.len(),
            self.tasks.len() - archived,
            self.nodes.len()
        ));
        let uncategorized = self.has_uncategorized();
        if !self.nodes.is_empty() || uncategorized {
            md.push('\n');
        }
        for n in self.nodes {
            md.push_str(&format!(
                "{}- [[{}|{}]] — {}\n",
                "\t".repeat(n.depth - 1),
                hub_link(&n.path),
                n.name,
                self.tally(&self.members(Some(n.key.as_str())))
            ));
        }
        if uncategorized {
            md.push_str(&format!(
                "- [[{}|{UNCATEGORIZED}]] — {} — 카테고리 관리… 에서 정리합니다\n",
                hub_link(UNCATEGORIZED),
                self.tally(&self.members(None))
            ));
        }
        md
    }

    /// 노드 허브(`None` 은 미분류 허브). 서브트리를 합쳐 보인다. 빈 절은 쓰지 않는다.
    fn node(&self, node: Option<&Node>) -> String {
        let members = self.members(node.map(|n| n.key.as_str()));
        let title = node.map_or(UNCATEGORIZED.to_string(), |n| n.path.replace('/', SEP));
        let mut md = format!("{MARKER}# {title}\n\n{NOTICE}");

        // 빵부스러기 — 조상의 표시 경로는 자기 표시 경로의 앞부분이다(`known_categories`).
        let mut crumbs = vec![format!("[[{OVERALL_LINK}|전체 카테고리]]")];
        match node {
            Some(n) => {
                let segs: Vec<&str> = n.path.split('/').collect();
                for depth in 1..segs.len() {
                    crumbs.push(format!(
                        "[[{}|{}]]",
                        hub_link(&segs[..depth].join("/")),
                        segs[depth - 1]
                    ));
                }
                crumbs.push(n.name.clone());
            }
            None => crumbs.push(UNCATEGORIZED.to_string()),
        }
        md.push_str(&format!("> {}\n", crumbs.join(SEP)));
        if node.is_none() {
            md.push_str("> 카테고리가 없는 업무입니다. 앱의 카테고리 관리… 에서 정리합니다.\n");
        }
        md.push_str(&format!("\n{}\n", self.tally(&members)));

        if let Some(n) = node {
            let head = format!("{}/", n.key);
            let kids: Vec<&Node> = self
                .nodes
                .iter()
                .filter(|c| c.depth == n.depth + 1 && c.key.starts_with(&head))
                .collect();
            if !kids.is_empty() {
                md.push_str(&format!("\n## 하위 카테고리 ({})\n", kids.len()));
                for k in kids {
                    md.push_str(&format!(
                        "- [[{}|{}]] — {}\n",
                        hub_link(&k.path),
                        k.name,
                        self.tally(&self.members(Some(k.key.as_str())))
                    ));
                }
            }
        }

        // 바이트가 흔들리지 않게 `updated` · `order` 는 정렬에 쓰지 않는다.
        let mut live: Vec<&TaskMeta> =
            members.iter().filter(|(_, a)| !*a).map(|(t, _)| *t).collect();
        live.sort_by(|a, b| b.created.cmp(&a.created).then(a.rel_folder.cmp(&b.rel_folder)));
        if !live.is_empty() {
            md.push_str(&format!("\n## 진행 중 ({})\n", live.len()));
            for t in live {
                let state = match t.status.as_str() {
                    "on-hold" => " · 보류",
                    "completed" => " · 완료",
                    _ => "",
                };
                md.push_str(&format!("- {}{}{state}\n", task_link(t), self.sub_label(node, t)));
            }
        }

        let mut archived: Vec<&TaskMeta> =
            members.iter().filter(|(_, a)| *a).map(|(t, _)| *t).collect();
        // 완료일 내림차순, 없으면 끝(`Some` 이 `None` 보다 크다).
        archived.sort_by(|a, b| {
            b.completed_at
                .cmp(&a.completed_at)
                .then(b.created.cmp(&a.created))
                .then(a.rel_folder.cmp(&b.rel_folder))
        });
        if !archived.is_empty() {
            md.push_str(&format!("\n## 보관 ({})\n", archived.len()));
            for t in archived {
                let page = self.sources.get(t.id.as_str());
                let mut line = match page {
                    Some(p) => format!("- [[{}|{}]]", page_link(p), link_text(&t.title)),
                    None => format!("- {}", task_link(t)),
                };
                line.push_str(&self.sub_label(node, t));
                if let Some(done) = &t.completed_at {
                    line.push_str(&format!(" · 완료 {done}"));
                }
                if page.is_none() {
                    line.push_str(" · 위키 반영 전");
                }
                md.push_str(&line);
                md.push('\n');
            }
        }

        let wiki = self.wiki_of(&members);
        if !wiki.is_empty() {
            md.push_str(&format!("\n## 위키 ({})\n", wiki.len()));
            let mut first = true;
            for (kind, _, label) in KINDS.iter().filter(|(k, _, _)| *k != "source") {
                let group: Vec<&&PageMeta> = wiki.iter().filter(|p| p.kind == *kind).collect();
                if group.is_empty() {
                    continue;
                }
                if !first {
                    md.push('\n');
                }
                first = false;
                md.push_str(&format!("### {label} ({})\n", group.len()));
                for p in group {
                    let mut line = format!("- [[{}|{}]]", page_link(p), link_text(&p.title));
                    if !p.summary.is_empty() {
                        line.push_str(&format!(" — {}", p.summary));
                    }
                    md.push_str(&line);
                    md.push('\n');
                }
            }
        }

        if self.dataview {
            // 키에는 `"` 와 `\` 가 없다(정리 규칙). `lower` 에 null 을 넘기지 않으려 `default` 를 쓴다.
            // 목록 값은 첫 항목으로 본다(`category::read` 와 같다) — 목록째 넘기면 `startswith` 가
            // 항목마다 돌아 비지 않은 목록이 되고, 그것이 참이라 모든 노드 허브에 든다. DQL 에는
            // 변수가 없어 두 번 쓴다.
            let value =
                "lower(default(choice(typeof(category) = \"array\", category[0], category), \"\"))";
            let cond = match node {
                Some(n) => {
                    format!("({value} = \"{k}\" OR startswith({value}, \"{k}/\"))", k = n.key)
                }
                None => "!category".to_string(),
            };
            md.push_str("\n> [!note]- Dataview 로 보기 — Obsidian 에서 고친 값까지 바로 반영\n");
            md.push_str("> ```dataview\n");
            md.push_str("> TABLE WITHOUT ID link(file.path, title) AS \"업무\", status AS \"상태\", completed_at AS \"완료\", category AS \"카테고리\"\n");
            md.push_str("> FROM \"Tasks\" OR \"Archive\"\n");
            md.push_str(&format!(
                "> WHERE file.name = \"index\" AND regexmatch(\"^(Tasks/[^/]+|Archive/[^/]+/[^/]+)$\", file.folder) AND {cond}\n"
            ));
            md.push_str("> SORT completed_at DESC\n");
            md.push_str("> ```\n");
        }
        md
    }
}

/// 허브를 쓰고 난 뒤의 트리 — `hub_path` 가 경로를 고르는 데 쓴다.
struct Built {
    nodes: Vec<Node>,
    uncategorized: bool,
    /// 쓰다 실패한 허브(Vault 기준 상대 경로)와 그 오류. 직접 열기가 그 허브를 고른 때만
    /// 오류로 돌려준다.
    failed: Vec<(String, AppError)>,
}

/// 카테고리 허브를 다시 쓴다. `force` 는 직접 열기용이다.
///
/// 자동 갱신(`force = false`)은 카테고리가 하나라도 있거나 앱이 만든 허브(표식)가 이미 있을
/// 때만 쓴다 — 카테고리를 한 번도 쓰지 않은 Vault 에 미분류뿐인 허브를 만들지 않는다.
/// `force` 는 그때도 쓴다(전체 허브를 처음 만드는 것). 그 뒤로는 허브가 있으니 자동 갱신도
/// 허브를 지키고, `Wiki/index.md` 의 허브 줄이 켜졌다 꺼졌다 하지 않는다. 전체 허브는 어느
/// 모드에서도 지우지 않고, 노드 · 미분류 허브의 정리는 두 모드가 같다 — 전체 허브가 지워졌거나
/// 그 자리가 사용자 노트여도, 남은 노드 · 미분류 허브가 있으면 자동 갱신이 정리하고 고친다.
pub fn write_hubs(root: &Path, arch_days: i64, force: bool) -> Result<HubReport> {
    let _held = lock_index();
    Ok(write_locked(root, arch_days, force)?.0)
}

fn write_locked(root: &Path, arch_days: i64, force: bool) -> Result<(HubReport, Option<Built>)> {
    // 엄격하게 훑는다 — 폴더 하나가 막혀 업무가 빠진 목록으로 허브를 지우면 안 된다.
    let tasks = vault::scan(root)?;
    let dir = root.join(INDEX_DIR).join(HUB_DIR);
    if !force
        && tasks.iter().all(|t| t.category.is_none())
        && !has_overall_hub(root)
        && !has_marked_hub(&dir)
    {
        return Ok((HubReport::default(), None));
    }
    let pages: Vec<PageMeta> = wiki::load_pages(root).into_iter().map(|(m, _)| m).collect();
    let nodes = category::known_categories(tasks.iter().map(|t| t.category.as_deref()));
    let view = View::new(root, &tasks, &nodes, &pages, arch_days);

    // 1. 원하는 파일들(`_index/카테고리/` 안의 이름과 내용).
    let mut wanted: Vec<(String, String)> =
        nodes.iter().map(|n| (file_name(&n.path), view.node(Some(n)))).collect();
    let uncategorized = view.has_uncategorized();
    if uncategorized {
        wanted.push((file_name(UNCATEGORIZED), view.node(None)));
    }

    // 2. 옛 허브를 먼저 지운다. 대소문자만 바뀐 철자도 여기서 지우고 새 이름으로 쓰므로,
    //    대소문자만 다른 rename 에서 Windows · macOS 가 어느 이름을 남기는지에 기대지 않는다.
    let keep: HashSet<&str> = wanted.iter().map(|(name, _)| name.as_str()).collect();
    let mut report = HubReport { removed: prune(&dir, &keep)?, ..HubReport::default() };

    // 3. 쓰기 전에 읽는다. 없거나 표식이 있으면 쓰고, 표식이 없거나 읽지 못하면 덮어쓰지 않고
    //    알린다. 대소문자를 가리지 않는 FS 에서는 대소문자만 다른 사용자 노트도 여기서 걸린다.
    let mut targets = vec![(overall_path(root), overall_rel(), view.overall())];
    for (name, text) in wanted {
        targets.push((dir.join(&name), format!("{INDEX_DIR}/{HUB_DIR}/{name}"), text));
    }
    // 하나를 쓰지 못해도(동기화 도구가 잡고 있는 등) 나머지 허브와 색인은 쓴다 — 남은 하나는
    // 다음 갱신 때 다시 쓴다.
    let mut failed = Vec::new();
    for (path, rel, text) in targets {
        let ours = match fs::read_to_string(&path) {
            Ok(old) => is_marked(&old),
            Err(e) => e.kind() == ErrorKind::NotFound,
        };
        if !ours {
            report.conflicts.push(rel);
            continue;
        }
        match write_if_changed(&path, &text) {
            Ok(true) => report.written += 1,
            Ok(false) => {}
            Err(e) => {
                eprintln!("[hub] 허브를 쓰지 못했습니다 {rel}: {e}");
                failed.push((rel, e));
            }
        }
    }
    report.conflicts.sort();

    // 4. 위키 색인의 허브 줄(바뀐 경우에만 쓴다). 앱이 만든 색인(`type: index`)일 때만 —
    //    위키를 쓰지 않는 Vault 의 같은 이름 사용자 노트를 덮어쓰지 않는다. 편의 줄이라 실패해도
    //    허브 쓰기는 성공으로 둔다.
    let index = root.join(WIKI_DIR).join("index.md");
    if fs::read_to_string(&index)
        .is_ok_and(|text| Doc::parse(&text).get_str("type").as_deref() == Some("index"))
    {
        if let Err(e) = wiki::rebuild_index(root) {
            eprintln!("[hub] 위키 색인의 허브 줄을 고치지 못했습니다: {e}");
        }
    }
    Ok((report, Some(Built { nodes, uncategorized, failed })))
}

/// `_index/카테고리/` 에 앱이 만든 허브가 하나라도 있는가(`prune` 과 같은 규칙). 읽지 못하면
/// 없는 것으로 본다.
fn has_marked_hub(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            !name.starts_with('.')
                && name.ends_with(".md")
                && entry.file_type().is_ok_and(|t| t.is_file())
                && fs::read_to_string(entry.path()).is_ok_and(|text| is_marked(&text))
        })
    })
}

/// `_index/카테고리/` 의 표식 있는 노트 중 원하는 이름과 **정확히** 같지 않은 것을 지운다.
/// `.md` 는 대소문자를 가리지 않는다(`wiki::load_pages` 와 같은 규칙). 표식 없는 노트는 두고,
/// 지우지 못한 것은 남겨 둔다 — 낡은 허브 하나가 남을 뿐이다.
fn prune(dir: &Path, keep: &HashSet<&str>) -> Result<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || !name.to_lowercase().ends_with(".md")
            || keep.contains(name.as_str())
        {
            continue;
        }
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        if !fs::read_to_string(&path).is_ok_and(|text| is_marked(&text)) {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(e) => eprintln!("[hub] 옛 허브를 지우지 못했습니다 {}: {}", path.display(), e),
        }
    }
    Ok(removed)
}

/// 허브를 모두 다시 쓴 뒤(`force`) 한 허브의 절대 경로를 돌려준다 — Obsidian 에서 열기용.
/// `None` 은 전체 허브, `Some("")` 는 미분류, 그 밖은 카테고리 키다.
pub fn hub_path(root: &Path, arch_days: i64, key: Option<&str>) -> Result<PathBuf> {
    let _held = lock_index();
    let (report, built) = write_locked(root, arch_days, true)?;
    let mut built =
        built.unwrap_or(Built { nodes: Vec::new(), uncategorized: false, failed: Vec::new() });
    let missing = || AppError::new("not_found", "그 카테고리의 업무가 없습니다");
    let rel = match key {
        None => overall_rel(),
        Some("") if built.uncategorized => node_rel(UNCATEGORIZED),
        Some("") => return Err(missing()),
        Some(key) => {
            let key = node_key(key.trim());
            let node = built.nodes.iter().find(|n| n.key == key).ok_or_else(missing)?;
            node_rel(&node.path)
        }
    };
    if report.conflicts.contains(&rel) {
        return Err(AppError::new(
            "already_exists",
            format!("‘{rel}’ 자리에 같은 이름의 노트가 있거나 읽을 수 없어 허브를 쓰지 않았습니다"),
        ));
    }
    if let Some(i) = built.failed.iter().position(|(failed, _)| *failed == rel) {
        return Err(built.failed.swap_remove(i).1);
    }
    Ok(root.join(rel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::tests::{make_in, set_field, set_updated, TempVault};
    use crate::vault::{read_task, set_archived, set_status};
    use crate::wiki::{apply, ApplyReq, PageWrite};
    use serde::Deserialize;
    use std::collections::BTreeMap;

    /// 업무 하나. `create_task` 의 id 는 초 단위라 한 테스트에서 겹치므로 id · `created` 를
    /// 번호로 벌려 둔다.
    fn task(root: &Path, n: u32, title: &str, cat: &str) -> TaskMeta {
        let t = make_in(root, title, cat);
        set_field(&t.folder, "id", &format!("task-{n:02}"));
        set_field(&t.folder, "created", &format!("2026-09-{n:02} 10:00"));
        read_task(root, &Path::new(&t.folder).join("index.md")).unwrap()
    }

    fn archive(root: &Path, t: &TaskMeta, mode: &str, done: &str) -> TaskMeta {
        set_status(root, Path::new(&t.folder), "completed").unwrap();
        set_field(&t.folder, "completed_at", done);
        set_archived(root, Path::new(&t.folder), true, mode, false).unwrap()
    }

    fn page(kind: &str, title: &str) -> PageWrite {
        PageWrite {
            kind: kind.into(),
            title: title.into(),
            body: "본문".into(),
            summary: Some(format!("{title} 요약")),
            tags: vec![],
            sources: vec![],
            base_hash: None,
        }
    }

    /// 위키 반영 — 반영한 업무의 id 가 페이지 `sources` 에 저절로 든다.
    fn ingest(root: &Path, t: &TaskMeta, pages: Vec<PageWrite>) {
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
        .unwrap();
    }

    fn hub_file(root: &Path, shown: &str) -> PathBuf {
        root.join(INDEX_DIR).join(HUB_DIR).join(format!("{PREFIX}{shown}.md"))
    }

    /// 노드 허브의 내용. `shown` 은 표시 경로(`프로젝트 › CF`)다.
    fn hub(root: &Path, shown: &str) -> String {
        fs::read_to_string(hub_file(root, shown)).unwrap()
    }

    fn overall(root: &Path) -> String {
        fs::read_to_string(overall_path(root)).unwrap()
    }

    fn task_href(t: &TaskMeta) -> String {
        encode_link(&format!("../../{}index.md", t.rel_folder))
    }

    /// `_index/카테고리/` 의 파일 이름들.
    fn hub_names(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root.join(INDEX_DIR).join(HUB_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    /// `_index/` 와 `Wiki/index.md` 의 모든 바이트.
    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out: Vec<(PathBuf, Vec<u8>)> = walkdir::WalkDir::new(root.join(INDEX_DIR))
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .map(|e| (e.path().to_path_buf(), fs::read(e.path()).unwrap()))
            .collect();
        let index = root.join(WIKI_DIR).join("index.md");
        if let Ok(bytes) = fs::read(&index) {
            out.push((index, bytes));
        }
        out.sort();
        out
    }

    /// 계획서의 예시 그대로 — 서브트리 합산, 하위 라벨, 상태 꼬리, 소스 링크와 "위키 반영 전".
    #[test]
    fn a_node_hub_reads_like_the_plan() {
        let v = TempVault::new("hub-format");
        let root = v.path();
        let board = task(root, 1, "대시보드 개편", "프로젝트/ContextFlow/UI");
        set_status(root, Path::new(&board.folder), "on-hold").unwrap();
        let deploy = task(root, 2, "배포 스크립트 고치기", "프로젝트/ContextFlow");
        let deploy = archive(root, &deploy, "tag", "2026-09-30");
        ingest(root, &deploy, vec![page("source", &deploy.title), page("procedure", "배포 절차")]);
        let logs = task(root, 3, "로그 정리", "프로젝트/ContextFlow");
        let logs = archive(root, &logs, "tag", "2026-09-20");
        let fresh = task(root, 4, "새 기능", "프로젝트/ContextFlow");

        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.removed, r.conflicts.len()), (4, 0, 0));

        let want = format!(
            "---\ntype: category-hub\ngenerator: contextflow\n---\n# 프로젝트 › ContextFlow\n\n\
             > ContextFlow 가 업무의 카테고리로 자동 생성합니다. 직접 고치면 다음 갱신 때 덮어써집니다.\n\
             > [[_index/카테고리|전체 카테고리]] › [[_index/카테고리/카테고리 · 프로젝트|프로젝트]] › ContextFlow\n\
             \n\
             업무 4 (진행 2 · 보관 2) · 위키 1\n\
             \n\
             ## 하위 카테고리 (1)\n\
             - [[_index/카테고리/카테고리 · 프로젝트 › ContextFlow › UI|UI]] — 업무 1 (진행 1 · 보관 0) · 위키 0\n\
             \n\
             ## 진행 중 (2)\n\
             - [새 기능]({})\n\
             - [대시보드 개편]({}) · UI · 보류\n\
             \n\
             ## 보관 (2)\n\
             - [[Wiki/sources/task-02|배포 스크립트 고치기]] · 완료 2026-09-30\n\
             - [로그 정리]({}) · 완료 2026-09-20 · 위키 반영 전\n\
             \n\
             ## 위키 (1)\n\
             ### 절차 (1)\n\
             - [[Wiki/procedures/배포 절차|배포 절차]] — 배포 절차 요약\n",
            task_href(&fresh),
            task_href(&board),
            task_href(&logs),
        );
        assert_eq!(hub(root, "프로젝트 › ContextFlow"), want);
        assert!(task_href(&board).starts_with("../../Tasks/%5B"), "{}", task_href(&board));

        assert_eq!(
            overall(root),
            "---\ntype: category-hub\ngenerator: contextflow\n---\n# 카테고리\n\n\
             > ContextFlow 가 업무의 카테고리로 자동 생성합니다. 직접 고치면 다음 갱신 때 덮어써집니다.\n\
             \n\
             업무 4 (진행 2 · 보관 2) · 카테고리 3\n\
             \n\
             - [[_index/카테고리/카테고리 · 프로젝트|프로젝트]] — 업무 4 (진행 2 · 보관 2) · 위키 1\n\
             \t- [[_index/카테고리/카테고리 · 프로젝트 › ContextFlow|ContextFlow]] — 업무 4 (진행 2 · 보관 2) · 위키 1\n\
             \t\t- [[_index/카테고리/카테고리 · 프로젝트 › ContextFlow › UI|UI]] — 업무 1 (진행 1 · 보관 0) · 위키 0\n"
        );
        // 미분류 업무가 없으면 미분류 허브도 없다.
        assert_eq!(
            hub_names(root),
            [
                "카테고리 · 프로젝트 › ContextFlow › UI.md",
                "카테고리 · 프로젝트 › ContextFlow.md",
                "카테고리 · 프로젝트.md"
            ]
        );
    }

    #[test]
    fn writing_twice_is_byte_stable() {
        let v = TempVault::new("hub-stable");
        let root = v.path();
        let a = task(root, 1, "가", "프로젝트/CF");
        task(root, 2, "나", "프로젝트/CF/UI");
        let c = task(root, 3, "다", "");
        let c = archive(root, &c, "move", "2026-09-30");
        ingest(root, &c, vec![page("source", &c.title), page("topic", "주제")]);

        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.removed), (5, 0));
        let before = snapshot(root);
        // 훑는 순서(`updated`)가 바뀌어도 바이트는 그대로다.
        set_updated(&a.folder, "2030-01-01 00:00");
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.removed, r.conflicts.len()), (0, 0, 0));
        assert_eq!(snapshot(root), before);
        // 직접 열기도 쓸 것이 없다.
        hub_path(root, 30, Some("프로젝트")).unwrap();
        assert_eq!(snapshot(root), before);
    }

    #[test]
    fn a_node_rolls_up_its_subtree_and_splits_live_from_archived() {
        let v = TempVault::new("hub-rollup");
        let root = v.path();
        task(root, 1, "직속 진행", "프로젝트");
        let done = task(root, 2, "직속 완료", "프로젝트");
        // 완료일은 `set_status` 가 찍는 오늘이다 — 날짜를 박아 두면 30일 뒤 나이로 보관이 된다.
        set_status(root, Path::new(&done.folder), "completed").unwrap();
        let kept = task(root, 3, "하위 보관", "프로젝트/CF");
        archive(root, &kept, "tag", "2026-09-30");
        let deep = task(root, 4, "깊은 보관", "프로젝트/CF/UI");
        archive(root, &deep, "move", "2026-08-01");
        task(root, 5, "다른 가지", "운영");

        write_hubs(root, 30, false).unwrap();
        let md = hub(root, "프로젝트");
        assert!(md.contains("\n업무 4 (진행 2 · 보관 2) · 위키 0\n"), "{md}");
        assert!(md.contains(
            "## 하위 카테고리 (1)\n- [[_index/카테고리/카테고리 · 프로젝트 › CF|CF]] — 업무 2 (진행 0 · 보관 2) · 위키 0\n"
        ), "{md}");
        // 진행 중은 만든 순서 내림차순, 완료됐지만 보관 전이면 ` · 완료`.
        let live = &md[md.find("## 진행 중 (2)").unwrap()..md.find("## 보관").unwrap()];
        let lines: Vec<&str> = live.lines().skip(1).filter(|l| !l.is_empty()).collect();
        assert!(lines[0].starts_with("- [직속 완료](") && lines[0].ends_with(") · 완료"), "{live}");
        assert!(lines[1].starts_with("- [직속 진행](") && lines[1].ends_with(")"), "{live}");
        // 보관은 완료일 내림차순, 하위 업무는 상대 경로 라벨.
        let kept_at = md.find("- [하위 보관](").unwrap();
        let deep_at = md.find("- [깊은 보관](").unwrap();
        assert!(kept_at < deep_at, "{md}");
        assert!(md.contains(") · CF · 완료 2026-09-30 · 위키 반영 전\n"), "{md}");
        assert!(md.contains(") · CF › UI · 완료 2026-08-01 · 위키 반영 전\n"), "{md}");
        assert!(!md.contains("다른 가지"));

        let all = overall(root);
        assert!(all.contains("\n업무 5 (진행 3 · 보관 2) · 카테고리 4\n"), "{all}");
        assert!(
            all.contains(
                "— 업무 1 (진행 1 · 보관 0) · 위키 0\n- [[_index/카테고리/카테고리 · 프로젝트|"
            ),
            "{all}"
        );
    }

    #[test]
    fn wiki_pages_come_from_sources_grouped_by_kind_and_the_uncategorized_hub_lists_its_own() {
        let v = TempVault::new("hub-wiki");
        let root = v.path();
        let a = task(root, 1, "분류된 업무", "a");
        let a = archive(root, &a, "tag", "2026-09-01");
        let b = task(root, 2, "미분류 업무", "");
        let b = archive(root, &b, "tag", "2026-09-02");
        task(root, 3, "상관없는 업무", "z");
        ingest(
            root,
            &a,
            vec![
                page("source", &a.title),
                page("topic", "주제 하나"),
                page("procedure", "배포 절차"),
            ],
        );
        ingest(
            root,
            &b,
            vec![
                page("source", &b.title),
                page("entity", "도구"),
                PageWrite { sources: vec![a.id.clone()], ..page("procedure", "공통 절차") },
            ],
        );

        write_hubs(root, 30, false).unwrap();
        let md = hub(root, "a");
        assert!(md.contains("\n업무 1 (진행 0 · 보관 1) · 위키 3\n"), "{md}");
        assert!(
            md.ends_with(
                "## 위키 (3)\n\
             ### 절차 (2)\n\
             - [[Wiki/procedures/공통 절차|공통 절차]] — 공통 절차 요약\n\
             - [[Wiki/procedures/배포 절차|배포 절차]] — 배포 절차 요약\n\
             \n\
             ### 주제 (1)\n\
             - [[Wiki/topics/주제 하나|주제 하나]] — 주제 하나 요약\n"
            ),
            "{md}"
        );
        assert!(md.contains("- [[Wiki/sources/task-01|분류된 업무]] · 완료 2026-09-01\n"), "{md}");

        let un = hub(root, UNCATEGORIZED);
        assert!(un.starts_with(
            "---\ntype: category-hub\ngenerator: contextflow\n---\n# 미분류\n\n\
             > ContextFlow 가 업무의 카테고리로 자동 생성합니다. 직접 고치면 다음 갱신 때 덮어써집니다.\n\
             > [[_index/카테고리|전체 카테고리]] › 미분류\n\
             > 카테고리가 없는 업무입니다. 앱의 카테고리 관리… 에서 정리합니다.\n\
             \n\
             업무 1 (진행 0 · 보관 1) · 위키 2\n"
        ), "{un}");
        assert!(un.contains("### 절차 (1)\n- [[Wiki/procedures/공통 절차|"), "{un}");
        assert!(
            un.contains("### 시스템 · 도구 (1)\n- [[Wiki/entities/도구|도구]] — 도구 요약\n"),
            "{un}"
        );
        assert!(!un.contains("배포 절차") && !un.contains("하위 카테고리"), "{un}");
        assert!(!hub(root, "z").contains("## 위키"));

        // 전체 허브에서 미분류는 맨 끝이고 정리할 곳을 알려 준다.
        let all = overall(root);
        assert!(all.ends_with(
            "- [[_index/카테고리/카테고리 · 미분류|미분류]] — 업무 1 (진행 0 · 보관 1) · 위키 2 — 카테고리 관리… 에서 정리합니다\n"
        ), "{all}");
    }

    #[derive(Deserialize)]
    struct WikiCase {
        note: String,
        tasks: Vec<WikiTask>,
        pages: Vec<WikiPage>,
        /// 노드 키(`""` = 미분류) → 그 노드(하위 포함)에 드는 페이지 경로, 정렬해서.
        expect: BTreeMap<String, Vec<String>>,
    }

    #[derive(Deserialize)]
    struct WikiTask {
        id: String,
        category: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WikiPage {
        path: String,
        kind: String,
        task_id: Option<String>,
        sources: Vec<String>,
    }

    /// id · 카테고리만 채운 업무. `TaskMeta` 의 Deserialize 는 필수 필드가 많아 fixture 를
    /// 그대로 읽지 않는다. 나머지는 계산에 닿지 않는 중립값이다 — `archived` 가 없고
    /// `arch_days` 를 0 으로 주면 보관 판정은 늘 '진행' 이다.
    fn bare_task(id: &str, category: Option<&str>) -> TaskMeta {
        TaskMeta {
            id: id.into(),
            title: String::new(),
            status: "in-progress".into(),
            tags: vec![],
            category: category.map(Into::into),
            created: String::new(),
            updated: String::new(),
            parent_task: None,
            template_ref: None,
            completed_at: None,
            archived: None,
            archived_at: None,
            runs: 0,
            order: None,
            folder: String::new(),
            rel_folder: String::new(),
            index_path: String::new(),
            tagline: String::new(),
        }
    }

    /// 허브가 짝짓는 데 보는 경로 · 유형 · `task_id` · `sources` 만 채운 위키 페이지.
    fn bare_page(path: &str, kind: &str, task_id: Option<&str>, sources: &[String]) -> PageMeta {
        PageMeta {
            path: path.into(),
            stem: String::new(),
            kind: kind.into(),
            title: String::new(),
            summary: String::new(),
            tags: vec![],
            sources: sources.to_vec(),
            created: String::new(),
            updated: String::new(),
            task_id: task_id.map(Into::into),
            task_path: None,
            source_sig: None,
            links: vec![],
            hash: String::new(),
        }
    }

    /// 프런트 `src/lib/wiki/categories.ts` 와 같은 fixture — 위키 화면의 카테고리 거르기가
    /// 허브와 같은 규칙으로 페이지를 고른다. 렌더된 허브가 아니라 `View` 의 멤버십(`members` ·
    /// `wiki_of` · `sources`)을 견준다 — 허브가 소스 페이지를 보관 업무의 '보관' 절에서만 링크하는
    /// 것은 보이는 방식의 차이다. 노드에 드는 페이지는 허브의 '위키' 절(`wiki_of`)과 멤버 업무의
    /// 소스 페이지(`sources`)를 합친 것이다. 기대의 키 집합이 노드 키(미분류 업무가
    /// 있으면 `""` 까지)와 같은지도 보므로, 기대 어디에도 없는 페이지는 어느 노드에도 들지
    /// 않음이 함께 증명된다.
    #[test]
    fn wiki_membership_matches_the_shared_fixture() {
        let cases: Vec<WikiCase> =
            serde_json::from_str(include_str!("../../src/lib/wiki/categories.json")).unwrap();
        assert!(!cases.is_empty());
        for c in &cases {
            let tasks: Vec<TaskMeta> =
                c.tasks.iter().map(|t| bare_task(&t.id, t.category.as_deref())).collect();
            let pages: Vec<PageMeta> = c
                .pages
                .iter()
                .map(|p| bare_page(&p.path, &p.kind, p.task_id.as_deref(), &p.sources))
                .collect();

            // 같은 `task_id` 의 소스 페이지가 둘이면 허브는 마지막 하나만 남기고 화면은 모두
            // 넣는다. 그 차이는 이 대조의 몫이 아니라 fixture 가 겹치지 않게 둔다.
            let mut ids: Vec<&str> = pages
                .iter()
                .filter(|p| p.kind == "source")
                .filter_map(|p| p.task_id.as_deref())
                .collect();
            let all = ids.len();
            ids.sort_unstable();
            ids.dedup();
            assert_eq!(ids.len(), all, "{}: 소스 페이지의 taskId 가 겹친다", c.note);

            let nodes = category::known_categories(tasks.iter().map(|t| t.category.as_deref()));
            let view = View::new(Path::new(""), &tasks, &nodes, &pages, 0);
            let mut keys: Vec<&str> = nodes.iter().map(|n| n.key.as_str()).collect();
            if view.has_uncategorized() {
                keys.push("");
            }
            keys.sort_unstable();
            assert_eq!(c.expect.keys().map(String::as_str).collect::<Vec<_>>(), keys, "{}", c.note);

            for (key, want) in &c.expect {
                let members = view.members(if key.is_empty() { None } else { Some(key.as_str()) });
                let mut got: Vec<&str> = view
                    .wiki_of(&members)
                    .iter()
                    .map(|p| p.path.as_str())
                    .chain(
                        members
                            .iter()
                            .filter_map(|(t, _)| view.sources.get(t.id.as_str()))
                            .map(|p| p.path.as_str()),
                    )
                    .collect();
                got.sort_unstable();
                got.dedup();
                assert_eq!(got, *want, "{} / {key}", c.note);
            }
        }
    }

    #[test]
    fn a_moved_category_prunes_its_old_marked_hubs() {
        let v = TempVault::new("hub-move");
        let root = v.path();
        task(root, 1, "가", "옛/하위");
        task(root, 2, "나", "남는 것");
        write_hubs(root, 30, false).unwrap();
        assert_eq!(
            hub_names(root),
            ["카테고리 · 남는 것.md", "카테고리 · 옛 › 하위.md", "카테고리 · 옛.md"]
        );

        category::move_category(root, "옛", Some("새"), false, None).unwrap();
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!(r.removed, 2);
        assert_eq!(
            hub_names(root),
            ["카테고리 · 남는 것.md", "카테고리 · 새 › 하위.md", "카테고리 · 새.md"]
        );
        assert!(overall(root).contains("[[_index/카테고리/카테고리 · 새|새]]"));
    }

    #[test]
    fn a_users_note_in_a_hubs_place_and_unrelated_notes_are_left_alone() {
        let v = TempVault::new("hub-user-note");
        let root = v.path();
        task(root, 1, "가", "a");
        task(root, 2, "나", "b");
        let dir = root.join(INDEX_DIR).join(HUB_DIR);
        fs::create_dir_all(&dir).unwrap();
        let mine = [
            (dir.join("카테고리 · a.md"), "내가 쓴 노트\n"),
            (dir.join("메모.md"), "---\ntype: note\n---\n아무 노트\n"),
            (dir.join("카테고리 · 옛것.md"), "---\ntype: category-hub\n---\n표식 반쪽\n"),
            (dir.join("그림.png"), "png"),
        ];
        for (path, text) in &mine {
            fs::write(path, text).unwrap();
        }

        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!(r.conflicts, ["_index/카테고리/카테고리 · a.md"]);
        assert_eq!(r.removed, 0);
        for (path, text) in &mine {
            assert_eq!(fs::read_to_string(path).unwrap(), *text, "{path:?}");
        }
        assert!(hub(root, "b").contains("# b\n"));
        // 다음 갱신도 같다 — 계속 알리고, 건드리지 않는다.
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.conflicts.len()), (0, 1));
        assert_eq!(fs::read_to_string(&mine[0].0).unwrap(), mine[0].1);
    }

    /// 읽기 오류는 NotFound 가 아니면 모두 충돌이다 — 폴더가 자리를 차지한 경우도.
    #[test]
    fn a_folder_in_a_hubs_place_is_a_conflict() {
        let v = TempVault::new("hub-folder");
        let root = v.path();
        task(root, 1, "가", "a");
        let path = hub_file(root, "a");
        fs::create_dir_all(path.join("안")).unwrap();
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!(r.conflicts, ["_index/카테고리/카테고리 · a.md"]);
        assert!(path.join("안").is_dir());
        let e = hub_path(root, 30, Some("a")).unwrap_err();
        assert_eq!(e.kind, "already_exists");
    }

    /// 읽지 못한 파일은 사용자 노트일 수 있으니 덮어쓰지 않는다. 루트로 돌면 권한으로 막을 수
    /// 없어 확인하지 못하니 그냥 지나간다.
    #[cfg(unix)]
    #[test]
    fn an_unreadable_hub_is_a_conflict_and_is_not_overwritten() {
        use std::os::unix::fs::PermissionsExt;

        struct Unblock(PathBuf);
        impl Drop for Unblock {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o644));
            }
        }

        let v = TempVault::new("hub-unreadable");
        let root = v.path();
        task(root, 1, "가", "a");
        write_hubs(root, 30, false).unwrap();
        let path = hub_file(root, "a");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let _unblock = Unblock(path.clone());
        if fs::read(&path).is_ok() {
            return;
        }
        task(root, 2, "나", "a");
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!(r.conflicts, ["_index/카테고리/카테고리 · a.md"]);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!hub(root, "a").contains("나"));
    }

    #[test]
    fn a_case_only_respelling_leaves_no_old_file() {
        let v = TempVault::new("hub-case");
        let root = v.path();
        let a = task(root, 1, "가", "Proj/Sub");
        write_hubs(root, 30, false).unwrap();
        assert_eq!(hub_names(root), ["카테고리 · Proj › Sub.md", "카테고리 · Proj.md"]);

        category::set_category(root, &[a.folder.clone()], Some("proj/sub")).unwrap();
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.removed, r.written), (2, 3));
        assert_eq!(hub_names(root), ["카테고리 · proj › sub.md", "카테고리 · proj.md"]);
        assert!(hub(root, "proj").starts_with(&format!("{MARKER}# proj\n")));
    }

    #[test]
    fn a_vault_without_categories_gets_hubs_only_when_opened() {
        let v = TempVault::new("hub-none");
        let root = v.path();
        task(root, 1, "가", "");
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.removed, r.conflicts.len()), (0, 0, 0));
        assert!(!overall_path(root).exists());
        assert!(!root.join(INDEX_DIR).join(HUB_DIR).exists());

        // 직접 열면 만든다.
        let path = hub_path(root, 30, None).unwrap();
        assert_eq!(path, overall_path(root));
        assert!(overall(root).contains("\n업무 1 (진행 1 · 보관 0) · 카테고리 0\n\n- [[_index/카테고리/카테고리 · 미분류|미분류]]"));
        assert_eq!(hub_names(root), ["카테고리 · 미분류.md"]);
        let before = snapshot(root);

        // 그 뒤의 자동 갱신은 허브를 지키고 쓸 것이 없다.
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.removed), (0, 0));
        assert_eq!(snapshot(root), before);

        // 표식 없는 같은 이름의 노트는 "이미 있는 허브" 로 치지 않는다.
        let v = TempVault::new("hub-none-user");
        let root = v.path();
        task(root, 1, "가", "");
        fs::write(overall_path(root), "내 카테고리 노트\n").unwrap();
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!(r.written, 0);
        assert!(!root.join(INDEX_DIR).join(HUB_DIR).exists());
    }

    #[test]
    fn the_dataview_callout_appears_only_inside_an_obsidian_vault() {
        let v = TempVault::new("hub-dataview");
        let root = v.path();
        task(root, 1, "가", "A/b");
        task(root, 2, "나", "");
        write_hubs(root, 30, false).unwrap();
        assert!(!hub(root, "A").contains("dataview"));

        fs::create_dir_all(root.join(".obsidian")).unwrap();
        let r = write_hubs(root, 30, false).unwrap();
        // 전체 허브에는 붙지 않는다.
        assert_eq!(r.written, 3);
        assert!(!overall(root).contains("dataview"));
        assert!(hub(root, "A").ends_with(
            "\n> [!note]- Dataview 로 보기 — Obsidian 에서 고친 값까지 바로 반영\n\
             > ```dataview\n\
             > TABLE WITHOUT ID link(file.path, title) AS \"업무\", status AS \"상태\", completed_at AS \"완료\", category AS \"카테고리\"\n\
             > FROM \"Tasks\" OR \"Archive\"\n\
             > WHERE file.name = \"index\" AND regexmatch(\"^(Tasks/[^/]+|Archive/[^/]+/[^/]+)$\", file.folder) AND (lower(default(choice(typeof(category) = \"array\", category[0], category), \"\")) = \"a\" OR startswith(lower(default(choice(typeof(category) = \"array\", category[0], category), \"\")), \"a/\"))\n\
             > SORT completed_at DESC\n\
             > ```\n"
        ));
        // 목록 값은 첫 항목으로 본다 — 목록째 `startswith` 에 넘기면 모든 노드에서 참이 된다.
        assert!(hub(root, "A › b").contains(
            "= \"a/b\" OR startswith(lower(default(choice(typeof(category) = \"array\", category[0], category), \"\")), \"a/b/\"))\n"
        ));
        assert!(hub(root, UNCATEGORIZED).contains("file.folder) AND !category\n> SORT"));
    }

    #[test]
    fn links_encode_month_brackets_and_titles_lose_link_breakers() {
        let v = TempVault::new("hub-encode");
        let root = v.path();
        let live = task(root, 1, "보고서", "a");
        set_field(&live.folder, "title", "\"보고서 [초안] | 1차\"");
        let old = task(root, 2, "회고", "a");
        set_field(&old.folder, "title", "\"회고 [최종] | 끝\"");
        let old = archive(root, &old, "tag", "2026-09-30");
        ingest(root, &old, vec![page("source", "회고"), page("topic", "괄호 [가] | 제목")]);

        write_hubs(root, 30, false).unwrap();
        let md = hub(root, "a");
        let href = task_href(&live);
        assert!(href.starts_with("../../Tasks/%5B") && href.contains("%5D%20보고서/"), "{href}");
        assert!(md.contains(&format!("- [보고서  초안    1차]({href})\n")), "{md}");
        assert!(
            md.contains("- [[Wiki/sources/task-02|회고  최종    끝]] · 완료 2026-09-30\n"),
            "{md}"
        );
        assert!(md.contains("- [[Wiki/topics/괄호 가 - 제목|괄호  가    제목]] — "), "{md}");
    }

    #[test]
    fn move_mode_archives_count_and_reference_copies_do_not() {
        let v = TempVault::new("hub-archive-move");
        let root = v.path();
        let a = task(root, 1, "옮긴 업무", "a");
        let a = archive(root, &a, "move", "2026-09-30");
        assert!(a.rel_folder.starts_with("Archive/2026/"));
        let b = task(root, 2, "받는 업무", "b");
        let copy = Path::new(&b.folder).join("reference/옮긴 업무");
        fs::create_dir_all(&copy).unwrap();
        fs::write(
            copy.join("index.md"),
            "---\nid: task-01\ntitle: 옮긴 업무\ncategory: \"a\"\narchived: true\n---\n",
        )
        .unwrap();

        write_hubs(root, 30, false).unwrap();
        let md = hub(root, "a");
        assert!(md.contains("\n업무 1 (진행 0 · 보관 1) · 위키 0\n"), "{md}");
        assert!(md.contains(&format!(
            "- [옮긴 업무]({}) · 완료 2026-09-30 · 위키 반영 전\n",
            task_href(&a)
        )));
        assert!(task_href(&a).starts_with("../../Archive/2026/%5B"));
        assert!(overall(root).contains("\n업무 2 (진행 1 · 보관 1) · 카테고리 2\n"));
    }

    /// `archived` 키가 없는 완료 업무는 완료일과 보관 기간으로 가른다 — 2000년이면 오늘이
    /// 언제든 보관이다.
    #[test]
    fn an_old_completion_without_an_archived_key_is_archived_by_age() {
        let v = TempVault::new("hub-age");
        let root = v.path();
        let t = task(root, 1, "오래된 완료", "a");
        set_status(root, Path::new(&t.folder), "completed").unwrap();
        set_field(&t.folder, "completed_at", "2000-01-01");
        assert_eq!(read_task(root, &Path::new(&t.folder).join("index.md")).unwrap().archived, None);

        write_hubs(root, 30, false).unwrap();
        let md = hub(root, "a");
        assert!(md.contains("## 보관 (1)\n- [오래된 완료]("), "{md}");
        assert!(md.contains(") · 완료 2000-01-01 · 위키 반영 전\n"), "{md}");
        // 보관 기간을 끄면 완료됐지만 보관 전이다.
        write_hubs(root, 0, false).unwrap();
        assert!(hub(root, "a").contains("## 진행 중 (1)\n- [오래된 완료]("));
        assert!(hub(root, "a").contains(") · 완료\n"));
    }

    #[test]
    fn hub_path_resolves_node_uncategorized_and_overall_and_refuses_the_rest() {
        let v = TempVault::new("hub-path");
        let root = v.path();
        task(root, 1, "가", "프로젝트/CF");
        task(root, 2, "나", "");

        let path = hub_path(root, 30, Some("프로젝트/cf")).unwrap();
        assert_eq!(path, hub_file(root, "프로젝트 › CF"));
        assert!(path.is_file());
        assert_eq!(hub_path(root, 30, Some("")).unwrap(), hub_file(root, UNCATEGORIZED));
        assert_eq!(hub_path(root, 30, None).unwrap(), overall_path(root));
        for key in ["없음", "프로젝트/c", "프로젝트/cf/ui"] {
            let e = hub_path(root, 30, Some(key)).unwrap_err();
            assert_eq!(
                (e.kind.as_str(), e.message.as_str()),
                ("not_found", "그 카테고리의 업무가 없습니다")
            );
        }

        // 미분류 업무가 없으면 미분류 허브도 없다.
        let v = TempVault::new("hub-path-user");
        let root = v.path();
        task(root, 1, "가", "프로젝트");
        let e = hub_path(root, 30, Some("")).unwrap_err();
        assert_eq!(e.kind, "not_found");
        // 자리에 사용자 노트가 있으면 그 허브만 거절하고 노트는 그대로다.
        fs::write(overall_path(root), "내 노트\n").unwrap();
        let e = hub_path(root, 30, None).unwrap_err();
        assert_eq!(
            (e.kind.as_str(), e.message.as_str()),
            (
                "already_exists",
                "‘_index/카테고리.md’ 자리에 같은 이름의 노트가 있거나 읽을 수 없어 허브를 쓰지 않았습니다"
            )
        );
        assert_eq!(overall(root), "내 노트\n");
        assert!(hub_path(root, 30, Some("프로젝트")).unwrap().is_file());
    }

    #[test]
    fn the_wiki_index_links_the_hub_only_when_the_app_made_it() {
        let v = TempVault::new("hub-wiki-index");
        let root = v.path();
        let t = task(root, 1, "가", "a");
        let t = archive(root, &t, "tag", "2026-09-30");
        ingest(root, &t, vec![page("source", &t.title)]);
        let index = root.join(WIKI_DIR).join("index.md");
        let line = "> 카테고리별로 보기는 [[_index/카테고리|카테고리]] 에 있습니다.\n";
        assert!(!fs::read_to_string(&index).unwrap().contains(line));

        write_hubs(root, 30, false).unwrap();
        let md = fs::read_to_string(&index).unwrap();
        assert!(md.contains(&format!(
            "> 규약은 [[Wiki/SCHEMA|SCHEMA]], 작업 기록은 [[Wiki/log|log]] 에 있습니다.\n{line}\n전체 1페이지"
        )), "{md}");
        // 다시 만들어도 같은 바이트이고, 쓰지 않는다.
        let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        fs::File::options().write(true).open(&index).unwrap().set_modified(old).unwrap();
        wiki::rebuild_index(root).unwrap();
        write_hubs(root, 30, false).unwrap();
        assert_eq!(fs::read_to_string(&index).unwrap(), md);
        assert_eq!(fs::metadata(&index).unwrap().modified().unwrap(), old);

        // 같은 자리가 사용자 노트면 줄이 빠진다.
        fs::write(overall_path(root), "내 노트\n").unwrap();
        wiki::rebuild_index(root).unwrap();
        assert!(!fs::read_to_string(&index).unwrap().contains(line));
    }

    /// 앱이 만든 색인(`type: index`)이 아닌 `Wiki/index.md` 는 허브 줄을 넣으려고 다시 만들지
    /// 않는다 — 위키를 쓰지 않는 Vault 의 사용자 노트일 수 있다.
    #[test]
    fn a_users_wiki_index_is_not_rebuilt_for_the_hub_line() {
        let v = TempVault::new("hub-user-index");
        let root = v.path();
        task(root, 1, "가", "a");
        let index = root.join(WIKI_DIR).join("index.md");
        fs::create_dir_all(root.join(WIKI_DIR)).unwrap();
        let mine = "---\ntype: moc\n---\n# 내 위키 MOC\n\n- [[어딘가]]\n";
        fs::write(&index, mine).unwrap();

        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.conflicts.len()), (2, 0));
        assert_eq!(fs::read_to_string(&index).unwrap(), mine);
        hub_path(root, 30, Some("a")).unwrap();
        assert_eq!(fs::read_to_string(&index).unwrap(), mine);
    }

    /// 색인의 허브 줄은 편의라, 색인을 쓰지 못해도 허브 쓰기와 직접 열기는 성공한다.
    #[test]
    fn a_blocked_wiki_index_does_not_fail_the_hubs() {
        let v = TempVault::new("hub-index-blocked");
        let root = v.path();
        let t = task(root, 1, "가", "a");
        let t = archive(root, &t, "tag", "2026-09-30");
        ingest(root, &t, vec![page("source", &t.title)]);
        let index = root.join(WIKI_DIR).join("index.md");
        let before = fs::read_to_string(&index).unwrap();
        // 전체 허브가 생기면 허브 줄이 들어가야 하는데, 임시 파일 자리가 막혀 색인을 못 쓴다.
        fs::create_dir_all(root.join(WIKI_DIR).join("index.md.tmp")).unwrap();

        let path = hub_path(root, 30, Some("a")).unwrap();
        assert!(path.is_file());
        assert!(has_overall_hub(root));
        assert_eq!(fs::read_to_string(&index).unwrap(), before);
        write_hubs(root, 30, false).unwrap();
    }

    /// 허브 하나가 막혀도(동기화 도구가 잡고 있는 등) 나머지 허브와 색인은 쓴다. 직접 열기는
    /// 그 허브를 고른 때만 실패한다.
    #[test]
    fn one_blocked_hub_does_not_stop_the_others() {
        let v = TempVault::new("hub-blocked");
        let root = v.path();
        task(root, 1, "가", "a");
        task(root, 2, "나", "b");
        // 임시 파일 자리에 폴더가 있으면 `write_atomic` 이 실패한다.
        let blocked = root.join(INDEX_DIR).join(HUB_DIR).join(format!("{PREFIX}a.md.tmp"));
        fs::create_dir_all(&blocked).unwrap();

        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.conflicts.len()), (2, 0));
        assert!(!hub_file(root, "a").exists());
        assert!(hub(root, "b").contains("# b\n"));
        assert!(overall(root).contains("[[_index/카테고리/카테고리 · a|a]]"));
        assert!(hub_path(root, 30, Some("b")).unwrap().is_file());
        assert!(hub_path(root, 30, None).unwrap().is_file());
        assert_eq!(hub_path(root, 30, Some("a")).unwrap_err().kind, "io");
        // 풀리면 다음 쓰기가 마저 쓴다.
        fs::remove_dir(&blocked).unwrap();
        assert!(hub_path(root, 30, Some("a")).unwrap().is_file());
    }

    /// 한글 30자 × 3단계면 이름이 ext4 · APFS 의 255바이트를 넘는다. 그때만 잘라 해시를 붙이고,
    /// 링크 · 정리 · 직접 열기가 모두 같은 이름을 쓴다.
    #[test]
    fn a_long_category_gets_a_capped_stable_file_name() {
        let v = TempVault::new("hub-long");
        let root = v.path();
        let seg = |c: char| c.to_string().repeat(30);
        let two = format!("{}/{}", seg('가'), seg('나'));
        // 끝 글자만 다른 형제 — 자른 앞부분이 같아도 이름이 겹치지 않아야 한다.
        let long = format!("{two}/{}가", "다".repeat(29));
        let twin = format!("{two}/{}나", "다".repeat(29));
        task(root, 1, "긴 것", &long);
        task(root, 2, "형제", &twin);
        task(root, 3, "짧은 것", "b");

        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.conflicts.len()), (6, 0), "{r:?}");
        let names = hub_names(root);
        assert_eq!(names.len(), 5, "{names:?}");
        for name in &names {
            // 임시 파일(`.md.tmp`)까지 255바이트 안에 든다.
            assert!(name.len() + 4 <= 255, "{name}");
            let stem = name.strip_suffix(".md").unwrap();
            assert!(overall(root).contains(&format!("[[{OVERALL_LINK}/{stem}|")), "{stem}");
        }
        // 넘지 않는 이름은 그대로다.
        assert!(hub_file(root, &two.replace('/', SEP)).is_file());
        assert!(hub_file(root, "b").is_file());

        let a = hub_path(root, 30, Some(&long)).unwrap();
        let b = hub_path(root, 30, Some(&twin)).unwrap();
        assert!(a.is_file() && b.is_file() && a != b, "{a:?} {b:?}");
        assert!(fs::read_to_string(&a).unwrap().contains("- [긴 것]("));
        // 바이트가 고정된다.
        let before = snapshot(root);
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!((r.written, r.removed), (0, 0));
        assert_eq!(snapshot(root), before);
    }

    /// 전체 허브가 지워진 뒤 마지막 카테고리를 비워도, 남은 앱 허브가 있으면 자동 갱신이
    /// 정리한다. 직접 열어 만든 미분류 허브도 지우지 않고 고친다.
    #[test]
    fn leftover_hubs_are_kept_up_to_date_after_the_last_category_goes() {
        let v = TempVault::new("hub-leftover");
        let root = v.path();
        let t = task(root, 1, "가", "a");
        write_hubs(root, 30, false).unwrap();
        fs::remove_file(overall_path(root)).unwrap();
        category::set_category(root, &[t.folder.clone()], None).unwrap();

        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!(r.removed, 1);
        assert_eq!(hub_names(root), ["카테고리 · 미분류.md"]);
        assert!(hub(root, UNCATEGORIZED).contains("- [가]("));
        assert!(has_overall_hub(root));

        // 전체 허브 자리가 사용자 노트인 Vault — 직접 열어 만든 미분류 허브.
        let v = TempVault::new("hub-leftover-user");
        let root = v.path();
        task(root, 1, "가", "");
        fs::write(overall_path(root), "내 노트\n").unwrap();
        hub_path(root, 30, Some("")).unwrap();
        task(root, 2, "나", "");
        let r = write_hubs(root, 30, false).unwrap();
        assert_eq!(r.conflicts, ["_index/카테고리.md"]);
        assert!(hub(root, UNCATEGORIZED).contains("- [나]("));
        assert_eq!(overall(root), "내 노트\n");
    }
}
