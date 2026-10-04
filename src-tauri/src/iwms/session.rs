//! i-WMS SSO 세션 — 앱의 WebView2 창으로 i-WMS 를 열고 `SESSION` 쿠키를 읽는다.
//!
//! 사내 통합인증이라 창이 뜨면 대개 저절로 로그인된다. 쿠키는 **메모리에만** 두고 로그 · 응답 ·
//! 파일에 남기지 않는다. 이 창은 `capabilities/default.json`(창 `main` 만)에 들지 않으므로
//! 원격 페이지가 앱의 커맨드를 부를 수 없다.
//!
//! 방식은 바탕화면 `auto-wms/app/src-tauri/src/lib.rs` 의 `session_connect` 를 옮긴 것이다(같은 Tauri 버전).

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::client::{CallError, Client, User};

pub const WINDOW: &str = "iwms-session";
const WAIT: Duration = Duration::from_secs(90);
const POLL: Duration = Duration::from_millis(700);

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

#[derive(Default)]
pub struct IwmsState {
    session: Mutex<Option<Session>>,
}

impl IwmsState {
    fn lock(&self) -> MutexGuard<'_, Option<Session>> {
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
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
                                state.set(Some(Session { base: base.to_string(), cookie: header, user }));
                                close_window(app);
                                return state.status();
                            }
                            Err(CallError::Expired) => {
                                rejected = Some(header);
                                last = "로그인이 아직 끝나지 않았습니다".into();
                            }
                            Err(CallError::Other(m)) => last = format!("프로필 확인 실패: {m}"),
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
