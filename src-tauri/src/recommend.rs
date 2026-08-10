//! Similar-task recommendation — the local engine.
//!
//! IDF-weighted Dice coefficient over word/Hangul-bigram tokens. No network, so
//! it is always available; it is also the fallback whenever the AI path fails.
//!
//! The AI path does not live here. The four connection methods (`agents.rs`) are
//! all chat services — two of them are CLIs that cannot produce embeddings at
//! all — so ranking by AI means sending a prompt and parsing a fenced JSON
//! answer. That belongs with the prompt text, which is on the frontend
//! (`src/lib/recommendPrompt.ts`).
//!
//! Scores are a genuine similarity in [0,1]; we do not massage the number to
//! look like the mockup. The active engine is reported so the UI can say which
//! one produced the scores.

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    /// Vault-relative note path, shown on the recommendation card.
    pub path: String,
    /// Date shown for cluster children (completed_at or updated).
    pub date: String,
    /// Title + tags + headings. Kept short on purpose: long bodies drown out
    /// the signal that actually decides whether two tasks are the same pattern.
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterItem {
    pub id: String,
    pub date: String,
    pub title: String,
    pub path: String,
    pub sim: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub id: String,
    pub sim: u32,
    pub title: String,
    pub path: String,
    /// Representative + folded duplicates. `None` when nothing clustered.
    pub cluster: Option<Vec<ClusterItem>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendResult {
    /// Always `"local"` here. The AI path reports the agent id instead.
    pub engine: String,
    pub note: String,
    pub items: Vec<Recommendation>,
}

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

fn is_hangul(c: char) -> bool {
    matches!(c as u32, 0xAC00..=0xD7A3 | 0x1100..=0x11FF | 0x3130..=0x318F)
}

/// ASCII/digit runs become whole tokens; Hangul runs become character bigrams,
/// which is what makes 마이그레이션 / 마이그레이션한 look alike without a
/// morphological analyser.
pub fn tokens(s: &str) -> Vec<String> {
    let lower = s.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut hangul = String::new();

    let flush_word = |word: &mut String, out: &mut Vec<String>| {
        if word.chars().count() >= 2 {
            out.push(word.clone());
        }
        word.clear();
    };
    let flush_hangul = |run: &mut String, out: &mut Vec<String>| {
        let chars: Vec<char> = run.chars().collect();
        if chars.len() == 1 {
            out.push(chars[0].to_string());
        } else {
            for w in chars.windows(2) {
                out.push(w.iter().collect());
            }
        }
        run.clear();
    };

    for c in lower.chars() {
        if is_hangul(c) {
            flush_word(&mut word, &mut out);
            hangul.push(c);
        } else if c.is_alphanumeric() {
            flush_hangul(&mut hangul, &mut out);
            word.push(c);
        } else {
            flush_word(&mut word, &mut out);
            flush_hangul(&mut hangul, &mut out);
        }
    }
    flush_word(&mut word, &mut out);
    flush_hangul(&mut hangul, &mut out);
    out
}

fn idf_table(docs: &[Vec<String>]) -> HashMap<String, f64> {
    let n = docs.len().max(1) as f64;
    let mut df: HashMap<String, f64> = HashMap::new();
    for d in docs {
        let mut seen: Vec<&String> = d.iter().collect();
        seen.sort();
        seen.dedup();
        for t in seen {
            *df.entry(t.clone()).or_insert(0.0) += 1.0;
        }
    }
    df.into_iter()
        .map(|(k, v)| {
            let idf = ((n + 1.0) / (v + 1.0)).ln() + 1.0;
            (k, idf)
        })
        .collect()
}

/// IDF-weighted Dice coefficient: `2·|A∩B| / (|A|+|B|)` with each token
/// contributing its IDF weight. Symmetric, in [0,1], and well behaved on the
/// short strings task titles actually are.
fn weighted_dice(a: &[String], b: &[String], idf: &HashMap<String, f64>) -> f64 {
    let w = |t: &String| idf.get(t).copied().unwrap_or(1.0);
    let mut counts_a: HashMap<&String, usize> = HashMap::new();
    for t in a {
        *counts_a.entry(t).or_insert(0) += 1;
    }
    let mut counts_b: HashMap<&String, usize> = HashMap::new();
    for t in b {
        *counts_b.entry(t).or_insert(0) += 1;
    }

    let mut inter = 0.0;
    for (t, ca) in &counts_a {
        if let Some(cb) = counts_b.get(*t) {
            inter += w(t) * (*ca).min(*cb) as f64;
        }
    }
    let total_a: f64 = counts_a.iter().map(|(t, c)| w(t) * *c as f64).sum();
    let total_b: f64 = counts_b.iter().map(|(t, c)| w(t) * *c as f64).sum();
    if total_a + total_b == 0.0 {
        return 0.0;
    }
    (2.0 * inter / (total_a + total_b)).clamp(0.0, 1.0)
}

fn pct(v: f64) -> u32 {
    (v * 100.0).round().clamp(0.0, 100.0) as u32
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// `threshold` is the percent at which two tasks are considered the same
/// pattern and get folded into one cluster card.
pub fn recommend(
    query: &str,
    candidates: &[Candidate],
    threshold: u32,
    max_items: usize,
) -> Result<RecommendResult> {
    if candidates.is_empty() || query.trim().chars().count() < 2 {
        return Ok(RecommendResult {
            engine: "local".into(),
            note: String::new(),
            items: Vec::new(),
        });
    }

    // sim_to_query[i], and a closure-free pairwise matrix for clustering.
    let (query_scores, pair): (Vec<f64>, Box<dyn Fn(usize, usize) -> f64>) = {
        let doc_tokens: Vec<Vec<String>> = candidates
            .iter()
            .map(|c| tokens(&format!("{} {} {}", c.title, c.tags.join(" "), c.text)))
            .collect();
        let idf = idf_table(&doc_tokens);
        let q_tokens = tokens(query);
        let scores: Vec<f64> = doc_tokens
            .iter()
            .map(|d| weighted_dice(&q_tokens, d, &idf))
            .collect();
        let docs2 = doc_tokens.clone();
        let idf2 = idf.clone();
        (
            scores,
            Box::new(move |i, j| weighted_dice(&docs2[i], &docs2[j], &idf2)),
        )
    };

    let engine = "local".to_string();
    let note = "로컬 유사도 (외부 통신 없음)".to_string();

    // Rank, then fold near-duplicates under the top-scoring representative.
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|a, b| query_scores[*b].partial_cmp(&query_scores[*a]).unwrap_or(std::cmp::Ordering::Equal));
    order.retain(|i| query_scores[*i] > 0.0);

    let thr = threshold as f64 / 100.0;
    let mut used = vec![false; candidates.len()];
    let mut items: Vec<Recommendation> = Vec::new();

    for &rep in &order {
        if used[rep] || items.len() >= max_items {
            continue;
        }
        used[rep] = true;
        let mut members: Vec<ClusterItem> = vec![ClusterItem {
            id: candidates[rep].id.clone(),
            date: candidates[rep].date.clone(),
            title: format!("{} (대표)", candidates[rep].title),
            path: candidates[rep].path.clone(),
            sim: pct(query_scores[rep]),
        }];

        for &other in &order {
            if used[other] {
                continue;
            }
            if pair(rep, other) >= thr {
                used[other] = true;
                members.push(ClusterItem {
                    id: candidates[other].id.clone(),
                    date: candidates[other].date.clone(),
                    title: candidates[other].title.clone(),
                    path: candidates[other].path.clone(),
                    sim: pct(query_scores[other]),
                });
            }
        }

        members[1..].sort_by(|a, b| b.date.cmp(&a.date));
        items.push(Recommendation {
            id: candidates[rep].id.clone(),
            sim: pct(query_scores[rep]),
            title: candidates[rep].title.clone(),
            path: candidates[rep].path.clone(),
            cluster: if members.len() > 1 { Some(members) } else { None },
        });
    }

    Ok(RecommendResult { engine, note, items })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, title: &str, date: &str) -> Candidate {
        Candidate {
            id: id.into(),
            title: title.into(),
            tags: vec![],
            path: format!("Tasks/{}/index.md", title),
            date: date.into(),
            text: title.into(),
        }
    }

    #[test]
    fn tokenises_mixed_korean_and_ascii() {
        let t = tokens("Tauri 2.0 마이그레이션");
        assert!(t.contains(&"tauri".to_string()));
        assert!(t.contains(&"마이".to_string()));
        assert!(t.contains(&"이그".to_string()));
        // Single characters and 1-char ascii runs are not standalone tokens.
        assert!(!t.contains(&"0".to_string()));
    }

    #[test]
    fn dice_is_symmetric_and_bounded() {
        let idf = idf_table(&[tokens("Tauri 마이그레이션"), tokens("보고서 작성")]);
        let a = tokens("Tauri 2.0 마이그레이션");
        let b = tokens("Tauri 1.5 마이그레이션");
        let ab = weighted_dice(&a, &b, &idf);
        let ba = weighted_dice(&b, &a, &idf);
        assert!((ab - ba).abs() < 1e-9);
        assert!(ab > 0.0 && ab <= 1.0);
        assert_eq!(weighted_dice(&a, &a, &idf), 1.0);
    }

    #[test]
    fn ranks_the_related_task_above_the_unrelated_one() {
        let cands = vec![
            cand("a", "Q3 보고서 작성", "2026-07-30"),
            cand("b", "Tauri 1.5 업그레이드 마이그레이션", "2026-05-14"),
        ];
        let r = recommend("Tauri 2.0 마이그레이션", &cands, 85, 3).unwrap();
        assert_eq!(r.engine, "local");
        assert!(!r.items.is_empty());
        assert_eq!(r.items[0].id, "b");
    }

    #[test]
    fn folds_near_identical_tasks_into_one_cluster() {
        let cands = vec![
            cand("a", "릴리스 노트 정리", "2026-04-11"),
            cand("b", "릴리스 노트 정리", "2026-01-15"),
            cand("c", "데이터베이스 백업 스크립트", "2026-02-01"),
        ];
        // Identical titles sit at 100%, so any threshold <= 100 folds them.
        let r = recommend("릴리스 노트 정리", &cands, 85, 5).unwrap();
        let first = &r.items[0];
        assert_eq!(first.cluster.as_ref().unwrap().len(), 2);
        assert!(first.cluster.as_ref().unwrap()[0].title.ends_with("(대표)"));
        // The unrelated task stays its own entry rather than joining the cluster.
        assert!(r.items.iter().all(|i| i.id != "c") || r.items.iter().find(|i| i.id == "c").unwrap().cluster.is_none());
    }

    #[test]
    fn short_queries_return_nothing() {
        let cands = vec![cand("a", "무언가", "2026-01-01")];
        assert!(recommend("T", &cands, 85, 3).unwrap().items.is_empty());
    }
}
