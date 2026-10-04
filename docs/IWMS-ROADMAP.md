# i-WMS 업무량 자동입력 로드맵

'오늘의 한일'(`~/.contextflow/today.db`)에 날짜별로 쌓인 업무를 i-WMS 의 MH(공수)로 옮겨 적는 일을 앱이 돕는다.
업무마다 **대가포함 여부**를 고르면 AI 가 그 업무들의 **i-WMS 카테고리를 고르고 · 분을 배분하고 · 상세내용을 정제**하고,
사람이 검토해 **[최종 확정]** 하면 그날 i-WMS 에 입력된다. 연결 · 카테고리 지정 · 정제 템플릿은 설정의 **i-WMS 탭**에서 정한다.
이 문서는 그 단계별 구현 계획이다. 다른 저장소에 그대로 옮길 수 있게 변경을 `docs/iwms-port/` 에 함께 남긴다.

## 1. 요구 — 무엇을 하려는가

* 오늘의 한일 팝업에서 업무마다 **3단 선택** `[입력 안 함 | 대가포함 | 대가미포함]`. 고른 업무만 자동입력 대상이다.
  선택은 DB 에 남아 팝업을 다시 열어도 그대로다.
* 버튼 하나로 고른 업무 각각의 **카테고리 · 분 · 상세내용**을 AI 가 제안한다. 분은 그날 기준시간(보통 480분)에서 이미
  i-WMS 에 입력된 분을 뺀 나머지를 배분한다. 사람은 검토 화면에서 무엇이든 고칠 수 있다.
* **[최종 확정]** 을 누르면 그 날짜의 그 카테고리에 입력된다. 이미 입력된 다른 업무는 건드리지 않는다.
* 설정의 i-WMS 탭: 연결(SSO), 쓸 카테고리 지정(그날 입력 가능한 목록을 보고 고른다), 정제 템플릿(공통 작성 규칙 ·
  카테고리별 샘플 문구).
* "카테고리 등록" 은 **MH(업무량) 등록**을 말한다. i-WMS '나의 MH 설정' 에 카테고리를 더하는 API 는 캡처된 적이 없어
  범위 밖이다 — 그 화면은 링크로 연다.

## 2. 재료 — 참고한 것

| 출처 | 무엇 | 이 기능에서 쓰는 곳 |
| --- | --- | --- |
| `Desktop/auto-wms/app` (Tauri 2.11.5 + React + Rust — **이 앱과 같은 스택**) | `iwms.rs`(REST 클라이언트 · 저장 페이로드) · `lib.rs`(WebView2 세션 창) · `planner.rs`(분류 프롬프트) · `guards.rs` | 클라이언트 · 세션 · 프롬프트 규칙의 원형 |
| `Desktop/auto-wms/docs/MH-INPUT-SCREENS.md` | 저장 API 실측 명세(§6) | 탭 통째 치환 · 다건 `rowseq` · 실패도 200 |
| `Desktop/mcp-wms` (Python MCP) | `service.py` 의 미리보기 → 확인 토큰 → 지문 비교 → 저장 → 재조회 검증 | 확정 안전장치 |
| 오늘의 한일 `today.db` | 날짜 · 업무 폴더 · 제목 · 내용 | 정제의 원문. 내용이 비어 있는 날이 많아 업무 폴더(`index.md` 개요 · Run Log · 카테고리)를 함께 싣는다 |

## 3. 제약 — 설계를 정하는 것들

* **저장은 탭을 통째로 바꾼다.** `POST /rest/iwms/MhRegistration/save` 에 실은 탭은 그 날짜의 그 탭 행 전체로 치환된다.
  행을 구조체로 받으면 모르는 필드가 사라지므로 `serde_json::Value` 원형을 지키고 쓰는 필드만 바꾼다.
* **실패도 HTTP 200 이다.** 응답 본문의 `errorCode == "200"` 일 때만 성공이고, 그래도 다시 조회해 대조한다.
* **인증은 `SESSION` 쿠키 하나다.** CSRF 가 없다. 사내 통합인증(SSO)으로 쿠키가 생기며, 앱은 비밀번호를 받지 않는다.
  쿠키는 메모리에만 둔다(로그 · 응답 · 파일에 남기지 않는다).
