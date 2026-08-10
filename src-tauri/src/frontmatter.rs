//! Line-oriented YAML frontmatter editing.
//!
//! We deliberately do NOT round-trip through a YAML serializer. Obsidian users
//! hand-edit these notes, and a serializer would reorder keys, requote strings
//! and rewrite `tags: [a, b]` into a block sequence on every status change.
//! Instead we keep the block as an ordered list of entries with their raw text,
//! touch only the keys we are asked to touch, and leave everything else byte
//! identical.

/// One `key: value` entry plus any continuation lines that belong to it
/// (block sequences, folded scalars — anything more indented that follows).
#[derive(Debug, Clone)]
struct Entry {
    key: String,
    /// Raw text after `key:` on the same line, leading space trimmed.
    inline: String,
    /// Raw continuation lines, stored verbatim including indentation.
    extra: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Doc {
    entries: Vec<Entry>,
    /// Everything after the closing `---`, verbatim.
    pub body: String,
    /// False for plain notes with no `---` block. Exercised by the tests; kept
    /// on the public API because callers that adopt arbitrary notes need it.
    #[allow(dead_code)]
    pub had_frontmatter: bool,
    /// Line ending used by the source file, so we write back what we read.
    eol: &'static str,
}

fn detect_eol(src: &str) -> &'static str {
    if src.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

impl Doc {
    pub fn parse(src: &str) -> Doc {
        let eol = detect_eol(src);
        let normalized = src.replace("\r\n", "\n");
        let trimmed = normalized.strip_prefix('\u{feff}').unwrap_or(&normalized);

        // A frontmatter block must open on the very first line.
        if !(trimmed.starts_with("---\n") || trimmed == "---") {
            return Doc {
                entries: Vec::new(),
                body: trimmed.to_string(),
                had_frontmatter: false,
                eol,
            };
        }

        let rest = &trimmed[4.min(trimmed.len())..];
        let mut lines = rest.split('\n');
        let mut yaml_lines: Vec<String> = Vec::new();
        let mut closed = false;
        let mut consumed = 0usize;
        for line in lines.by_ref() {
            consumed += line.len() + 1;
            if line.trim_end() == "---" {
                closed = true;
                break;
            }
            yaml_lines.push(line.to_string());
        }

        if !closed {
            // Unterminated block — treat the whole file as body so we never
            // destroy content we did not understand.
            return Doc {
                entries: Vec::new(),
                body: trimmed.to_string(),
                had_frontmatter: false,
                eol,
            };
        }

        let body = rest[consumed.min(rest.len())..].to_string();
        let mut entries: Vec<Entry> = Vec::new();
        for line in yaml_lines {
            let is_continuation = line.starts_with(' ')
                || line.starts_with('\t')
                || line.trim_start().starts_with('-')
                || line.trim().is_empty();
            if is_continuation {
                if let Some(last) = entries.last_mut() {
                    last.extra.push(line);
                    continue;
                }
                // Stray line before any key — keep it as a keyless entry so it
                // survives the round trip.
                entries.push(Entry { key: String::new(), inline: line, extra: Vec::new() });
                continue;
            }
            match line.split_once(':') {
                Some((k, v)) => entries.push(Entry {
                    key: k.trim().to_string(),
                    inline: v.trim_start().to_string(),
                    extra: Vec::new(),
                }),
                None => entries.push(Entry {
                    key: String::new(),
                    inline: line,
                    extra: Vec::new(),
                }),
            }
        }

        Doc { entries, body, had_frontmatter: true, eol }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries.iter().find(|e| e.key == key).map(|e| e.inline.as_str())
    }

    /// Scalar value with surrounding quotes stripped.
    pub fn get_str(&self, key: &str) -> Option<String> {
        self.get(key).map(unquote).filter(|v| !v.is_empty() && v != "null" && v != "~")
    }

    pub fn get_bool(&self, key: &str) -> Option<bool> {
        match self.get_str(key)?.to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" => Some(true),
            "false" | "no" | "off" => Some(false),
            _ => None,
        }
    }

    pub fn get_u32(&self, key: &str) -> Option<u32> {
        self.get_str(key)?.parse().ok()
    }

