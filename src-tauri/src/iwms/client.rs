//! i-WMS REST 클라이언트.
//!
//! 규격은 실측된 것만 쓴다(바탕화면 `auto-wms/docs/MH-INPUT-SCREENS.md` §6, `mcp-wms` 의 `client.py`).
//! 인증은 `SESSION` 쿠키 하나이고 CSRF 토큰은 없다. 이 앱의 다른 원격 호출(`fabrix.rs`)처럼
//! `reqwest::blocking` 이라 **IPC 스레드에서 부르지 않는다** — 커맨드가 `spawn_blocking` 안에서 쓴다.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// 호출이 실패한 까닭. 프런트가 할 일이 다른 것만 따로 둔다 — 만료면 다시 연결, 낡았으면 다시 미리보기,
/// 입력이 틀렸으면 고치기.
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// 401 · 403, 또는 200 인데 본문이 로그인 화면 HTML 이다.
    Expired,
    /// 미리보기 뒤에 i-WMS 쪽 값이 바뀌었다.
    Stale(String),
    /// 저장하기 전에 앱이 막은 입력(분 · 상세내용 · 마감 · 결재 …).
    Invalid(String),
    Other(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Expired => write!(f, "i-WMS 세션이 만료되었습니다"),
            CallError::Stale(m) | CallError::Invalid(m) | CallError::Other(m) => write!(f, "{m}"),
        }
    }
}

pub type CallResult<T> = std::result::Result<T, CallError>;

/// 로그인한 사람. 프로필 응답의 키 이름이 확실치 않아 흔한 후보를 훑는다(auto-wms 와 같다).
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub user_id: String,
    pub user_name: String,
    pub dept: String,
}

/// 쿠키를 다시 읽는 길 — 지금 쓰던 값을 받아, 브라우저(WebView2 · CDP)에 **다른** 값이 있으면 돌려준다.
///
/// i-WMS 는 SSO 화면이 뜬 직후 세션 id 를 한 번 바꾼다(2026-10-04 실측: 연결 0.6초 뒤 회전, 옛 값은 그때부터
/// 403 `LOGIN-108`). 바뀌기 전 값을 집으면 몇 번 부르다 막힌다 — 그때 새 값을 다시 읽어 한 번 더 시도한다.
pub type Refresh = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct Client {
    http: reqwest::blocking::Client,
    base: String,
    cookie: Mutex<String>,
    refresh: Option<Refresh>,
}

impl Client {
    /// `cookie` 는 `SESSION=…` 꼴의 Cookie 헤더 값이다.
    pub fn new(base: &str, cookie: &str) -> CallResult<Client> {
        if cookie.trim().is_empty() {
            return Err(CallError::Expired);
        }
        // 사내 호스트는 NO_PROXY 에 없다. 프록시를 타면 SSO 세션이 깨지므로 직결한다.
        let http = reqwest::blocking::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| CallError::Other(format!("HTTP 클라이언트를 만들지 못했습니다: {e}")))?;
        Ok(Client {
            http,
            base: base.trim_end_matches('/').to_string(),
            cookie: Mutex::new(cookie.to_string()),
            refresh: None,
        })
    }

    /// 만료로 막히면 쿠키를 다시 읽어 **한 번** 더 시도한다.
    pub fn with_refresh(mut self, refresh: Refresh) -> Client {
        self.refresh = Some(refresh);
        self
    }

    /// 지금 쓰는 쿠키(다시 읽어 바뀌었을 수 있다).
    pub fn cookie(&self) -> String {
        self.cookie.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn once(&self, method: &str, path: &str, body: Option<&Value>, cookie: &str) -> CallResult<Value> {
        let url = format!("{}{path}", self.base);
        let req = match body {
            None => self.http.get(url),
            Some(b) => self.http.post(url).json(b),
        };
        finish(method, path, req.header("cookie", cookie).header("accept", "application/json").send())
    }

    /// 401 · 403 · 로그인 화면은 **서버가 요청을 처리하기 전**에 인증 필터가 돌려준 것이라, 같은 요청을 새 쿠키로
    /// 다시 보내도 두 번 들어가지 않는다(저장 POST 포함).
    fn send(&self, method: &str, path: &str, body: Option<&Value>) -> CallResult<Value> {
        let cookie = self.cookie();
        match self.once(method, path, body, &cookie) {
            Err(CallError::Expired) => {
                let Some(refresh) = &self.refresh else { return Err(CallError::Expired) };
                std::thread::sleep(Duration::from_millis(300));
                let Some(fresh) = refresh(&cookie) else { return Err(CallError::Expired) };
                *self.cookie.lock().unwrap_or_else(PoisonError::into_inner) = fresh.clone();
                self.once(method, path, body, &fresh)
            }
            other => other,
        }
    }

    fn get(&self, path: &str) -> CallResult<Value> {
        self.send("GET", path, None)
    }

    fn post(&self, path: &str, body: &Value) -> CallResult<Value> {
        self.send("POST", path, Some(body))
    }

    pub fn profile(&self) -> CallResult<User> {
        let p = self.get("/rest/v2/user/profile")?;
        let user = user_from_profile(&p);
        if user.user_id.is_empty() {
            return Err(CallError::Other("프로필 응답에 사용자 id 가 없습니다".into()));
        }
        Ok(user)
    }

    /// 하루치 운영 · 비대상 탭 전체. 저장의 기준이 되는 조회다. `ymd` 는 `YYYYMMDD`.
    pub fn mh_list(&self, user_id: &str, ymd: &str) -> CallResult<Value> {
        self.get(&format!(
            "/rest/iwms/MhRegistration/mhList?userId={}&searchDate={ymd}",
            urlencoding::encode(user_id)
        ))
    }

    /// 기준시간 · 최대시간 · 결재 여부. `improvedFlag` 는 저장 페이로드에 그대로 싣는다.
    pub fn init_mh_info(&self, user_id: &str, ymd: &str) -> CallResult<Value> {
        self.get(&format!(
            "/rest/iwms/mhImprovRegister/initMHInfo?userId={}&workDate={ymd}&oper=init",
            urlencoding::encode(user_id)
        ))
    }

    /// 저장. **실패도 HTTP 200 으로 온다** — 본문의 `errorCode` 가 `"200"` 일 때만 성공이다.
    pub fn save(&self, payload: &Value) -> CallResult<Value> {
        let res = self.post("/rest/iwms/MhRegistration/save", payload)?;
        check_saved(&res)?;
        Ok(res)
    }
}

