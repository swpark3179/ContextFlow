/**
 * 클립보드에 텍스트를 올린다. 성공 여부를 돌려주며 예외를 던지지 않는다.
 *
 * 두 길을 차례로 밟는 이유는 웹뷰가 Clipboard API 를 거절할 수 있기 때문이다
 * (권한 · 보안 컨텍스트 판정이 플랫폼마다 다르다). 그때는 보이지 않는 textarea 를
 * 골라 `execCommand` 로 옮긴다 — 에디터의 Ctrl+X 가 이미 쓰는 것과 같은 폴백이다.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 아래 폴백으로 */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    // 화면 밖에 두되 `display:none` 은 쓰지 않는다 — 그리지 않은 요소는 선택할 수 없다.
    el.style.position = "fixed";
    el.style.top = "-1000px";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
