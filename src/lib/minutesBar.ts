/**
 * i-WMS 업무량 입력의 누적 막대 — 기준(보통 480분) 위에 이미 입력한 분, 이번에 넣을 줄마다의 분, 기준을
 * 넘친 몫을 겹쳐 그린다(`IwmsPushModal`). 값은 막대 폭에 대한 백분율이다.
 *
 * 줄의 몫은 기준 안에서만 늘어난다 — 넘친 만큼은 오른쪽 끝에 빗금으로 따로 그린다. 넘친 몫이 막대를 다
 * 먹으면 무엇이 넘쳤는지 읽을 수 없으므로 `overCap`(기본 30%)에서 자른다.
 */

export interface BarPart {
  left: number;
  width: number;
}

export interface MinutesBar {
  /** 이미 입력한 분의 폭. 막대 왼쪽 끝부터. */
  done: number;
  /** 줄마다의 몫 — 들어온 순서대로 이어 붙는다. */
  parts: BarPart[];
  /** 기준을 넘친 몫(오른쪽 끝). 넘치지 않았으면 폭이 0 이다. */
  over: BarPart;
}

const pct = (v: number) => Math.round(v * 100) / 100;

export function minutesBar(standard: number, entered: number, rows: readonly number[], overCap = 30): MinutesBar {
  const pos = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0);
  const sum = rows.reduce((n, m) => n + pos(m), 0);
  // 기준이 없는 날(0분)은 채운 만큼을 막대 전체로 본다 — 0 으로 나누지 않게.
  const scale = standard > 0 ? standard : Math.max(1, pos(entered) + sum);
  const done = Math.min(100, (pos(entered) / scale) * 100);
  let acc = done;
  const parts = rows.map((m) => {
    const width = Math.max(0, Math.min((pos(m) / scale) * 100, 100 - acc));
    const part = { left: pct(acc), width: pct(width) };
    acc += width;
    return part;
  });
  const extra = Math.max(0, pos(entered) + sum - scale);
  const overW = Math.min((extra / scale) * 100, overCap);
  return { done: pct(done), parts, over: { left: pct(100 - overW), width: pct(overW) } };
}