fn finish(method: &str, path: &str, res: reqwest::Result<reqwest::blocking::Response>) -> CallResult<Value> {
    let res = res.map_err(|e| CallError::Other(format!("{method} {} 전송 실패: {e}", short(path))))?;
    let status = res.status().as_u16();
    let final_url = res.url().path().to_string();
    let kind = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = res
        .text()
        .map_err(|e| CallError::Other(format!("{method} {} 응답을 읽지 못했습니다: {e}", short(path))))?;
    // 진단용(쿠키는 찍지 않는다): `IWMS_DEBUG=1` 이면 응답의 상태 · 종류 · 앞부분을 stderr 로.
    if std::env::var_os("IWMS_DEBUG").is_some() {
        eprintln!(
            "[iwms] {method} {} → HTTP {status} {kind} (최종 {final_url}) {}",
            short(path),
            trunc(&text.replace('\n', " "), 300)
        );
    }
    read_body(status, &text).map_err(|e| match e {
        CallError::Other(m) => CallError::Other(format!("{method} {}: {m}", short(path))),
        expired => expired,
    })
}

/// 쿼리스트링을 뗀 경로 — 오류 문구에 사용자 id 를 남기지 않는다.
fn short(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

/// 응답 본문을 판정한다. SSO 가 끊기면 401 · 403 이 오거나, 로그인 화면 HTML 이 200 으로 온다.
pub fn read_body(status: u16, text: &str) -> CallResult<Value> {
    if status == 401 || status == 403 {
        return Err(CallError::Expired);
    }
    if !(200..300).contains(&status) {
        return Err(CallError::Other(format!("HTTP {status}: {}", trunc(text, 300))));
    }
    if text.trim_start().starts_with('<') {
        return Err(CallError::Expired);
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text)
        .map_err(|e| CallError::Other(format!("응답이 JSON 이 아닙니다({e}): {}", trunc(text, 300))))
}

/// 저장 응답의 성공 판정. `errorCode` 가 없는 응답은 판단 근거가 없으므로 실패로 본다 —
/// 성공으로 넘기면 저장 뒤 재조회 대조만이 남는데, 그것까지 기다리게 할 이유가 없다.
pub fn check_saved(res: &Value) -> CallResult<()> {
    let code = match res.get("errorCode") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    if code == "200" {
        return Ok(());
    }
    let detail = res.get("errorText").and_then(Value::as_str).unwrap_or("");
    Err(CallError::Other(save_error_message(&code, detail)))
}

/// 저장 거부 코드 → 사람이 읽는 사유. i-WMS 화면의 저장 처리와 같은 분기다.
pub fn save_error_message(code: &str, detail: &str) -> String {
    let d = if detail.is_empty() { "해당 항목" } else { detail };
    match code {
        "NO_TASK_CHG_REL" => "Change 와 먼저 연결해야 공수를 등록할 수 있습니다.".to_string(),
        "NO_RELEASE_CHG_REL" => "Change 나 Task 와 먼저 연결해야 공수를 등록할 수 있습니다.".to_string(),
        "CALL_MH_PERFORMANCE_SAVE_ERROR" | "CALL_MH_PERFORMANCE_APPROVED_SAVE_ERROR" => {
            format!("{d} 이(가) 실적 확정 상태라 더 저장할 수 없습니다.")
        }
        "MH_MANAGEMENT_SAVE_DEADLINE_DATE_ERROR" => format!("{d} 의 마감일이 지나 저장할 수 없습니다."),
        "MH_MANAGEMENT_SAVE_BEFORE_ABANDONED_ERROR" => format!("{d} 은(는) 폐기되어 저장할 수 없습니다."),
        "" => "i-WMS 가 저장 결과를 알려 주지 않았습니다(errorCode 없음).".to_string(),
        other => format!("i-WMS 가 저장을 거부했습니다({other}) {detail}").trim_end().to_string(),
    }
}

pub fn user_from_profile(p: &Value) -> User {
    let pick = |keys: &[&str]| {
        keys.iter()
            .filter_map(|k| p.get(*k))
            .filter_map(|v| match v {
                Value::String(s) => Some(s.trim().to_string()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .find(|s| !s.is_empty())
            .unwrap_or_default()
    };
    User {
        user_id: pick(&["userId", "loginId", "id", "empNo"]),
        user_name: pick(&["userName", "userNm", "name", "empNm"]),
        dept: pick(&["deptName", "deptNm", "orgName", "dept"]),
    }
}

/// 숫자 필드를 관대하게 읽는다. **i-WMS 응답을 읽을 때는 항상 이것을 쓴다.**
///
/// 같은 값이 자리마다 다른 자료형으로 온다(auto-wms 2026-08-31 실측): mhList 의 `"mh": 30.0`,
/// initMHInfo 의 `"standardTime": "480"`, standard-mh 의 정수. `as_i64()` 는 실수와 문자열에
/// 모두 `None` 을 준다 — 예전에 등록된 MH 를 전부 0 으로 읽어 검증이 틀린 일이 있었다.
pub fn num(v: &Value, k: &str) -> Option<i64> {
    match v.get(k)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.round() as i64)),
        Value::String(s) => {
            let t = s.trim();
            t.parse::<i64>().ok().or_else(|| t.parse::<f64>().ok().map(|f| f.round() as i64))
        }
        _ => None,
    }
}

/// 문자열 필드. `null` · 없음 · 다른 자료형은 빈 문자열이다.
pub fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// `true` · `"1"` · `"Y"` · `"true"` 를 참으로.
pub fn flag(v: &Value, k: &str) -> bool {
    match v.get(k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(x)) => matches!(x.trim().to_ascii_lowercase().as_str(), "1" | "y" | "yes" | "true"),
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        _ => false,
    }
}

