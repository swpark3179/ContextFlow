//! 자식 프로세스 실행 헬퍼 — 탐지(`--version`)와 실행(`run.rs`)이 함께 쓴다.
//!
//! Windows 특이사항 두 가지를 여기서 흡수한다: `.cmd`/`.bat` shim 은 `cmd.exe` 로
//! 감싸야 하고, 콘솔 창이 깜빡이지 않도록 `CREATE_NO_WINDOW` 를 붙여야 한다.

use std::ffi::OsStr;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;

use wait_timeout::ChildExt;

/// `run_capture` 의 결과. spawn 자체가 실패한 경우와 실행 후 실패를 구분한다.
pub struct Captured {
    pub stdout: String,
    pub status_code: Option<i32>,
    pub timed_out: bool,
    pub spawn_error: Option<std::io::Error>,
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// 실행 파일 경로와 인자로 `Command` 를 만든다.
///
/// `.cmd`/`.bat` 은 `cmd.exe /d /s /c <path> <args>` 로 감싼다. Rust 표준 라이브러리의
/// *BatBadBut* 완화책이 배치 파일에 인자 전달을 거부하므로, 진짜 `.exe` 인 `cmd.exe` 를
/// 거쳐 우회한다. `/d` 는 AutoRun 생략, `/s /c` 는 나머지를 명령으로 실행.
///
/// **호출부는 항상 인자를 1개 이상 넘겨야 한다.** 뒤에 인자가 하나도 없으면 `/s` 의
/// "바깥 따옴표 제거" 규칙이 발동해 공백 포함 경로가 잘못 파싱된다.
pub fn command_for<S: AsRef<OsStr>>(path: &str, args: &[S]) -> Command {
    let lower = path.to_ascii_lowercase();
    let is_shim = lower.ends_with(".cmd") || lower.ends_with(".bat");
    let mut cmd = if is_shim {
        let mut c = Command::new("cmd.exe");
        c.arg("/d").arg("/s").arg("/c").arg(path);
        for a in args {
            c.arg(a);
        }
        c
    } else {
        let mut c = Command::new(path);
        for a in args {
            c.arg(a);
        }
        c
    };
    no_window(&mut cmd);
    cmd
}

/// 실행 후 stdout 을 통째로 걷어 온다. 타임아웃을 넘기면 자식을 죽인다.
///
/// stdout/stderr 를 **각각 별도 스레드에서** 끝까지 읽는다. 출력이 파이프 버퍼(보통 64KB)를
/// 채우면 자식이 쓰기에서 블록되고 우리는 `wait` 에서 블록되어 서로 멈춘다.
pub fn run_capture<S: AsRef<OsStr>>(path: &str, args: &[S], timeout: Duration) -> Captured {
    let mut cmd = command_for(path, args);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Captured {
                stdout: String::new(),
                status_code: None,
                timed_out: false,
                spawn_error: Some(e),
            }
        }
    };

    let out = child.stdout.take();
    let err = child.stderr.take();
    let out_handle = std::thread::spawn(move || drain(out));
    let err_handle = std::thread::spawn(move || drain(err));

    let (status_code, timed_out) = match child.wait_timeout(timeout) {
        Ok(Some(status)) => (status.code(), false),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            (None, true)
        }
        Err(_) => (None, false),
    };

    let stdout = out_handle.join().unwrap_or_default();
    let _ = err_handle.join();

    Captured { stdout, status_code, timed_out, spawn_error: None }
}

fn drain<R: Read>(reader: Option<R>) -> String {
    let mut buf = Vec::new();
    if let Some(mut r) = reader {
        let _ = r.read_to_end(&mut buf);
    }
    // 깨진 바이트 하나가 나머지를 통째로 버리지 않도록 lossy 로 읽는다.
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_paths_route_through_cmd_exe() {
        let cmd = command_for("C:\\tools\\claude.cmd", &["--version"]);
        assert_eq!(cmd.get_program(), OsStr::new("cmd.exe"));
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["/d", "/s", "/c", "C:\\tools\\claude.cmd", "--version"]);
    }

    #[test]
    fn plain_paths_run_directly() {
        let cmd = command_for("/usr/bin/claude", &["--version"]);
        assert_eq!(cmd.get_program(), OsStr::new("/usr/bin/claude"));
        let args: Vec<_> = cmd.get_args().collect();
        assert_eq!(args, vec!["--version"]);
    }

    #[test]
    fn missing_binary_reports_spawn_error() {
        let r = run_capture(
            "/nonexistent/contextflow-test-binary",
            &["--version"],
            Duration::from_secs(2),
        );
        assert!(r.spawn_error.is_some());
    }
}
