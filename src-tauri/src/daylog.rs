//! 오늘의 한일 — 날짜별로 쌓이는 영구 기록.
//!
//! **왜 이것만 DB 인가.** 이 앱의 진실의 원천은 Obsidian Vault 다(`vault.rs`). 업무
//! 메타데이터는 `index.md` frontmatter 에 있고 별도 DB 가 없다 — Obsidian 에 보이는 것이
//! 곧 앱에 보이는 것이라는 약속이다. 오늘의 한일만 그 밖에 산다. 이 목록이 담는 것은
//! "어느 날 어떤 업무를 손댔는가" 이고, 그것은 어느 한 업무의 속성이 아니라 **날짜를 축으로
//! 한 교차 기록**이다. 노트로 남기면 Vault 에 날짜 노트가 하루 한 장씩 쌓이고 지우는 손이
//! 하나 더 생기며, 업무 폴더 안에 넣으면 "9월 3일에 뭐 했지" 에 답하려고 폴더 전체를
//! 뒤져야 한다. 날짜로 묻는 질문에는 날짜로 색인된 저장소가 답한다.
//!
//! 파일은 `~/.contextflow/today.db` 다. Vault **밖**이라 Vault 를 갈아타도 기록이 남고,
//! 행마다 `vault_root` 를 들고 있어 지금 Vault 의 것만 골라 읽는다. 같은 이유로 Vault 를
//! 통째로 옮기면 그 기록은 다른 Vault 의 것으로 보인다 — 절대 경로를 키로 쓰는 대가다.
//!
//! 저장소를 못 열면 커맨드는 오류를 돌려준다. 삼키지 않는 이유는 부르는 자리마다 원하는
//! 것이 달라서다 — 업무를 손댈 때의 기록은 프런트가 조용히 흘리고(파일을 저장할 때마다
//! 경고가 뜨면 안 된다), 사용자가 직접 연 팝업에서는 실패가 보여야 한다. 연결은 실패해도
//! 캐시하지 않으므로 다음 호출이 다시 시도한다.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::{named_params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

const DB_FILE: &str = "today.db";

/// 스키마 버전. 컬럼을 늘릴 때는 이 값을 올리고 `migrate` 에 계단을 하나 더 붙인다.
const SCHEMA_VERSION: i64 = 1;

/// `folder` 에 붙은 부분 유니크 인덱스가 이 스키마의 핵심이다. "같은 날 같은 업무는 한
/// 줄" 규칙을 DB 제약으로 지키면서, 팝업에서 손으로 넣는 자유 항목(`folder IS NULL`)은
/// 몇 개든 공존하게 한다. `WHERE folder IS NOT NULL` 을 명시하는 것은 SQLite 가 유니크
/// 인덱스에서 NULL 을 서로 다른 값으로 보는 성질에 기대지 않으려는 것이다 — 의도를
/// 스키마에 적어 두면 읽는 사람이 헷갈리지 않는다.
const DDL_V1: &str = "
CREATE TABLE IF NOT EXISTS entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT    NOT NULL,
  vault_root TEXT    NOT NULL,
  folder     TEXT,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  at         TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS entries_day_folder
  ON entries(day, vault_root, folder) WHERE folder IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_day ON entries(vault_root, day);
";

/// 기록 한 줄. `folder` 가 `None` 이면 업무와 연결되지 않은 자유 항목이라 눌러 갈 곳이 없다.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayEntry {
    pub id: i64,
    pub day: String,
    pub folder: Option<String>,
    pub title: String,
    pub body: String,
    pub at: String,
}

/// 팝업 왼쪽의 날짜 목록용. 본문까지 끌고 오지 않는다.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DaySummary {
    pub day: String,
    pub count: i64,
}

/// `localStorage` 시절의 한 줄. 1회 이관에만 쓴다.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    #[serde(default)]
    pub folder: Option<String>,
    pub title: String,
    #[serde(default)]
    pub at: String,
}

// ---------------------------------------------------------------------------
// 커넥션
// ---------------------------------------------------------------------------

/// 앱이 하나 들고 있는 커넥션. `RunRegistry`(`run.rs`) 와 같은 자리에 같은 방식으로 산다.
#[derive(Default)]
pub struct DayLog {
    /// 아직 열지 않았거나 열기에 실패했으면 `None`. 파일은 첫 사용 때 생긴다 — 이 기능을
    /// 쓰지 않는 사용자의 홈에 빈 DB 를 만들어 두지 않는다.
    conn: Mutex<Option<Connection>>,
}

