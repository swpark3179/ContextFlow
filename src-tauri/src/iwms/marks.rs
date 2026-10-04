//! 오늘의 한일 줄마다 고른 대가 구분(`iwms_marks`)과 i-WMS 에 넣은 이력(`iwms_pushes`).
//!
//! 표는 `today.db` v2 에 있다(`daylog.rs` 의 `DDL_V2`) — 같은 커넥션(`DayLog::with`)을 쓴다.

use rusqlite::{named_params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub entry_id: i64,
    /// `O` 대가포함 · `N` 대가미포함.
    pub price: String,
}

/// i-WMS 에 넣은 행 하나.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Push {
    pub id: i64,
    pub commit_id: String,
    /// 오늘의 한일 줄. 그 줄을 지웠어도 이력은 남는다.
    pub entry_id: Option<i64>,
    pub day: String,
    pub title: String,
    pub ci_key: String,
    pub ci_name: String,
    pub wbsid: String,
    pub task: String,
    pub price: String,
    pub minutes: i64,
    pub note: String,
    pub pushed_at: String,
    /// 되돌렸으면 그 시각.
    pub undone_at: Option<String>,
}

/// 기록할 행 — 확정이 끝난 뒤 줄마다 하나.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewPush {
    pub entry_id: Option<i64>,
    pub title: String,
    pub ci_key: String,
    pub ci_name: String,
    pub wbsid: String,
    pub task: String,
    pub price: String,
    pub minutes: i64,
    pub note: String,
}

pub fn check_price(price: &str) -> Result<()> {
    if price == "O" || price == "N" {
        Ok(())
    } else {
        Err(AppError::new("invalid", format!("대가 구분은 O · N 중 하나입니다: {price}")))
    }
}

