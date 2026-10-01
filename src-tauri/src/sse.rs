//! 원격 커넥터(FabriX 의 두 방식)가 공유하는 SSE 읽기.
//!
//! 예전에는 두 원격 커넥터(AI Pro · FabriX)가 같은 루프를 따로 들고 있었는데, 그 루프에는
//! 두 가지 결함이 함께 있었다.
//!
//! * **유휴 상한이 숨어 있었다.** reqwest blocking 클라이언트는 `timeout` 을 주지 않으면
//!   기본 30초를 건다(헤더 대기와 본문 읽기 한 번마다). 코드 주석은 "타임아웃 없음" 이라고
//!   적었지만 실제로는 30초 동안 한 글자도 오지 않으면 끊겼고, 긴 프롬프트(위키 반영)는
//!   첫 토큰 전에 잘린 뒤 세 번 재시도됐다. 이제 상한을 [`STREAM_IDLE`] 로 **명시**한다.
//! * **취소가 다음 줄을 기다렸다.** 읽기가 막혀 있는 동안에는 취소 플래그를 볼 수 없어서,
//!   느린 서버에서는 [취소] 가 길게는 유휴 상한만큼 늦게 먹었다. 이제 읽기는 별도 스레드가
//!   하고 이 루프는 짧게 깨어나 플래그를 본다 — 취소하면 곧바로 돌아오고, 남은 읽기 스레드는
//!   다음 바이트나 상한에서 스스로 끝난다(받는 쪽이 사라졌으니 보낼 곳이 없다).

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::run::RunEvent;

/// 조각과 조각 사이에 허용하는 최대 공백. **전체** 길이 상한이 아니다 — 긴 답변이 몇 분씩
/// 이어지는 것은 정상이고, 문제는 한참 동안 아무것도 오지 않는 것이다. 추론 모델은 첫
/// 토큰 전에 오래 생각하므로 넉넉히 잡는다.
pub const STREAM_IDLE: Duration = Duration::from_secs(180);

/// 취소 플래그를 보는 간격.
const POLL: Duration = Duration::from_millis(150);

