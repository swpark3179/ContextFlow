import type { AiSettings, PromptPack } from "./ai";

/**
 * 사용자 프롬프트 팩의 조립.
 *
 * 팩 본문은 `~/.contextflow/prompts/*.md` 가, 어느 훅에 붙일지는 `ai.json` 이 갖는다.
 * 여기서는 그 둘을 합쳐 프롬프트에 실을 한 덩어리 문자열을 만든다.
 *
 * **내장 프롬프트는 파일로 빼지 않는다 — 주입은 순수 가산이다.** 출력 계약(펜스 규격)은
 * 프롬프트 텍스트와 파서 사이의 경성 결합이라, 사용자가 그것을 덮어쓸 수 있게 하면 한
 * 글자 편집이 모든 추천을 미파싱 폴백으로 떨어뜨린다. 그 폴백(로컬 유사도)이 정당한
 * 코드 경로라 에러조차 뜨지 않는다.
 */

/**
 * 주입 지점은 **추천 순위 요청 하나뿐이다.**
 *
 * 시스템 프롬프트에는 붙이지 않는다. 판단하는 쪽의 정체성을 사용자 지침이 통과하면
 * 점수가 왜 기울었는지 추적할 방법이 없고, 결과는 여전히 중립적인 유사도처럼 보인다.
 * 순위 요청은 이미 확보된 후보 목록을 **읽는 방식**만 바꾸므로 그 문제가 없다.
 */
export type PromptHook = "recommend.rank";

export const PROMPT_HOOKS: { id: PromptHook; label: string; note: string }[] = [
  { id: "recommend.rank", label: "추천 순위", note: "순위 요청의 출력 형식 앞" },
];

/**
 * 훅 1개의 합성 상한.
 *
 * 정확성이 아니라 비용 · 컨텍스트 문제라 하드 차단 대신 설정 화면이 경고 한 줄을 띄운다.
 */
export const HOOK_CAP = 12_000;

/**
 * 팩 **1개** 본문의 상한. 실제 절단과 `truncated` 판정은 Rust(`prompts.rs` 의 `PACK_CAP`)가
 * 하고, 여기 값은 설정 화면 안내 문구용 사본이다 — 원본은 Rust 쪽이다.
 */
export const PACK_CAP = 8_000;

/** 어떤 훅에도 배정되지 않은 상태. 명시적 opt-in 이라 기본값은 "아무것도 주입 안 함". */
const NO_HOOKS: Record<string, string[]> = {};

export function hooksOf(settings: AiSettings | null): Record<string, string[]> {
  return settings?.prompts?.hooks ?? NO_HOOKS;
}

export interface ComposedHook {
  text: string;
  /** 합성 상한을 넘겨 실리지 **않은** 팩의 파일명. 설정 화면이 경고로 띄운다. */
  dropped: string[];
}

/**
 * 훅에 배정된 팩들의 본문을 설정에 적힌 순서대로 이어 붙인다.
 *
 * 읽기에 실패했거나(`error`) 파일이 사라진 팩은 조용히 건너뛴다 — 설정은 파일 존재를
 * 검증하지 않으므로 사용자가 파일을 잠깐 빼 두는 것이 정상 경로다.
 *
 * 상한을 넘긴 팩은 `dropped` 로 **보고한다.** 조용히 빠뜨리면 사용자는 켜 둔 지침이
 * 실제로는 나가지 않는다는 사실을 알 방법이 없다. 상한에 닿으면 멈추고(`full`) 뒤를
 * 전부 버린다 — 팩 순서가 사용자 우선순위이므로, 큰 것을 건너뛰고 뒤의 작은 것을 넣으면
 * 오히려 예상을 벗어난다.
 */
export function composeHook(
  hook: PromptHook,
  packs: PromptPack[],
  hooks: Record<string, string[]>,
): ComposedHook {
  const files = hooks[hook] ?? [];
  if (files.length === 0) return { text: "", dropped: [] };

  const byFile = new Map(packs.map((p) => [p.file, p]));
  const bodies: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  let full = false;

  for (const file of files) {
    const pack = byFile.get(file);
    if (!pack || pack.error || !pack.body.trim()) continue;
    const body = pack.body.trim();
    if (full || used + body.length > HOOK_CAP) {
      full = true;
      dropped.push(file);
      continue;
    }
    bodies.push(body);
    used += body.length;
  }

  return { text: bodies.join("\n\n"), dropped };
}

/**
 * 주입 블록. 본문이 있을 때만 만든다.
 *
 * 마지막 줄이 안전장치다 — 사용자 지침이 출력 계약과 부딪히면 계약이 이긴다고 못박는다.
 * 진짜 방어선은 이 문장이 아니라 **삽입 위치**(계약보다 앞)이지만, 둘 다 있는 편이 낫다.
 */
export function injectionBlock(text: string): string {
  const body = text.trim();
  if (!body) return "";
  return [
    "# 추가 지침 (사용자 지정)",
    "아래는 이 앱의 사용자가 추가한 지침입니다. 위아래에 적힌 출력 형식과 충돌하면",
    "출력 형식이 우선합니다.",
    "",
    body,
  ].join("\n");
}

/** 훅 하나를 조립해 바로 프롬프트에 넣을 수 있는 형태로. */
export function injectionFor(
  hook: PromptHook,
  packs: PromptPack[],
  settings: AiSettings | null,
): string {
  return injectionBlock(composeHook(hook, packs, hooksOf(settings)).text);
}
