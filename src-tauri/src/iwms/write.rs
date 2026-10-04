//! i-WMS 에 쓰기 — 미리보기 · 확정 · 되돌리기. 블로킹이라 커맨드가 풀에서 부른다.
//!
//! 순서는 `mcp-wms`(`service.py`)와 같다: 미리보기에서 대상 카테고리의 상태를 적어 두고 → 확정 때 다시 조회해
//! 그 상태가 그대로인지 보고 → 저장 → **다시 조회해 기대한 행과 대조**한다. i-WMS 는 거절도 HTTP 200 으로
//! 주고(`client::check_saved`), 저장 응답만으로는 실제로 들어갔는지 알 수 없다.

use std::time::Duration;

use serde_json::Value;

use super::client::{CallError, CallResult, Client};
use super::day::{self, NewRow, Plan, Preview, Removal};

/// 확정 · 되돌리기의 결과. 저장은 됐는데 대조가 어긋나면 `verified = false` 와 그 내용을 돌려준다 —
/// 실패로 던지면 이미 들어간 행의 이력을 남기지 못한다.
pub struct Outcome {
    pub plan: Plan,
    pub verified: bool,
    pub mismatches: Vec<String>,
}

fn read(c: &Client, user_id: &str, ymd: &str) -> CallResult<(Value, Value)> {
    Ok((c.mh_list(user_id, ymd)?, c.init_mh_info(user_id, ymd)?))
}

fn keys_of(rows: &[NewRow]) -> Vec<(String, String)> {
    day::group_keys(rows.iter().map(|r| (r.ci_key.as_str(), r.wbsid.as_str())))
}

/// 미리보기 — i-WMS 에 쓰지 않는다. 대상 카테고리의 지금 상태를 함께 돌려준다(확정 때 견준다).
pub fn preview(c: &Client, user_id: &str, ymd: &str, iso: &str, today: &str, rows: &[NewRow]) -> CallResult<(Preview, String)> {
    let (mh, init) = read(c, user_id, ymd)?;
    let plan = day::plan_append(&mh, &init, rows, iso, today).map_err(CallError::Invalid)?;
    Ok((plan.preview, day::state_of(&mh, &keys_of(rows))))
}

/// 저장하고 다시 조회해 대조한다. **저장이 된 뒤의 실패는 오류로 던지지 않는다** — 던지면 이미 들어간 행의
/// 이력이 남지 않아 되돌릴 수 없다(2026-10-04 실측: 저장 직후 재조회가 세션 회전으로 403 이었다).
fn save_and_verify(c: &Client, user_id: &str, ymd: &str, init: &Value, plan: Plan) -> CallResult<Outcome> {
    c.save(&day::payload(&plan, init, user_id, ymd))?;
    // 저장은 즉시 반영된다(auto-wms 실측 44ms). 어긋나거나 못 읽으면 한 번만 잠깐 기다렸다 다시 본다.
    let check = || match c.mh_list(user_id, ymd) {
        Ok(after) => day::verify(&after, &plan.expected),
        Err(e) => vec![format!("저장 뒤 다시 조회하지 못했습니다({e}) — i-WMS 화면에서 확인하세요")],
    };
    let mut bad = check();
    if !bad.is_empty() {
        std::thread::sleep(Duration::from_millis(500));
        bad = check();
    }
    Ok(Outcome { plan, verified: bad.is_empty(), mismatches: bad })
}

/// 확정 — 미리보기 때의 상태(`expected_state`)가 그대로일 때만 쓴다.
pub fn commit(
    c: &Client,
    user_id: &str,
    ymd: &str,
    iso: &str,
    today: &str,
    rows: &[NewRow],
    expected_state: &str,
) -> CallResult<Outcome> {
    let (mh, init) = read(c, user_id, ymd)?;
    if day::state_of(&mh, &keys_of(rows)) != expected_state {
        return Err(CallError::Stale(
            "미리보기 뒤에 i-WMS 에서 그 카테고리가 바뀌었습니다 — 다시 미리보고 확정하세요".into(),
        ));
    }
    let plan = day::plan_append(&mh, &init, rows, iso, today).map_err(CallError::Invalid)?;
    save_and_verify(c, user_id, ymd, &init, plan)
}

/// 되돌리기 — 이 앱이 넣은 행만 지운다. 그사이 그 행이 바뀌었으면 거절한다(`plan_remove`).
pub fn undo(c: &Client, user_id: &str, ymd: &str, iso: &str, today: &str, removals: &[Removal]) -> CallResult<Outcome> {
    let (mh, init) = read(c, user_id, ymd)?;
    let plan = day::plan_remove(&mh, &init, removals, iso, today).map_err(CallError::Stale)?;
    save_and_verify(c, user_id, ymd, &init, plan)
}
