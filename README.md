# ContextFlow

업무 맥락 유지 및 지식 관리 도구 (Windows Desktop · Tauri 2.0)

여러 업무를 오가며 생기는 맥락 손실을 줄이는 것이 목적이다. 왼쪽에서 업무를 고르면
그 업무 전용 작업공간(파일 탐색기 · 에디터 · 마크다운 뷰어 · 메모장)이 그대로 복원되고,
모든 데이터는 Obsidian Vault 폴더 구조로 저장되므로 완료된 업무를 Obsidian에서 바로 열 수 있다.

UI는 `design/ContextFlow.dc.html`(Claude Design 프로젝트에서 내려받은 원본)을 그대로 옮긴 것이다.
폰트와 글자 크기만 의도적으로 다르며, 이유는 아래 "알려진 제약"에 적어 두었다.
`design/support.js`는 디자인 미리보기용 React 런타임이며 앱에서는 사용하지 않는다.

## 실행

```bash
pnpm install
pnpm tauri dev        # 개발 실행
pnpm tauri build      # msi / nsis 패키징
```

검증:

```bash
pnpm typecheck                                   # TypeScript
pnpm test                                        # Vitest (마크다운 파서 · 파일 트리)
cargo test --manifest-path src-tauri/Cargo.toml  # Rust (frontmatter · Vault 생애주기 · 파일 조작 · 추천)
```

## 저장소 구조 (Obsidian Vault)

진실의 원천은 파일시스템이다. 별도 DB가 없고, 업무 메타데이터는 `index.md`의 YAML
frontmatter에 있다. Obsidian에서 보이는 것이 곧 ContextFlow에서 보이는 것이다.

```
%USERPROFILE%\Documents\ContextFlow Vault\   ← 설정에서 변경 가능
├── Tasks/
│   └── [2026-08] Tauri 2.0 마이그레이션/
│       ├── index.md                 # frontmatter = 업무 메타데이터
│       ├── notes.md
│       ├── attachments/
│       └── .context_snapshot.json   # 열린 탭 · 선택 파일 · 미저장 텍스트 · 메모
├── Templates/                       # 표준 패턴 (반복 업무)
├── Archive/[연도]/                  # 보관 방식이 'move'일 때만 사용
└── _index/Archive.md                # 보관 목록 MOC (Dataview 표)
```

frontmatter 스키마:

```yaml
---
id: task-2026-0803-01
title: Tauri 2.0 마이그레이션
status: in-progress        # in-progress | on-hold | completed | reopened
tags: [dev, tauri, rust]
created: 2026-08-03 10:00
updated: 2026-08-03 15:30
parent_task: null
template_ref: "[[Templates/Tauri 마이그레이션 표준절차]]"
runs: 2
completed_at: 2026-08-10   # 완료 시
archived: true             # 보관 시
archived_at: 2026-08-11
---
```

frontmatter는 **줄 단위로 부분 수정**한다(`src-tauri/src/frontmatter.rs`). 상태 하나를 바꿔도
나머지 키의 순서 · 따옴표 · 본문이 바이트 단위로 보존되므로, Obsidian에서 손으로 고친 내용이
앱 때문에 재작성되지 않는다.

## 화면

| 화면 | 하는 일 |
| --- | --- |
| 워크스페이스 | 업무별 파일 트리 · 탭 에디터 · 마크다운 뷰어 · 메모장. 업무 전환 시 스냅샷 저장/복원 |
| 템플릿 | 표준 패턴과 회차별 Run Log. "생성하지 않은 중복 노트" 수치는 실제 Vault에서 계산 |
| 보관함 | 분기별 그룹 · 본문 전문 검색 · [Obsidian] 열기 · [재개] |
| 설정 | Vault 경로 · 열기 기본값 · 보관 정책 · AI 연결 4종 · 프롬프트 팩 · 유사도 임계값 · 컨텍스트 보존 토글 |

## AI 연결