impl DayLog {
    /// 뮤텍스 중독을 흡수한다. 한 번 poisoned 되면 기록 경로가 영구히 죽으므로
    /// `.unwrap()` 은 쓰지 않는다 — `run.rs` 의 `RunRegistry::lock` 과 같은 이유다.
    fn lock(&self) -> MutexGuard<'_, Option<Connection>> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 열려 있지 않으면 열고 스키마를 맞춘 뒤 넘겨준다. 열기에 실패한 것은 캐시하지
    /// 않으므로(=`None` 으로 남으므로) 다음 호출이 다시 시도한다.
    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.lock();
        if guard.is_none() {
            *guard = Some(open(db_path()?)?);
        }
        match guard.as_mut() {
            Some(conn) => f(conn),
            // `open` 이 성공했으면 여기 올 수 없다. 그래도 패닉 대신 오류로 돌려준다.
            None => Err(AppError::new("db", "기록 저장소를 열지 못했습니다")),
        }
    }
}

fn db_path() -> Result<PathBuf> {
    let dir = crate::app_home().map_err(AppError::io)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(DB_FILE))
}

fn open(path: PathBuf) -> Result<Connection> {
    let conn = Connection::open(path)?;
    // WAL 은 읽기가 쓰기를 막지 않게 한다. `pragma_update` 대신 batch 인 이유는
    // `journal_mode` 가 값을 한 줄 돌려주는 pragma 라 execute 계열이 거부하기 때문이다.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    if version < 1 {
        conn.execute_batch(DDL_V1)?;
    }
    // pragma 는 바인딩을 받지 않는다. 값이 코드 안의 상수라 문자열 조립이 안전하다.
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 쿼리
// ---------------------------------------------------------------------------

const SELECT_COLS: &str = "id, day, folder, title, body, at";

fn row_to_entry(row: &Row<'_>) -> rusqlite::Result<DayEntry> {
    Ok(DayEntry {
        id: row.get(0)?,
        day: row.get(1)?,
        folder: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        at: row.get(5)?,
    })
}

/// 업무 한 줄을 그날의 기록에 올린다.
///
/// `folder` 가 있으면 `(day, vault_root, folder)` 로 접히고 `at` 과 `seq` 만 새로 적힌다 —
/// 한 업무를 열 번 고친 날의 기록이 열 줄이 되면 읽을 수 없다. `seq` 를 그날의 최댓값 +1 로
/// 올리므로 다시 건드린 업무가 맨 위로 온다.
///
/// `body` 가 `None` 이면 **기존 본문을 건드리지 않는다**. 업무를 다시 손댔다는 이유로
/// 팝업에서 적어 둔 내용이 지워지면 안 된다.
fn insert_entry(
    conn: &Connection,
    vault: &str,
    day: &str,
    at: &str,
    folder: Option<&str>,
    title: &str,
    body: Option<&str>,
) -> Result<DayEntry> {
    let now = crate::vault::now_stamp();
    let sql = format!(
        "INSERT INTO entries (day, vault_root, folder, title, body, at, seq, created_at, updated_at)
         VALUES (
           :day, :vault, :folder, :title, COALESCE(:body, ''), :at,
           (SELECT IFNULL(MAX(seq), 0) + 1 FROM entries WHERE vault_root = :vault AND day = :day),
           :now, :now
         )
         ON CONFLICT(day, vault_root, folder) WHERE folder IS NOT NULL DO UPDATE SET
           title      = excluded.title,
           body       = COALESCE(:body, entries.body),
           at         = excluded.at,
           seq        = excluded.seq,
           updated_at = excluded.updated_at
         RETURNING {SELECT_COLS}"
    );
    let entry = conn.query_row(
        &sql,
        named_params! {
            ":day": day,
            ":vault": vault,
            ":folder": folder,
            ":title": title,
            ":body": body,
            ":at": at,
            ":now": now,
        },
        row_to_entry,
    )?;
    Ok(entry)
}

// ---------------------------------------------------------------------------
// 커맨드
// ---------------------------------------------------------------------------
//
// 로컬 SQLite 의 단일 행 조작이라 `spawn_blocking` 없이 동기 커맨드로 둔다 —
// `run::cancel_run` 이 이미 `State` 를 받는 동기 커맨드다.

