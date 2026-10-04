//! i-WMS 업무량(MH) 자동입력 — `docs/IWMS-ROADMAP.md`.
//!
//! 오늘의 한일의 업무를 i-WMS 의 그날 카테고리에 입력한다. 이 모듈이 i-WMS 쪽 전부다:
//! REST 클라이언트(`client`), 응답 해석과 저장 페이로드(`day`), SSO 세션(`session`),
//! 설정 파일(`settings`), 오늘의 한일 줄의 대가 선택과 입력 이력(`marks`, `today.db` v2). 커맨드는 여기 모아 둔다 — `generate_handler!` 는 커맨드가 정의된 모듈
//! 경로로 불러야 해서 다시 내보내기(`pub use`)로는 등록할 수 없다.
//!
//! 오류 종류(`AppError.kind`): `iwms_session`(연결 없음 · 만료 — 프런트가 다시 연결하고 한 번 더
//! 시도한다), `iwms`(i-WMS 가 거절 · 통신 실패), `invalid`(입력이 틀림).

mod client;
mod day;
mod marks;
mod session;
mod settings;
mod write;

#[cfg(test)]
mod live;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::daylog::DayLog;
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
        CallError::Stale(m) => AppError::new("iwms_stale", m),
        CallError::Invalid(m) => AppError::new("invalid", m),
        CallError::Other(m) => AppError::new("iwms", m),
    }
}

