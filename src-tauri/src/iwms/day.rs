//! 하루치 i-WMS 응답을 화면이 쓰는 모양으로 — 순수 함수만 둔다.
//!
//! `mhList` 응답은 탭(서브시스템) 배열이고 탭마다 행 배열이다. 한 카테고리(`wbsid`)가 `rowseq` 로
//! 여러 행일 수 있다. 마지막 탭 `ciKey = "NON-OBJECT"` 가 비대상(대가미포함)이다. 행의
//! `priceType` 이 `O`(운영) 면 대가포함, `N`(비대상) 이면 대가미포함이다.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::client::{flag, num, s};

/// 비대상 탭의 `ciKey`. 응답의 `ciName` 도 같은 글자라 화면 이름을 따로 준다.
pub const NON_OBJECT: &str = "NON-OBJECT";

/// 이미 들어 있는 행 하나(값이 있는 행만).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub row_seq: i64,
    pub minutes: i64,
    pub note: String,
    pub req_date: String,
    pub except_time: bool,
    pub except_day: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub title: String,
    pub content: String,
}

/// 그날 입력할 수 있는 카테고리 하나 — `(ciKey, wbsid)` 가 키다.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub ci_key: String,
    /// 탭 이름. 비대상 탭은 `비대상`.
    pub ci_name: String,
    pub wbsid: String,
    /// `O` 운영(대가포함) · `N` 비대상(대가미포함) · `I` 이슈(이 앱은 다루지 않는다).
    pub price_type: String,
    /// `대분류 > 중분류 > 소분류`
    pub path: String,
    /// 태스크명(`wbsname7`).
    pub task: String,
    pub templates: Vec<Template>,
    /// 이미 들어 있는 행(값이 있는 것만).
    pub rows: Vec<Row>,
    pub minutes: i64,
    /// 쓸 수 없으면 그 사유(읽기 전용 · 마감 · 폐기 · 결재).
    pub blocked: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub ci_key: String,
    pub ci_name: String,
    pub minutes: i64,
    /// `YYYY-MM-DD` 또는 빈 문자열.
    pub deadline: String,
    pub categories: usize,
    pub blocked: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    /// `YYYY-MM-DD`
    pub work_date: String,
    pub user_id: String,
    pub standard_minutes: i64,
    pub max_minutes: i64,
    /// 그날 모든 탭에 이미 들어 있는 분의 합.
    pub total_minutes: i64,
    pub approved: bool,
    pub holiday: bool,
    pub tabs: Vec<Tab>,
    pub categories: Vec<Category>,
}

/// `YYYY-MM-DD` 또는 `YYYYMMDD` → `(YYYY-MM-DD, YYYYMMDD)`.
pub fn normalize_date(raw: &str) -> Result<(String, String), String> {
    let t = raw.trim();
    let parsed = if t.len() == 8 && t.bytes().all(|b| b.is_ascii_digit()) {
        NaiveDate::parse_from_str(t, "%Y%m%d")
    } else {
        NaiveDate::parse_from_str(t, "%Y-%m-%d")
    }
    .map_err(|_| format!("날짜 형식이 아닙니다: {t} (YYYY-MM-DD)"))?;
    Ok((parsed.format("%Y-%m-%d").to_string(), parsed.format("%Y%m%d").to_string()))
}

pub fn tabs(mh_list: &Value) -> Result<&Vec<Value>, String> {
    mh_list
        .get("operationNonObjectMhList")
        .and_then(Value::as_array)
        .ok_or_else(|| "i-WMS 응답에 operationNonObjectMhList 가 없습니다".to_string())
}

pub fn tab_key(tab: &Value) -> String {
    tab.get("mhSubsystemVo").map(|vo| s(vo, "ciKey")).unwrap_or_default()
}

pub fn tab_name(tab: &Value) -> String {
    let key = tab_key(tab);
    if key == NON_OBJECT {
        return "비대상".to_string();
    }
    let name = tab.get("mhSubsystemVo").map(|vo| s(vo, "ciName")).unwrap_or_default();
    if name.is_empty() { key } else { name }
}

