/**
 * i-WMS 커맨드 래퍼 — Rust `src-tauri/src/iwms/mod.rs`.
 *
 * `src/lib/api.ts` 에 붙이지 않고 따로 두는 이유는 이 기능을 다른 저장소로 옮길 때 기존 파일을
 * 덜 건드리게 하려는 것이다(`docs/iwms-port/`). 오류 모양은 같은 `AppError` 라 `api.errMessage` ·
 * `api.errKind` 를 그대로 쓴다. `errKind === "iwms_session"` 이면 다시 연결해야 한다.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  CommitOut,
  IwmsDay,
  IwmsMark,
  IwmsPush,
  IwmsSettings,
  IwmsStatus,
  NewRow,
  PreviewOut,
  Price,
  UndoOut,
} from "./types";

/** SSO 로 연결한다(창이 떴다 닫힌다). 실패도 `connected: false` 와 사유로 돌아온다. */
export const iwmsConnect = () => invoke<IwmsStatus>("iwms_connect");
export const iwmsStatus = () => invoke<IwmsStatus>("iwms_status");
export const iwmsDisconnect = () => invoke<void>("iwms_disconnect");

/** 그날의 탭 · 카테고리 · 이미 들어 있는 행 · 기준시간. `date` 는 `YYYY-MM-DD`. */
export const iwmsDay = (date: string) => invoke<IwmsDay>("iwms_day", { date });

// -- 오늘의 한일 줄의 대가 선택 · 입력 이력 (`today.db` v2) --------------------

/** 그날 지금 Vault 의 줄에 붙은 대가 선택. */
export const iwmsMarks = (vault: string, day: string) => invoke<IwmsMark[]>("iwms_marks", { vault, day });
/** 한 줄의 대가 구분. `null` = 입력 안 함. */
export const setIwmsMark = (entryId: number, price: Price | null) =>
  invoke<void>("set_iwms_mark", { entryId, price });
/** 그날 i-WMS 에 넣은 행(되돌린 것 포함), 최근 것 먼저. */
export const iwmsPushes = (day: string) => invoke<IwmsPush[]>("iwms_pushes", { day });
/** 최근에 확정한(되돌리지 않은) 행 — 정제의 예시. */
export const iwmsRecentPushes = (limit: number) => invoke<IwmsPush[]>("iwms_recent_pushes", { limit });

// -- 쓰기 -------------------------------------------------------------------

/** 저장 전 미리보기 — i-WMS 에 쓰지 않는다. */
export const iwmsPreview = (date: string, rows: NewRow[]) => invoke<PreviewOut>("iwms_preview", { date, rows });
/**
 * 최종 확정. 미리보기 뒤 i-WMS 쪽이 바뀌었으면 `errKind === "iwms_stale"` 로 거절한다 — 다시 미리본다.
 * 저장은 됐는데 재조회 대조가 어긋나면 오류가 아니라 `verified: false` 로 돌아온다(이력은 남는다).
 */
export const iwmsCommit = (token: string) => invoke<CommitOut>("iwms_commit", { token });
/** 그 확정이 넣은 행만 i-WMS 에서 지운다. */
export const iwmsUndo = (commitId: string) => invoke<UndoOut>("iwms_undo", { commitId });

// -- 설정 -------------------------------------------------------------------

export const getIwmsSettings = () => invoke<IwmsSettings>("get_iwms_settings");
/** 통째로 바꾼다. 백엔드가 정리한 값을 돌려준다. */
export const saveIwmsSettings = (settings: IwmsSettings) =>
  invoke<IwmsSettings>("save_iwms_settings", { settings });