    /// Reads both `tags: [a, b]` and the block-sequence form.
    pub fn get_list(&self, key: &str) -> Vec<String> {
        let Some(entry) = self.entries.iter().find(|e| e.key == key) else {
            return Vec::new();
        };
        let inline = entry.inline.trim();
        if inline.starts_with('[') {
            let inner = inline.trim_start_matches('[').trim_end_matches(']');
            return inner
                .split(',')
                .map(|s| unquote(s.trim()))
                .filter(|s| !s.is_empty())
                .collect();
        }
        if !inline.is_empty() {
            return vec![unquote(inline)].into_iter().filter(|s| !s.is_empty()).collect();
        }
        entry
            .extra
            .iter()
            .filter_map(|l| l.trim().strip_prefix('-').map(|v| unquote(v.trim())))
            .filter(|s| !s.is_empty())
            .collect()
    }

    /// Sets a scalar. Existing keys keep their position; new keys are appended.
    pub fn set(&mut self, key: &str, value: impl Into<String>) {
        let value = value.into();
        if let Some(entry) = self.entries.iter_mut().find(|e| e.key == key) {
            entry.inline = value;
            entry.extra.clear();
        } else {
            self.entries.push(Entry { key: key.to_string(), inline: value, extra: Vec::new() });
        }
    }

    /// Writes `key: [a, b, c]` — the inline form the requirements spec uses.
    pub fn set_list(&mut self, key: &str, values: &[String]) {
        let rendered = format!(
            "[{}]",
            values.iter().map(|v| quote_if_needed(v)).collect::<Vec<_>>().join(", ")
        );
        self.set(key, rendered);
    }

    pub fn remove(&mut self, key: &str) {
        self.entries.retain(|e| e.key != key);
    }

    pub fn set_body(&mut self, body: impl Into<String>) {
        self.body = body.into();
    }

    pub fn render(&self) -> String {
        let mut out = String::from("---\n");
        for e in &self.entries {
            if e.key.is_empty() {
                out.push_str(&e.inline);
            } else if e.inline.is_empty() {
                out.push_str(&format!("{}:", e.key));
            } else {
                out.push_str(&format!("{}: {}", e.key, e.inline));
            }
            out.push('\n');
            for x in &e.extra {
                out.push_str(x);
                out.push('\n');
            }
        }
        out.push_str("---\n");
        out.push_str(&self.body);
        if self.eol == "\r\n" {
            out.replace('\n', "\r\n")
        } else {
            out
        }
    }
}

pub fn unquote(v: &str) -> String {
    let v = v.trim();
    // Strip a trailing `# comment` only when it is clearly outside quotes.
    let v = if !v.starts_with('"') && !v.starts_with('\'') {
        match v.split_once(" #") {
            Some((head, _)) => head.trim(),
            None => v,
        }
    } else {
        v
    };
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
    {
        return v[1..v.len() - 1].to_string();
    }
    v.to_string()
}

pub fn quote_if_needed(v: &str) -> String {
    if v.is_empty() || v.contains(',') || v.contains(':') || v.contains('[') || v.contains(']') {
        format!("\"{}\"", v.replace('"', "\\\""))
    } else {
        v.to_string()
    }
}

/// The Run Log heading the design writes to (`appendRun` in the .dc.html).
pub const RUN_LOG_HEADING: &str = "## 실행 이력 (Run Log)";