/// 그날 지금 Vault 의 줄에 붙은 대가 선택. 지운 줄의 선택은 JOIN 에서 빠진다.
pub fn marks(conn: &Connection, vault: &str, day: &str) -> Result<Vec<Mark>> {
    let mut stmt = conn.prepare(
        "SELECT m.entry_id, m.price FROM iwms_marks m
         JOIN entries e ON e.id = m.entry_id
         WHERE e.vault_root = ?1 AND e.day = ?2
         ORDER BY m.entry_id",
    )?;
    let rows = stmt.query_map((vault, day), |r| Ok(Mark { entry_id: r.get(0)?, price: r.get(1)? }))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 고르거나(`Some`) 지운다(`None` = 입력 안 함). 없는 줄이면 오류다.
pub fn set_mark(conn: &Connection, entry_id: i64, price: Option<&str>) -> Result<()> {
    let exists: Option<i64> =
        conn.query_row("SELECT id FROM entries WHERE id = ?1", [entry_id], |r| r.get(0)).optional()?;
    if exists.is_none() {
        return Err(AppError::new("not_found", "이미 지워진 기록입니다"));
    }
    match price {
        Some(p) => {
            check_price(p)?;
            conn.execute(
                "INSERT INTO iwms_marks (entry_id, price, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(entry_id) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at",
                (entry_id, p, crate::vault::now_stamp()),
            )?;
        }
        None => {
            conn.execute("DELETE FROM iwms_marks WHERE entry_id = ?1", [entry_id])?;
        }
    }
    Ok(())
}

const PUSH_COLS: &str = "id, commit_id, entry_id, day, title, ci_key, ci_name, wbsid, task, price, minutes, note, pushed_at, undone_at";

fn row_to_push(r: &rusqlite::Row<'_>) -> rusqlite::Result<Push> {
    Ok(Push {
        id: r.get(0)?,
        commit_id: r.get(1)?,
        entry_id: r.get(2)?,
        day: r.get(3)?,
        title: r.get(4)?,
        ci_key: r.get(5)?,
        ci_name: r.get(6)?,
        wbsid: r.get(7)?,
        task: r.get(8)?,
        price: r.get(9)?,
        minutes: r.get(10)?,
        note: r.get(11)?,
        pushed_at: r.get(12)?,
        undone_at: r.get(13)?,
    })
}

/// 그날 i-WMS 에 넣은 행(되돌린 것 포함), 최근 것 먼저.
pub fn pushes(conn: &Connection, day: &str) -> Result<Vec<Push>> {
    let sql = format!("SELECT {PUSH_COLS} FROM iwms_pushes WHERE day = ?1 ORDER BY id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([day], row_to_push)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 최근에 확정한(되돌리지 않은) 행 — 정제 프롬프트의 예시로 쓴다.
pub fn recent_pushes(conn: &Connection, limit: i64) -> Result<Vec<Push>> {
    let sql = format!("SELECT {PUSH_COLS} FROM iwms_pushes WHERE undone_at IS NULL ORDER BY id DESC LIMIT ?1");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([limit], row_to_push)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 확정 하나의 행을 한 트랜잭션으로 남긴다. `before` 는 카테고리별 저장 전 원형 행(JSON) — 되돌리기의 근거다.
pub fn record(
    conn: &mut Connection,
    commit_id: &str,
    day: &str,
    rows: &[NewPush],
    before: &dyn Fn(&NewPush) -> String,
) -> Result<Vec<Push>> {
    let now = crate::vault::now_stamp();
    let tx = conn.transaction()?;
    for p in rows {
        check_price(&p.price)?;
        tx.execute(
            "INSERT INTO iwms_pushes
               (commit_id, entry_id, day, title, ci_key, ci_name, wbsid, task, price, minutes, note, pushed_at, before_json)
             VALUES (:commit, :entry, :day, :title, :ci_key, :ci_name, :wbsid, :task, :price, :minutes, :note, :now, :before)",
            named_params! {
                ":commit": commit_id,
                ":entry": p.entry_id,
                ":day": day,
                ":title": p.title,
                ":ci_key": p.ci_key,
                ":ci_name": p.ci_name,
                ":wbsid": p.wbsid,
                ":task": p.task,
                ":price": p.price,
                ":minutes": p.minutes,
                ":note": p.note,
                ":now": now,
                ":before": before(p),
            },
        )?;
    }
    tx.commit()?;
    let sql = format!("SELECT {PUSH_COLS} FROM iwms_pushes WHERE commit_id = ?1 ORDER BY id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([commit_id], row_to_push)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 확정 하나의 행들과 카테고리별 저장 전 원형(`(ci_key, wbsid, before_json)`, 카테고리마다 하나).
pub fn commit_rows(conn: &Connection, commit_id: &str) -> Result<(Vec<Push>, Vec<(String, String, String)>)> {
    let sql = format!("SELECT {PUSH_COLS} FROM iwms_pushes WHERE commit_id = ?1 ORDER BY id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([commit_id], row_to_push)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = conn.prepare(
        "SELECT ci_key, wbsid, before_json FROM iwms_pushes WHERE commit_id = ?1
         GROUP BY ci_key, wbsid ORDER BY MIN(id)",
    )?;
    let before = stmt
        .query_map([commit_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok((rows, before))
}

pub fn mark_undone(conn: &Connection, commit_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE iwms_pushes SET undone_at = ?1 WHERE commit_id = ?2 AND undone_at IS NULL",
        (crate::vault::now_stamp(), commit_id),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::daylog::migrate(&conn).unwrap();
        conn
    }

    fn entry(conn: &Connection, vault: &str, day: &str, title: &str) -> i64 {
        conn.query_row(
            "INSERT INTO entries (day, vault_root, folder, title, body, at, seq, created_at, updated_at)
             VALUES (?1, ?2, NULL, ?3, '', '09:00', 1, 'now', 'now') RETURNING id",
            (day, vault, title),
            |r| r.get(0),
        )
        .unwrap()
    }

    fn push(entry_id: Option<i64>, wbsid: &str, minutes: i64) -> NewPush {
        NewPush {
            entry_id,
            title: "t".into(),
            ci_key: "A".into(),
            ci_name: "공통".into(),
            wbsid: wbsid.into(),
            task: "task".into(),
            price: "O".into(),
            minutes,
            note: "n".into(),
        }
    }

    #[test]
    fn marks_are_set_cleared_and_scoped_to_the_vault_and_day() {
        let conn = db();
        let a = entry(&conn, "/v", "2026-10-02", "a");
        let b = entry(&conn, "/v", "2026-10-02", "b");
        let other = entry(&conn, "/w", "2026-10-02", "c");
        set_mark(&conn, a, Some("O")).unwrap();
        set_mark(&conn, b, Some("N")).unwrap();
        set_mark(&conn, other, Some("O")).unwrap();
        set_mark(&conn, b, Some("O")).unwrap();
        assert_eq!(
            marks(&conn, "/v", "2026-10-02").unwrap(),
            [Mark { entry_id: a, price: "O".into() }, Mark { entry_id: b, price: "O".into() }]
        );
        set_mark(&conn, a, None).unwrap();
        assert_eq!(marks(&conn, "/v", "2026-10-02").unwrap().len(), 1);
        assert!(marks(&conn, "/v", "2026-10-03").unwrap().is_empty());
    }

    #[test]
    fn a_removed_entry_loses_its_mark_and_bad_input_is_refused() {
        let conn = db();
        let a = entry(&conn, "/v", "2026-10-02", "a");
        set_mark(&conn, a, Some("N")).unwrap();
        conn.execute("DELETE FROM entries WHERE id = ?1", [a]).unwrap();
        assert!(marks(&conn, "/v", "2026-10-02").unwrap().is_empty(), "고아 선택은 보이지 않는다");
        assert_eq!(set_mark(&conn, a, Some("O")).unwrap_err().kind, "not_found");
        let b = entry(&conn, "/v", "2026-10-02", "b");
        assert_eq!(set_mark(&conn, b, Some("I")).unwrap_err().kind, "invalid");
    }

    #[test]
    fn pushes_are_recorded_per_commit_and_survive_their_entry() {
        let mut conn = db();
        let a = entry(&conn, "/v", "2026-10-02", "a");
        let rows = vec![push(Some(a), "w1", 60), push(None, "w1", 30), push(Some(a), "w2", 10)];
        let saved = record(&mut conn, "c1", "2026-10-02", &rows, &|p| format!("[{}]", p.wbsid)).unwrap();
        assert_eq!(saved.len(), 3);
        conn.execute("DELETE FROM entries WHERE id = ?1", [a]).unwrap();

        let all = pushes(&conn, "2026-10-02").unwrap();
        assert_eq!(all.iter().map(|p| p.minutes).collect::<Vec<_>>(), [10, 30, 60]);
        let (rows, before) = commit_rows(&conn, "c1").unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            before,
            [("A".into(), "w1".into(), "[w1]".into()), ("A".into(), "w2".into(), "[w2]".into())],
            "저장 전 원형은 카테고리마다 하나"
        );

        mark_undone(&conn, "c1").unwrap();
        assert!(pushes(&conn, "2026-10-02").unwrap().iter().all(|p| p.undone_at.is_some()));
        assert!(recent_pushes(&conn, 10).unwrap().is_empty(), "되돌린 것은 예시로 쓰지 않는다");
    }
}
