/**
 * 탭 묶음에서 탭을 닫는 규칙. 한곳에 모아 두는 이유는 닫는 길이 넷이라서다 —
 * 탭의 ✕, 우클릭 메뉴의 세 항목(이 탭 · 나머지 전부 · 전부)이 모두 같은 규칙으로
 * 다음 활성 탭을 골라야 한다.
 *
 * 상태를 건드리지 않는다. 스토어(`useStore`)가 결과를 `setUi` 로 넣는다.
 */

export interface TabLike {
  path: string;
  mode: string;
}

/** 탭의 식별자. `docs` 는 경로로 키잉하지만 탭은 **모드까지** 합쳐야 하나가 된다. */
export function tabKey(tab: TabLike): string {
  return `${tab.mode}|${tab.path}`;
}

/**
 * `keep` 이 참인 탭만 남기고, 활성 탭을 다시 고른다.
 *
 * 활성 탭이 살아 있으면 그대로 둔다. 닫혔으면 **남은 것 중 마지막**이 활성이 된다 —
 * 탭 하나를 닫았을 때 예전부터 그렇게 움직였고, 여러 개를 닫는 새 항목들도 같은 규칙을
 * 쓴다. 하나도 남지 않으면 빈 문자열이고, 그때 편집기는 "열려 있는 파일이 없습니다" 를
 * 그린다.
 */
export function keepTabs<T extends TabLike>(
  openTabs: T[],
  activeTab: string,
  keep: (tab: T) => boolean,
): { openTabs: T[]; activeTab: string } {
  const left = openTabs.filter(keep);
  if (left.some((t) => tabKey(t) === activeTab)) {
    return { openTabs: left, activeTab };
  }
  return { openTabs: left, activeTab: left.length ? tabKey(left[left.length - 1]) : "" };
}