/// Inserts `- <stamp> · <text>` directly under the Run Log heading, newest
/// first. Creates the section at the end of the document when it is missing.
/// Mirrors the design's `appendRun` exactly.
pub fn append_run_log(body: &str, stamp: &str, text: &str) -> String {
    let line = format!("- {} · {}", stamp, text);
    let needle = format!("{}\n", RUN_LOG_HEADING);
    if let Some(pos) = body.find(&needle) {
        let cut = pos + needle.len();
        let mut out = String::with_capacity(body.len() + line.len() + 1);
        out.push_str(&body[..cut]);
        out.push_str(&line);
        out.push('\n');
        out.push_str(&body[cut..]);
        out
    } else if body.trim_end().ends_with(RUN_LOG_HEADING) {
        // Heading is the very last line with no trailing newline.
        format!("{}\n{}\n", body.trim_end(), line)
    } else {
        format!("{}\n\n{}\n{}\n", body.trim_end(), RUN_LOG_HEADING, line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nid: task-2026-0803-01\ntitle: Tauri 2.0 마이그레이션\nstatus: in-progress # 진행 상태\ntags: [dev, tauri, rust]\ncreated: 2026-08-03 10:00\nupdated: 2026-08-03 15:30\nparent_task: null\ntemplate_ref: \"[[Templates/Tauri 마이그레이션 표준절차]]\"\n---\n## 배경\n본문입니다.\n";

    #[test]
    fn reads_all_spec_fields() {
        let d = Doc::parse(SAMPLE);
        assert!(d.had_frontmatter);
        assert_eq!(d.get_str("id").unwrap(), "task-2026-0803-01");
        assert_eq!(d.get_str("title").unwrap(), "Tauri 2.0 마이그레이션");
        assert_eq!(d.get_str("status").unwrap(), "in-progress");
        assert_eq!(d.get_list("tags"), vec!["dev", "tauri", "rust"]);
        assert_eq!(
            d.get_str("template_ref").unwrap(),
            "[[Templates/Tauri 마이그레이션 표준절차]]"
        );
        // `null` is normalised away rather than surfacing as the string "null".
        assert_eq!(d.get_str("parent_task"), None);
        assert_eq!(d.body, "## 배경\n본문입니다.\n");
    }

    #[test]
    fn editing_one_key_preserves_everything_else() {
        let mut d = Doc::parse(SAMPLE);
        d.set("status", "completed");
        let out = d.render();
        // Untouched keys keep their exact original text, including the quoted
        // wikilink and the key order.
        assert!(out.contains("id: task-2026-0803-01"));
        assert!(out.contains("tags: [dev, tauri, rust]"));
        assert!(out.contains("template_ref: \"[[Templates/Tauri 마이그레이션 표준절차]]\""));
        assert!(out.contains("status: completed"));
        assert!(!out.contains("status: in-progress"));
        assert!(out.ends_with("## 배경\n본문입니다.\n"));
        // Key order is unchanged.
        let keys: Vec<&str> = out
            .lines()
            .skip(1)
            .take_while(|l| *l != "---")
            .filter_map(|l| l.split(':').next())
            .collect();
        assert_eq!(keys[0], "id");
        assert_eq!(keys[2], "status");
    }

    #[test]
    fn appends_new_keys_without_disturbing_old_ones() {
        let mut d = Doc::parse(SAMPLE);
        d.set("archived", "true");
        d.set("archived_at", "2026-08-04");
        let out = d.render();
        assert!(out.contains("archived: true"));
        assert!(out.contains("archived_at: 2026-08-04"));
        assert!(out.contains("id: task-2026-0803-01"));
    }

    #[test]
    fn reads_block_sequence_tags_too() {
        let src = "---\ntitle: 테스트\ntags:\n  - dev\n  - ops\nstatus: on-hold\n---\n본문\n";
        let d = Doc::parse(src);
        assert_eq!(d.get_list("tags"), vec!["dev", "ops"]);
        assert_eq!(d.get_str("status").unwrap(), "on-hold");
        // Round trip keeps the block form when we do not touch it.
        assert!(d.render().contains("  - dev"));
    }

    #[test]
    fn file_without_frontmatter_is_all_body() {
        let d = Doc::parse("# 그냥 노트\n내용\n");
        assert!(!d.had_frontmatter);
        assert_eq!(d.body, "# 그냥 노트\n내용\n");
    }

    #[test]
    fn run_log_inserts_newest_first_under_existing_heading() {
        let body = "## 배경\n설명\n\n## 실행 이력 (Run Log)\n- 2026-08-03 15:30 · 이전 회차\n";
        let out = append_run_log(body, "2026-08-04 09:00", "새 회차");
        let idx_head = out.find(RUN_LOG_HEADING).unwrap();
        let idx_new = out.find("새 회차").unwrap();
        let idx_old = out.find("이전 회차").unwrap();
        assert!(idx_head < idx_new && idx_new < idx_old);
        assert!(out.starts_with("## 배경\n설명\n"));
    }

    #[test]
    fn run_log_creates_section_when_missing() {
        let out = append_run_log("## 개요\n내용", "2026-08-04 09:00", "업무 생성");
        assert!(out.contains(RUN_LOG_HEADING));
        assert!(out.contains("- 2026-08-04 09:00 · 업무 생성"));
        assert!(out.starts_with("## 개요\n내용"));
    }

    #[test]
    fn crlf_files_stay_crlf() {
        let src = "---\r\ntitle: 윈도우\r\nstatus: in-progress\r\n---\r\n본문\r\n";
        let mut d = Doc::parse(src);
        d.set("status", "completed");
        let out = d.render();
        assert!(out.contains("\r\n"));
        assert!(!out.contains("\n\n\r"));
        assert!(out.contains("status: completed"));
    }
}
