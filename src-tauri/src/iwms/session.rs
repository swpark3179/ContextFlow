//! i-WMS SSO 세션 — 앱의 WebView2 창으로 i-WMS 를 열고 `SESSION` 쿠키를 읽는다.
//!
//! 사내 통합인증이라 창이 뜨면 대개 저절로 로그인된다. 쿠키는 **메모리에만** 두고 로그 · 응답 ·
//! 파일에 남기지 않는다. 이 창은 `capabilities/default.json`(창 `main` 만)에 들지 않으므로
//! 원격 페이지가 앱의 커맨드를 부를 수 없다.
//!
//! 방식은 바탕화면 `auto-wms/app/src-tauri/src/lib.rs` 의 `session_connect` 를 옮긴 것이다(같은 Tauri 버전).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::client::{CallError, Client, Refresh, User};
use super::day::NewRow;

pub const WINDOW: &str = "iwms-session";
const WAIT: Duration = Duration::from_secs(90);
const POLL: Duration = Duration::from_millis(700);
/// 쿠키가 이만큼 그대로면 회전이 끝난 것으로 본다.
const SETTLE: Duration = Duration::from_secs(2);
const SETTLE_MAX: Duration = Duration::from_secs(10);

/// 연결된 세션 하나. `base` 는 연결할 때의 주소다 — 설정에서 주소를 바꾸면 다시 연결해야 한다.
#[derive(Clone)]
pub struct Session {
    pub base: String,
    pub cookie: String,
    pub user: User,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub user: Option<User>,
    pub base: String,
    pub message: String,
}

/// 미리보기 하나 — 확정할 때 이것으로 다시 조회해 견주고 쓴다. 메모리에만 있고 10분 뒤 · 한 번 쓰면 사라진다.
pub struct PreviewRecord {
    pub user_id: String,
    /// `YYYY-MM-DD`
    pub date: String,
    pub rows: Vec<NewRow>,
    /// 미리보기 때 대상 카테고리의 상태(`day::state_of`).
    pub state: String,
    at: Instant,
}

impl PreviewRecord {
    pub fn new(user_id: String, date: String, rows: Vec<NewRow>, state: String) -> Self {
        PreviewRecord { user_id, date, rows, state, at: Instant::now() }
    }
}

const PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct IwmsState {
    session: Mutex<Option<Session>>,
    previews: Mutex<HashMap<String, PreviewRecord>>,
    counter: AtomicU64,
}

impl IwmsState {
    fn lock(&self) -> MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 미리보기를 맡기고 토큰을 받는다. 지난 것은 이때 치운다.
    pub fn put_preview(&self, rec: PreviewRecord) -> String {
        let mut map = self.previews.lock().unwrap_or_else(PoisonError::into_inner);
        map.retain(|_, r| r.at.elapsed() < PREVIEW_TTL);
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let token = format!("p{nanos:x}-{n:x}");
        map.insert(token.clone(), rec);
        token
    }

    /// 토큰의 미리보기를 꺼낸다(한 번만). 지났으면 `None`.
    pub fn take_preview(&self, token: &str) -> Option<PreviewRecord> {
        let mut map = self.previews.lock().unwrap_or_else(PoisonError::into_inner);
        map.remove(token).filter(|r| r.at.elapsed() < PREVIEW_TTL)
    }

    pub fn get(&self) -> Option<Session> {
        self.lock().clone()
    }

    pub fn set(&self, s: Option<Session>) {
        *self.lock() = s;
    }

    pub fn status(&self) -> Status {
        match self.get() {
            Some(s) => Status { connected: true, user: Some(s.user), base: s.base, message: "연결됨".into() },
            None => Status { connected: false, user: None, base: String::new(), message: "연결되지 않음".into() },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_token_is_used_once() {
        let st = IwmsState::default();
        let a = st.put_preview(PreviewRecord::new("u".into(), "2026-10-02".into(), vec![], "s".into()));
        let b = st.put_preview(PreviewRecord::new("u".into(), "2026-10-02".into(), vec![], "t".into()));
        assert_ne!(a, b);
        assert_eq!(st.take_preview(&a).map(|r| r.state), Some("s".into()));
        assert!(st.take_preview(&a).is_none(), "두 번 쓸 수 없다");
        assert!(st.take_preview("nope").is_none());
    }
}

fn not_connected(base: &str, message: impl Into<String>) -> Status {
    Status { connected: false, user: None, base: base.to_string(), message: message.into() }
}

/// 세션 창을 띄운다. 이미 있으면 앞으로 가져온다.
fn open_window(app: &AppHandle, base: &str) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let url = tauri::Url::parse(base).map_err(|e| format!("i-WMS 주소가 올바르지 않습니다({base}): {e}"))?;
    WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .title("i-WMS 연결 — 로그인이 끝나면 저절로 닫힙니다")
        .inner_size(1100.0, 820.0)
        .build()
        .map_err(|e| format!("i-WMS 창을 열지 못했습니다: {e}"))?;
    Ok(())
}

pub fn close_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.close();
    }
}