/// 그 날짜의 기록을 최신 먼저 돌려준다.
#[tauri::command]
pub fn day_entries(
    state: tauri::State<'_, DayLog>,
    vault: String,
    day: String,
) -> Result<Vec<DayEntry>> {
    state.with(|conn| {
        let sql = format!(
            "SELECT {SELECT_COLS} FROM entries
             WHERE vault_root = ?1 AND day = ?2
             ORDER BY seq DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map((&vault, &day), row_to_entry)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 기록이 있는 날짜와 건수를 최신 먼저. 팝업 왼쪽 목록이 쓴다.
///
/// `from`/`to` 는 `YYYY-MM-DD` 이고 양끝을 포함한다. 날짜가 사전식으로 정렬되는 형식이라
/// 문자열 비교가 곧 날짜 비교다.
#[tauri::command]
pub fn day_index(
    state: tauri::State<'_, DayLog>,
    vault: String,
    from: String,
    to: String,
) -> Result<Vec<DaySummary>> {
    state.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT day, COUNT(*) FROM entries
             WHERE vault_root = ?1 AND day >= ?2 AND day <= ?3
             GROUP BY day ORDER BY day DESC",
        )?;
        let rows = stmt.query_map((&vault, &from, &to), |row| {
            Ok(DaySummary { day: row.get(0)?, count: row.get(1)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
}

/// 기록 한 줄을 올린다(같은 날 같은 업무는 접힌다). `folder` 가 `None` 이면 항상 새 줄이다.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn note_day_entry(
    state: tauri::State<'_, DayLog>,
    vault: String,
    day: String,
    at: String,
    folder: Option<String>,
    title: String,
    body: Option<String>,
) -> Result<DayEntry> {
    state.with(|conn| {
        insert_entry(conn, &vault, &day, &at, folder.as_deref(), &title, body.as_deref())
    })
}

/// 팝업에서 제목과 본문을 고친다. **`seq` 는 건드리지 않는다** — 고치는 것이 순서를 바꾸는
/// 일이 되면, 오타 하나 고친 항목이 그날 목록의 맨 위로 튀어 오른다.
#[tauri::command]
pub fn edit_day_entry(
    state: tauri::State<'_, DayLog>,
    id: i64,
    title: String,
    body: String,
) -> Result<DayEntry> {
    state.with(|conn| {
        let sql = format!(
            "UPDATE entries SET title = ?1, body = ?2, updated_at = ?3
             WHERE id = ?4
             RETURNING {SELECT_COLS}"
        );
        let now = crate::vault::now_stamp();
        conn.query_row(&sql, (&title, &body, &now, id), row_to_entry)
            .optional()?
            .ok_or_else(|| AppError::new("not_found", "이미 지워진 기록입니다"))
    })
}

/// 기록 한 줄을 지운다. 이미 없는 줄을 지우는 것은 오류가 아니다 — 같은 ✕ 를 두 번 누른
/// 것과 팝업과 도크에서 같은 줄을 지운 것이 모두 이 경우다.
#[tauri::command]
pub fn remove_day_entry(state: tauri::State<'_, DayLog>, id: i64) -> Result<()> {
    state.with(|conn| {
        conn.execute("DELETE FROM entries WHERE id = ?1", (id,))?;
        Ok(())
    })
}

/// 업무 폴더 경로가 바뀐 것을 기록에도 반영한다(업무명 변경 · Archive 로 이동).
///
/// **과거 날짜의 줄까지 모두** 따라간다. 경로가 기본키라 이걸 안 하면 지난주의 그 줄은
/// 없는 업무를 가리키고, 눌러도 아무 일이 일어나지 않는다.
#[tauri::command]
pub fn relocate_day_entries(
    state: tauri::State<'_, DayLog>,
    vault: String,
    from: String,
    to: String,
    title: String,
) -> Result<()> {
    state.with(|conn| {
        // `OR REPLACE` 는 목적지 경로의 같은 날 줄이 이미 있을 때를 위한 것이다(옛 업무를
        // 보관한 자리에 새 업무가 같은 이름으로 들어선 경우). 그때 남길 것은 지금 옮기는
        // 쪽이다 — 한 업무당 한 줄이라는 규칙이 곧 이 기록의 읽는 방식이다.
        let now = crate::vault::now_stamp();
        conn.execute(
            "UPDATE OR REPLACE entries SET folder = ?1, title = ?2, updated_at = ?3
             WHERE vault_root = ?4 AND folder = ?5",
            (&to, &title, &now, &vault, &from),
        )?;
        Ok(())
    })
}

/// `localStorage` 에 있던 옛 목록을 옮긴다. 부팅 때 한 번만 부른다.
///
/// 하나의 트랜잭션으로 묶는 이유는 중간에 실패했을 때 절반만 옮겨진 기록이 남지 않게 하는
/// 것이다 — 프런트는 이 호출이 성공한 뒤에야 `localStorage` 키를 지운다.
#[tauri::command]
pub fn import_day_log(
    state: tauri::State<'_, DayLog>,
    vault: String,
    day: String,
    rows: Vec<ImportRow>,
) -> Result<usize> {
    state.with(|conn| {
        let tx = conn.transaction()?;
        let mut n = 0;
        // 옛 목록은 최신이 앞이다. 거꾸로 넣어야 `seq` 가 오래된 것부터 올라가 순서가 산다.
        for row in rows.iter().rev() {
            let folder = row.folder.as_deref().filter(|f| !f.is_empty());
            insert_entry(&tx, &vault, &day, &row.at, folder, &row.title, None)?;
            n += 1;
        }
        tx.commit()?;
        Ok(n)
    })
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트는 파일을 만들지 않는다 — 스키마와 쿼리가 검증 대상이고 둘 다 메모리에서 같다.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    const V: &str = "/vault";
    const DAY: &str = "2026-09-11";

    fn note(conn: &Connection, folder: Option<&str>, title: &str, at: &str) -> DayEntry {
        insert_entry(conn, V, DAY, at, folder, title, None).unwrap()
    }

    fn titles(conn: &Connection, day: &str) -> Vec<String> {
        let sql = format!(
            "SELECT {SELECT_COLS} FROM entries WHERE vault_root = ?1 AND day = ?2 ORDER BY seq DESC"
        );
        let mut stmt = conn.prepare(&sql).unwrap();
        let rows = stmt.query_map((V, day), row_to_entry).unwrap();
        rows.map(|r| r.unwrap().title).collect()
    }

    /// `fsops` · `vault` 의 테스트와 같은 방식으로 손으로 만든 임시 폴더.
    /// `tempfile` 은 이 프로젝트의 dev-dependency 가 아니다.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "contextflow-daylog-{}-{}",
                tag,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 메모리가 아닌 **파일**로 한 번은 돌려 본다 — `open` 의 WAL pragma 와 마이그레이션이
    /// 실제 파일에서도 통과하는지, 그리고 닫고 다시 열면 기록이 남아 있는지가 이 기능의
    /// 약속 자체다("반영구적으로 보관").
    #[test]
    fn a_file_backed_log_survives_being_closed_and_reopened() {
        let dir = TempDir::new("file");
        let path = dir.0.join("today.db");

        {
            let conn = open(path.clone()).unwrap();
            insert_entry(&conn, V, DAY, "09:00", Some("/t/a"), "어제 만든 업무", None).unwrap();
            insert_entry(&conn, V, DAY, "10:00", None, "회의", Some("본문")).unwrap();
        }
        assert!(path.is_file());

        // 같은 파일을 다시 연다. `migrate` 는 이미 올라간 버전을 보고 아무것도 하지 않는다.
        let conn = open(path).unwrap();
        assert_eq!(titles(&conn, DAY), ["회의", "어제 만든 업무"]);

        let body: String = conn
            .query_row("SELECT body FROM entries WHERE folder IS NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "본문");
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let conn = db();
        note(&conn, Some("/vault/Tasks/a"), "a", "09:00");
        migrate(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert_eq!(titles(&conn, DAY), ["a"]);
    }

    #[test]
    fn same_task_same_day_folds_into_one_line_and_rises() {
        let conn = db();
        note(&conn, Some("/vault/Tasks/a"), "a", "09:00");
        note(&conn, Some("/vault/Tasks/b"), "b", "10:00");
        let again = note(&conn, Some("/vault/Tasks/a"), "a 이름 바뀜", "17:20");

        // 두 줄뿐이고, 다시 건드린 쪽이 맨 위다.
        assert_eq!(titles(&conn, DAY), ["a 이름 바뀜", "b"]);
        assert_eq!(again.at, "17:20");
    }

    #[test]
    fn touching_a_task_again_keeps_the_body_written_in_the_popup() {
        let conn = db();
        let row = insert_entry(&conn, V, DAY, "09:00", Some("/t/a"), "a", Some("메모 본문")).unwrap();
        assert_eq!(row.body, "메모 본문");

        // 업무를 다시 손댄 것은 본문을 지우는 일이 아니다.
        let again = insert_entry(&conn, V, DAY, "11:00", Some("/t/a"), "a", None).unwrap();
        assert_eq!(again.body, "메모 본문");
        assert_eq!(again.id, row.id);
    }

    #[test]
    fn free_entries_never_collapse_into_each_other() {
        let conn = db();
        note(&conn, None, "회의", "09:00");
        note(&conn, None, "전화", "10:00");
        note(&conn, None, "회의", "11:00"); // 제목이 같아도 다른 줄이다
        assert_eq!(titles(&conn, DAY).len(), 3);
    }

    #[test]
    fn a_different_vault_is_a_different_log() {
        let conn = db();
        note(&conn, Some("/vault/Tasks/a"), "a", "09:00");
        insert_entry(&conn, "/other", DAY, "09:00", Some("/other/Tasks/a"), "남의 업무", None)
            .unwrap();
        assert_eq!(titles(&conn, DAY), ["a"]);
    }

    #[test]
    fn each_day_keeps_its_own_lines() {
        let conn = db();
        note(&conn, Some("/t/a"), "어제의 a", "09:00");
        insert_entry(&conn, V, "2026-09-12", "09:00", Some("/t/a"), "오늘의 a", None).unwrap();
        assert_eq!(titles(&conn, DAY), ["어제의 a"]);
        assert_eq!(titles(&conn, "2026-09-12"), ["오늘의 a"]);
    }

    #[test]
    fn editing_does_not_reorder_the_day() {
        let conn = db();
        let first = note(&conn, Some("/t/a"), "a", "09:00");
        note(&conn, Some("/t/b"), "b", "10:00");

        let sql = format!(
            "UPDATE entries SET title = ?1, body = ?2 WHERE id = ?3 RETURNING {SELECT_COLS}"
        );
        let edited: DayEntry = conn
            .query_row(&sql, ("a 고침", "본문", first.id), row_to_entry)
            .unwrap();
        assert_eq!(edited.body, "본문");
        // 고친 줄이 위로 튀어 오르지 않는다.
        assert_eq!(titles(&conn, DAY), ["b", "a 고침"]);
    }

    #[test]
    fn relocating_follows_past_days_too() {
        let conn = db();
        insert_entry(&conn, V, "2026-09-01", "09:00", Some("/t/옛 이름"), "옛 이름", None).unwrap();
        insert_entry(&conn, V, DAY, "09:00", Some("/t/옛 이름"), "옛 이름", None).unwrap();

        conn.execute(
            "UPDATE OR REPLACE entries SET folder = ?1, title = ?2
             WHERE vault_root = ?3 AND folder = ?4",
            ("/t/Archive/새 이름", "새 이름", V, "/t/옛 이름"),
        )
        .unwrap();

        assert_eq!(titles(&conn, "2026-09-01"), ["새 이름"]);
        assert_eq!(titles(&conn, DAY), ["새 이름"]);
        let folders: Vec<Option<String>> = conn
            .prepare("SELECT folder FROM entries ORDER BY day")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(folders.iter().all(|f| f.as_deref() == Some("/t/Archive/새 이름")));
    }

    #[test]
    fn relocating_onto_an_occupied_path_leaves_one_line() {
        let conn = db();
        note(&conn, Some("/t/옛 업무"), "옛 업무", "09:00");
        note(&conn, Some("/t/새 업무"), "새 업무", "10:00");

        // 옛 업무가 새 업무의 경로로 옮겨 간다 — 같은 날 같은 경로에 두 줄이 될 수 없다.
        conn.execute(
            "UPDATE OR REPLACE entries SET folder = ?1, title = ?2
             WHERE vault_root = ?3 AND folder = ?4",
            ("/t/새 업무", "옮겨 온 업무", V, "/t/옛 업무"),
        )
        .unwrap();
        assert_eq!(titles(&conn, DAY), ["옮겨 온 업무"]);
    }

    #[test]
    fn the_day_index_counts_lines_per_day() {
        let conn = db();
        note(&conn, Some("/t/a"), "a", "09:00");
        note(&conn, None, "회의", "10:00");
        insert_entry(&conn, V, "2026-09-12", "09:00", Some("/t/b"), "b", None).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT day, COUNT(*) FROM entries
                 WHERE vault_root = ?1 AND day >= ?2 AND day <= ?3
                 GROUP BY day ORDER BY day DESC",
            )
            .unwrap();
        let rows: Vec<DaySummary> = stmt
            .query_map((V, "2026-09-01", "2026-09-30"), |row| {
                Ok(DaySummary { day: row.get(0)?, count: row.get(1)? })
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(
            rows,
            [
                DaySummary { day: "2026-09-12".into(), count: 1 },
                DaySummary { day: DAY.into(), count: 2 },
            ]
        );
    }

    #[test]
    fn importing_keeps_the_newest_first_order_of_the_old_list() {
        let conn = db();
        // 옛 `localStorage` 목록은 최신이 앞이다.
        let rows = [("/t/c", "c"), ("/t/b", "b"), ("/t/a", "a")];
        for (folder, title) in rows.iter().rev() {
            note(&conn, Some(folder), title, "09:00");
        }
        assert_eq!(titles(&conn, DAY), ["c", "b", "a"]);
    }
}
