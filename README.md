# ContextFlow

업무 맥락 유지 및 지식 관리 도구 (Windows Desktop · Tauri 2.0)

여러 업무를 오가며 생기는 맥락 손실을 줄이는 것이 목적이다. 왼쪽에서 업무를 고르면
그 업무 전용 작업공간(파일 탐색기 · 에디터 · 마크다운 뷰어 · 메모장)이 그대로 복원되고,
모든 데이터는 Obsidian Vault 폴더 구조로 저장되므로 완료된 업무를 Obsidian에서 바로 열 수 있다.

UI는 `design/ContextFlow.dc.html`(Claude Design 프로젝트에서 내려받은 원본)을 그대로 옮긴 것이다.
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
| 설정 | Vault 경로 · 열기 기본값 · 보관 정책 · LLM Endpoint · 유사도 임계값 · 컨텍스트 보존 토글 |

## 유사 업무 추천

두 엔진이 같은 인터페이스 뒤에 있다 (`src-tauri/src/recommend.rs`).

* **local** — IDF 가중 Dice 계수 (영문 단어 + 한글 bigram 토큰). 네트워크 없이 항상 동작하며 기본값이다.
* **llm** — 설정의 Endpoint로 OpenAI 호환 `POST {endpoint}/embeddings` 호출 후 코사인 유사도.
  실패하면 자동으로 local로 대체하고 그 사실을 UI에 표시한다.

두 엔진 모두 실제 유사도를 [0,1]로 그대로 보고한다. 목업의 숫자에 맞추려고 값을 보정하지 않으므로,
로컬 엔진의 점수는 임베딩 모델을 붙였을 때보다 낮게 나올 수 있다. 현재 엔진은 추천 패널 하단에 표시된다.

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
* **사내 LLM Endpoint는 사내망에서만 검증 가능하다.** 어댑터 계약과 폴백 동작까지만 확인했다.
* **`text-wrap: pretty`를 쓰지 않는다.** 커스텀 스크롤바가 레이아웃 폭을 차지하는 좁은 스크롤
  컬럼에서 Chrome 레이아웃이 무한 진동해 렌더러가 멈춘다. `src/styles/global.css`의
  `scrollbar-gutter: stable`이 근본 원인을 막고, 해당 속성은 설계에서 쓰였더라도 사용하지 않는다.
