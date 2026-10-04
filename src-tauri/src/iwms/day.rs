//! 하루치 i-WMS 응답을 화면이 쓰는 모양으로 — 순수 함수만 둔다.
//!
//! `mhList` 응답은 탭(서브시스템) 배열이고 탭마다 행 배열이다. 한 카테고리(`wbsid`)가 `rowseq` 로
//! 여러 행일 수 있다. 마지막 탭 `ciKey = "NON-OBJECT"` 가 비대상(대가미포함)이다. 행의
//! `priceType` 이 `O`(운영) 면 대가포함, `N`(비대상) 이면 대가미포함이다.

use chrono::NaiveDate;
use serde::Serialize;
use serde_json::Value;

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
}
