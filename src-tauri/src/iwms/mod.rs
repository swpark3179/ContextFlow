//! i-WMS 업무량(MH) 자동입력 — `docs/IWMS-ROADMAP.md`.
//!
//! 오늘의 한일의 업무를 i-WMS 의 그날 카테고리에 입력한다. 이 모듈이 i-WMS 쪽 전부다:
//! REST 클라이언트(`client`), 응답 해석과 저장 페이로드(`day`), SSO 세션(`session`),
//! 설정 파일(`settings`). 커맨드는 여기 모아 둔다 — `generate_handler!` 는 커맨드가 정의된 모듈
//! 경로로 불러야 해서 다시 내보내기(`pub use`)로는 등록할 수 없다.
//!
//! 오류 종류(`AppError.kind`): `iwms_session`(연결 없음 · 만료 — 프런트가 다시 연결하고 한 번 더
//! 시도한다), `iwms`(i-WMS 가 거절 · 통신 실패), `invalid`(입력이 틀림).

mod client;
mod day;
mod session;
mod settings;

#[cfg(test)]
mod live;

use tauri::{AppHandle, State};

use crate::error::{AppError, Result};
use client::{CallError, CallResult, Client};
pub use session::IwmsState;
use session::{Session, Status};
use settings::IwmsSettings;

fn home() -> Result<std::path::PathBuf> {
    crate::app_home().map_err(AppError::io)
}

/// 이 PC 의 오늘 `YYYY-MM-DD` — 마감 판정에 쓴다.
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn call_err(e: CallError) -> AppError {
    match e {
        CallError::Expired => AppError::new("iwms_session", "i-WMS 세션이 없거나 만료되었습니다. 다시 연결하세요."),
        CallError::Other(m) => AppError::new("iwms", m),
    }
}

/// 연결된 세션으로 블로킹 호출을 한다. 만료면 세션을 버린다 — 다음 호출이 다시 연결하게.
async fn with_session<T: Send + 'static>(
    state: &IwmsState,
    f: impl FnOnce(Client, Session) -> CallResult<T> + Send + 'static,
) -> Result<T> {
    let sess = state.get().ok_or_else(|| call_err(CallError::Expired))?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        let c = Client::new(&sess.base, &sess.cookie)?;
        f(c, sess)
    })
    .await
    .map_err(|e| AppError::new("iwms", format!("i-WMS 호출이 중단되었습니다: {e}")))?;
    if matches!(out, Err(CallError::Expired)) {
        state.set(None);
    }
    out.map_err(call_err)
}

// ---------------------------------------------------------------------------
// 커맨드
// ---------------------------------------------------------------------------

/// SSO 로 연결한다. 이미 연결돼 있으면 창을 띄우지 않는다. 실패도 `Ok(Status)` 로 돌려준다 —
/// 사유는 화면에 그대로 적을 문구다.
#[tauri::command]
pub async fn iwms_connect(app: AppHandle, state: State<'_, IwmsState>) -> Result<Status> {
    let base = settings::load(&home()?).base_url;
    Ok(session::connect(&app, &state, &base).await)
}

#[tauri::command]
pub fn iwms_status(state: State<'_, IwmsState>) -> Status {
    state.status()
}

/// 세션을 버린다(쿠키는 메모리에만 있었다). 열린 세션 창도 닫는다.
#[tauri::command]
pub fn iwms_disconnect(app: AppHandle, state: State<'_, IwmsState>) {
    state.set(None);
    session::close_window(&app);
}

/// 그날의 탭 · 카테고리 · 이미 들어 있는 행 · 기준시간 · 쓸 수 없는 까닭.
#[tauri::command]
pub async fn iwms_day(state: State<'_, IwmsState>, date: String) -> Result<day::Day> {
    let (iso, ymd) = day::normalize_date(&date).map_err(|m| AppError::new("invalid", m))?;
    with_session(&state, move |c, s| {
        let mh = c.mh_list(&s.user.user_id, &ymd)?;
        let init = c.init_mh_info(&s.user.user_id, &ymd)?;
        day::summarize(&mh, &init, &iso, &s.user.user_id, &today()).map_err(CallError::Other)
    })
    .await
}

#[tauri::command]
pub fn get_iwms_settings() -> Result<IwmsSettings> {
    Ok(settings::load(&home()?))
}

/// 통째로 바꾼다. 정리한 값을 돌려준다 — 프런트는 그것으로 사본을 갈아치운다.
#[tauri::command]
pub fn save_iwms_settings(settings: IwmsSettings) -> Result<IwmsSettings> {
    settings::save(&home()?, &settings)
}
