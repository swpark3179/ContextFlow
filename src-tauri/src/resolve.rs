//! 로컬 CLI 실행 파일 경로 해석.
//!
//! **왜 `PATH` 만으로는 부족한가**: GUI 로 실행된 패키징 앱은 축소된("stripped") PATH 를
//! 물려받는 경우가 많아, npm 전역 설치 위치 같은 곳을 명시적으로 보강해야 한다.

use std::path::{Path, PathBuf};

use crate::agents::AgentDef;

pub struct Resolved {
    pub path: String,
    /// `custom-path`(사용자 지정 · env) 또는 `path`(검색으로 발견).
    pub source: &'static str,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// 절대경로이고 실제 파일이어야 사용자 지정 경로로 인정한다.
fn valid_custom(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = Path::new(trimmed);
    if p.is_absolute() && p.is_file() {
        Some(trimmed.to_string())
    } else {
        None
    }
}

/// `PATHEXT` 를 확장자 후보 목록으로 바꾼다. 확장자 없는 파일도 매칭되도록 빈 문자열을
/// 덧붙인다(Unix 및 확장자 없는 shim 대응).
fn path_exts() -> Vec<String> {
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string());
    let mut exts: Vec<String> = raw
        .split(';')
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();
    exts.push(String::new());
    exts
}

/// 검색 대상 디렉터리를 순서를 보존하며 모은다(중복 제거).
fn search_dirs(def: &AgentDef) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let push = |d: PathBuf, dirs: &mut Vec<PathBuf>| {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    };

    if let Some(path) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&path) {
            push(p, &mut dirs);
        }
    }

    // npm 전역 기본 위치 — 이 목록에서 가장 중요하다.
    if let Some(appdata) = std::env::var_os("APPDATA") {
        push(PathBuf::from(appdata).join("npm"), &mut dirs);
    }
    if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
        push(PathBuf::from(&prefix), &mut dirs);
        push(PathBuf::from(&prefix).join("bin"), &mut dirs);
    }

    if let Some(home) = home_dir() {
        for sub in [
            "scoop/shims",
            ".bun/bin",
            ".cargo/bin",
            ".local/bin",
            ".deno/bin",
            ".volta/bin",
        ] {
            push(home.join(sub), &mut dirs);
        }
        for sub in def.extra_search_subdirs {
            push(home.join(sub.replace('\\', "/")), &mut dirs);
        }
    }

    // fnm 은 node 버전마다 별도 `installation` 디렉터리에 전역 bin 을 둔다.
    let fnm_roots = ["APPDATA", "LOCALAPPDATA"]
        .iter()
        .filter_map(|k| std::env::var_os(k).map(|v| PathBuf::from(v).join("fnm")))
        .chain(std::env::var_os("FNM_DIR").map(PathBuf::from))
        .collect::<Vec<_>>();
    for root in fnm_roots {
        let versions = root.join("node-versions");
        if let Ok(entries) = std::fs::read_dir(&versions) {
            for e in entries.flatten() {
                push(e.path().join("installation"), &mut dirs);
            }
        }
    }

    dirs
}

/// 우선순위: 저장된 사용자 지정 경로 → `def.env_var` 환경변수 → 검색.
///
/// 사용자 지정 경로가 있으나 무효면 env 로 가지 않고 곧장 검색으로 떨어진다(설정이
/// 낡았을 때 조용히 다른 바이너리를 쓰는 것보다 재탐지가 낫다).
pub fn resolve_agent(def: &AgentDef, custom: Option<&str>) -> Option<Resolved> {
    if let Some(c) = custom {
        if let Some(path) = valid_custom(c) {
            return Some(Resolved { path, source: "custom-path" });
        }
    } else if let Some(var) = def.env_var {
        if let Ok(v) = std::env::var(var) {
            if let Some(path) = valid_custom(&v) {
                return Some(Resolved { path, source: "custom-path" });
            }
        }
    }

    let exts = path_exts();
    for dir in search_dirs(def) {
        for bin in def.bin_candidates {
            for ext in &exts {
                let candidate = dir.join(format!("{bin}{ext}"));
                if candidate.is_file() {
                    return Some(Resolved {
                        path: candidate.to_string_lossy().into_owned(),
                        source: "path",
                    });
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents;

    #[test]
    fn relative_custom_path_is_rejected() {
        assert!(valid_custom("claude").is_none());
        assert!(valid_custom("  ").is_none());
    }

    #[test]
    fn invalid_custom_path_falls_through_to_search() {
        let def = agents::find("claude").unwrap();
        // 존재하지 않는 절대경로 → custom 으로 채택되지 않는다. 검색 결과는 환경에 따라
        // 다르므로 source 만 확인한다.
        let r = resolve_agent(def, Some("/definitely/not/here/claude"));
        assert!(r.as_ref().map(|r| r.source) != Some("custom-path"));
    }

    #[test]
    fn path_exts_always_include_bare() {
        assert!(path_exts().iter().any(|e| e.is_empty()));
    }
}
