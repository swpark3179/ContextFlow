//! 실서비스 점검 — 사내망에서 손으로만 돌린다(`#[ignore]`).
//!
//! ```powershell
//! $env:IWMS_DATE = "2026-10-02"
//! cargo test --manifest-path src-tauri/Cargo.toml live_read -- --ignored --nocapture
//! ```
//!
//! 앱은 WebView2 창으로 SSO 쿠키를 얻지만 테스트에는 창을 띄울 Tauri 런타임이 없다. 그래서 여기서는
//! 전용 프로필의 Chrome · Edge 를 DevTools 프로토콜로 띄워 `Storage.getCookies` 로 같은 `SESSION`
//! 쿠키를 읽는다(바탕화면 `mcp-wms` 의 방식). **쿠키 값은 출력하지 않는다.**
//!
//! 환경변수: `IWMS_DATE`(기본 2026-10-02) · `IWMS_BASE`(기본 설정 파일의 주소) · `IWMS_BROWSER`(실행 파일,
//! 기본 Edge) · `IWMS_WAIT`(로그인 대기 초, 기본 90) · `IWMS_DUMP`(폴더 — 원본 응답을 거기에 저장한다.
//! 저장소 안에 두지 않는다). 로그인이 시간 안에 안 끝나면 창을 열어 둔다 — 로그인하고 다시 돌리면 그
//! 브라우저를 그대로 쓴다.

use std::io::ErrorKind;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

use super::client::{CallError, Client, User};
use super::day;

pub(super) fn env_date() -> String {
    std::env::var("IWMS_DATE").unwrap_or_else(|_| "2026-10-02".to_string())
}

pub(super) fn env_base() -> String {
    std::env::var("IWMS_BASE")
        .ok()
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| super::settings::load(&crate::app_home().unwrap()).base_url)
}

/// 테스트 전용 브라우저 하나. 끝나면 `Browser.close` 로 닫는다.
pub(super) struct TestBrowser {
    ws_url: String,
}

impl Drop for TestBrowser {
    fn drop(&mut self) {
        if let Ok(mut cdp) = Cdp::connect(&self.ws_url) {
            let _ = cdp.call("Browser.close", json!({}));
        }
    }
}

struct Cdp {
    ws: WebSocket<TcpStream>,
    next: u64,
}

impl Cdp {
    fn connect(ws_url: &str) -> Result<Cdp, String> {
        let host = ws_url.trim_start_matches("ws://").split('/').next().unwrap_or_default();
        let addr: SocketAddr = host.replace("localhost", "127.0.0.1").parse().map_err(|e| format!("{host}: {e}"))?;
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| e.to_string())?;
        stream.set_read_timeout(Some(Duration::from_millis(250))).map_err(|e| e.to_string())?;
        let (ws, _) = tungstenite::client(ws_url, stream).map_err(|e| e.to_string())?;
        Ok(Cdp { ws, next: 1 })
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        self.ws
            .send(Message::text(json!({ "id": id, "method": method, "params": params }).to_string()))
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match self.ws.read() {
                Ok(Message::Text(t)) => {
                    let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    if v.get("id").and_then(Value::as_u64) != Some(id) {
                        continue;
                    }
                    if let Some(err) = v.get("error") {
                        return Err(format!("{method}: {err}"));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(e) => return Err(e.to_string()),
            }
            if Instant::now() >= deadline {
                return Err(format!("{method}: 응답 없음"));
            }
        }
    }
}

fn devtools_ws(port: u16) -> Option<String> {
    let http = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().ok()?;
    let v: Value = http.get(format!("http://127.0.0.1:{port}/json/version")).send().ok()?.json().ok()?;
    v.get("webSocketDebuggerUrl")?.as_str().map(str::to_string)
}