pub fn trunc(text: &str, n: usize) -> String {
    if text.chars().count() <= n {
        text.to_string()
    } else {
        text.chars().take(n).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn login_page_html_is_an_expired_session_not_a_parse_error() {
        assert_eq!(read_body(200, "  <!DOCTYPE html><html>…"), Err(CallError::Expired));
        assert_eq!(read_body(401, "{}"), Err(CallError::Expired));
        assert_eq!(read_body(403, ""), Err(CallError::Expired));
        assert!(matches!(read_body(500, "boom"), Err(CallError::Other(m)) if m.contains("500")));
        assert_eq!(read_body(200, "").unwrap(), Value::Null);
        assert_eq!(read_body(200, r#"{"a":1}"#).unwrap(), json!({"a":1}));
    }

    #[test]
    fn numbers_come_as_floats_strings_and_ints() {
        let v = json!({ "f": 30.0, "s": "480", "i": 45, "sf": "12.0", "n": null, "x": "abc" });
        assert_eq!(num(&v, "f"), Some(30));
        assert_eq!(num(&v, "s"), Some(480));
        assert_eq!(num(&v, "i"), Some(45));
        assert_eq!(num(&v, "sf"), Some(12));
        assert_eq!(num(&v, "n"), None);
        assert_eq!(num(&v, "x"), None);
        assert_eq!(num(&v, "missing"), None);
    }

    #[test]
    fn a_save_is_successful_only_with_error_code_200() {
        assert!(check_saved(&json!({"errorCode":"200","errorText":null})).is_ok());
        assert!(check_saved(&json!({"errorCode":200})).is_ok());
        let err = check_saved(&json!({"errorCode":"MH_MANAGEMENT_SAVE_DEADLINE_DATE_ERROR","errorText":"공통"}))
            .unwrap_err();
        assert_eq!(err, CallError::Other("공통 의 마감일이 지나 저장할 수 없습니다.".into()));
        assert!(check_saved(&json!({})).is_err(), "errorCode 가 없으면 성공으로 보지 않는다");
    }

    #[test]
    fn profile_keys_are_searched_in_order() {
        let u = user_from_profile(&json!({"loginId":"kim","userNm":"김","deptNm":"팀"}));
        assert_eq!(u, User { user_id: "kim".into(), user_name: "김".into(), dept: "팀".into() });
        assert_eq!(user_from_profile(&json!({"userId":"","id":"lee"})).user_id, "lee");
    }

    #[test]
    fn flags_accept_the_shapes_i_wms_uses() {
        let v = json!({"a":"1","b":"Y","c":true,"d":"0","e":null});
        assert!(flag(&v, "a") && flag(&v, "b") && flag(&v, "c"));
        assert!(!flag(&v, "d") && !flag(&v, "e") && !flag(&v, "zz"));
    }
}
