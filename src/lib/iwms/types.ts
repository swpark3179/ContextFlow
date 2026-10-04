/**
 * i-WMS 업무량 자동입력 — 화면이 쓰는 모양. Rust `src-tauri/src/iwms/` 의 구조체와 1:1 이다.
 *
 * `priceType` 이 대가 구분이다: `O`(운영) = 대가포함, `N`(비대상) = 대가미포함. 오늘의 한일에서
 * 업무마다 고르는 값도 이 둘이다(`Price`).
 */

export type Price = "O" | "N";

export const PRICE_LABEL: Record<Price, string> = { O: "대가포함", N: "대가미포함" };

export interface IwmsUser {
  userId: string;
  userName: string;
  dept: string;
}

export interface IwmsStatus {
  connected: boolean;
  user: IwmsUser | null;
  /** 연결할 때의 주소. 연결되지 않았으면 시도한 주소 또는 빈 값. */
  base: string;
  /** 화면에 그대로 적는 사유. */
  message: string;
}

/** i-WMS 에 이미 들어 있는 행 하나. */
export interface IwmsRow {
  rowSeq: number;
  minutes: number;
  note: string;
  reqDate: string;
  exceptTime: boolean;
  exceptDay: boolean;
}

export interface IwmsTemplate {
  title: string;
  content: string;
}

/** 그날 입력할 수 있는 카테고리 — `(ciKey, wbsid)` 가 키다. */
export interface IwmsCategory {
  ciKey: string;
  ciName: string;
  wbsid: string;
  /** `O` · `N` · `I`(이슈 — 다루지 않는다). */
  priceType: string;
  /** `대분류 > 중분류 > 소분류` */
  path: string;
  task: string;
  templates: IwmsTemplate[];
  rows: IwmsRow[];
  minutes: number;
  /** 쓸 수 없으면 그 사유. */
  blocked: string | null;
}

export interface IwmsTab {
  ciKey: string;
  ciName: string;
  minutes: number;
  deadline: string;
  categories: number;
  blocked: string | null;
}

export interface IwmsDay {
  workDate: string;
  userId: string;
  standardMinutes: number;
  maxMinutes: number;
  totalMinutes: number;
  approved: boolean;
  holiday: boolean;
  tabs: IwmsTab[];
  categories: IwmsCategory[];
}

/** 설정에서 사용하기로 지정한 카테고리(`~/.contextflow/iwms.json`). */
export interface Designated {
  ciKey: string;
  ciName: string;
  wbsid: string;
  path: string;
  task: string;
  priceType: string;
  /** 이 카테고리에 넣는 일의 설명 — AI 가 고를 때 읽는다. */
  hint: string;
  /** 이 ContextFlow 카테고리(하위 포함)의 업무는 이 카테고리로 고정한다. */
  mapFrom: string[];
  /** 상세내용 샘플 문구. */
  samples: string[];
}

export interface IwmsSettings {
  baseUrl: string;
  fillToStandard: boolean;
  minuteStep: number;
  styleGuide: string;
  categories: Designated[];
}

/** 오늘의 한일 한 줄의 대가 선택. 고르지 않은 줄(입력 안 함)은 목록에 없다. */
export interface IwmsMark {
  entryId: number;
  price: Price;
}

/** i-WMS 에 넣은 행 하나(`today.db` 의 `iwms_pushes`). */
export interface IwmsPush {
  id: number;
  commitId: string;
  /** 오늘의 한일 줄. 그 줄을 지웠으면 `null` 일 수 있다. */
  entryId: number | null;
  day: string;
  title: string;
  ciKey: string;
  ciName: string;
  wbsid: string;
  task: string;
  price: Price;
  minutes: number;
  note: string;
  pushedAt: string;
  /** 되돌렸으면 그 시각. */
  undoneAt: string | null;
}

/** i-WMS 에 덧붙일 행 하나(Rust `day::NewRow`). `entryId` · `title` 은 입력 이력에만 남는다. */
export interface NewRow {
  entryId: number | null;
  title: string;
  ciKey: string;
  wbsid: string;
  minutes: number;
  note: string;
  reqDate: string;
  /** 고른 대가 구분 — 백엔드가 카테고리의 `priceType` 과 같은지 한 번 더 본다. */
  price: Price;
}

export interface CategoryDiff {
  ciKey: string;
  ciName: string;
  wbsid: string;
  task: string;
  priceType: string;
  before: IwmsRow[];
  after: IwmsRow[];
  added: number;
  removed: number;
}

export interface IwmsPreview {
  workDate: string;
  diffs: CategoryDiff[];
  beforeMinutes: number;
  afterMinutes: number;
  standardMinutes: number;
  maxMinutes: number;
  warnings: string[];
}

export interface PreviewOut {
  /** 확정할 때 돌려줄 일회용 토큰(10분). */
  token: string;
  preview: IwmsPreview;
}

export interface CommitOut {
  commitId: string;
  preview: IwmsPreview;
  /** 저장 뒤 다시 조회해 기대한 행과 같았다. */
  verified: boolean;
  mismatches: string[];
  pushes: IwmsPush[];
}

export interface UndoOut {
  preview: IwmsPreview;
  verified: boolean;
  mismatches: string[];
}

/** 카테고리의 키. 같은 `wbsid` 가 두 탭(대가포함 · 비대상)에 있을 수 있어 탭까지 묶는다. */
export function categoryKey(c: { ciKey: string; wbsid: string }): string {
  return `${c.ciKey}|${c.wbsid}`;
}

/** `대분류 > 중분류 > 소분류 > 태스크` 한 줄. */
export function categoryLabel(c: { path: string; task: string }): string {
  return c.path ? `${c.path} > ${c.task}` : c.task;
}

/** 지정한 카테고리의 사본을 i-WMS 의 그날 값으로 만든다. 힌트 · 매핑 · 샘플은 앞의 값을 지킨다. */
export function designate(c: IwmsCategory, prev?: Designated): Designated {
  return {
    ciKey: c.ciKey,
    ciName: c.ciName,
    wbsid: c.wbsid,
    path: c.path,
    task: c.task,
    priceType: c.priceType,
    hint: prev?.hint ?? "",
    mapFrom: prev?.mapFrom ?? [],
    samples: prev?.samples ?? [],
  };
}

/** i-WMS 의 그날 MH 입력 화면 주소. */
export function registUrl(base: string, userId: string, day: string): string {
  return `${base.replace(/\/+$/, "")}/#/iwms/mh/regist?userid=${encodeURIComponent(userId)}&workdate=${day.replace(/-/g, "")}&openCount=1`;
}

/** i-WMS '나의 MH 설정'(카테고리 추가는 거기서 한다). */
export function settingUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/#/wms/mh/mhSetting`;
}
