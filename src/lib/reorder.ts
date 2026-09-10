/**
 * 업무 리스트에서 하나를 끌어 놓았을 때의 **최종 순서** 계산.
 *
 * `order` 는 상태와 무관한 하나의 줄 세우기라(각 업무 `index.md` 의 키 하나), 최종
 * 순서는 언제나 살아 있는 업무 **전체**로 만들어야 한다. 그런데 사용자가 자리를 고른
 * 곳은 화면에 보이던 목록이고, 상태 필터가 걸려 있으면 그것은 전체의 부분집합이다.
 *
 * 여기서 하는 일이 그 다리 놓기다 — 놓은 자리를 **새 이웃**으로 읽는다. 끌어온 업무는
 * 보이는 목록에서 바로 뒤에 오게 될 업무 앞(맨 끝이면 마지막으로 보이던 업무 뒤)에
 * 들어간다. 그래서 화면에서 본 결과가 그대로 나오면서, 사이에 숨어 있던 업무들은
 * 있던 자리에 남는다.
 */
export function reorderedList(
  /** 살아 있는 업무 전체의 지금 순서. */
  all: string[],
  /** 그중 화면에 보이던 것들, 같은 순서로. 필터가 없으면 `all` 과 같다. */
  visible: string[],
  /** 끌어온 업무. */
  moved: string,
  /** 보이던 목록 기준의 삽입 인덱스. `0` 은 맨 위, 목록 길이는 맨 아래다. */
  at: number,
): string[] | null {
  const from = all.indexOf(moved);
  const visFrom = visible.indexOf(moved);
  if (from < 0 || visFrom < 0) return null;

  // 자기 자신을 뺀 자리 기준으로 삽입 지점을 다시 센다.
  const visRest = visible.filter((f) => f !== moved);
  const to = Math.max(0, Math.min(at > visFrom ? at - 1 : at, visRest.length));

  const rest = all.filter((f) => f !== moved);
  const anchor =
    to < visRest.length
      ? rest.indexOf(visRest[to]) // 이 업무 **앞**
      : visRest.length
        ? rest.indexOf(visRest[to - 1]) + 1 // 마지막으로 보이던 업무 **뒤**
        : from; // 보이는 것이 자기 하나뿐 — 옮길 자리가 없다
  // `anchor === from` 은 있던 자리 그대로다. 노트를 다시 쓸 이유가 없다.
  if (anchor < 0 || anchor === from) return null;
  return [...rest.slice(0, anchor), moved, ...rest.slice(anchor)];
}
