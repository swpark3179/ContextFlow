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
        let found = cdp_session(&mut cdp, &host);
        if let Some(header) = found.filter(|h| rejected.as_deref() != Some(h.as_str())) {
            match Client::new(base, &header).and_then(|c| c.profile()) {
                Ok(user) => {
                    // 앱의 `session::settle` 과 같다 — SSO 화면이 뜬 직후의 세션 회전을 기다린다.
                    let (mut header, mut user, mut stable) = (header, user, Instant::now());
                    let until = Instant::now() + Duration::from_secs(10);
                    while Instant::now() < until && stable.elapsed() < Duration::from_secs(2) {
                        std::thread::sleep(Duration::from_millis(400));
                        if let Some(now) = cdp_session(&mut cdp, &host).filter(|v| *v != header) {
                            if let Ok(u) = Client::new(base, &now).and_then(|c| c.profile()) {
                                println!("  세션이 바뀌어 새 값을 씁니다");
                                (header, user, stable) = (now, u, Instant::now());
                            }
                        }
                    }
                    // i-WMS 화면을 닫는다 — 열려 있으면 그 화면이 뒤에서 세션을 또 바꾼다(2026-10-04 실측:
                    // 확정 직후 회전). 앱도 연결이 끝나면 세션 창을 닫는다.
                    close_iwms_pages(&mut cdp, &host);
                    return (browser, header, user);
                }
                Err(CallError::Expired) => rejected = Some(header),
                Err(e) => panic!("프로필 확인 실패: {e}"),
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

fn close_iwms_pages(cdp: &mut Cdp, host: &str) {
    let Ok(targets) = cdp.call("Target.getTargets", json!({})) else { return };
    let ids: Vec<String> = targets["targetInfos"]
        .as_array()
        .map(|ts| {
            ts.iter()
                .filter(|t| t["type"] == "page" && t["url"].as_str().is_some_and(|u| u.contains(host)))
                .filter_map(|t| t["targetId"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    // 브라우저에 탭이 하나도 안 남으면 닫히므로 빈 탭을 먼저 하나 둔다.
    let _ = cdp.call("Target.createTarget", json!({ "url": "about:blank" }));
    for id in ids {
        let _ = cdp.call("Target.closeTarget", json!({ "targetId": id }));
    }
}

fn cdp_session(cdp: &mut Cdp, host: &str) -> Option<String> {
    let cookies = cdp.call("Storage.getCookies", json!({})).ok()?;
    cookies
        .get("cookies")?
        .as_array()?
        .iter()
        .find(|c| {
            c.get("name").and_then(Value::as_str) == Some("SESSION")
                && host.ends_with(c.get("domain").and_then(Value::as_str).unwrap_or("-").trim_start_matches('.'))
        })
        .and_then(|c| c.get("value").and_then(Value::as_str))
        .map(|v| format!("SESSION={v}"))
}

/// 테스트 브라우저에서 쿠키를 다시 읽는 길 — 앱의 `session::refresher` 와 같은 일을 CDP 로.
pub(super) fn refresher(browser: &TestBrowser, base: &str) -> super::client::Refresh {
    let ws = browser.ws_url.clone();
    let host = tauri::Url::parse(base).unwrap().host_str().unwrap_or_default().to_string();
    std::sync::Arc::new(move |old: &str| {
        let mut cdp = Cdp::connect(&ws).ok()?;
        let now = cdp_session(&mut cdp, &host).filter(|v| v != old)?;
        println!("  쿠키를 다시 읽었습니다(세션 회전)");
        Some(now)
    })
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
    let (browser, cookie, user) = connect_via_browser(&base);
    println!("연결: {} ({}) · {base}", user.user_id, user.user_name);

    let c = Client::new(&base, &cookie).unwrap().with_refresh(refresher(&browser, &base));
    let mh = c.mh_list(&user.user_id, &ymd).expect("mhList");
    let init = c.init_mh_info(&user.user_id, &ymd).expect("initMHInfo");
    dump(&format!("mhlist-{ymd}.json"), &mh);
    dump(&format!("initmhinfo-{ymd}.json"), &init);

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let d = day::summarize(&mh, &init, &iso, &user.user_id, &today).expect("summarize");
    // 화면이 받는 모양 그대로 — `src/lib/iwms/live.test.ts` 가 이것으로 실제 프롬프트를 만든다.
    dump(&format!("day-{ymd}.json"), &serde_json::to_value(&d).unwrap());
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

/// 정제 프롬프트를 앱과 **같은 실행 경로**(`run::execute_blocking`)로 실제 연결에 보낸다.
///
/// `IWMS_PROMPT_DIR` 의 `system.txt` · `prompt.txt` 를 읽어 기능별 연결 `iwms.refine`(없으면 기본 연결)로
/// 돌리고 답을 `response.txt` 에 쓴다. 프롬프트는 `src/lib/iwms/live.test.ts` 가 만든다:
///
/// ```powershell
/// $env:IWMS_LIVE_DIR = "<폴더>"; node_modules/.bin/vitest run src/lib/iwms/live.test.ts   # 프롬프트 만들기
/// $env:IWMS_PROMPT_DIR = "<폴더>"; cargo test … live_refine_run -- --ignored --nocapture  # AI 에 묻기
/// node_modules/.bin/vitest run src/lib/iwms/live.test.ts                                  # 답 해석
/// ```
#[test]
#[ignore = "AI 연결이 필요하다"]
fn live_refine_run() {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let dir = PathBuf::from(std::env::var("IWMS_PROMPT_DIR").expect("IWMS_PROMPT_DIR"));
    let system = std::fs::read_to_string(dir.join("system.txt")).expect("system.txt");
    let prompt = std::fs::read_to_string(dir.join("prompt.txt")).expect("prompt.txt");
    let s = crate::ai_settings::load(&crate::app_home().unwrap());
    let choice = s.routes.get("iwms.refine").cloned().unwrap_or_else(|| s.active.clone());
    assert!(!choice.agent_id.is_empty(), "AI 연결이 없습니다 — 설정 → AI 연결");
    println!("연결: {} · 모델 {}", choice.agent_id, choice.model);

    let args = crate::run::RunArgs {
        agent_id: choice.agent_id.clone(),
        prompt,
        cwd: crate::resolve_cwd("").unwrap(),
        system_prompt: system,
        model: Some(choice.model.clone()).filter(|m| !m.is_empty()),
        session_id: None,
        max_tokens: Some(16_384),
        temperature: Some(0.2),
    };
    let started = Instant::now();
    let mut text = String::new();
    let mut truncated = false;
    let status = crate::run::execute_blocking(&args, &Arc::new(AtomicBool::new(false)), &mut |_| {}, &mut |ev| {
        match ev {
            crate::run::RunEvent::TextDelta { delta } => text.push_str(&delta),
            crate::run::RunEvent::Truncated => truncated = true,
            crate::run::RunEvent::Error { message } => println!("오류: {message}"),
            crate::run::RunEvent::Usage { input_tokens, output_tokens } => {
                println!("토큰: 입력 {input_tokens:?} · 출력 {output_tokens:?}")
            }
            _ => {}
        }
    });
    println!("상태 {status} · {:.1}초 · {}자 · 잘림 {truncated}", started.elapsed().as_secs_f32(), text.chars().count());
    std::fs::write(dir.join("response.txt"), &text).unwrap();
    assert!(!text.trim().is_empty(), "응답이 비었습니다");
}

/// 실서비스 쓰기 · 원복 — 지정한 카테고리에 1분짜리 행을 **덧붙이고**, 재조회로 확인한 뒤, 앱의 되돌리기와
/// 같은 길(`write::undo`)로 지우고, 그 카테고리가 처음과 같은지 확인한다.
///
/// 운영 데이터를 잠시 바꾸므로 확인 문구가 정확해야만 쓴다(`mcp-wms` 의 `live_test --write` 와 같은 규칙):
///
/// ```powershell
/// $env:IWMS_DATE = "2026-10-02"; $env:IWMS_CI_KEY = "MSPCMDBCHG-…"; $env:IWMS_WBSID = "nb…"
/// $env:IWMS_WRITE_CONFIRM = "2026-10-02/MSPCMDBCHG-…/nb…"
/// cargo test --manifest-path src-tauri/Cargo.toml live_write_restore -- --ignored --nocapture
/// ```
///
/// 쓰기 전에 그 카테고리의 원형 행을 `IWMS_DUMP`(있으면)에 남긴다 — 중간에 끊기면 그것으로 되살린다.
#[test]
#[ignore = "사내망 · i-WMS 운영 데이터를 잠시 바꾼다"]
fn live_write_restore() {
    use super::day::{NewRow, Removal};
    use super::write;

    let base = env_base();
    let (iso, ymd) = day::normalize_date(&env_date()).unwrap();
    let ci = std::env::var("IWMS_CI_KEY").expect("IWMS_CI_KEY");
    let wbs = std::env::var("IWMS_WBSID").expect("IWMS_WBSID");
    let phrase = format!("{iso}/{ci}/{wbs}");
    assert_eq!(std::env::var("IWMS_WRITE_CONFIRM").unwrap_or_default(), phrase, "확인 문구가 다릅니다 — 아무것도 쓰지 않았습니다");

    let (browser, cookie, user) = connect_via_browser(&base);
    let c = Client::new(&base, &cookie).unwrap().with_refresh(refresher(&browser, &base));
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let snapshot = |label: &str| {
        let mh = c.mh_list(&user.user_id, &ymd).unwrap();
        let init = c.init_mh_info(&user.user_id, &ymd).unwrap();
        let d = day::summarize(&mh, &init, &iso, &user.user_id, &today).unwrap();
        let cat = d.categories.iter().find(|x| x.ci_key == ci && x.wbsid == wbs).cloned().expect("그날 그 카테고리가 없습니다");
        println!("[{label}] {} › {} · {}분 · {}행 · 하루 {}분", cat.ci_name, cat.task, cat.minutes, cat.rows.len(), d.total_minutes);
        for r in &cat.rows {
            println!("    {}. {}분 · {}", r.row_seq, r.minutes, r.note.replace('\n', " / "));
        }
        (mh, d, cat)
    };

    let (mh, before_day, before) = snapshot("처음");
    assert!(before.blocked.is_none(), "쓸 수 없는 카테고리입니다: {:?}", before.blocked);
    let raw: Vec<Value> = day::tabs(&mh).unwrap().iter()
        .filter(|t| day::tab_key(t) == ci)
        .flat_map(|t| day::tab_rows(t).iter().filter(|r| super::client::s(r, "wbsid") == wbs).cloned())
        .collect();
    dump(&format!("before-{ymd}-{wbs}.json"), &Value::Array(raw));

    let note = "ContextFlow 왕복 검증".to_string();
    let rows = vec![NewRow {
        entry_id: None,
        title: "live_write_restore".into(),
        ci_key: ci.clone(),
        wbsid: wbs.clone(),
        minutes: 1,
        note: note.clone(),
        req_date: String::new(),
        price: before.price_type.clone(),
    }];
    let (preview, state) = write::preview(&c, &user.user_id, &ymd, &iso, &today, &rows).expect("미리보기");
    println!("미리보기: 하루 {}분 → {}분 · {:?}", preview.before_minutes, preview.after_minutes, preview.warnings);

    let saved = write::commit(&c, &user.user_id, &ymd, &iso, &today, &rows, &state).expect("확정");
    println!("확정: 검증 {} {:?}", saved.verified, saved.mismatches);
    let (_, mid_day, mid) = snapshot("넣은 뒤");

    let undone = write::undo(&c, &user.user_id, &ymd, &iso, &today, &[Removal { ci_key: ci.clone(), wbsid: wbs.clone(), minutes: 1, note }])
        .expect("되돌리기");
    println!("되돌리기: 검증 {} {:?}", undone.verified, undone.mismatches);
    let (_, after_day, after) = snapshot("되돌린 뒤");

    assert!(saved.verified, "넣은 뒤 대조가 어긋났습니다");
    assert_eq!(mid.rows.len(), before.rows.len() + 1);
    assert_eq!(mid_day.total_minutes, before_day.total_minutes + 1);
    assert!(undone.verified, "되돌린 뒤 대조가 어긋났습니다");
    let key = |r: &day::Row| (r.minutes, r.note.clone(), r.req_date.clone(), r.except_time, r.except_day);
    assert_eq!(after.rows.iter().map(key).collect::<Vec<_>>(), before.rows.iter().map(key).collect::<Vec<_>>(), "처음과 같아야 합니다");
    assert_eq!(after_day.total_minutes, before_day.total_minutes);
}

/// 정리 — `live_write_restore` 가 중간에 끊겨 남은 `ContextFlow 왕복 검증` 행만 지운다(같은 확인 문구).
/// 저장 응답을 어떻게 판정하든 다시 조회해 그 행이 없어졌는지로 끝을 본다.
#[test]
#[ignore = "사내망 · i-WMS 운영 데이터를 바꾼다"]
fn live_cleanup() {
    use super::day::Removal;

    let base = env_base();
    let (iso, ymd) = day::normalize_date(&env_date()).unwrap();
    let ci = std::env::var("IWMS_CI_KEY").expect("IWMS_CI_KEY");
    let wbs = std::env::var("IWMS_WBSID").expect("IWMS_WBSID");
    assert_eq!(std::env::var("IWMS_WRITE_CONFIRM").unwrap_or_default(), format!("{iso}/{ci}/{wbs}"), "확인 문구가 다릅니다");
    let note = "ContextFlow 왕복 검증";

    let (browser, cookie, user) = connect_via_browser(&base);
    let c = Client::new(&base, &cookie).unwrap().with_refresh(refresher(&browser, &base));
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let leftovers = |c: &Client| -> Vec<day::Row> {
        let mh = c.mh_list(&user.user_id, &ymd).unwrap();
        let init = c.init_mh_info(&user.user_id, &ymd).unwrap();
        let d = day::summarize(&mh, &init, &iso, &user.user_id, &today).unwrap();
        d.categories.iter().filter(|x| x.ci_key == ci && x.wbsid == wbs).flat_map(|x| x.rows.clone()).filter(|r| r.note == note).collect()
    };
    let left = leftovers(&c);
    println!("남은 검증 행 {}개", left.len());
    if left.is_empty() {
        return;
    }
    let mh = c.mh_list(&user.user_id, &ymd).unwrap();
    let init = c.init_mh_info(&user.user_id, &ymd).unwrap();
    let removals: Vec<Removal> = left.iter().map(|r| Removal { ci_key: ci.clone(), wbsid: wbs.clone(), minutes: r.minutes, note: note.into() }).collect();
    let plan = day::plan_remove(&mh, &init, &removals, &iso, &today).expect("계획");
    let res = c.save(&day::payload(&plan, &init, &user.user_id, &ymd));
    println!("저장 응답 판정: {:?}", res.as_ref().map(|_| "ok").map_err(|e| e.to_string()));
    assert!(leftovers(&c).is_empty(), "검증 행이 아직 남아 있습니다");
    println!("정리 끝 — 검증 행이 없습니다");
}

/// 진단 — 같은 세션으로 연달아 부를 때 403(LOGIN-108)이 섞이는지, 그 호스트의 다른 쿠키를 함께 보내면
/// 사라지는지 본다. 쿠키는 **이름만** 찍는다.
#[test]
#[ignore = "사내망 · i-WMS 접속이 필요하다"]
fn live_session_probe() {
    let base = env_base();
    let (browser, session, _user) = connect_via_browser(&base);
    let host = tauri::Url::parse(&base).unwrap().host_str().unwrap_or_default().to_string();
    let mut cdp = Cdp::connect(&browser.ws_url).unwrap();
    let cookies = cdp.call("Storage.getCookies", json!({})).unwrap();
    let mine: Vec<(String, String)> = cookies["cookies"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| host.ends_with(c["domain"].as_str().unwrap_or("-").trim_start_matches('.')))
        .map(|c| (c["name"].as_str().unwrap_or("").to_string(), c["value"].as_str().unwrap_or("").to_string()))
        .collect();
    println!("{host} 쿠키: {:?}", mine.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>());
    let all = mine.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ");

    for (label, cookie) in [("SESSION 만", session.as_str()), ("모든 쿠키", all.as_str())] {
        let c = Client::new(&base, cookie).unwrap();
        let mut fail = 0;
        for _ in 0..20 {
            if c.profile().is_err() {
                fail += 1;
            }
        }
        println!("{label}: 20회 중 실패 {fail}");
    }
}

/// 진단 — 연결한 뒤 SESSION 값이 바뀌는지(세션 회전) 15초 동안 본다. 값은 찍지 않고 짧은 해시만.
#[test]
#[ignore = "사내망 · i-WMS 접속이 필요하다"]
fn live_session_rotation() {
    let base = env_base();
    let (browser, first, _user) = connect_via_browser(&base);
    let host = tauri::Url::parse(&base).unwrap().host_str().unwrap_or_default().to_string();
    let mut cdp = Cdp::connect(&browser.ws_url).unwrap();
    let h = |v: &str| v.bytes().fold(0xcbf29ce484222325u64, |a, b| (a ^ b as u64).wrapping_mul(0x100000001b3)) & 0xffff;
    let started = Instant::now();
    let mut last = first.clone();
    println!("0.0s 처음 {:04x}", h(&first));
    let old = Client::new(&base, &first).unwrap();
    while started.elapsed() < Duration::from_secs(15) {
        let now = cdp.call("Storage.getCookies", json!({})).unwrap()["cookies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "SESSION" && host.ends_with(c["domain"].as_str().unwrap_or("-").trim_start_matches('.')))
            .map(|c| format!("SESSION={}", c["value"].as_str().unwrap_or("")))
            .unwrap_or_default();
        if now != last {
            println!("{:.1}s 바뀜 {:04x} → {:04x}", started.elapsed().as_secs_f32(), h(&last), h(&now));
            last = now;
        }
        let ok = old.profile().is_ok();
        if !ok {
            println!("{:.1}s 처음 쿠키로 profile 실패", started.elapsed().as_secs_f32());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
