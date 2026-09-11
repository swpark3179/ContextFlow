/**
 * 오늘의 한일 — 날짜별로 쌓이는 영구 기록의 **화면 쪽 투영**.
 *
 * 진짜 저장소는 SQLite 다(`src-tauri/src/daylog.rs`, `~/.contextflow/today.db`). 이 파일이
 * 하는 일은 그중 **오늘 하루**를 메모리에 들고 사이드바 도크가 그릴 수 있게 하는 것뿐이다.
 * 어제와 그제를 보는 곳은 도크가 아니라 팝업이고, 팝업은 필요한 날짜를 그때 DB 에서 읽는다.
 *
 * 그래서 여기 있는 함수는 전부 순수하다. 저장은 스토어가 커맨드로 하고, 이 리듀서들은
 * 커맨드가 돌려준 행을 화면 목록의 옳은 자리에 끼우는 일만 한다 — 낙관적 갱신을 하지 않으
 * 므로(`useStore.noteToday`) 여기 들어오는 행은 이미 DB 에 적힌 행이다.
 *
 * 항목의 기본키는 `id` 다. 예전에는 업무 폴더 경로였는데, 이제 업무와 연결되지 않은 자유
 * 항목(`folder === null`)이 한 날짜에 여러 개 있을 수 있어 경로로는 줄을 가릴 수 없다.
 */

export interface DayEntry {
  /** DB rowid. 자유 항목은 경로가 없으므로 이것만이 줄을 가리킬 수 있다. */
  id: number;
  /** 이 줄이 속한 날 `YYYY-MM-DD`. */
  day: string;
  /**
   * 업무 폴더 경로. `null` 이면 팝업에서 손으로 넣은 자유 항목이라(회의 · 전화 · 지원 업무)
   * 눌러 갈 곳이 없다.
   */
  folder: string | null;
  title: string;
  /** 내용. 목록에는 제목만 보이고 이 값은 팝업에서만 다룬다. */
  body: string;
  /** 마지막으로 건드린 시각 `HH:MM`. 날짜는 위의 `day` 가 들고 있다. */
  at: string;
}

/** 화면에 들고 있는 하루. 도크가 그리는 것은 언제나 오늘 하루뿐이다. */
export interface DayLog {
  day: string;
  entries: DayEntry[];
}

export const EMPTY_LOG: DayLog = { day: "", entries: [] };

/**
 * 화면의 목록을 그 날짜로 맞춘다. 날이 다르면 **화면만** 빈 목록이 된다 —
 * 어제의 줄은 DB 에 그대로 있고 팝업에서 볼 수 있다.
 */
export function rollDay(log: DayLog, day: string): DayLog {
  return log.day === day ? log : { day, entries: [] };
}

/**
 * DB 가 돌려준 줄을 목록 맨 위에 끼운다.
 *
 * 같은 줄인지는 `id` 로 보고, 업무와 연결된 줄이면 **경로로도** 본다. 경로까지 보는 이유는
 * 업무가 옮겨 간 뒤(`relocateEntries`) 그 자리를 이미 다른 줄이 차지하고 있을 수 있어서다
 * (DB 쪽 `UPDATE OR REPLACE`). 그때 남아야 하는 것은 방금 DB 가 확인해 준 이 줄 하나다.
 */
export function upsertEntry(log: DayLog, day: string, row: DayEntry): DayLog {
  const base = rollDay(log, day);
  const rest = base.entries.filter(
    (e) => e.id !== row.id && !(row.folder !== null && e.folder === row.folder),
  );
  return { day, entries: [row, ...rest] };
}

export function removeEntry(log: DayLog, id: number): DayLog {
  return { ...log, entries: log.entries.filter((e) => e.id !== id) };
}

/**
 * 업무의 폴더 경로가 바뀐 것을 따라간다(업무명 변경 · Archive 로 이동).
 *
 * 경로가 업무의 기본키라 이걸 안 하면 그 줄은 없는 업무를 가리키게 되고, 눌러도 아무 일도
 * 일어나지 않는다. 자유 항목은 애초에 가리키는 업무가 없으니 건너뛴다.
 */
export function relocateEntries(
  log: DayLog,
  from: string,
  to: string,
  title: string,
): DayLog {
  return {
    ...log,
    entries: log.entries.map((e) =>
      e.folder !== null && e.folder === from ? { ...e, folder: to, title } : e,
    ),
  };
}

// ---------------------------------------------------------------------------
// 가벼운 업무를 접을 때
// ---------------------------------------------------------------------------

