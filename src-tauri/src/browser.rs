//! 웹 검색 — PC 의 크롬 계열 브라우저(Chrome · Edge)를 DevTools 프로토콜(CDP)로 조종한다.
//!
//! 위키 질의 중 AI 가 웹을 찾아야 할 때 쓴다. HTTP 로 검색 엔진을 직접 때리지 않고 **사용자의
//! 브라우저를 띄우는** 이유:
//!
//! * 사내망의 프록시 · 인증서 · 접근 정책은 브라우저에 맞춰져 있다(Windows 의 Chrome · Edge 는
//!   시스템 프록시 설정을 그대로 쓴다). 앱의 HTTP 클라이언트는 사내 엔드포인트용으로 프록시를
//!   끄고 있어 바깥 웹에 닿지 않는 경우가 많다.
//! * 검색 엔진은 브라우저가 아닌 요청을 막거나 다른 페이지를 준다. 결과 페이지가 자바스크립트로
//!   그려지는 사이트도 브라우저면 그대로 읽힌다.
//!
//! **할 수 있는 일은 둘뿐이다** — 검색 결과 페이지를 열어 제목 · 주소 · 요약을 읽는 것(`search`),
//! 결과 주소 하나를 열어 본문 글을 읽는 것(`read`). 클릭 · 입력 · 로그인 같은 조작은 하지 않고,
//! `http(s)` 가 아닌 주소(`file:` · `chrome:` · `javascript:`)는 열지 않는다.
//!
//! 브라우저는 **전용 프로필**(`~/.contextflow/browser`)로 띄운다. 사용자의 평소 프로필(로그인한
//! 계정 · 쿠키)을 AI 가 조종하는 창에 내주지 않기 위해서이고, Chrome 136 부터는 기본 프로필로는
//! 원격 디버깅 자체가 켜지지 않는다. 한 번 띄운 브라우저는 다음 검색에 다시 쓰고, 앱이 끝날 때 닫는다.
//!
//! 포트는 `--remote-debugging-port=0` 으로 브라우저가 고르게 하고, 프로필 폴더의
//! `DevToolsActivePort` 에서 읽는다 — 고정 포트는 다른 프로그램과 부딪힌다. 앱을 다시 켰을 때
//! 앞서 띄운 브라우저가 살아 있으면 그 파일로 찾아 그대로 쓴다(같은 프로필로 또 띄우면 새 창이
//! 기존 프로세스에 넘겨지고 바로 끝나 버린다).

use std::io::ErrorKind;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

/// 브라우저가 뜨고 디버깅 포트 파일을 쓸 때까지 기다리는 상한.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(20);
/// 페이지 하나를 여는 상한. 넘으면 그때까지 그려진 것을 읽는다.
const NAV_TIMEOUT: Duration = Duration::from_secs(15);
/// `interactive` 에서 이만큼 지나도 `complete` 가 안 되면 그대로 읽는다(광고 · 추적 스크립트가
/// 끝없이 붙드는 페이지가 많다).
const INTERACTIVE_GRACE: Duration = Duration::from_secs(3);
/// 다 열린 뒤 자바스크립트가 본문을 그릴 틈.
const SETTLE: Duration = Duration::from_millis(400);
/// CDP 명령 하나의 응답 상한.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// 페이지 본문에서 돌려줄 최대 글자 수. 프롬프트에 실을 분량은 프런트가 다시 자른다.
const PAGE_TEXT_CAP: usize = 12_000;
/// 검색 결과 수 상한.
const MAX_RESULTS: usize = 10;
/// 이만큼 쓰지 않으면 띄운 브라우저를 닫는다 — 헤드리스면 창이 없어 사용자가 닫을 길이 없고,
/// 검색 한 번 뒤로 하루 종일 메모리를 붙들 이유가 없다. 다음 검색이 다시 띄운다.
const IDLE_CLOSE: Duration = Duration::from_secs(10 * 60);

/// 프런트가 고르는 실행 방식(`settings.json` 의 웹 검색 항목).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOptions {
    /// 직접 지정한 실행 파일. 비우면 Chrome → Edge → PATH 순으로 찾는다.
    #[serde(default)]
    pub path: Option<String>,
    /// 창을 보이게 띄운다. 끄면 헤드리스 — 검색 엔진이 보안 문자를 내밀면 켜서 한 번 풀면 된다.
    #[serde(default)]
    pub show: bool,
    /// `google` · `bing` · `duckduckgo` · `naver`. 모르는 값은 google.
    #[serde(default)]
    pub engine: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub path: Option<String>,
    /// `Chrome` · `Edge` · `Chromium` — 화면 표시용.
    pub name: Option<String>,
    /// `custom`(지정 경로) · `auto`(찾음) · `not-found`.
    pub source: String,
    /// 이 앱이 띄운 브라우저가 지금 살아 있는가.
    pub running: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebResult {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub snippet: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SerpResult {
    pub query: String,
    pub engine: String,
    /// 실제로 연 검색 결과 페이지 주소.
    pub url: String,
    pub results: Vec<WebResult>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    pub url: String,
    /// 넘겨받은 뒤의 주소.
    pub final_url: String,
    pub title: String,
    pub text: String,
    pub truncated: bool,
}

/* ── 브라우저 찾기 ─────────────────────────────────────────── */

/// 이 이름의 실행 파일을 PATH 에서 찾는다.
fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) { &[".exe", ""] } else { &[""] };
    std::env::split_paths(&path).find_map(|dir| {
        exts.iter()
            .map(|e| dir.join(format!("{name}{e}")))
            .find(|p| p.is_file())
    })
}