연결 방법은 네 가지이고 **전부 채팅 방식**이다. 레지스트리 한 곳(`src-tauri/src/agents.rs`)이
정의하고, 넷 모두 하나의 이벤트 어휘(`RunEvent`)로 수렴한다.

| id | 이름 | 전송 | 인증 |
| --- | --- | --- | --- |
| `claude` | Claude Code | 로컬 CLI (`-p --output-format stream-json`) | 없음 (CLI 자체 로그인) |
| `codex` | Codex CLI | 로컬 CLI (`codex exec --json`) | 없음 (CLI 자체 로그인) |
| `aipro` | AI Pro | HTTP + SSE (`POST {base}/chat/completions`) | `Authorization: Bearer` |
| `fabrix` | FabriX | HTTP + SSE (`POST {base}/openapi/chat/v1/messages`) | `x-fabrix-client` · `x-openapi-token` |

로컬 CLI 2종은 도구를 전부 차단한 채 실행한다 — 파일을 읽거나 고치지 않고 텍스트 답변만 받으므로
권한 프롬프트가 뜰 일이 없고, 권한 우회 플래그도 쓰지 않는다. 작업 폴더는 `~/.contextflow/runs/current`
라는 **빈 폴더**여서 CLAUDE.md 자동 탐색에 Vault 가 빨려 들어가지 않는다.

연결 설정은 `~/.contextflow/ai.json` 에 있고 **Rust 가 소유한다**(앱 설정 `settings.json` 은 프런트가
소유한다 — 파일 하나에 소유자 하나). 파싱에 실패하면 원본을 `ai.json.corrupt` 로 먼저 보존한다.
API 키와 토큰은 평문으로 저장되며, 설정 화면이 그 사실을 표시한다.

## 유사 업무 추천

두 엔진이 같은 결과 모양 뒤에 있다.

* **local** — IDF 가중 Dice 계수 (영문 단어 + 한글 bigram 토큰), `src-tauri/src/recommend.rs`.
  네트워크 없이 항상 동작하며 기본값이자 폴백이다.
* **AI** — 설정에서 고른 연결로 후보 목록을 보내 순위와 클러스터를 받는다
  (`src/lib/recommendPrompt.ts`). 어느 단계든 실패하면 자동으로 local 로 대체하고 그 사실을
  추천 패널 하단에 표시한다.