pub fn tab_rows(tab: &Value) -> &[Value] {
    tab.get("mhList").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// 값이 있는 행인가. 빈 자리(분 0 · 내용 없음)는 카테고리가 화면에 보이게 하는 자리일 뿐이다.
pub fn row_active(row: &Value) -> bool {
    num(row, "mh").unwrap_or(0) != 0
        || !s(row, "note").trim().is_empty()
        || !s(row, "reqDate").trim().is_empty()
        || s(row, "exceptTimeYn") == "1"
        || s(row, "exceptDayYn") == "1"
}

pub fn row_view(row: &Value) -> Row {
    Row {
        row_seq: num(row, "rowseq").unwrap_or(1),
        minutes: num(row, "mh").unwrap_or(0),
        note: s(row, "note"),
        req_date: s(row, "reqDate"),
        except_time: s(row, "exceptTimeYn") == "1",
        except_day: s(row, "exceptDayYn") == "1",
    }
}

/// 결재가 끝난 날인가. 키 이름이 응답마다 달라 둘 다 본다(mcp-wms 와 같다).
pub fn approved(init: &Value) -> bool {
    flag(init, "mhapprovalflag") || flag(init, "mhApprovalFlag")
}

/// 탭에 쓸 수 없는 까닭. 서버도 막지만(실패 코드) 저장 전에 사람이 읽는 말로 알린다.
///
/// `beforeAbandonedYn` 은 보지 않는다 — 2026-10-02 실측에서 입력이 되는 탭 모두가 `"Y"`(폐기 전)였다.
/// 폐기된 탭은 서버가 `MH_MANAGEMENT_SAVE_BEFORE_ABANDONED_ERROR` 로 거절한다.
///
/// 마감일(`deadLineDate`)은 입력 날짜가 넘어서거나(auto-wms · mcp-wms 의 판정) **오늘이** 넘어서면
/// 막는다. 그 날짜가 무엇의 마감인지 실측으로 확정하지 못해 두 해석 모두에서 맞는 쪽을 택했다.
pub fn tab_blocked(tab: &Value, work_date: &str, today: &str) -> Option<String> {
    if tab.get("canEdit") == Some(&Value::Bool(false)) {
        return Some("읽기 전용 탭입니다".into());
    }
    let vo = tab.get("mhSubsystemVo").cloned().unwrap_or(Value::Null);
    if s(&vo, "deleteYn") == "Y" {
        return Some("삭제된 서브시스템입니다".into());
    }
    let deadline = s(&vo, "deadLineDate");
    if let Ok((dl, _)) = normalize_date(&deadline) {
        if work_date > dl.as_str() || today > dl.as_str() {
            return Some(format!("마감일({dl})이 지났습니다"));
        }
    }
    None
}

/// 하루치 응답을 탭 · 카테고리 목록으로. `today` 는 `YYYY-MM-DD`(마감 판정용).
pub fn summarize(mh_list: &Value, init: &Value, work_date: &str, user_id: &str, today: &str) -> Result<Day, String> {
    let day_blocked = approved(init).then(|| "결재가 끝난 날입니다".to_string());
    let mut out_tabs = Vec::new();
    let mut cats: Vec<Category> = Vec::new();
    let mut total = 0;

    for tab in tabs(mh_list)? {
        let key = tab_key(tab);
        let name = tab_name(tab);
        let rows = tab_rows(tab);
        let blocked = day_blocked.clone().or_else(|| tab_blocked(tab, work_date, today));
        let minutes: i64 = rows.iter().map(|r| num(r, "mh").unwrap_or(0)).sum();
        total += minutes;

        let mut seen: Vec<String> = Vec::new();
        for row in rows {
            let wbsid = s(row, "wbsid");
            if wbsid.is_empty() || seen.contains(&wbsid) {
                continue;
            }
            seen.push(wbsid.clone());
            let same: Vec<&Value> = rows.iter().filter(|r| s(r, "wbsid") == wbsid).collect();
            let templates = row
                .get("templateVoList")
                .and_then(Value::as_array)
                .map(|ts| {
                    ts.iter()
                        .map(|t| Template { title: s(t, "title"), content: s(t, "content") })
                        .filter(|t| !t.content.trim().is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let path = [s(row, "wbsname4"), s(row, "wbsname5"), s(row, "wbsname6")]
                .into_iter()
                .filter(|x| !x.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" > ");
            let active: Vec<Row> = same.iter().filter(|r| row_active(r)).map(|r| row_view(r)).collect();
            cats.push(Category {
                ci_key: key.clone(),
                ci_name: name.clone(),
                wbsid,
                price_type: s(row, "priceType"),
                path,
                task: s(row, "wbsname7"),
                templates,
                minutes: active.iter().map(|r| r.minutes).sum(),
                rows: active,
                blocked: blocked.clone(),
            });
        }

        out_tabs.push(Tab {
            ci_key: key,
            ci_name: name,
            minutes,
            deadline: tab.get("mhSubsystemVo").map(|vo| s(vo, "deadLineDate")).unwrap_or_default(),
            categories: seen.len(),
            blocked,
        });
    }

    Ok(Day {
        work_date: work_date.to_string(),
        user_id: user_id.to_string(),
        standard_minutes: num(init, "standardTime").unwrap_or(480),
        max_minutes: num(init, "maxDailyTime").unwrap_or(480),
        total_minutes: total,
        approved: approved(init),
        holiday: s(init, "holidayYn") == "Y",
        tabs: out_tabs,
        categories: cats,
    })
}

// ---------------------------------------------------------------------------
// 쓰기 계획 — 저장 페이로드 · 미리보기 · 검증
// ---------------------------------------------------------------------------
//
// 저장은 **탭을 통째로 바꾼다**(auto-wms `MH-INPUT-SCREENS.md` §6.2). 그래서 조회한 탭을 원형(`Value`)
// 그대로 복제해 대상 카테고리의 행만 바꿔 끼우고, 건드린 탭만 싣는다. 이 앱의 규칙은 **덧붙이기**다 —
// 그 카테고리에 이미 있는 행은 원형 그대로 두고 순번만 다시 매기며, 새 행은 그 뒤에 붙인다. 지우는 것은
// 이 앱이 넣은 행(되돌리기)뿐이다.

/// 상세내용 상한(i-WMS 화면 · 서버).
pub const NOTE_MAX: usize = 1000;
/// 하루 상한. i-WMS 화면이 저장 전에 막는 유일한 값이다.
pub const DAY_LIMIT: i64 = 1440;

/// 덧붙일 행 하나. `entry_id` · `title` 은 i-WMS 로 가지 않고 입력 이력(`iwms_pushes`)에만 남는다.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewRow {
    #[serde(default)]
    pub entry_id: Option<i64>,
    #[serde(default)]
    pub title: String,
    pub ci_key: String,
    pub wbsid: String,
    pub minutes: i64,
    pub note: String,
    /// `YYYY-MM-DD` 또는 빈 값.
    #[serde(default)]
    pub req_date: String,
    /// 사용자가 고른 대가 구분(`O` · `N`). 주면 카테고리의 `priceType` 과 같아야 한다 — 대가포함 업무가
    /// 비대상 탭에 들어가는 일을 저장 전에 막는다.
    #[serde(default)]
    pub price: String,
}

/// 지울 행 — 이 앱이 넣은 그대로의 값으로 찾는다.
#[derive(Clone, Debug, PartialEq)]
pub struct Removal {
    pub ci_key: String,
    pub wbsid: String,
    pub minutes: i64,
    pub note: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CategoryDiff {
    pub ci_key: String,
    pub ci_name: String,
    pub wbsid: String,
    pub task: String,
    pub price_type: String,
    /// 저장 전 그 카테고리에 있던 행(값이 있는 것).
    pub before: Vec<Row>,
    /// 저장 뒤 그 카테고리의 행.
    pub after: Vec<Row>,
    pub added: usize,
    pub removed: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub work_date: String,
    pub diffs: Vec<CategoryDiff>,
    pub before_minutes: i64,
    pub after_minutes: i64,
    pub standard_minutes: i64,
    pub max_minutes: i64,
    pub warnings: Vec<String>,
}

/// 쓰기 하나의 계획. `tabs` 는 저장에 실을 탭(건드린 것만, 모든 행 포함)이다.
#[derive(Clone, Debug)]
pub struct Plan {
    pub tabs: Vec<Value>,
    pub preview: Preview,
    /// 카테고리별 저장 전 원형 행 — 입력 이력에 남겨 손으로 되살릴 근거로 둔다.
    pub before: Vec<(String, String, Vec<Value>)>,
    /// 카테고리별 저장 뒤 기대하는 행 — 재조회 검증에 쓴다.
    pub expected: Vec<(String, String, Vec<Row>)>,
}

/// 원형 행에 쓰는 필드만 바꾼다. 나머지(`taskId` · `sequence` · 사용자 정보 …)는 그대로 나간다.
fn set_row(row: &mut Value, minutes: i64, note: Option<&str>, req_date: &str) {
    row["mh"] = json!(minutes);
    row["orgmh"] = json!(minutes);
    row["note"] = note.map(|n| json!(n)).unwrap_or(Value::Null);
    row["reqDate"] = json!(req_date);
    row["exceptTimeYn"] = json!("0");
    row["exceptDayYn"] = json!("0");
}

/// 같은 카테고리의 행이 여럿이면 `rowseq` 1..n · `rowspan` n (§6.4).
fn renumber(rows: &mut [Value]) {
    let n = rows.len() as i64;
    for (i, r) in rows.iter_mut().enumerate() {
        r["rowseq"] = json!(i as i64 + 1);
        r["rowspan"] = json!(n);
    }
}

fn tab_index(mh_list: &Value, ci_key: &str) -> Option<usize> {
    tabs(mh_list).ok()?.iter().position(|t| tab_key(t) == ci_key)
}

fn sum_minutes(mh_list: &Value) -> i64 {
    tabs(mh_list)
        .map(|ts| ts.iter().flat_map(|t| tab_rows(t)).map(|r| num(r, "mh").unwrap_or(0)).sum())
        .unwrap_or(0)
}

/// 카테고리 키를 처음 나온 순서대로 묶는다.
pub fn group_keys<'a>(keys: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (c, w) in keys {
        if !out.iter().any(|(a, b)| a == c && b == w) {
            out.push((c.to_string(), w.to_string()));
        }
    }
    out
}

/// 대상 카테고리들의 지금 상태 — 미리보기와 확정 사이에 i-WMS 에서 바뀌었는지 이것을 견준다.
/// 해시 대신 정규화한 글 그대로를 견준다(의존성을 늘리지 않고, 정확하다).
pub fn state_of(mh_list: &Value, keys: &[(String, String)]) -> String {
    let mut sorted = keys.to_vec();
    sorted.sort();
    let state: Vec<Value> = sorted
        .iter()
        .map(|(ci, wbs)| {
            let rows: Vec<Value> = tab_index(mh_list, ci)
                .and_then(|i| tabs(mh_list).ok().map(|ts| tab_rows(&ts[i]).to_vec()))
                .unwrap_or_default()
                .iter()
                .filter(|r| s(r, "wbsid") == *wbs)
                .map(|r| {
                    json!([num(r, "mh").unwrap_or(0), s(r, "note"), s(r, "reqDate"), s(r, "exceptTimeYn"),
                           s(r, "exceptDayYn"), num(r, "rowseq").unwrap_or(1)])
                })
                .collect();
            json!([ci, wbs, rows])
        })
        .collect();
    Value::Array(state).to_string()
}

/// 저장 뒤 다시 조회한 값이 기대와 같은가. 순번은 서버가 다시 매길 수 있어 보지 않는다.
pub fn verify(mh_list: &Value, expected: &[(String, String, Vec<Row>)]) -> Vec<String> {
    let key = |r: &Row| (r.minutes, r.note.trim().to_string(), r.req_date.clone(), r.except_time, r.except_day);
    let mut bad = Vec::new();
    for (ci, wbs, want) in expected {
        let actual: Vec<Row> = tab_index(mh_list, ci)
            .and_then(|i| tabs(mh_list).ok().map(|ts| tab_rows(&ts[i]).to_vec()))
            .unwrap_or_default()
            .iter()
            .filter(|r| s(r, "wbsid") == *wbs && row_active(r))
            .map(row_view)
            .collect();
        let mut a: Vec<_> = actual.iter().map(key).collect();
        let mut w: Vec<_> = want.iter().map(key).collect();
        a.sort();
        w.sort();
        if a != w {
            bad.push(format!("{ci}/{wbs}: 기대 {}행 {}분, 실제 {}행 {}분", w.len(), w.iter().map(|x| x.0).sum::<i64>(),
                             a.len(), a.iter().map(|x| x.0).sum::<i64>()));
        }
    }
    bad
}

/// 행을 바꿔 끼우는 공통 길 — `change(활성 원형 행, 기준 행) → 새 행들` 로 카테고리마다 정한다.
fn plan_with(
    mh_list: &Value,
    init: &Value,
    keys: &[(String, String)],
    work_date: &str,
    today: &str,
    mut change: impl FnMut(&str, &str, Vec<Value>, &Value) -> Result<Vec<Value>, String>,
) -> Result<Plan, String> {
    if approved(init) {
        return Err(format!("{work_date} 은 결재가 끝난 날이라 바꿀 수 없습니다"));
    }
    let mut source = mh_list.clone();
    let before_minutes = sum_minutes(mh_list);
    let mut touched: Vec<usize> = Vec::new();
    let mut diffs = Vec::new();
    let mut before = Vec::new();
    let mut expected = Vec::new();

    for (ci, wbs) in keys {
        let ti = tab_index(&source, ci).ok_or_else(|| format!("그날 i-WMS 에 없는 탭입니다: {ci}"))?;
        let tab = &mut source["operationNonObjectMhList"][ti];
        if let Some(why) = tab_blocked(tab, work_date, today) {
            return Err(format!("{}: {why}", tab_name(tab)));
        }
        let ci_name = tab_name(tab);
        let rows = tab
            .get_mut("mhList")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| format!("{ci_name} 탭에 행 목록이 없습니다"))?;
        let idxs: Vec<usize> = rows.iter().enumerate().filter(|(_, r)| s(r, "wbsid") == *wbs).map(|(i, _)| i).collect();
        let at = *idxs.first().ok_or_else(|| format!("그날 {ci_name} 탭에 없는 카테고리입니다: {wbs}"))?;
        let base = rows[at].clone();
        let raw: Vec<Value> = idxs.iter().map(|i| rows[*i].clone()).collect();
        let active: Vec<Value> = raw.iter().filter(|r| row_active(r)).cloned().collect();
        let before_rows: Vec<Row> = active.iter().map(row_view).collect();

        let mut next = change(ci, wbs, active, &base)?;
        if next.is_empty() {
            // 다 지웠으면 빈 자리 한 줄을 남긴다 — 탭에 그 카테고리가 계속 보여야 한다.
            let mut empty = base.clone();
            set_row(&mut empty, 0, None, "");
            next.push(empty);
        }
        renumber(&mut next);
        let after_rows: Vec<Row> = next.iter().filter(|r| row_active(r)).map(row_view).collect();

        for i in idxs.iter().rev() {
            rows.remove(*i);
        }
        for (k, r) in next.into_iter().enumerate() {
            rows.insert(at + k, r);
        }
        if !touched.contains(&ti) {
            touched.push(ti);
        }
        diffs.push(CategoryDiff {
            ci_key: ci.clone(),
            ci_name,
            wbsid: wbs.clone(),
            task: s(&base, "wbsname7"),
            price_type: s(&base, "priceType"),
            added: after_rows.len().saturating_sub(before_rows.len()),
            removed: before_rows.len().saturating_sub(after_rows.len()),
            before: before_rows,
            after: after_rows.clone(),
        });
        before.push((ci.clone(), wbs.clone(), raw));
        expected.push((ci.clone(), wbs.clone(), after_rows));
    }

    let after_minutes = sum_minutes(&source);
    if after_minutes > DAY_LIMIT {
        return Err(format!("하루 합계가 {after_minutes}분이 되어 상한 {DAY_LIMIT}분을 넘습니다"));
    }
    let standard = num(init, "standardTime").unwrap_or(480);
    let max = num(init, "maxDailyTime").unwrap_or(standard);
    let mut warnings = Vec::new();
    if after_minutes != standard {
        let d = after_minutes - standard;
        warnings.push(format!(
            "저장 뒤 합계 {after_minutes}분 — 기준 {standard}분보다 {}분 {}",
            d.abs(),
            if d > 0 { "많습니다" } else { "적습니다" }
        ));
    }
    if after_minutes > max && max != standard {
        warnings.push(format!("최대 {max}분을 넘습니다"));
    }
    touched.sort_unstable();
    let out_tabs = touched.iter().map(|i| source["operationNonObjectMhList"][*i].clone()).collect();
    Ok(Plan {
        tabs: out_tabs,
        preview: Preview {
            work_date: work_date.to_string(),
            diffs,
            before_minutes,
            after_minutes,
            standard_minutes: standard,
            max_minutes: max,
            warnings,
        },
        before,
        expected,
    })
}

/// 덧붙이기 계획. 입력을 먼저 전부 검사한다(분 · 상세내용 · 같은 카테고리의 대가 구분).
pub fn plan_append(mh_list: &Value, init: &Value, rows: &[NewRow], work_date: &str, today: &str) -> Result<Plan, String> {
    if rows.is_empty() {
        return Err("넣을 행이 없습니다".into());
    }
    for r in rows {
        let label = if r.title.is_empty() { r.wbsid.as_str() } else { r.title.as_str() };
        if r.minutes <= 0 || r.minutes > DAY_LIMIT {
            return Err(format!("{label}: 분은 1~{DAY_LIMIT} 사이여야 합니다"));
        }
        if r.note.trim().is_empty() {
            return Err(format!("{label}: 상세내용이 비어 있습니다 — i-WMS 가 저장을 거부합니다"));
        }
        if r.note.chars().count() > NOTE_MAX {
            return Err(format!("{label}: 상세내용이 {NOTE_MAX}자를 넘습니다"));
        }
        if !r.req_date.is_empty() && normalize_date(&r.req_date).is_err() {
            return Err(format!("{label}: 요청일 형식이 아닙니다({})", r.req_date));
        }
    }
    let keys = group_keys(rows.iter().map(|r| (r.ci_key.as_str(), r.wbsid.as_str())));
    plan_with(mh_list, init, &keys, work_date, today, |ci, wbs, active, base| {
        let mut next = active;
        let price = s(base, "priceType");
        for r in rows.iter().filter(|r| r.ci_key == ci && r.wbsid == wbs) {
            if !r.price.is_empty() && r.price != price {
                return Err(format!("{}: 대가 구분({})과 카테고리의 대가 구분({price})이 다릅니다", r.title, r.price));
            }
            let mut row = base.clone();
            set_row(&mut row, r.minutes, Some(r.note.trim()), &r.req_date);
            next.push(row);
        }
        Ok(next)
    })
}

/// 되돌리기 계획 — 이 앱이 넣은 행만 지운다(분 · 상세내용으로 찾는다). 못 찾으면 그사이 바뀐 것이라 거절한다.
pub fn plan_remove(mh_list: &Value, init: &Value, removals: &[Removal], work_date: &str, today: &str) -> Result<Plan, String> {
    if removals.is_empty() {
        return Err("되돌릴 행이 없습니다".into());
    }
    let keys = group_keys(removals.iter().map(|r| (r.ci_key.as_str(), r.wbsid.as_str())));
    plan_with(mh_list, init, &keys, work_date, today, |ci, wbs, active, _| {
        let mut next = active;
        for r in removals.iter().filter(|r| r.ci_key == ci && r.wbsid == wbs) {
            let at = next
                .iter()
                .position(|x| num(x, "mh").unwrap_or(0) == r.minutes && s(x, "note").trim() == r.note.trim())
                .ok_or_else(|| {
                    format!("{wbs} 에서 이 앱이 넣은 행({}분)을 찾지 못했습니다 — 그사이 i-WMS 에서 바뀌었습니다", r.minutes)
                })?;
            next.remove(at);
        }
        Ok(next)
    })
}

/// 저장 요청 본문(§6.2). 기준을 넘으면 'MH 정상 확인' 을 켠다 — i-WMS 화면이 그렇게 보낸다.
pub fn payload(plan: &Plan, init: &Value, user_id: &str, ymd: &str) -> Value {
    json!({
        "clickMHConfirm": plan.preview.after_minutes > plan.preview.standard_minutes,
        "userId": user_id,
        "workDate": ymd,
        "improvedFlag": init.get("improvedFlag").and_then(Value::as_bool).unwrap_or(true),
        "mhList": plan.tabs,
        "mhInputVOList": [],
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn sample() -> (Value, Value) {
        (
            serde_json::from_str(include_str!("fixtures/mhlist.sample.json")).unwrap(),
            serde_json::from_str(include_str!("fixtures/initmhinfo.sample.json")).unwrap(),
        )
    }

    #[test]
    fn dates_are_accepted_in_both_shapes() {
        assert_eq!(normalize_date("2026-10-02").unwrap(), ("2026-10-02".into(), "20261002".into()));
        assert_eq!(normalize_date(" 20261002 ").unwrap(), ("2026-10-02".into(), "20261002".into()));
        assert!(normalize_date("2026-13-02").is_err());
        assert!(normalize_date("10/02").is_err());
    }

    const TODAY: &str = "2026-10-04";

    #[test]
    fn a_day_is_summarised_into_tabs_and_categories() {
        let (mh, init) = sample();
        let day = summarize(&mh, &init, "2026-10-02", "sample.user", TODAY).unwrap();
        assert_eq!(day.standard_minutes, 480, "문자열 숫자도 읽는다");
        assert_eq!(day.total_minutes, 30 + 30 + 45 + 60, "실수형 mh 도 더한다");
        assert_eq!(day.tabs.len(), 3);
        assert_eq!(day.tabs[1].categories, 0, "행이 없는 탭도 탭으로는 보인다");
        assert_eq!(day.tabs[2].ci_name, "비대상");

        let keys: Vec<_> = day.categories.iter().map(|c| c.wbsid.as_str()).collect();
        assert_eq!(keys, ["nbaa200000", "nbaa300000", "nbbc100000", "nbbl200000", "nbbl300000"]);

        let multi = &day.categories[2];
        assert_eq!(multi.rows.len(), 2, "rowseq 로 나뉜 두 행이 한 카테고리다");
        assert_eq!(multi.minutes, 75);
        assert_eq!(multi.path, "운영업무 > 서비스 요청 > 데이터 요청");

        let empty = &day.categories[1];
        assert!(empty.rows.is_empty(), "빈 자리 행은 들어 있는 행이 아니다");
        assert_eq!(day.categories[0].templates[0].title, "모니터링");
        assert_eq!(day.categories[3].price_type, "N");
        assert!(day.categories.iter().all(|c| c.blocked.is_none()));
    }

    #[test]
    fn deadline_approval_and_read_only_block_writing() {
        let (mut mh, mut init) = sample();
        let day = summarize(&mh, &init, "2026-10-13", "u", TODAY).unwrap();
        assert_eq!(day.tabs[0].blocked.as_deref(), Some("마감일(2026-10-12)이 지났습니다"));
        let day = summarize(&mh, &init, "2026-10-02", "u", "2026-10-13").unwrap();
        assert_eq!(day.tabs[0].blocked.as_deref(), Some("마감일(2026-10-12)이 지났습니다"), "오늘이 넘어서도 막는다");

        mh["operationNonObjectMhList"][1]["canEdit"] = json!(false);
        let day = summarize(&mh, &init, "2026-10-02", "u", TODAY).unwrap();
        assert!(day.tabs[0].blocked.is_none(), "beforeAbandonedYn=Y(폐기 전)는 막지 않는다");
        assert_eq!(day.tabs[1].blocked.as_deref(), Some("읽기 전용 탭입니다"));

        mh["operationNonObjectMhList"][2]["mhSubsystemVo"]["deleteYn"] = json!("Y");
        let day = summarize(&mh, &init, "2026-10-02", "u", TODAY).unwrap();
        assert_eq!(day.tabs[2].blocked.as_deref(), Some("삭제된 서브시스템입니다"));

        init["mhapprovalflag"] = json!("Y");
        let day = summarize(&mh, &init, "2026-10-02", "u", TODAY).unwrap();
        assert!(day.approved);
        assert!(day.categories.iter().all(|c| c.blocked.as_deref() == Some("결재가 끝난 날입니다")));
    }

    #[test]
    fn a_response_without_tabs_is_an_error() {
        assert!(summarize(&json!({"checkAuthMessage":"FAIL"}), &json!({}), "2026-10-02", "u", TODAY).is_err());
    }

    // -- 쓰기 계획 ------------------------------------------------------------

    const DAY: &str = "2026-10-02";

    fn row(ci: &str, wbs: &str, minutes: i64, note: &str) -> NewRow {
        NewRow {
            entry_id: Some(1),
            title: "t".into(),
            ci_key: ci.into(),
            wbsid: wbs.into(),
            minutes,
            note: note.into(),
            req_date: String::new(),
            price: String::new(),
        }
    }

    fn rows_of<'a>(tab: &'a Value, wbs: &str) -> Vec<&'a Value> {
        tab_rows(tab).iter().filter(|r| s(r, "wbsid") == wbs).collect()
    }

    #[test]
    fn appending_keeps_existing_rows_and_renumbers() {
        let (mh, init) = sample();
        let plan = plan_append(&mh, &init, &[row("MSPCMDBCHG-000001", "nbbc100000", 20, "C-3. 셋째")], DAY, TODAY).unwrap();
        assert_eq!(plan.tabs.len(), 1, "건드린 탭만 싣는다");
        let tab = &plan.tabs[0];
        assert_eq!(tab_rows(tab).len(), 5, "그 탭의 모든 행이 실린다(빈 자리 포함)");
        let cat = rows_of(tab, "nbbc100000");
        let seen: Vec<_> = cat.iter().map(|r| (num(r, "rowseq").unwrap(), num(r, "rowspan").unwrap(), num(r, "mh").unwrap(), s(r, "note"))).collect();
        assert_eq!(seen, [(1, 3, 30, "B-1. 첫째".into()), (2, 3, 45, "B-2. 둘째".into()), (3, 3, 20, "C-3. 셋째".into())]);
        assert_eq!(s(cat[0], "reqDate"), "2026-10-01", "기존 행은 원형 그대로");
        assert_eq!(cat[2]["taskId"], cat[0]["taskId"], "새 행은 그 카테고리의 행을 복제한다");
        assert_eq!(cat[2]["orgmh"], json!(20));
        // 같은 탭의 다른 카테고리는 그대로다.
        assert_eq!(s(rows_of(tab, "nbaa200000")[0], "note"), "정기 모니터링 수행");

        let p = &plan.preview;
        assert_eq!((p.before_minutes, p.after_minutes), (165, 185));
        assert_eq!(p.diffs[0].before.len(), 2);
        assert_eq!(p.diffs[0].after.len(), 3);
        assert_eq!(p.diffs[0].added, 1);
        assert!(p.warnings[0].contains("기준 480분보다 295분 적습니다"));
    }

    #[test]
    fn an_empty_placeholder_is_replaced_and_several_rows_share_a_category() {
        let (mh, init) = sample();
        let rows = [row("NON-OBJECT", "nbbl300000", 30, "a"), row("NON-OBJECT", "nbbl300000", 40, "b")];
        let plan = plan_append(&mh, &init, &rows, DAY, TODAY).unwrap();
        let cat = rows_of(&plan.tabs[0], "nbbl300000");
        assert_eq!(cat.len(), 2, "빈 자리 행은 새 행으로 바뀐다");
        assert_eq!(cat.iter().map(|r| s(r, "note")).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(plan.expected[0].2.len(), 2);
        let body = payload(&plan, &init, "sample.user", "20261002");
        assert_eq!(body["workDate"], "20261002");
        assert_eq!(body["clickMHConfirm"], false);
        assert_eq!(body["improvedFlag"], true);
        assert_eq!(body["mhInputVOList"], json!([]));
        assert_eq!(body["mhList"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn bad_input_is_refused_before_anything_is_built() {
        let (mh, mut init) = sample();
        let ci = "MSPCMDBCHG-000001";
        assert!(plan_append(&mh, &init, &[], DAY, TODAY).is_err());
        assert!(plan_append(&mh, &init, &[row(ci, "nbaa300000", 0, "a")], DAY, TODAY).unwrap_err().contains("분은"));
        assert!(plan_append(&mh, &init, &[row(ci, "nbaa300000", 10, " ")], DAY, TODAY).unwrap_err().contains("상세내용이 비어"));
        assert!(plan_append(&mh, &init, &[row(ci, "nbaa300000", 10, &"가".repeat(1001))], DAY, TODAY).is_err());
        assert!(plan_append(&mh, &init, &[row(ci, "zzzz", 10, "a")], DAY, TODAY).unwrap_err().contains("없는 카테고리"));
        assert!(plan_append(&mh, &init, &[row("NOPE", "nbaa300000", 10, "a")], DAY, TODAY).unwrap_err().contains("없는 탭"));
        assert!(plan_append(&mh, &init, &[row(ci, "nbaa300000", 1300, "a")], DAY, TODAY).unwrap_err().contains("1440"));
        assert!(plan_append(&mh, &init, &[row(ci, "nbaa300000", 10, "a")], "2026-10-13", TODAY).unwrap_err().contains("마감일"));
        let wrong = NewRow { price: "N".into(), ..row(ci, "nbaa300000", 10, "a") };
        assert!(plan_append(&mh, &init, &[wrong], DAY, TODAY).unwrap_err().contains("대가 구분"));
        init["mhapprovalflag"] = json!(true);
        assert!(plan_append(&mh, &init, &[row(ci, "nbaa300000", 10, "a")], DAY, TODAY).unwrap_err().contains("결재"));
    }

    #[test]
    fn undo_removes_only_the_rows_this_app_added() {
        let (mh, init) = sample();
        let ci = "MSPCMDBCHG-000001";
        // 덧붙인 뒤의 상태를 서버가 돌려준다고 치고, 거기서 되돌린다.
        let added = plan_append(&mh, &init, &[row(ci, "nbbc100000", 20, "C-3. 셋째"), row(ci, "nbaa300000", 10, "새 행")], DAY, TODAY).unwrap();
        let mut server = mh.clone();
        server["operationNonObjectMhList"][0] = added.tabs[0].clone();

        let undo = plan_remove(
            &server,
            &init,
            &[
                Removal { ci_key: ci.into(), wbsid: "nbbc100000".into(), minutes: 20, note: "C-3. 셋째".into() },
                Removal { ci_key: ci.into(), wbsid: "nbaa300000".into(), minutes: 10, note: "새 행".into() },
            ],
            DAY,
            TODAY,
        )
        .unwrap();
        let tab = &undo.tabs[0];
        let multi: Vec<_> = rows_of(tab, "nbbc100000").iter().map(|r| (num(r, "mh").unwrap(), num(r, "rowspan").unwrap())).collect();
        assert_eq!(multi, [(30, 2), (45, 2)], "원래 있던 두 행은 남는다");
        let empty = rows_of(tab, "nbaa300000");
        assert_eq!(empty.len(), 1, "다 지운 카테고리는 빈 자리 한 줄");
        assert!(!row_active(empty[0]));
        assert_eq!(undo.preview.after_minutes, 165);

        // 그사이 누가 고쳐 그 행이 없으면 거절한다.
        let gone = plan_remove(&mh, &init, &[Removal { ci_key: ci.into(), wbsid: "nbbc100000".into(), minutes: 20, note: "C-3. 셋째".into() }], DAY, TODAY);
        assert!(gone.unwrap_err().contains("찾지 못했습니다"));
    }

    #[test]
    fn state_changes_are_detected_and_saves_are_verified() {
        let (mh, init) = sample();
        let keys = vec![("MSPCMDBCHG-000001".to_string(), "nbbc100000".to_string())];
        let before = state_of(&mh, &keys);
        let mut other = mh.clone();
        other["operationNonObjectMhList"][0]["mhList"][0]["note"] = json!("다른 카테고리를 고쳤다");
        assert_eq!(state_of(&other, &keys), before, "대상 밖의 변화는 보지 않는다");
        other["operationNonObjectMhList"][0]["mhList"][3]["mh"] = json!(50.0);
        assert_ne!(state_of(&other, &keys), before);

        let plan = plan_append(&mh, &init, &[row("MSPCMDBCHG-000001", "nbbc100000", 20, "C")], DAY, TODAY).unwrap();
        let mut saved = mh.clone();
        saved["operationNonObjectMhList"][0] = plan.tabs[0].clone();
        assert!(verify(&saved, &plan.expected).is_empty());
        assert_eq!(verify(&mh, &plan.expected).len(), 1, "저장이 안 됐으면 어긋난다");
    }
}