/// 알려진 설치 위치 → PATH 순서의 후보. Chrome 을 Edge 보다 먼저 본다 — 둘 다 있으면 사용자가
/// 따로 깐 쪽이 평소 쓰는 브라우저일 가능성이 높다(Edge 는 Windows 에 늘 깔려 있다).
fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        let bases: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
            .collect();
        for b in &bases {
            out.push(b.join(r"Google\Chrome\Application\chrome.exe"));
        }
        for b in &bases {
            out.push(b.join(r"Microsoft\Edge\Application\msedge.exe"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        for p in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ] {
            out.push(PathBuf::from(p));
        }
    }
    for name in [
        "chrome",
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "msedge",
        "microsoft-edge",
        "microsoft-edge-stable",
    ] {
        if let Some(p) = on_path(name) {
            out.push(p);
        }
    }
    out
}

/// 쓸 브라우저. 지정 경로가 파일로 있으면 그것, 아니면 자동으로 찾은 첫 후보.
///
/// 지정 경로가 없는 파일이면 **자동 탐색으로 넘어가지 않는다** — 사용자가 일부러 고른 것을
/// 조용히 다른 브라우저로 바꾸면 왜 그 창이 떴는지 알 수 없다.
pub fn find_browser(custom: Option<&str>) -> Result<(PathBuf, &'static str), String> {
    if let Some(c) = custom.map(str::trim).filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        return if p.is_file() {
            Ok((p, "custom"))
        } else {
            Err(format!("지정한 브라우저 실행 파일이 없습니다: {c}"))
        };
    }
    candidates()
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| (p, "auto"))
        .ok_or_else(|| {
            "Chrome · Edge 를 찾지 못했습니다. 설정 → 웹 검색 브라우저에서 실행 파일을 지정하세요."
                .to_string()
        })
}

pub fn browser_name(path: &Path) -> &'static str {
    let n = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if n.contains("edge") {
        "Edge"
    } else if n.contains("chromium") {
        "Chromium"
    } else {
        "Chrome"
    }
}

/* ── 검색 주소 ─────────────────────────────────────────────── */

pub fn engine_id(engine: &str) -> &'static str {
    match engine.trim().to_ascii_lowercase().as_str() {
        "bing" => "bing",
        "duckduckgo" | "ddg" => "duckduckgo",
        "naver" => "naver",
        _ => "google",
    }
}

pub fn search_url(engine: &str, query: &str) -> String {
    let q = urlencoding::encode(query.trim());
    match engine_id(engine) {
        "bing" => format!("https://www.bing.com/search?q={q}&setlang=ko"),
        // HTML 판은 자바스크립트 없이 결과가 오고 주소가 안정적이다.
        "duckduckgo" => format!("https://html.duckduckgo.com/html/?q={q}&kl=kr-kr"),
        "naver" => format!("https://search.naver.com/search.naver?query={q}"),
        _ => format!("https://www.google.com/search?q={q}&hl=ko"),
    }
}

/// 열어도 되는 주소인가 — 웹 페이지(`http` · `https`)만.
pub fn readable_url(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    (u.starts_with("http://") || u.starts_with("https://")) && u.len() > "https://".len()
}

/* ── CDP 클라이언트 ────────────────────────────────────────── */

/// DevTools WebSocket 연결 하나. 명령을 보내고 같은 id 의 응답이 올 때까지 읽는다 — 그 사이에
/// 오는 이벤트는 버린다(도메인을 켜지 않으므로 거의 오지 않는다).
struct Cdp {
    ws: WebSocket<TcpStream>,
    next: u64,
}