/**
 * `create_task` 가 템플릿 없이 만드는 본문의 골격(`src-tauri/src/vault.rs` 의
 * `DEFAULT_SKELETON`). 이 머리말만 남은 본문은 사용자가 쓴 것이 없다는 뜻이다.
 */
const SKELETON_HEADING = /^##\s*개요\s*$/;

/**
 * 지워질 업무 폴더가 들고 있던 글을 기록 한 줄의 **내용**으로 모은다.
 *
 * 파일을 하나도 붙이지 않은 업무를 완료하면 그 폴더를 지운다(`useStore.logAndDiscard`).
 * 그때 사라지는 글은 둘이다 — 간단 메모장의 메모와 `index.md` 본문(새 업무 대화상자에서
 * 적은 개요, 또는 나중에 직접 쓴 글). **둘을 다 옮기는 것이 확인 대화상자 없이 지우는 것을
 * 정당화한다**: 폴더가 들고 있던 글이 전부 기록으로 옮겨 가면 삭제가 실질적으로 무손실이다.
 *
 * `## 개요` 머리말은 앱이 만든 골격이라 걷어낸다. 그것만 남은 본문은 사용자가 쓴 것이
 * 없다는 뜻이므로 메모만 남는다. 템플릿으로 만든 업무의 본문은 골격이 더 길지만 통째로
 * 싣는다 — 조금 장황한 것이 글을 잃는 것보다 낫다.
 */
export function composeDiscardBody(memo: string, indexBody: string): string {
  const lines = indexBody.replace(/\r\n/g, "\n").split("\n");
  // 앞쪽 빈 줄을 지나 첫 글줄이 골격 머리말이면 그 **한 줄만** 걷어낸다. 가운데의
  // `## 개요` 는 사용자가 쓴 것이므로 건드리지 않는다.
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && SKELETON_HEADING.test(lines[i].trim())) i++;
  const rest = lines.slice(i).join("\n").trim();
  const head = memo.trim();
  if (!rest) return head;
  if (!head) return rest;
  return `${head}\n\n---\n\n${rest}`;
}

// ---------------------------------------------------------------------------
// localStorage 1회 이관
// ---------------------------------------------------------------------------

/** 옛 목록의 한 줄. `import_day_log` 커맨드의 `ImportRow` 와 1:1. */
export interface LegacyRow {
  folder: string;
  title: string;
  at: string;
}

export interface LegacyLog {
  day: string;
  rows: LegacyRow[];
}

/** 오늘의 한일이 `localStorage` 에 살던 시절의 키. 이관하고 나면 지운다. */
export const LEGACY_KEY = "contextflow.today";

export const EMPTY_LEGACY: LegacyLog = { day: "", rows: [] };

/**
 * 옛 `localStorage` 값을 읽는다. 모양이 아니면 조용히 빈 목록이다 — 한 번 옮기고 버릴
 * 값이라, 읽다 실패한 것으로 부팅을 막을 이유가 없다.
 */
export function parseLegacyLog(raw: string | null): LegacyLog {
  if (!raw) return EMPTY_LEGACY;
  try {
    const value = JSON.parse(raw) as { date?: unknown; items?: unknown } | null;
    if (!value || typeof value.date !== "string" || !Array.isArray(value.items)) {
      return EMPTY_LEGACY;
    }
    const rows: LegacyRow[] = [];
    for (const it of value.items as Partial<LegacyRow>[]) {
      if (!it || typeof it.folder !== "string" || !it.folder) continue;
      rows.push({
        folder: it.folder,
        title: typeof it.title === "string" ? it.title : it.folder,
        at: typeof it.at === "string" ? it.at : "",
      });
    }
    return { day: value.date, rows };
  } catch {
    return EMPTY_LEGACY;
  }
}

/**
 * 옛 값을 읽어 내고 그 자리에서 키를 지운다. **이관 완료 표시는 키의 부재 그 자체다** —
 * 따로 플래그를 두면 그 플래그도 지워야 할 값이 된다.
 *
 * 키를 먼저 지우지 않는다. 부르는 쪽이 DB 에 넣기를 성공한 뒤 `forgetLegacyLog` 를 부른다.
 */
export function readLegacyLog(): LegacyLog {
  try {
    return parseLegacyLog(window.localStorage.getItem(LEGACY_KEY));
  } catch {
    // 저장소를 못 읽는 환경이면 이관할 것도 없다.
    return EMPTY_LEGACY;
  }
}

export function forgetLegacyLog(): void {
  try {
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 못 지워도 다음 부팅에서 같은 값을 다시 이관할 뿐이고, 그건 DB 가 접어 준다 */
  }
}