/// 연결된 세션으로 블로킹 호출을 한다. 막히면 쿠키를 한 번 다시 읽어 시도하고(`session::refresher` — 세션
/// 회전), 그래도 만료면 세션을 버린다 — 다음 호출이 다시 연결하게.
async fn with_session<T: Send + 'static>(
    app: &AppHandle,
    state: &IwmsState,
    f: impl FnOnce(Client, Session) -> CallResult<T> + Send + 'static,
) -> Result<T> {
    let sess = state.get().ok_or_else(|| call_err(CallError::Expired))?;
    let refresh = session::refresher(app.clone(), sess.base.clone());
    let out = tauri::async_runtime::spawn_blocking(move || {
        let c = Client::new(&sess.base, &sess.cookie)?.with_refresh(refresh);
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
pub async fn iwms_day(app: AppHandle, state: State<'_, IwmsState>, date: String) -> Result<day::Day> {
    let (iso, ymd) = day::normalize_date(&date).map_err(|m| AppError::new("invalid", m))?;
    with_session(&app, &state, move |c, s| {
        let mh = c.mh_list(&s.user.user_id, &ymd)?;
        let init = c.init_mh_info(&s.user.user_id, &ymd)?;
        day::summarize(&mh, &init, &iso, &s.user.user_id, &today()).map_err(CallError::Other)
    })
    .await
}

/// 그날 지금 Vault 의 줄에 붙은 대가 선택(`O` · `N`). 고르지 않은 줄은 없다.
#[tauri::command]
pub fn iwms_marks(log: State<'_, DayLog>, vault: String, day: String) -> Result<Vec<marks::Mark>> {
    log.with(|conn| marks::marks(conn, &vault, &day))
}

/// 한 줄의 대가 구분을 고른다. `None` = 입력 안 함.
#[tauri::command]
pub fn set_iwms_mark(log: State<'_, DayLog>, entry_id: i64, price: Option<String>) -> Result<()> {
    log.with(|conn| marks::set_mark(conn, entry_id, price.as_deref()))
}

/// 그날 i-WMS 에 넣은 행(되돌린 것 포함). 줄의 배지와 검토 화면이 쓴다.
#[tauri::command]
pub fn iwms_pushes(log: State<'_, DayLog>, day: String) -> Result<Vec<marks::Push>> {
    log.with(|conn| marks::pushes(conn, &day))
}

/// 최근에 확정한 행 — 정제 프롬프트의 예시(학습).
#[tauri::command]
pub fn iwms_recent_pushes(log: State<'_, DayLog>, limit: i64) -> Result<Vec<marks::Push>> {
    log.with(|conn| marks::recent_pushes(conn, limit.clamp(1, 100)))
}

// -- 쓰기 ------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOut {
    /// 확정할 때 돌려줄 일회용 토큰(10분).
    pub token: String,
    pub preview: day::Preview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOut {
    pub commit_id: String,
    pub preview: day::Preview,
    /// 저장 뒤 다시 조회해 기대한 행과 같았다.
    pub verified: bool,
    pub mismatches: Vec<String>,
    pub pushes: Vec<marks::Push>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOut {
    pub preview: day::Preview,
    pub verified: bool,
    pub mismatches: Vec<String>,
}

/// 저장 전 미리보기 — i-WMS 에 쓰지 않는다. 카테고리별 전/후, 저장 뒤 합계, 경고와 토큰.
#[tauri::command]
pub async fn iwms_preview(app: AppHandle, state: State<'_, IwmsState>, date: String, rows: Vec<day::NewRow>) -> Result<PreviewOut> {
    let (iso, ymd) = day::normalize_date(&date).map_err(|m| AppError::new("invalid", m))?;
    let today = today();
    let sent = rows.clone();
    let date = iso.clone();
    let (preview, st, user_id) = with_session(&app, &state, move |c, s| {
        let (p, st) = write::preview(&c, &s.user.user_id, &ymd, &iso, &today, &sent)?;
        Ok((p, st, s.user.user_id))
    })
    .await?;
    let token = state.put_preview(session::PreviewRecord::new(user_id, date, rows, st));
    Ok(PreviewOut { token, preview })
}

/// 최종 확정 — 미리보기 뒤 i-WMS 쪽이 그대로일 때만 저장하고, 다시 조회해 대조하고, 입력 이력을 남긴다.
#[tauri::command]
pub async fn iwms_commit(app: AppHandle, state: State<'_, IwmsState>, log: State<'_, DayLog>, token: String) -> Result<CommitOut> {
    let rec = state
        .take_preview(&token)
        .ok_or_else(|| AppError::new("iwms_stale", "미리보기가 지났거나 이미 썼습니다 — 다시 미리보세요"))?;
    if state.get().map(|s| s.user.user_id) != Some(rec.user_id.clone()) {
        return Err(AppError::new("iwms_stale", "미리보기 뒤에 i-WMS 연결이 바뀌었습니다 — 다시 미리보세요"));
    }
    let (iso, ymd) = day::normalize_date(&rec.date).map_err(|m| AppError::new("invalid", m))?;
    let rows = rec.rows.clone();
    let expected = rec.state.clone();
    let (today, day_iso) = (today(), iso.clone());
    let outcome =
        with_session(&app, &state, move |c, s| write::commit(&c, &s.user.user_id, &ymd, &day_iso, &today, &rows, &expected))
            .await?;

    // 이력: 줄마다 한 행. 카테고리 이름 · 태스크 · 대가 구분은 미리보기(=조회한 i-WMS 값)에서 온다.
    let commit_id = format!("{}-{}", iso.replace('-', ""), chrono::Local::now().format("%H%M%S%3f"));
    let diffs = &outcome.plan.preview.diffs;
    let new_pushes: Vec<marks::NewPush> = rec
        .rows
        .iter()
        .map(|r| {
            let d = diffs.iter().find(|d| d.ci_key == r.ci_key && d.wbsid == r.wbsid);
            marks::NewPush {
                entry_id: r.entry_id,
                title: r.title.clone(),
                ci_key: r.ci_key.clone(),
                ci_name: d.map(|d| d.ci_name.clone()).unwrap_or_default(),
                wbsid: r.wbsid.clone(),
                task: d.map(|d| d.task.clone()).unwrap_or_default(),
                price: d.map(|d| d.price_type.clone()).filter(|p| p == "O" || p == "N").unwrap_or_else(|| r.price.clone()),
                minutes: r.minutes,
                note: r.note.trim().to_string(),
            }
        })
        .collect();
    let before = &outcome.plan.before;
    let before_json = |p: &marks::NewPush| {
        before
            .iter()
            .find(|(c, w, _)| *c == p.ci_key && *w == p.wbsid)
            .map(|(_, _, rows)| serde_json::Value::Array(rows.clone()).to_string())
            .unwrap_or_else(|| "[]".into())
    };
    let pushes = log
        .with(|conn| marks::record(conn, &commit_id, &iso, &new_pushes, &before_json))
        .map_err(|e| AppError::new("db", format!("i-WMS 에는 저장했지만 입력 이력을 남기지 못했습니다: {}", e.message)))?;

    Ok(CommitOut {
        commit_id,
        preview: outcome.plan.preview,
        verified: outcome.verified,
        mismatches: outcome.mismatches,
        pushes,
    })
}

/// 되돌리기 — 그 확정이 넣은 행만 i-WMS 에서 지운다. 대조가 맞을 때만 이력에 되돌림을 적는다.
#[tauri::command]
pub async fn iwms_undo(app: AppHandle, state: State<'_, IwmsState>, log: State<'_, DayLog>, commit_id: String) -> Result<UndoOut> {
    let (rows, _) = log.with(|conn| marks::commit_rows(conn, &commit_id))?;
    let first = rows.first().ok_or_else(|| AppError::new("not_found", "그 입력 이력이 없습니다"))?;
    if rows.iter().any(|p| p.undone_at.is_some()) {
        return Err(AppError::new("invalid", "이미 되돌린 입력입니다"));
    }
    let (iso, ymd) = day::normalize_date(&first.day).map_err(|m| AppError::new("invalid", m))?;
    let removals: Vec<day::Removal> = rows
        .iter()
        .map(|p| day::Removal { ci_key: p.ci_key.clone(), wbsid: p.wbsid.clone(), minutes: p.minutes, note: p.note.clone() })
        .collect();
    let today = today();
    let outcome =
        with_session(&app, &state, move |c, s| write::undo(&c, &s.user.user_id, &ymd, &iso, &today, &removals)).await?;
    if outcome.verified {
        log.with(|conn| marks::mark_undone(conn, &commit_id))?;
    }
    Ok(UndoOut { preview: outcome.plan.preview, verified: outcome.verified, mismatches: outcome.mismatches })
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