impl Cdp {
    fn connect(ws_url: &str) -> Result<Cdp, String> {
        let rest = ws_url
            .strip_prefix("ws://")
            .ok_or_else(|| format!("DevTools 주소가 이상합니다: {ws_url}"))?;
        let host = rest.split('/').next().unwrap_or_default();
        let addr: SocketAddr = host
            .replace("localhost", "127.0.0.1")
            .parse()
            .map_err(|e| format!("DevTools 주소를 읽지 못했습니다({host}): {e}"))?;
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
            .map_err(|e| format!("브라우저에 연결하지 못했습니다: {e}"))?;
        // 짧게 끊어 읽는다 — 응답 상한과 취소를 이 간격으로 본다. 응답 하나가 큰 프레임
        // 여러 개로 와도 tungstenite 가 받은 데까지 모아 두므로 이어 읽으면 된다.
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|e| e.to_string())?;
        let (ws, _) = tungstenite::client(ws_url, stream)
            .map_err(|e| format!("DevTools 연결 수립에 실패했습니다: {e}"))?;
        Ok(Cdp { ws, next: 1 })
    }

    fn call(&mut self, session: Option<&str>, method: &str, params: Value) -> Result<Value, String> {
        self.call_within(session, method, params, CALL_TIMEOUT)
    }

    fn call_within(
        &mut self,
        session: Option<&str>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        self.ws
            .send(Message::text(msg.to_string()))
            .map_err(|e| format!("브라우저에 명령을 보내지 못했습니다({method}): {e}"))?;
        let deadline = Instant::now() + timeout;
        loop {
            match self.ws.read() {
                Ok(Message::Text(t)) => {
                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
                        continue;
                    }
                    if let Some(err) = v.get("error") {
                        let m = err.get("message").and_then(|m| m.as_str()).unwrap_or("오류");
                        return Err(format!("{method}: {m}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(Message::Close(_)) => return Err("브라우저가 연결을 닫았습니다".to_string()),
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(e) => return Err(format!("브라우저 연결이 끊겼습니다: {e}")),
            }
            if Instant::now() >= deadline {
                return Err(format!("브라우저가 {}초 안에 답하지 않았습니다({method})", timeout.as_secs()));
            }
        }
    }

    /// 페이지에서 식을 평가해 값을 받는다. 식이 던지면 그 문구를 돌려준다.
    fn eval(&mut self, session: &str, expr: &str) -> Result<Value, String> {
        let r = self.call(
            Some(session),
            "Runtime.evaluate",
            json!({ "expression": expr, "returnByValue": true, "awaitPromise": true }),
        )?;
        if let Some(ex) = r.get("exceptionDetails") {
            let m = ex
                .get("exception")
                .and_then(|e| e.get("description"))
                .and_then(|d| d.as_str())
                .or_else(|| ex.get("text").and_then(|t| t.as_str()))
                .unwrap_or("스크립트 오류");
            return Err(m.to_string());
        }
        Ok(r.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null))
    }
}

/// 새 탭 하나를 열어 일을 시키고, 성공이든 실패든 탭을 닫는다.
///
/// 헤드리스 브라우저는 User-Agent 에 `HeadlessChrome` 을 달고 다니고, 검색 엔진은 그것을 보고
/// 결과 대신 보안 문자를 내민다. 탭마다 평소 UA 로 바꿔 단다(언어도 한국어 우선).
fn with_tab<T>(ws_url: &str, work: impl FnOnce(&mut Cdp, &str) -> Result<T, String>) -> Result<T, String> {
    let mut cdp = Cdp::connect(ws_url)?;
    let target = cdp.call(None, "Target.createTarget", json!({ "url": "about:blank" }))?;
    let target = target
        .get("targetId")
        .and_then(|t| t.as_str())
        .ok_or("브라우저가 새 탭을 열지 못했습니다")?
        .to_string();
    let result = (|| {
        let att = cdp.call(None, "Target.attachToTarget", json!({ "targetId": target, "flatten": true }))?;
        let session = att
            .get("sessionId")
            .and_then(|s| s.as_str())
            .ok_or("새 탭에 붙지 못했습니다")?
            .to_string();
        if let Ok(v) = cdp.call(None, "Browser.getVersion", json!({})) {
            if let Some(ua) = v.get("userAgent").and_then(|u| u.as_str()) {
                let _ = cdp.call(
                    Some(&session),
                    "Emulation.setUserAgentOverride",
                    json!({
                        "userAgent": ua.replace("HeadlessChrome", "Chrome"),
                        "acceptLanguage": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
                    }),
                );
            }
        }
        work(&mut cdp, &session)
    })();
    let _ = cdp.call_within(None, "Target.closeTarget", json!({ "targetId": target }), Duration::from_secs(5));
    let _ = cdp.ws.close(None);
    result
}

/// 주소를 열고 문서가 (거의) 다 그려질 때까지 기다린다.
fn navigate(cdp: &mut Cdp, session: &str, url: &str) -> Result<(), String> {
    let r = cdp.call_within(Some(session), "Page.navigate", json!({ "url": url }), NAV_TIMEOUT)?;
    if let Some(err) = r.get("errorText").and_then(|e| e.as_str()).filter(|e| !e.is_empty()) {
        return Err(format!("페이지를 열지 못했습니다({err}): {url}"));
    }
    let started = Instant::now();
    let mut interactive_at: Option<Instant> = None;
    loop {
        // 탐색이 넘어가는 순간에는 평가가 실패한다("context destroyed") — 다음 바퀴에 다시 본다.
        let state = cdp
            .eval(session, "JSON.stringify([document.readyState, location.href])")
            .ok()
            .and_then(|v| v.as_str().and_then(|s| serde_json::from_str::<Vec<String>>(s).ok()));
        if let Some([ready, href]) = state.as_deref() {
            if href != "about:blank" {
                if ready == "complete" {
                    break;
                }
                if ready == "interactive" {
                    let at = *interactive_at.get_or_insert_with(Instant::now);
                    if at.elapsed() >= INTERACTIVE_GRACE {
                        break;
                    }
                }
            }
        }
        if started.elapsed() >= NAV_TIMEOUT {
            break; // 그때까지 그려진 것을 읽는다
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    std::thread::sleep(SETTLE);
    Ok(())
}

/// 검색 결과 페이지에서 결과를 읽는 스크립트. 엔진마다 아는 모양을 먼저 보고, 셋도 못 찾으면
/// 제목 링크를 두루 줍는다. 엔진의 되돌림 주소(DuckDuckGo `uddg` · Bing `ck/a` · Google `/url`)는
/// 원래 주소로 푼다.
const SERP_JS: &str = r##"
(() => {
  const engine = "__ENGINE__";
  const host = location.hostname.replace(/^www\./, "");
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  // 되돌림 주소는 경로와 매개변수로 알아본다 — 결과 페이지 안의 상대 주소라 호스트가 늘
  // 엔진 이름은 아니다.
  const decode = (href) => {
    try {
      const u = new URL(href, location.href);
      const q = (k) => u.searchParams.get(k);
      if (u.pathname.startsWith("/l/") && q("uddg")) return q("uddg");
      if (u.pathname.startsWith("/ck/") && (q("u") || "").startsWith("a1")) {
        let v = q("u").slice(2).replace(/-/g, "+").replace(/_/g, "/");
        while (v.length % 4) v += "=";
        return atob(v);
      }
      if (u.pathname === "/url" && (q("q") || q("url"))) return q("q") || q("url");
      return u.href;
    } catch (e) { return href; }
  };
  // 엔진 자신의 페이지(설정 · 지도 · 다음 쪽)는 결과가 아니다. 네이버는 블로그 · 카페가 결과라
  // 결과 페이지의 호스트만 뺀다.
  const OWN = { google: /(^|\.)google\.[a-z.]+$/, bing: /(^|\.)bing\.com$/, duckduckgo: /(^|\.)duckduckgo\.com$/ };
  const own = (h) => h === host || h.endsWith("." + host) || (OWN[engine] ? OWN[engine].test(h) : false);
  const out = [];
  const seen = new Set();
  const push = (a, titleEl, snippetEl) => {
    if (!a || out.length >= __MAX__) return;
    const url = decode(a.getAttribute("href") || a.href || "");
    if (!/^https?:\/\//i.test(url)) return;
    let h = "";
    try { h = new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return; }
    if (own(h)) return;
    if (seen.has(url)) return;
    const title = clean((titleEl || a).innerText || (titleEl || a).textContent);
    if (title.length < 2) return;
    let snippet = snippetEl ? clean(snippetEl.innerText || snippetEl.textContent) : "";
    if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
    seen.add(url);
    out.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 400) });
  };
  const by = {
    google: () => document.querySelectorAll("#search a:has(h3), #rso a:has(h3), #main a:has(h3)").forEach((a) => {
      const box = a.closest("div.g, div.MjjYud, div[data-hveid], div[data-sokoban-container]");
      push(a, a.querySelector("h3"), box && box.querySelector(".VwiC3b, [data-sncf], .IsZvec, .s3v9rd"));
    }),
    bing: () => document.querySelectorAll("li.b_algo").forEach((li) => {
      const a = li.querySelector("h2 a");
      push(a, a, li.querySelector(".b_caption p, .b_lineclamp2, .b_lineclamp3, p"));
    }),
    duckduckgo: () => document.querySelectorAll(".result, .web-result").forEach((r) => {
      const a = r.querySelector("a.result__a");
      push(a, a, r.querySelector(".result__snippet"));
    }),
    naver: () => document.querySelectorAll(".total_wrap, .total_area, li.bx, .fds-web-doc-root").forEach((r) => {
      const a = r.querySelector("a.link_tit, a.total_tit, .total_tit a, a.title_link, a.api_txt_lines");
      push(a, a, r.querySelector(".api_txt_lines.dsc_txt, .total_dsc, .dsc_txt, .api_txt_lines"));
    }),
  };
  try { (by[engine] || by.google)(); } catch (e) {}
  if (out.length < 3) {
    document.querySelectorAll("a:has(h3), a:has(h2), h3 a, h2 a").forEach((a) => push(a, a, a.closest("li, article, div")));
  }
  const head = (document.body ? (document.body.innerText || "") : "").slice(0, 3000);
  const blocked = /\/sorry\/|captcha|recaptcha|unusual traffic|비정상적인 트래픽|자동화된 요청/i.test(location.href + " " + document.title + " " + head);
  return JSON.stringify({ results: out, blocked: blocked && out.length === 0, url: location.href });
})()
"##;

/// 본문 글을 읽는 스크립트. 내비게이션 · 머리말 · 꼬리말 · 광고처럼 본문이 아닌 것을 숨긴 뒤
/// (`innerText` 는 숨긴 요소를 빼고 센다) 가장 글이 많은 본문 후보를 고른다.
const PAGE_JS: &str = r##"
(() => {
  const type = document.contentType || "";
  if (!/html|xml|text\/plain/i.test(type)) return JSON.stringify({ title: document.title || "", text: "", url: location.href, skipped: type });
  const hide = "script,style,noscript,template,svg,canvas,iframe,nav,header,footer,aside,form,button,dialog,[role=navigation],[role=banner],[role=contentinfo],[role=dialog],[aria-hidden=true],.cookie,.cookies,.ad,.ads,.advert,.advertisement,.banner";
  document.querySelectorAll(hide).forEach((e) => { try { e.style.setProperty("display", "none", "important"); } catch (x) {} });
  let root = document.body, best = 0;
  document.querySelectorAll("article, main, [role=main], #content, #main, .content, .post, .article, .markdown-body").forEach((c) => {
    const n = (c.innerText || "").length;
    if (n > best) { best = n; root = c; }
  });
  if (best < 400) root = document.body;
  let text = root ? (root.innerText || "") : "";
  const lines = [];
  for (const raw of text.split("\n")) {
    const l = raw.replace(/[ \t\u00a0]+/g, " ").trim();
    if (l || (lines.length && lines[lines.length - 1] !== "")) lines.push(l);
  }
  return JSON.stringify({ title: document.title || "", text: lines.join("\n").trim(), url: location.href });
})()
"##;

fn extract_serp(cdp: &mut Cdp, session: &str, engine: &str) -> Result<(Vec<WebResult>, bool, String), String> {
    let js = SERP_JS
        .replace("__ENGINE__", engine_id(engine))
        .replace("__MAX__", &MAX_RESULTS.to_string());
    let v = cdp.eval(session, &js)?;
    let parsed: Value = v
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .ok_or("검색 결과를 읽지 못했습니다")?;
    let results: Vec<WebResult> = serde_json::from_value(parsed["results"].clone()).unwrap_or_default();
    let blocked = parsed["blocked"].as_bool().unwrap_or(false);
    let url = parsed["url"].as_str().unwrap_or_default().to_string();
    Ok((results, blocked, url))
}

fn extract_page(cdp: &mut Cdp, session: &str, requested: &str) -> Result<WebPage, String> {
    let v = cdp.eval(session, PAGE_JS)?;
    let p: Value = v
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .ok_or("페이지 본문을 읽지 못했습니다")?;
    if let Some(t) = p["skipped"].as_str() {
        return Err(format!("HTML 문서가 아니라 읽지 않았습니다({t}): {requested}"));
    }
    let full = p["text"].as_str().unwrap_or_default();
    let truncated = full.chars().count() > PAGE_TEXT_CAP;
    let text: String = full.chars().take(PAGE_TEXT_CAP).collect();
    Ok(WebPage {
        url: requested.to_string(),
        final_url: p["url"].as_str().unwrap_or(requested).to_string(),
        title: p["title"].as_str().unwrap_or_default().trim().to_string(),
        text,
        truncated,
    })
}

/* ── 브라우저 프로세스 ─────────────────────────────────────── */

/// 띄운 브라우저 하나. `child` 가 없으면 앞선 실행에서 띄워 둔 것을 찾아 쓰는 중이다.
struct Session {
    ws_url: String,
    port: u16,
    child: Option<Child>,
    path: PathBuf,
    show: bool,
}

/// `/json/version` — 살아 있으면 `(DevTools WebSocket 주소, 헤드리스인가)`.
fn probe(port: u16) -> Option<(String, bool)> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let v: Value = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .ok()?
        .json()
        .ok()?;
    let ws = v.get("webSocketDebuggerUrl")?.as_str()?.to_string();
    let ua = v.get("User-Agent").and_then(|u| u.as_str()).unwrap_or_default();
    let browser = v.get("Browser").and_then(|u| u.as_str()).unwrap_or_default();
    Some((ws, ua.contains("Headless") || browser.contains("Headless")))
}