* **원격 페이지에 IPC 를 열지 않는다.** 세션 창은 capability 가 없는 별도 창이다(`capabilities/default.json` 은 `main` 만).
* **업무 내용이 AI 로 나간다.** 기능별 연결(`iwms.refine`)로 사내 FabriX 만 쓰게 고를 수 있어야 한다.
* **모달을 겹치지 않는다**(`DayLogModal.tsx`). 검토 화면은 오늘의 한일을 대신해 뜬다.
* **이식하기 쉬워야 한다.** 기능 코드는 새 폴더(`src-tauri/src/iwms/` · `src/lib/iwms/`)와 새 파일에 모으고, 기존 파일
  편집은 등록 몇 줄 · 팝업 · 설정 화면으로 한정한다. 의존성은 늘리지 않는다.

## 4. 핵심 결정

| 주제 | 결정 | 이유 |
| --- | --- | --- |
| 세션 | 앱이 **WebView2 창**(`iwms-session`)으로 i-WMS 를 열고 `cookies_for_url` 로 SESSION 을 읽는다. 0.7초 간격 · 90초 한도, 성공하면 창을 닫는다. 쿠키 읽기는 async 커맨드에서만(WebView2 데드락) | Chrome 이 필요 없고 통합인증으로 SSO 가 저절로 된다. auto-wms 가 같은 Tauri 버전에서 실사용으로 검증했다 |
| HTTP | `reqwest::blocking` 을 `spawn_blocking` 안에서. 프록시 우회(`no_proxy`), 타임아웃 10/60초 | 이 앱의 관례(IPC 스레드에서 막지 않는다). 사내 호스트가 `NO_PROXY` 에 없어 프록시를 타면 SSO 가 깨진다 |
| 설정 | 백엔드 소유 `~/.contextflow/iwms.json`, `fsops::replace_text` 로 원자적 쓰기. 비밀값 없음 | `useStore.ts` 를 건드리지 않아 이식 충돌이 적다. `ai.json` 과 같은 선례 |
| 대가 선택 · 입력 이력 | `today.db` 스키마 v2 — `iwms_marks` · `iwms_pushes` | `entries` · `DayEntry` 모양은 그대로다. 외래키가 꺼져 있어 JOIN 으로 고아 행을 숨긴다 |
| 대가 구분 | i-WMS 행의 `priceType`: `O`(운영) = 대가포함, `N`(비대상) = 대가미포함. 후보는 그 값으로 거른다 | 같은 카테고리 코드가 두 탭에 있을 수 있고, 어느 탭에 넣느냐가 청구를 정한다 |
| 쓰기 규칙 | **덧붙이기만 한다.** 그 카테고리의 기존 활성 행은 원형 그대로 두고 순번만 다시 매기며 새 행을 뒤에 붙인다 | 사람이 웹에서 넣은 행을 앱이 지우는 일이 없다. 지울 수 있는 것은 앱이 넣은 행뿐(되돌리기) |
| 확정 안전장치 | 미리보기 → 대상 행 지문(SHA-256) + 10분 일회용 토큰 → 확정 때 다시 조회해 지문 비교 → 저장 → 재조회 대조 | 미리보기와 확정 사이에 웹에서 고친 것을 덮어쓰지 않는다(mcp-wms) |
| AI | 기존 기능별 연결 · 프롬프트 팩에 `iwms.refine` 을 더한다. 출력은 펜스 JSON, 형식 위반이면 한 번 고쳐 묻는다 | 새 연결 체계를 만들지 않는다. 사내 연결을 고를 수 있다 |
| 분 배분 | AI 가 제안하고 앱이 `fitMinutes` 로 합을 남은 시간에 맞춘다(10분 단위, 사람이 고친 값은 잠금) | AI 의 합계 산수를 믿지 않는다 |

## 5. 데이터 모델

`today.db` v2(`daylog.rs` 의 `SCHEMA_VERSION = 2`, `DDL_V2`):