/// SSE 본문을 끝까지 읽어 이벤트로 흘려보낸다. 종료 상태(`succeeded`/`failed`/`canceled`)를
/// 돌려준다.
///
/// * 줄 단위로 자른다 — `\n\n` 으로 이벤트를 나누는 파서는 WSO2 게이트웨이가 보내는
///   `\r\n\r\n` 을 놓친다. 줄 끝의 `\r` 은 떼어 낸다.
/// * `data:` 줄만 본다(`event:` · `id:` · 주석은 이 서비스들에서 의미가 없다).
/// * `[DONE]` 에서 멈춘다 — 그 뒤로 오는 것은 없어야 하고, 연결을 붙잡을 이유도 없다.
/// * 바이트를 모았다가 줄이 끝날 때만 디코딩하므로 한글이 청크 경계에서 깨지지 않는다.
pub fn pump<R: Read + Send + 'static>(
    resp: R,
    canceled: &AtomicBool,
    idle: Duration,
    parse: &mut dyn FnMut(&str) -> Vec<RunEvent>,
    on_event: &mut dyn FnMut(RunEvent),
) -> String {
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(resp);
        loop {
            let mut buf = Vec::new();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    if tx.send(Ok(buf)).is_err() {
                        break; // 받는 쪽이 떠났다(취소)
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                    break;
                }
            }
        }
    });

    let mut had_error = false;
    let mut last = Instant::now();
    loop {
        if canceled.load(Ordering::Relaxed) {
            return "canceled".to_string();
        }
        match rx.recv_timeout(POLL) {
            Ok(Ok(bytes)) => {
                last = Instant::now();
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim_end_matches(['\r', '\n']);
                let data = match line.strip_prefix("data:") {
                    Some(rest) => rest.trim(),
                    None => continue,
                };
                if data == "[DONE]" {
                    break;
                }
                for ev in parse(data) {
                    if matches!(ev, RunEvent::Error { .. }) {
                        had_error = true;
                    }
                    on_event(ev);
                }
            }
            Ok(Err(e)) => {
                on_event(RunEvent::Error { message: format!("응답 스트림이 끊겼습니다: {e}") });
                had_error = true;
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last.elapsed() >= idle {
                    on_event(RunEvent::Error {
                        message: format!(
                            "AI 서비스가 {}초 동안 응답하지 않았습니다.",
                            idle.as_secs()
                        ),
                    });
                    had_error = true;
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // 정상 종료(EOF)
        }
    }

    if canceled.load(Ordering::Relaxed) {
        "canceled".to_string()
    } else if had_error {
        "failed".to_string()
    } else {
        "succeeded".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn text_parser() -> impl FnMut(&str) -> Vec<RunEvent> {
        |d: &str| {
            if d.is_empty() {
                Vec::new()
            } else if let Some(m) = d.strip_prefix("ERR ") {
                vec![RunEvent::Error { message: m.to_string() }]
            } else {
                vec![RunEvent::TextDelta { delta: d.to_string() }]
            }
        }
    }

    fn run(body: &str) -> (String, Vec<RunEvent>) {
        let flag = AtomicBool::new(false);
        let mut evs = Vec::new();
        let mut parse = text_parser();
        let status = pump(
            Cursor::new(body.as_bytes().to_vec()),
            &flag,
            Duration::from_secs(5),
            &mut parse,
            &mut |e| evs.push(e),
        );
        (status, evs)
    }

    #[test]
    fn reads_data_lines_with_lf_and_crlf() {
        let (status, evs) = run("data: 가\r\n\r\nevent: x\ndata:나\n: 주석\ndata: 다");
        assert_eq!(status, "succeeded");
        assert_eq!(
            evs,
            vec![
                RunEvent::TextDelta { delta: "가".into() },
                RunEvent::TextDelta { delta: "나".into() },
                RunEvent::TextDelta { delta: "다".into() },
            ]
        );
    }

    #[test]
    fn stops_at_done() {
        let (status, evs) = run("data: a\ndata: [DONE]\ndata: b\n");
        assert_eq!(status, "succeeded");
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "a".into() }]);
    }

    #[test]
    fn parser_errors_fail_the_run() {
        let (status, evs) = run("data: a\ndata: ERR 터짐\n");
        assert_eq!(status, "failed");
        assert_eq!(evs.last(), Some(&RunEvent::Error { message: "터짐".into() }));
    }

    /// 한글 한 글자가 바이트 경계에 걸쳐도 줄이 끝날 때 디코딩하므로 깨지지 않는다.
    #[test]
    fn multibyte_split_is_not_mangled() {
        struct Dribble(Vec<u8>, usize);
        impl Read for Dribble {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.1 >= self.0.len() || out.is_empty() {
                    return Ok(0);
                }
                out[0] = self.0[self.1];
                self.1 += 1;
                Ok(1)
            }
        }
        let flag = AtomicBool::new(false);
        let mut evs = Vec::new();
        let mut parse = text_parser();
        pump(
            Dribble("data: 한글\n".as_bytes().to_vec(), 0),
            &flag,
            Duration::from_secs(5),
            &mut parse,
            &mut |e| evs.push(e),
        );
        assert_eq!(evs, vec![RunEvent::TextDelta { delta: "한글".into() }]);
    }

    /// 아무것도 오지 않는 읽기에 매달려 있어도 취소는 곧바로 먹어야 한다.
    struct Stall;
    impl Read for Stall {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            std::thread::sleep(Duration::from_secs(2));
            Ok(0)
        }
    }

    #[test]
    fn cancel_returns_without_waiting_for_the_next_line() {
        let flag = AtomicBool::new(true);
        let started = Instant::now();
        let mut parse = text_parser();
        let status = pump(Stall, &flag, Duration::from_secs(60), &mut parse, &mut |_| {});
        assert_eq!(status, "canceled");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn idle_limit_fails_with_a_reason() {
        let flag = AtomicBool::new(false);
        let mut evs = Vec::new();
        let mut parse = text_parser();
        let status =
            pump(Stall, &flag, Duration::from_millis(400), &mut parse, &mut |e| evs.push(e));
        assert_eq!(status, "failed");
        assert!(matches!(&evs[0], RunEvent::Error { message } if message.contains("응답하지")));
    }
}