/// 프로필 폴더의 `DevToolsActivePort` 첫 줄 = 포트.
pub fn read_port_file(profile: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    raw.lines().next()?.trim().parse().ok().filter(|p| *p > 0)
}

/// 브라우저를 CDP 로 닫는다(`Browser.close`). 앱이 띄우지 않은 — 앞선 실행이 남긴 — 것도 닫힌다.
fn close_via_cdp(ws_url: &str) {
    if let Ok(mut cdp) = Cdp::connect(ws_url) {
        let _ = cdp.call_within(None, "Browser.close", json!({}), Duration::from_secs(3));
    }
}

fn launch_args(profile: &Path, show: bool, extra: &[String]) -> Vec<String> {
    let mut a = vec![
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-default-apps".to_string(),
        "--disable-sync".to_string(),
        // 번역 제안 · 기기 찾기 같은 팝업이 페이지 위를 덮지 않게.
        "--disable-features=Translate,MediaRouter".to_string(),
        "--lang=ko-KR".to_string(),
        "--window-size=1280,900".to_string(),
    ];
    if !show {
        a.push("--headless=new".to_string());
    }
    a.extend(extra.iter().cloned());
    a.push("about:blank".to_string());
    a
}

/// 사내 정책 등으로 브라우저에 인자를 더 줘야 할 때(`--proxy-server=…` 등). 공백으로 나눈다.
fn env_extra_args() -> Vec<String> {
    std::env::var("CONTEXTFLOW_BROWSER_ARGS")
        .map(|v| v.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

/// 앱이 쥔 브라우저. 한 번에 한 작업만 한다(뮤텍스) — 검색 엔진에 요청을 겹쳐 보내면 보안
/// 문자가 뜨기 쉽고, 위키 질의도 한 번에 하나다.
pub struct BrowserState {
    inner: Arc<Mutex<Option<Session>>>,
    /// 마지막으로 쓴 때 — `IDLE_CLOSE` 가 지나면 정리 스레드가 닫는다.
    last_used: Arc<Mutex<Instant>>,
    reaper: AtomicBool,
    /// 테스트용 — 프로필 폴더와 추가 인자.
    profile_override: Option<PathBuf>,
    extra: Vec<String>,
}

impl Default for BrowserState {
    fn default() -> Self {
        BrowserState {
            inner: Arc::new(Mutex::new(None)),
            last_used: Arc::new(Mutex::new(Instant::now())),
            reaper: AtomicBool::new(false),
            profile_override: None,
            extra: Vec::new(),
        }
    }
}

impl BrowserState {
    #[cfg(test)]
    fn for_test(profile: PathBuf, extra: Vec<String>) -> BrowserState {
        BrowserState { profile_override: Some(profile), extra, ..BrowserState::default() }
    }

    fn touch(&self) {
        *self.last_used.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    /// 쓰지 않는 브라우저를 닫는 스레드 — 처음 띄울 때 한 번만 만든다. 작업 중이면(뮤텍스를
    /// 쥐고 있으면) 건드리지 않는다.
    fn start_reaper(&self) {
        if self.reaper.swap(true, Ordering::SeqCst) {
            return;
        }
        let inner = self.inner.clone();
        let last = self.last_used.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(30));
            let idle = last.lock().unwrap_or_else(PoisonError::into_inner).elapsed();
            if idle < IDLE_CLOSE {
                continue;
            }
            if let Ok(mut slot) = inner.try_lock() {
                if let Some(s) = slot.take() {
                    shutdown_session(s);
                }
            }
        });
    }

    fn profile(&self) -> Result<PathBuf, String> {
        match &self.profile_override {
            Some(p) => Ok(p.clone()),
            None => Ok(crate::app_home()?.join("browser")),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Session>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 쓸 수 있는 브라우저의 DevTools 주소. 없으면 띄운다.
    fn ensure(&self, slot: &mut Option<Session>, opts: &BrowserOptions) -> Result<String, String> {
        let (path, _) = find_browser(opts.path.as_deref())?;
        if let Some(s) = slot.as_mut() {
            let same = s.path == path && s.show == opts.show;
            let exited = s.child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(Some(_))));
            if same && !exited {
                if let Some((ws, _)) = probe(s.port) {
                    s.ws_url = ws.clone();
                    return Ok(ws);
                }
            }
            // 설정이 바뀌었거나(창 보이기 · 다른 브라우저) 사용자가 창을 닫았다 — 새로 띄운다.
            let old = slot.take().expect("checked");
            shutdown_session(old);
        }

        self.start_reaper();
        let profile = self.profile()?;
        std::fs::create_dir_all(&profile).map_err(|e| format!("브라우저 프로필 폴더를 만들 수 없습니다: {e}"))?;

        // 앞선 실행이 남긴 브라우저가 살아 있으면 그대로 쓴다. 방식(헤드리스 여부)이 다르면 닫는다.
        if let Some(port) = read_port_file(&profile) {
            if let Some((ws, headless)) = probe(port) {
                if headless == !opts.show {
                    *slot = Some(Session { ws_url: ws.clone(), port, child: None, path, show: opts.show });
                    return Ok(ws);
                }
                close_via_cdp(&ws);
                let t = Instant::now();
                while probe(port).is_some() && t.elapsed() < Duration::from_secs(5) {
                    std::thread::sleep(Duration::from_millis(150));
                }
            }
        }
        let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));

        let mut extra = self.extra.clone();
        extra.extend(env_extra_args());
        let mut child = Command::new(&path)
            .args(launch_args(&profile, opts.show, &extra))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("{} 를 띄우지 못했습니다: {e}", browser_name(&path)))?;

        let started = Instant::now();
        loop {
            if let Some(port) = read_port_file(&profile) {
                if let Some((ws, _)) = probe(port) {
                    *slot = Some(Session { ws_url: ws.clone(), port, child: Some(child), path, show: opts.show });
                    return Ok(ws);
                }
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "{} 가 바로 끝났습니다({status}). 같은 프로필을 쓰는 창이 이미 떠 있으면 닫고 다시 시도하세요.",
                    browser_name(&path)
                ));
            }
            if started.elapsed() >= LAUNCH_TIMEOUT {
                let _ = child.kill();
                return Err(format!(
                    "{} 의 원격 디버깅 포트를 {}초 안에 찾지 못했습니다. 회사 정책으로 원격 디버깅이 \
                     막힌 브라우저일 수 있습니다 — 설정 → 웹 검색 브라우저에서 다른 브라우저(Edge · Chrome)를 \
                     지정해 보세요.",
                    browser_name(&path),
                    LAUNCH_TIMEOUT.as_secs()
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// 검색 결과 페이지를 열어 결과를 읽는다.
    pub fn search(&self, opts: &BrowserOptions, query: &str) -> Result<SerpResult, String> {
        let query = query.trim();
        if query.is_empty() {
            return Err("검색어가 비어 있습니다".to_string());
        }
        let mut slot = self.lock();
        let ws = self.ensure(&mut slot, opts)?;
        self.touch();
        let engine = engine_id(&opts.engine);
        let url = search_url(engine, query);
        let serp = with_tab(&ws, |cdp, s| {
            navigate(cdp, s, &url)?;
            extract_serp(cdp, s, engine)
        });
        self.touch();
        let (results, blocked, final_url) = serp?;
        if blocked {
            return Err(format!(
                "검색 엔진({engine})이 자동 검색을 막았습니다(보안 문자). 설정 → 웹 검색 브라우저에서 \
                 [브라우저 창 보이기] 를 켜고 한 번 풀거나, 다른 검색 엔진을 고르세요."
            ));
        }
        Ok(SerpResult { query: query.to_string(), engine: engine.to_string(), url: final_url, results })
    }

    /// 결과 주소 하나를 열어 본문 글을 읽는다.
    pub fn read(&self, opts: &BrowserOptions, url: &str) -> Result<WebPage, String> {
        let url = url.trim();
        if !readable_url(url) {
            return Err(format!("웹 페이지 주소가 아니라 열지 않습니다: {url}"));
        }
        let mut slot = self.lock();
        let ws = self.ensure(&mut slot, opts)?;
        self.touch();
        let page = with_tab(&ws, |cdp, s| {
            navigate(cdp, s, url)?;
            extract_page(cdp, s, url)
        });
        self.touch();
        page
    }

    pub fn running(&self) -> bool {
        self.lock().as_ref().is_some_and(|s| probe(s.port).is_some())
    }

    /// 띄운 브라우저를 닫는다. 앱이 끝날 때와 설정 화면의 [브라우저 닫기] 에서.
    pub fn shutdown(&self) {
        if let Some(s) = self.lock().take() {
            shutdown_session(s);
        }
    }
}

fn shutdown_session(mut s: Session) {
    close_via_cdp(&s.ws_url);
    if let Some(c) = s.child.as_mut() {
        let t = Instant::now();
        while matches!(c.try_wait(), Ok(None)) && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = c.kill();
        let _ = c.wait();
    }
}

/* ── 커맨드 ────────────────────────────────────────────────── */

/// 쓸 브라우저를 알려 준다. 띄우지는 않는다.
#[tauri::command]
pub async fn browser_detect(app: tauri::AppHandle, path: Option<String>) -> Result<BrowserInfo, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let running = app.state::<BrowserState>().running();
        Ok(match find_browser(path.as_deref()) {
            Ok((p, source)) => BrowserInfo {
                name: Some(browser_name(&p).to_string()),
                path: Some(p.to_string_lossy().into_owned()),
                source: source.to_string(),
                running,
            },
            Err(_) => BrowserInfo { path: None, name: None, source: "not-found".to_string(), running },
        })
    })
    .await
    .map_err(|e| format!("브라우저 확인이 중단되었습니다: {e}"))?
}