```sql
CREATE TABLE iwms_marks (                 -- 행이 없음 = 입력 안 함
  entry_id   INTEGER PRIMARY KEY,
  price      TEXT NOT NULL CHECK (price IN ('O','N')),
  updated_at TEXT NOT NULL);
CREATE TABLE iwms_pushes (                -- i-WMS 에 실제로 넣은 행. 되돌리기 · 학습의 근거
  id INTEGER PRIMARY KEY AUTOINCREMENT, commit_id TEXT NOT NULL, entry_id INTEGER, day TEXT NOT NULL,
  title TEXT NOT NULL, ci_key TEXT NOT NULL, ci_name TEXT NOT NULL, wbsid TEXT NOT NULL, task TEXT NOT NULL,
  price TEXT NOT NULL, minutes INTEGER NOT NULL, note TEXT NOT NULL, pushed_at TEXT NOT NULL,
  undone_at TEXT, before_json TEXT NOT NULL);
```

`~/.contextflow/iwms.json`:

```json
{ "baseUrl": "http://i-wms.sds.samsung.net", "fillToStandard": true, "minuteStep": 10,
  "styleGuide": "…",
  "categories": [{ "ciKey": "…", "ciName": "…", "wbsid": "…", "path": "대 > 중 > 소", "task": "…",
                   "priceType": "O", "hint": "…", "mapFrom": ["프로젝트/S-PCS-Plus"], "samples": ["…"] }] }
```

## 6. 단계별 계획

### 0단계 — 문서와 이식 틀 (이 브랜치)

* 이 문서, `docs/iwms-port/`(README · CHANGES · apply.ps1 · patches).

### 1단계 — i-WMS 연결 · 읽기 (완료)

* Rust `src-tauri/src/iwms/`: `client.rs`(REST · 만료 판정 · 관대한 숫자 파싱 · 오류 문구), `day.rs`(mhList → 탭 ·
  카테고리 · 기존 행, initMHInfo 요약 · 가드), `session.rs`(WebView2 세션 창), `settings.rs`(`iwms.json`).
* 커맨드 `iwms_connect` · `iwms_status` · `iwms_disconnect` · `iwms_day` · `get_iwms_settings` · `save_iwms_settings`.
  세션 만료는 `AppError{kind:"iwms_session"}` — 프런트(`useIwms.day`)가 다시 연결하고 한 번 다시 시도한다.
* 설정 화면 제목 옆에 탭 `[일반 | i-WMS]`. 지금 내용이 그대로 '일반' 이다. i-WMS 탭의 연결 카드(주소 · 상태 ·
  [i-WMS 연결] · [나의 MH 설정 열기 ↗]).
* **실서비스 읽기 점검(2026-10-02, `live_read`)** — 탭 6개(공통 · EP · 통합 권한/계정 · 문서관리 · 통합과제관리 · 비대상),
  카테고리 25개(대가포함 O 15 · 대가미포함 N 10), 이미 입력된 360분(2개 카테고리에 각 2행), 기준 480분.
  여기서 바로잡은 것(계획을 바꿨다):
  * **`beforeAbandonedYn` 은 막는 조건이 아니다.** 입력이 되는 탭 모두가 `"Y"`(폐기 전)였다. 삭제(`deleteYn = "Y"`)만
    미리 막고 폐기는 서버 오류 코드에 맡긴다.
  * **마감일은 입력 날짜 또는 오늘이 넘어서면 막는다.** 10/2 의 `deadLineDate` 가 10/15 였다 — 무엇의 마감인지 확정하지
    못해 두 해석 모두에서 맞는 쪽을 택했다.
  * **새 프로필의 Chrome 은 SSO 가 저절로 되지 않았다**(로그인 화면에 멈춤). Edge 는 몇 초 만에 됐다. 테스트 도우미는
    Edge 를 먼저 쓴다. 앱은 WebView2(Edge 엔진)이므로 같은 결과를 기대한다 — 앱 E2E 에서 확인한다.
  * 실데이터의 `mh` 는 모두 실수(`60.0`)였다 — 관대한 파싱이 필요하다는 auto-wms 의 기록과 같다.

### 2단계 — 카테고리 지정 (완료)

* 설정 i-WMS 탭의 카테고리 카드: 기준일로 그날 입력 가능한 카테고리를 불러와 **대가포함(운영) · 대가미포함(비대상)**
  으로 나누고 탭별로 묶어 보인다. 줄마다 [사용] 체크, 체크한 줄에 힌트(AI 가 고를 때 읽는 설명)와 ContextFlow 카테고리
  매핑(`CategoryPicker` 재사용). 지정했지만 그날 없는 카테고리는 아래에 흐리게 모아 [해제] 할 수 있다.