/// 전용 프로필 브라우저를 i-WMS 주소로 띄우고 SSO 가 끝날 때까지(90초) 쿠키를 기다린다.
pub(super) fn connect_via_browser(base: &str) -> (TestBrowser, String, User) {
    // Edge 를 먼저 쓴다. 2026-10-04 실측: 새 프로필의 Chrome 은 사내 통합인증이 저절로 되지 않아 로그인
    // 화면에 멈췄고, Edge 는 몇 초 만에 SSO 가 끝났다(앱의 WebView2 도 Edge 엔진이다).
    let custom = std::env::var("IWMS_BROWSER").ok().or_else(|| {
        ["ProgramFiles(x86)", "ProgramFiles"]
            .iter()
            .filter_map(|k| std::env::var(k).ok())
            .map(|d| PathBuf::from(d).join("Microsoft/Edge/Application/msedge.exe"))
            .find(|p| p.is_file())
            .map(|p| p.to_string_lossy().into_owned())
    });
    let (exe, _) = crate::browser::find_browser(custom.as_deref()).expect("Chrome · Edge 가 필요합니다");
    let name = crate::browser::browser_name(&exe).to_ascii_lowercase();
    let profile: PathBuf = crate::app_home().unwrap().join(format!("iwms-test-{name}"));
    std::fs::create_dir_all(&profile).unwrap();
    println!("브라우저: {} · 프로필 {}", exe.display(), profile.display());

    let ws_url = match crate::browser::read_port_file(&profile).and_then(devtools_ws) {
        Some(ws) => ws,
        None => {
            let _ = std::fs::remove_file(profile.join("DevToolsActivePort"));
            Command::new(&exe)
                .args([
                    "--remote-debugging-port=0".to_string(),
                    format!("--user-data-dir={}", profile.display()),
                    "--no-first-run".to_string(),
                    "--no-default-browser-check".to_string(),
                    "--window-size=1100,820".to_string(),
                    base.to_string(),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("브라우저를 띄우지 못했습니다");
            let started = Instant::now();
            loop {
                if let Some(ws) = crate::browser::read_port_file(&profile).and_then(devtools_ws) {
                    break ws;
                }
                assert!(started.elapsed() < Duration::from_secs(20), "원격 디버깅 포트가 열리지 않았습니다");
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    };
    let browser = TestBrowser { ws_url: ws_url.clone() };
    let host = tauri::Url::parse(base).unwrap().host_str().unwrap_or_default().to_string();

    let mut cdp = Cdp::connect(&ws_url).expect("DevTools 연결 실패");
    // 앞선 실행이 남긴 창이면 i-WMS 탭이 없을 수 있다.
    let _ = cdp.call("Target.createTarget", json!({ "url": base }));
    let wait = Duration::from_secs(
        std::env::var("IWMS_WAIT").ok().and_then(|w| w.parse().ok()).unwrap_or(90),
    );
    let deadline = Instant::now() + wait;
    let mut last_report = Instant::now();
    let mut rejected: Option<String> = None;
    loop {
        let cookies = cdp.call("Storage.getCookies", json!({})).unwrap_or(Value::Null);
        let found = cookies
            .get("cookies")
            .and_then(Value::as_array)
            .and_then(|cs| {
                cs.iter().find(|c| {
                    c.get("name").and_then(Value::as_str) == Some("SESSION")
                        && host.ends_with(c.get("domain").and_then(Value::as_str).unwrap_or("-").trim_start_matches('.'))
                })
            })
            .and_then(|c| c.get("value").and_then(Value::as_str))
            .map(|v| format!("SESSION={v}"));
        if let Some(header) = found.filter(|h| rejected.as_deref() != Some(h.as_str())) {
            match Client::new(base, &header).and_then(|c| c.profile()) {
                Ok(user) => return (browser, header, user),
                Err(CallError::Expired) => rejected = Some(header),
                Err(CallError::Other(m)) => panic!("프로필 확인 실패: {m}"),
            }
        }
        if last_report.elapsed() >= Duration::from_secs(10) {
            last_report = Instant::now();
            println!("  기다리는 중 — 열린 페이지: {}", page_hosts(&mut cdp));
        }
        if Instant::now() >= deadline {
            // 창을 닫지 않는다 — 열린 창에서 로그인을 마치고 다시 돌리면 같은 브라우저를 쓴다.
            std::mem::forget(browser);
            panic!("{}초 안에 i-WMS 로그인이 끝나지 않았습니다 — 열린 창에서 로그인한 뒤 다시 실행하세요", wait.as_secs());
        }
        std::thread::sleep(Duration::from_millis(700));
    }
}

/// 열린 탭의 호스트 · 경로(쿼리 제외) — 로그인 화면에 멈춰 있는지 볼 수 있게.
fn page_hosts(cdp: &mut Cdp) -> String {
    let targets = cdp.call("Target.getTargets", json!({})).unwrap_or(Value::Null);
    targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .map(|ts| {
            ts.iter()
                .filter(|t| t.get("type").and_then(Value::as_str) == Some("page"))
                .filter_map(|t| t.get("url").and_then(Value::as_str))
                .filter_map(|u| tauri::Url::parse(u).ok())
                .map(|u| format!("{}{}", u.host_str().unwrap_or(u.scheme()), u.path()))
                .collect::<Vec<_>>()
                .join(" , ")
        })
        .unwrap_or_default()
}

fn dump(name: &str, v: &Value) {
    if let Ok(dir) = std::env::var("IWMS_DUMP") {
        let path = PathBuf::from(dir).join(name);
        std::fs::write(&path, serde_json::to_string_pretty(v).unwrap()).unwrap();
        println!("원본 응답 저장: {}", path.display());
    }
}

/// 읽기만 한다. 그날의 탭 · 카테고리 · 합계를 i-WMS 화면과 맞춰 볼 수 있게 요약을 찍는다.
#[test]
#[ignore = "사내망 · i-WMS 접속이 필요하다"]
fn live_read() {
    let base = env_base();
    let (iso, ymd) = day::normalize_date(&env_date()).unwrap();
    let (_browser, cookie, user) = connect_via_browser(&base);
    println!("연결: {} ({}) · {base}", user.user_id, user.user_name);

    let c = Client::new(&base, &cookie).unwrap();
    let mh = c.mh_list(&user.user_id, &ymd).expect("mhList");
    let init = c.init_mh_info(&user.user_id, &ymd).expect("initMHInfo");
    dump(&format!("mhlist-{ymd}.json"), &mh);
    dump(&format!("initmhinfo-{ymd}.json"), &init);

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let d = day::summarize(&mh, &init, &iso, &user.user_id, &today).expect("summarize");
    println!(
        "{iso} · 기준 {}분 · 최대 {}분 · 입력됨 {}분 · 결재 {} · 휴일 {}",
        d.standard_minutes, d.max_minutes, d.total_minutes, d.approved, d.holiday
    );
    for t in &d.tabs {
        println!(
            "  탭 {} ({}) · 카테고리 {} · {}분 · 마감 {} · {}",
            t.ci_name,
            t.ci_key,
            t.categories,
            t.minutes,
            if t.deadline.is_empty() { "-" } else { &t.deadline },
            t.blocked.as_deref().unwrap_or("입력 가능")
        );
    }
    let o = d.categories.iter().filter(|c| c.price_type == "O").count();
    let n = d.categories.iter().filter(|c| c.price_type == "N").count();
    println!("카테고리 {} (대가포함 O {o} · 대가미포함 N {n} · 기타 {})", d.categories.len(), d.categories.len() - o - n);
    for c in d.categories.iter().filter(|c| !c.rows.is_empty()) {
        println!("  입력됨 [{}] {} > {} · {}분 · {}행", c.price_type, c.ci_name, c.task, c.minutes, c.rows.len());
    }
    assert!(!d.tabs.is_empty(), "탭이 하나도 없습니다 — 나의 MH 설정을 확인하세요");
}