#[tauri::command]
pub async fn web_search(app: tauri::AppHandle, opts: BrowserOptions, query: String) -> Result<SerpResult, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || app.state::<BrowserState>().search(&opts, &query))
        .await
        .map_err(|e| format!("웹 검색이 중단되었습니다: {e}"))?
}

#[tauri::command]
pub async fn web_read(app: tauri::AppHandle, opts: BrowserOptions, url: String) -> Result<WebPage, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || app.state::<BrowserState>().read(&opts, &url))
        .await
        .map_err(|e| format!("페이지 읽기가 중단되었습니다: {e}"))?
}

#[tauri::command]
pub async fn browser_close(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || app.state::<BrowserState>().shutdown())
        .await
        .map_err(|e| format!("브라우저를 닫지 못했습니다: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn engines_and_urls() {
        assert_eq!(engine_id(""), "google");
        assert_eq!(engine_id("BING"), "bing");
        assert_eq!(engine_id("ddg"), "duckduckgo");
        assert_eq!(engine_id("모름"), "google");
        assert_eq!(
            search_url("google", " Jenkins 재시도 "),
            "https://www.google.com/search?q=Jenkins%20%EC%9E%AC%EC%8B%9C%EB%8F%84&hl=ko"
        );
        assert!(search_url("duckduckgo", "a&b").contains("html.duckduckgo.com/html/?q=a%26b"));
        assert!(search_url("naver", "x").starts_with("https://search.naver.com/"));
        assert!(search_url("bing", "x").starts_with("https://www.bing.com/search?q=x"));
    }

    /// 웹 페이지만 연다 — 로컬 파일 · 브라우저 내부 페이지 · 스크립트 주소는 거절한다.
    #[test]
    fn only_web_urls_are_readable() {
        assert!(readable_url("https://example.com/a"));
        assert!(readable_url(" HTTP://example.com "));
        for bad in ["file:///C:/secret.txt", "chrome://settings", "javascript:alert(1)", "https://", "about:blank", ""] {
            assert!(!readable_url(bad), "{bad}");
        }
    }

    #[test]
    fn names_follow_the_executable() {
        assert_eq!(browser_name(Path::new(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe")), "Edge");
        assert_eq!(browser_name(Path::new("/usr/bin/chromium-browser")), "Chromium");
        assert_eq!(browser_name(Path::new("/opt/google/chrome/chrome")), "Chrome");
    }

    #[test]
    fn launch_args_pick_headless_and_a_private_profile() {
        let p = Path::new("/tmp/cf-profile");
        let a = launch_args(p, false, &["--no-sandbox".to_string()]);
        assert!(a.contains(&"--remote-debugging-port=0".to_string()));
        assert!(a.contains(&"--user-data-dir=/tmp/cf-profile".to_string()));
        assert!(a.contains(&"--headless=new".to_string()));
        assert!(a.contains(&"--no-sandbox".to_string()));
        assert_eq!(a.last().map(String::as_str), Some("about:blank"));
        assert!(!launch_args(p, true, &[]).iter().any(|x| x.starts_with("--headless")));
    }

    #[test]
    fn custom_path_must_exist_and_is_never_swapped_silently() {
        let err = find_browser(Some("/definitely/not/here/chrome")).unwrap_err();
        assert!(err.contains("지정한 브라우저"));
        let exe = std::env::current_exe().unwrap();
        let (p, src) = find_browser(Some(exe.to_str().unwrap())).unwrap();
        assert_eq!((p, src), (exe, "custom"));
    }

    #[test]
    fn port_file_first_line_is_the_port() {
        let dir = std::env::temp_dir().join("contextflow-browser-portfile");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_port_file(&dir), None);
        std::fs::write(dir.join("DevToolsActivePort"), "41237\n/devtools/browser/abc\n").unwrap();
        assert_eq!(read_port_file(&dir), Some(41237));
        std::fs::write(dir.join("DevToolsActivePort"), "junk").unwrap();
        assert_eq!(read_port_file(&dir), None);
    }

    /* ── 실제 브라우저로 — CONTEXTFLOW_TEST_BROWSER 가 있을 때만 ─────── */

    /// 아주 작은 HTTP 서버 — 경로 → 본문.
    fn serve(pages: Vec<(&'static str, String)>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let path = path.split('?').next().unwrap_or("/").to_string();
                let body = pages
                    .iter()
                    .find(|(p, _)| *p == path)
                    .map(|(_, b)| b.clone())
                    .unwrap_or_else(|| "<h1>없음</h1>".to_string());
                let ctype = if path.ends_with(".pdf") { "application/pdf" } else { "text/html; charset=utf-8" };
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    #[test]
    fn drives_a_real_browser() {
        let Ok(bin) = std::env::var("CONTEXTFLOW_TEST_BROWSER") else {
            eprintln!("CONTEXTFLOW_TEST_BROWSER 가 없어 건너뜁니다");
            return;
        };
        let google = r#"<html><body><div id="search"><div class="g"><a href="https://docs.example.com/retry"><h3>Pipeline retry 문서</h3></a><div class="VwiC3b">retry 로 본문을 N 번 다시 돌린다</div></div>
            <div class="g"><a href="/url?q=https://blog.example.org/rollback&sa=U"><h3>롤백 전략</h3></a><div class="VwiC3b">이전 빌드로 되돌린다</div></div>
            <div class="g"><a href="https://www.google.com/preferences"><h3>설정</h3></a></div></div></body></html>"#;
        let ddg = r#"<html><body><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fa%3Fx%3D1&rut=z">덕덕고 결과</a><a class="result__snippet">요약 글</a></div></body></html>"#;
        let bing = r#"<html><body><ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=1&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9iaW5n&ntb=1">빙 결과</a></h2><div class="b_caption"><p>빙 요약</p></div></li></ol></body></html>"#;
        let sorry = r#"<html><head><title>Sorry...</title></head><body>Our systems have detected unusual traffic from your computer network.</body></html>"#;
        let article = format!(
            r#"<html><head><title>재시도 가이드</title></head><body><nav>메뉴 메뉴 메뉴</nav><header>사이트 머리말</header>
            <article><h1>재시도 가이드</h1><p>{}</p><p>두 번째 문단.</p><script>var x = "숨은 스크립트";</script><p id="late"></p></article>
            <footer>꼬리말</footer><script>setTimeout(() => document.getElementById('late').textContent = '늦게 그려진 글', 50)</script></body></html>"#,
            "retry 단계는 실패한 본문을 다시 실행한다. ".repeat(30)
        );
        let port = serve(vec![
            ("/google", google.to_string()),
            ("/ddg", ddg.to_string()),
            ("/bing", bing.to_string()),
            ("/sorry", sorry.to_string()),
            ("/article", article),
            ("/doc.pdf", "%PDF-1.4".to_string()),
        ]);
        let base = format!("http://127.0.0.1:{port}");

        let profile = std::env::temp_dir().join(format!("contextflow-browser-it-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let state = BrowserState::for_test(profile.clone(), vec!["--no-sandbox".to_string()]);
        let opts = BrowserOptions { path: Some(bin), show: false, engine: "google".into() };

        // 결과 페이지 읽기 — 엔진마다 모양과 되돌림 주소가 다르다.
        let serp = |engine: &str, path: &str| {
            let mut slot = state.lock();
            let ws = state.ensure(&mut slot, &opts).unwrap();
            with_tab(&ws, |cdp, s| {
                navigate(cdp, s, &format!("{base}{path}"))?;
                extract_serp(cdp, s, engine)
            })
            .unwrap()
        };
        let (g, blocked, _) = serp("google", "/google");
        assert!(!blocked);
        assert_eq!(g.len(), 2, "{g:?}");
        assert_eq!(g[0].url, "https://docs.example.com/retry");
        assert_eq!(g[0].title, "Pipeline retry 문서");
        assert!(g[0].snippet.contains("N 번"));
        assert_eq!(g[1].url, "https://blog.example.org/rollback");
        let (d, _, _) = serp("duckduckgo", "/ddg");
        assert_eq!(d[0].url, "https://example.net/a?x=1");
        assert_eq!(d[0].snippet, "요약 글");
        let (b, _, _) = serp("bing", "/bing");
        assert_eq!(b[0].url, "https://example.com/bing");
        let (none, blocked, _) = serp("google", "/sorry");
        assert!(none.is_empty() && blocked);

        // 본문 읽기 — 메뉴 · 머리말 · 꼬리말 · 스크립트는 빠지고 늦게 그려진 글은 들어온다.
        let page = state.read(&opts, &format!("{base}/article")).unwrap();
        assert_eq!(page.title, "재시도 가이드");
        assert!(page.text.contains("두 번째 문단."));
        assert!(page.text.contains("늦게 그려진 글"));
        assert!(!page.text.contains("메뉴 메뉴"));
        assert!(!page.text.contains("꼬리말"));
        assert!(!page.text.contains("숨은 스크립트"));
        assert!(state.read(&opts, &format!("{base}/doc.pdf")).is_err());
        assert!(state.read(&opts, "file:///etc/passwd").is_err());

        // 같은 브라우저를 다시 쓴다.
        assert!(state.running());
        let before = state.lock().as_ref().map(|s| s.port);
        state.read(&opts, &format!("{base}/article")).unwrap();
        assert_eq!(state.lock().as_ref().map(|s| s.port), before);

        // 앱이 브라우저를 닫지 못하고 끝났다(강제 종료) — 다음 실행은 남은 브라우저를 찾아 쓴다.
        let port = state.lock().as_ref().map(|s| s.port).unwrap();
        std::mem::forget(state.lock().take()); // 닫지 않고 손만 놓는다
        let next = BrowserState::for_test(profile.clone(), vec!["--no-sandbox".to_string()]);
        let page = next.read(&opts, &format!("{base}/article")).unwrap();
        assert_eq!(page.title, "재시도 가이드");
        assert_eq!(next.lock().as_ref().map(|s| (s.port, s.child.is_none())), Some((port, true)));

        // 남은 브라우저도 CDP 로 닫힌다.
        next.shutdown();
        let t = Instant::now();
        while probe(port).is_some() && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(probe(port).is_none());
        let _ = std::fs::remove_dir_all(&profile);
    }

    /// 실제 검색 엔진으로 — 네트워크가 필요해 기본으로는 돌지 않는다.
    /// `CONTEXTFLOW_TEST_BROWSER=… cargo test --lib live_engines -- --ignored --nocapture`
    /// (프록시가 필요하면 `CONTEXTFLOW_BROWSER_ARGS="--proxy-server=…"`).
    #[test]
    #[ignore]
    fn live_engines() {
        let bin = std::env::var("CONTEXTFLOW_TEST_BROWSER").expect("CONTEXTFLOW_TEST_BROWSER");
        let profile = std::env::temp_dir().join(format!("contextflow-browser-live-{}", std::process::id()));
        let state = BrowserState::for_test(profile.clone(), vec!["--no-sandbox".to_string()]);
        for engine in ["google", "bing", "duckduckgo", "naver"] {
            let opts = BrowserOptions { path: Some(bin.clone()), show: false, engine: engine.into() };
            match state.search(&opts, "Tauri 2 sidecar") {
                Ok(r) => {
                    eprintln!("{engine}: {} 건 — {:?}", r.results.len(), r.results.first());
                    if let Some(first) = r.results.first() {
                        match state.read(&opts, &first.url) {
                            Ok(p) => eprintln!("  읽음: {} ({}자)", p.title, p.text.chars().count()),
                            Err(e) => eprintln!("  읽기 실패: {e}"),
                        }
                    }
                }
                Err(e) => eprintln!("{engine}: 실패 — {e}"),
            }
        }
        state.shutdown();
        let _ = std::fs::remove_dir_all(&profile);
    }
}
