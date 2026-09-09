/**
 * 오늘의 한일 — 오늘 손댄 업무의 제목만 쌓아 두는 **하루짜리** 목록.
 *
 * Vault 에 쓰지 않는 유일한 사용자 데이터다. 이유는 그것이 하루가 지나면 사라지는
 * 값이기 때문이다 — 노트로 남기면 Obsidian 쪽에 어제·그제의 목록이 그대로 쌓이고,
 * 지우는 손이 하나 더 생긴다. 업무를 언제 무엇을 고쳤는지는 이미 `updated` 와
 * Run Log 가 영구히 들고 있으므로, 이 목록이 하는 일은 "오늘 무엇을 건드렸는지"를
 * 하루 동안 눈앞에 두는 것뿐이다.
 *
 * 저장 위치는 브라우저 저장소다(`localStorage`). 앱을 다시 켜도 같은 날이면 그대로
 * 보이고, 날이 바뀌면 읽는 순간 비워진다. 여기 있는 함수는 저장소를 만지는 둘
 * (`readLog` · `writeLog`)을 빼면 전부 순수 함수다.
 */

export interface TodayItem {
  /** 업무 폴더 경로 — 앱 전역의 업무 기본키다. 이름을 바꾸거나 보관하면 함께 옮긴다. */
  folder: string;
  title: string;
  /** 마지막으로 건드린 시각 `HH:MM`. */
  at: string;
}

export interface TodayLog {
  /** 이 목록이 만들어진 날 `YYYY-MM-DD`. 오늘과 다르면 목록은 없는 것으로 본다. */
  date: string;
  items: TodayItem[];
}

export const EMPTY_LOG: TodayLog = { date: "", items: [] };

/** 하루에 이만큼 넘게 쌓이면 오래된 것부터 버린다. 목록이지 이력이 아니다. */
const MAX_ITEMS = 60;

const KEY = "contextflow.today";

/** 어제까지의 목록은 휘발된다 — 날이 다르면 빈 목록으로 갈아 준다. */
export function pruneLog(log: TodayLog, day: string): TodayLog {
  return log.date === day ? log : { date: day, items: [] };
}

/**
 * 업무 하나를 목록 맨 위에 올린다. 같은 업무는 한 줄뿐이고, 다시 건드리면 시각만
 * 새로 적힌다 — 한 업무를 열 번 고친 날의 목록이 열 줄이 되면 읽을 수 없다.
 */
export function addItem(log: TodayLog, day: string, item: TodayItem): TodayLog {
  const base = pruneLog(log, day);
  const rest = base.items.filter((i) => i.folder !== item.folder);
  return { date: day, items: [item, ...rest].slice(0, MAX_ITEMS) };
}

export function removeItem(log: TodayLog, folder: string): TodayLog {
  return { ...log, items: log.items.filter((i) => i.folder !== folder) };
}

/**
 * 업무의 폴더 경로가 바뀐 것을 따라간다(업무명 변경 · Archive 폴더로 이동).
 * 경로가 기본키라 이걸 안 하면 목록의 그 줄은 없는 업무를 가리키게 되고, 눌러도
 * 아무 일도 일어나지 않는다.
 */
export function moveItem(log: TodayLog, from: string, to: string, title: string): TodayLog {
  if (from === to) {
    return { ...log, items: log.items.map((i) => (i.folder === from ? { ...i, title } : i)) };
  }
  return {
    ...log,
    items: log.items.map((i) => (i.folder === from ? { ...i, folder: to, title } : i)),
  };
}

/** 저장된 문자열을 목록으로 읽는다. 모양이 아니면 조용히 빈 목록이다. */
export function parseLog(raw: string | null): TodayLog {
  if (!raw) return EMPTY_LOG;
  try {
    const value = JSON.parse(raw) as Partial<TodayLog> | null;
    if (!value || typeof value.date !== "string" || !Array.isArray(value.items)) return EMPTY_LOG;
    const items: TodayItem[] = [];
    for (const it of value.items) {
      if (!it || typeof it.folder !== "string" || !it.folder) continue;
      items.push({
        folder: it.folder,
        title: typeof it.title === "string" ? it.title : it.folder,
        at: typeof it.at === "string" ? it.at : "",
      });
    }
    return { date: value.date, items: items.slice(0, MAX_ITEMS) };
  } catch {
    return EMPTY_LOG;
  }
}

export function readLog(): TodayLog {
  try {
    return parseLog(window.localStorage.getItem(KEY));
  } catch {
    // 저장소를 못 읽는 것으로 앱이 멈추지는 않는다 — 오늘 목록이 비어 보일 뿐이다.
    return EMPTY_LOG;
  }
}

export function writeLog(log: TodayLog): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(log));
  } catch {
    /* 저장에 실패해도 화면의 목록은 그대로 쓴다 */
  }
}
