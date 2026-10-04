/**
 * 분 배분 — AI 의 합계 산수를 믿지 않고 앱이 맞춘다.
 *
 * AI 가 낸 분은 **비율**로만 쓴다. 사람이 고친 값(`locked`)은 그대로 두고, 나머지 줄을 남은 시간에
 * 맞게 늘이거나 줄인다. `step` 단위로 내리고, 모자란 몫은 버림이 컸던 줄부터 한 단위씩 준다(최대 잔여).
 * 줄마다 최소 한 단위를 준다 — 0분 줄은 i-WMS 에 아무것도 남기지 않는다.
 */
export function fitMinutes(values: number[], locked: boolean[], total: number, step: number): number[] {
  const unit = Math.max(1, Math.round(step));
  const free = values.map((_, i) => i).filter((i) => !locked[i]);
  const fixed = values.reduce((n, v, i) => n + (locked[i] ? Math.max(0, v) : 0), 0);
  const target = total - fixed;
  if (!free.length || target <= 0) return values.map((v, i) => (locked[i] ? v : snap(v, unit)));

  const weights = free.map((i) => Math.max(0, values[i]));
  const sum = weights.reduce((a, b) => a + b, 0);
  const share = sum > 0 ? weights.map((w) => (target * w) / sum) : weights.map(() => target / free.length);

  const units = Math.floor(target / unit);
  const floor = share.map((s) => Math.floor(s / unit));
  // 줄마다 최소 한 단위.
  const alloc = floor.map((f) => Math.max(f, 1));
  let over = alloc.reduce((a, b) => a + b, 0) - units;
  // 최소를 채우느라 넘쳤으면 가장 큰 줄부터 덜어 낸다(1 아래로는 내리지 않는다).
  while (over > 0) {
    const k = alloc.reduce((best, v, j) => (v > alloc[best] ? j : best), 0);
    if (alloc[k] <= 1) break;
    alloc[k] -= 1;
    over -= 1;
  }
  // 모자라면 버림이 컸던 줄부터 한 단위씩.
  const order = share.map((s, k) => ({ k, rest: s / unit - floor[k] })).sort((a, b) => b.rest - a.rest || a.k - b.k);
  let short = units - alloc.reduce((a, b) => a + b, 0);
  for (let j = 0; short > 0; j = (j + 1) % order.length, short--) alloc[order[j].k] += 1;

  const out = [...values];
  free.forEach((i, k) => (out[i] = alloc[k] * unit));
  // 단위로 나누어떨어지지 않는 끝수는 가장 큰 줄에 붙여 합을 정확히 맞춘다.
  const tail = target - units * unit;
  if (tail > 0) {
    const big = free.reduce((best, i) => (out[i] > out[best] ? i : best), free[0]);
    out[big] += tail;
  }
  return out;
}

function snap(v: number, unit: number): number {
  return Math.max(0, Math.round(v / unit) * unit);
}