AI 경로의 출력 계약은 "자유롭게 판단 근거를 서술한 뒤 **맨 마지막에** ` ```recommend ` 펜스 하나" 다.
네이티브 structured output 이나 도구 호출을 쓰지 않는 이유는 네 연결의 공통 분모가 텍스트 스트림
뿐이기 때문이다. 파싱은 `src/lib/fencedJson.ts` 의 공통 관문을 지나며, 가장 흔한 실패인 **출력 잘림**
(닫는 ` ``` ` 도 닫는 `}` 도 오지 않음)은 안전한 절단점을 되짚어 닫아서 앞쪽 항목을 살린다.
펜스를 못 찾으면 "서술은 반복하지 말고 펜스만 다시" 라고 **한 번만** 재질의하고, 그래도 실패하면
local 로 떨어진다. 모델이 만들어 낸 가짜 id 와 `sim` 이 없는 항목은 버린다.

Vault 가 커지면 후보 전부를 프롬프트에 실을 수 없으므로, 40건을 넘으면 local 엔진을 재현율 단계로
한 번 돌려 상위 묶음만 추린다(접힌 자식까지 펼쳐서 보낸다).

두 엔진 모두 실제 유사도를 [0,1]로 그대로 보고한다. 목업의 숫자에 맞추려고 값을 보정하지 않는다.

## 프롬프트 팩 (사용자 지침)

`~/.contextflow/prompts/*.md` 에 파일을 넣고 설정 화면에서 켜면 그 내용이 추천 순위 요청에 붙는다.
프런트마터(`name` · `description` · `stage`)는 선택 사항이다. 앱은 이 폴더에 쓰지 않는다.

주입 지점은 **`recommend.rank` 하나뿐이고, 출력 계약보다 앞에 놓인다.** 계약(펜스 규격)은 프롬프트
텍스트와 파서 사이의 경성 결합이라, 사용자가 그것을 덮어쓸 수 있으면 한 글자 편집이 모든 추천을
조용히 local 폴백으로 떨어뜨린다 — 그 폴백이 정당한 코드 경로라 에러조차 뜨지 않는다. 시스템
프롬프트에도 주입하지 않는다: 판단하는 쪽의 정체성이 바뀌면 점수가 왜 기울었는지 추적할 수 없다.

팩 1개는 8,000자, 훅 1개의 합성은 12,000자에서 멈춘다. 상한을 넘겨 실리지 **못한** 팩은 설정 화면이
경고로 알린다 — 조용히 빠뜨리면 켜 둔 지침이 실제로는 나가지 않는다는 사실을 알 방법이 없다.

## Obsidian 연동

`obsidian://open?path=<절대경로>`로 노트를 연다. `HKCR\obsidian` 프로토콜이 등록되어 있지 않으면
Windows 탐색기로 해당 폴더를 열고 그 사실을 토스트로 알린다 — 조용히 실패하지 않는다.

보관 방식은 두 가지다.

* **frontmatter 태그** (기본) — 파일을 옮기지 않고 `archived: true`만 기록한다.
  위키링크 · 그래프 · 심볼릭 링크가 모두 살아 있다.
* **Archive 폴더로 이동** — `Tasks/` → `Archive/[연도]/`로 실제 이동한다.

## 알려진 제약

* **심볼릭 링크 가져오기**는 Windows에서 개발자 모드나 관리자 권한이 필요하다. 실패하면 복사로
  대체하고 어떤 항목이 대체됐는지 토스트로 알린다.
* **삭제는 휴지통을 거치지 않는 영구 삭제**다(설계 그대로). 이름을 직접 입력하는 확인이 유일한
  안전장치이며, 업무의 `index.md`는 삭제할 수 없도록 막아 두었다.
* **AI Pro · FabriX 엔드포인트는 사내망에서만 검증 가능하다.** 사외에서는 요청 조립 · SSE 파싱 ·
  연결 테스트의 분기까지만 유닛 테스트로 덮었다. 로컬 CLI 2종과 local 폴백 경로는 실제로 돌려서
  확인했다.
* **AI Pro 게이트웨이는 `User-Agent: opencode/0.1.0` 을 요구한다.** UA 가 없으면 게이트웨이
  백엔드가 `ua.split("/")` 에서 터져 HTTP 500 을 주고, 다른 UA 면 406 이다. `/models` 조회에도
  똑같이 적용되므로 이 값을 지우면 두 경로가 함께 죽는다.
* **폰트와 글자 크기가 설계와 다르다.** 설계의 IBM Plex Sans KR / IBM Plex Mono 대신 Google의
  Noto Sans KR / Roboto Mono를 쓰고, 모든 글자 크기를 설계보다 1px 크게 렌더링한다(본문 기준
  10.5px → 11.5px). 9.5~11.5px 위주의 조밀한 화면을 읽기 편하게 하려는 것이고, 한글 음절 지원
  범위도 KS X 1001 2350자에서 11,172자 전체로 넓어진다. 대가로 번들에 들어가는 웹폰트가
  10MB → 19MB(woff2만 보면 5.3MB → 8.3MB)로 늘어난다. 무게 700은 설계와 코드 어디에서도
  쓰지 않으므로, 용량이 문제가 되면 `src/styles/global.css`의 `700.css` import를 먼저 지우면 된다.
* **`text-wrap: pretty`를 쓰지 않는다.** 커스텀 스크롤바가 레이아웃 폭을 차지하는 좁은 스크롤
  컬럼에서 Chrome 레이아웃이 무한 진동해 렌더러가 멈춘다. `src/styles/global.css`의
  `scrollbar-gutter: stable`이 근본 원인을 막고, 해당 속성은 설계에서 쓰였더라도 사용하지 않는다.