* 순수 함수 `candidatesFor`(지정 ∩ 그날 가능 ∩ 대가 구분 — 그 구분에 지정한 것이 없으면 그날 전체) · `mappedCategory`
  (가장 깊은 매핑이 이긴다, 대가 구분이 다른 매핑은 보지 않는다).

### 3단계 — 오늘의 한일 대가 선택

* DB v2, 커맨드 `iwms_marks` · `set_iwms_mark` · `iwms_pushes`. 팝업 줄마다 3단 선택, 입력된 줄의 배지,
  꼬리의 [i-WMS 업무량 입력…].

### 4단계 — AI 정제 · 검토 화면 · 템플릿

* 재료(제목 · 내용 · 업무 카테고리 · 태그 · 개요 · 그날 Run Log), 프롬프트, 파서, `fitMinutes`.
* `IwmsPushModal`: 그날 현황(입력된 분 / 기준 / 남은 분) · 표(원문 | 대가 | 카테고리 | 분 | 상세내용 | 확신도).
* 템플릿 카드: 공통 작성 규칙 · 카테고리별 샘플 · [i-WMS 템플릿 가져오기] · [샘플로 시험].

### 5단계 — 미리보기 · 최종 확정 · 되돌리기

* `iwms_preview` → `iwms_commit` → `iwms_undo`. 덧붙이기 페이로드 · 지문 · 검증은 순수 함수로 테스트한다.
* 실서비스 쓰기 · 원복(`#[ignore] live_write_restore`, 2026-10-02, 1분 테스트 행).

### 6단계 — 마무리

* 확정 이력을 프롬프트 예시로(학습), 이미 넣은 줄 기본 제외, README, 이식 패치 마무리.

## 7. 기존 기능과의 관계

* **오늘의 한일:** 항목 · 편집 · 삭제는 그대로다. 항목을 지우면 그 대가 선택은 JOIN 에서 빠져 보이지 않는다.
  입력 이력(`iwms_pushes`)은 남는다 — i-WMS 에 실제로 들어간 행이라 되돌리기의 근거이기 때문이다.
* **AI 연결:** 기능별 연결 표와 프롬프트 팩 지점에 `i-WMS 정제` 가 하나 더 보인다.
* **창 포커스 다시 읽기:** 세션 창이 뜨면 메인 창이 흐려졌다가 돌아오며 다시 읽는다 — 무해하다.

## 8. 위험과 대응

* **탭 통째 치환으로 기존 MH 유실** — 가장 치명적이다. `Value` 원형 보존, 덧붙이기만, 미리보기에 기존 행 유지 표시,
  지문으로 동시 변경 거절, 저장 뒤 재조회 대조. 단위 테스트로 지킨다.
* **WebView2 SSO 가 이 앱에서 안 될 가능성** — 실패하면 창을 열어 두고 사유를 보인다. 안 되면 CDP 브라우저 방식을
  앱 옵션으로 올린다(실서비스 테스트 도우미가 이미 그 방식이다).
* **AI 환각 · 잘림** — 후보 밖이면 버린다. 잘림은 형식 위반과 따로 알린다. 확정은 언제나 사람이 누른다.
* **세션 수명 · 마감 · 결재 처리** — 실측되지 않았다. 마감 · 결재는 미리 막고, 서버 오류 코드는 사람이 읽는 문구로 바꾼다.

## 9. 순서를 이렇게 잡은 이유

1. **연결과 읽기가 먼저다.** 실서비스에서 무엇이 오는지 보지 않고는 카테고리도 프롬프트도 정할 수 없다.
2. **카테고리 지정은 읽기만 한다.** i-WMS 에 쓰지 않으니 위험이 낮다.
3. **대가 선택(3단계)은 로컬 DB 만 바꾼다.** 화면과 데이터 모델을 먼저 굳힌다.
4. **AI 정제(4단계)도 쓰지 않는다.** 결과를 실컷 고쳐 보며 프롬프트를 다듬을 수 있다.
5. **쓰기(5단계)는 하나의 단계에 모은다.** 위험한 일을 한곳에서 집중해서 테스트한다.