/// 블로킹 풀에서 잔다 — 이 앱은 tokio 를 직접 쓰지 않는다.
async fn pause(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// 앱의 WebView2 쿠키 저장소에서 SESSION 을 읽는다. 앱의 창들은 한 저장소를 함께 쓰므로 세션 창이 닫혔어도
/// 메인 창으로 읽힌다. **메인 스레드에서 부르면 교착한다**(WebView2) — async 커맨드나 블로킹 풀에서만 부른다.
fn read_session(app: &AppHandle, url: &tauri::Url) -> Option<String> {
    [WINDOW, "main"].iter().filter_map(|label| app.get_webview_window(label)).find_map(|w| {
        w.cookies_for_url(url.clone())
            .ok()?
            .iter()
            .find(|c| c.name() == "SESSION")
            .map(|c| format!("SESSION={}", c.value()))
    })
}

/// 만료로 막힌 호출이 쿠키를 다시 읽는 길(`client::Refresh`). 새 값이면 상태에도 적는다.
pub fn refresher(app: AppHandle, base: String) -> Refresh {
    Arc::new(move |old: &str| {
        let url = tauri::Url::parse(&base).ok()?;
        let now = read_session(&app, &url).filter(|v| v != old)?;
        let state = app.state::<IwmsState>();
        if let Some(mut s) = state.get().filter(|s| s.base == base) {
            s.cookie = now.clone();
            state.set(Some(s));
        }
        Some(now)
    })
}

/// 세션 회전을 기다린다 — 값이 `SETTLE` 동안 그대로일 때까지(최대 `SETTLE_MAX`) 다시 읽는다. i-WMS 는 SSO
/// 화면이 뜬 직후 세션 id 를 한 번 바꾸고 옛 값을 곧바로 막는다(2026-10-04 실측: 0.6초 뒤).
async fn settle(app: &AppHandle, url: &tauri::Url, base: &str, mut header: String, mut user: User) -> (String, User) {
    let until = Instant::now() + SETTLE_MAX;
    let mut stable = Instant::now();
    while Instant::now() < until && stable.elapsed() < SETTLE {
        pause(Duration::from_millis(400)).await;
        let Some(now) = read_session(app, url).filter(|v| *v != header) else { continue };
        if let Ok(u) = verify(base.to_string(), now.clone()).await {
            header = now;
            user = u;
            stable = Instant::now();
        }
    }
    (header, user)
}

/// 프로필을 찍어 쿠키가 살아 있는지 본다. 블로킹 HTTP 라 풀에서 돈다.
async fn verify(base: String, cookie: String) -> Result<User, CallError> {
    tauri::async_runtime::spawn_blocking(move || Client::new(&base, &cookie)?.profile())
        .await
        .unwrap_or_else(|e| Err(CallError::Other(format!("확인이 중단되었습니다: {e}"))))
}

/// 연결한다. 이미 연결돼 있고 쿠키가 살아 있으면 창을 띄우지 않는다.
///
/// 창을 띄운 뒤 0.7초마다 쿠키를 읽어 프로필로 확인하고, 되면 창을 닫는다. 90초 안에 안 되면
/// **창을 열어 둔 채** 사유를 돌려준다 — 로그인 화면이나 오류 페이지를 사람이 봐야 한다.
///
/// 쿠키 읽기(`cookies_for_url`)는 Windows 에서 동기 커맨드로 부르면 WebView2 와 교착하므로
/// 반드시 async 커맨드에서 부른다(auto-wms 실측).
pub async fn connect(app: &AppHandle, state: &IwmsState, base: &str) -> Status {
    if let Some(s) = state.get().filter(|s| s.base == base) {
        if verify(s.base.clone(), s.cookie.clone()).await.is_ok() {
            return state.status();
        }
        state.set(None);
    }
    if let Err(m) = open_window(app, base) {
        return not_connected(base, m);
    }
    let url = match tauri::Url::parse(base) {
        Ok(u) => u,
        Err(e) => return not_connected(base, e.to_string()),
    };

    let deadline = Instant::now() + WAIT;
    // 만료로 거절된 쿠키는 다시 확인하지 않는다 — 창이 새 쿠키를 받을 때까지 기다린다.
    let mut rejected: Option<String> = None;
    let mut last = "i-WMS 화면이 열리기를 기다리는 중입니다".to_string();
    loop {
        let Some(win) = app.get_webview_window(WINDOW) else {
            return not_connected(base, "i-WMS 창이 닫혔습니다. [연결] 을 다시 누르세요.");
        };
        match win.cookies_for_url(url.clone()) {
            Ok(cookies) => match cookies.iter().find(|c| c.name() == "SESSION") {
                Some(c) => {
                    let header = format!("SESSION={}", c.value());
                    if rejected.as_deref() != Some(header.as_str()) {
                        match verify(base.to_string(), header.clone()).await {
                            Ok(user) => {
                                let (cookie, user) = settle(app, &url, base, header, user).await;
                                state.set(Some(Session { base: base.to_string(), cookie, user }));
                                close_window(app);
                                return state.status();
                            }
                            Err(CallError::Expired) => {
                                rejected = Some(header);
                                last = "로그인이 아직 끝나지 않았습니다".into();
                            }
                            Err(e) => last = format!("프로필 확인 실패: {e}"),
                        }
                    }
                }
                None => last = "SESSION 쿠키가 아직 없습니다 — i-WMS 화면이 다 열렸는지 확인하세요".into(),
            },
            Err(e) => last = format!("쿠키를 읽지 못했습니다: {e}"),
        }
        if Instant::now() >= deadline {
            return not_connected(
                base,
                format!("{last} ({}초 기다렸습니다). 열려 있는 i-WMS 창에서 로그인 상태를 확인하세요.", WAIT.as_secs()),
            );
        }
        pause(POLL).await;
    }
}
