/**
 * 템플릿 기본 카테고리를 입력칸에 미리 채우는 규칙 — 새 업무 대화상자의 템플릿 고르기
 * (`setNtTemplate`)와 템플릿 등록 대화상자의 폴더 고르기(`TemplateModal`)가 함께 쓴다.
 */
import type { TaskMeta } from "./api";
import { keyOf, normalizeCategory } from "./category";

const keyOfText = (text: string) => keyOf(normalizeCategory(text).value);

/**
 * 고르는 대상(템플릿 · 원본 폴더)이 바뀔 때 카테고리 칸에 둘 값. 칸이 비었거나 앞 대상의 기본값
 * 그대로면 새 기본값(없으면 빈 칸)으로 갈아 끼우고, 사용자가 손으로 고친 값이면 그대로 둔다 —
 * 템플릿을 이리저리 바꿔 보는 동안 앞 템플릿의 기본값이 남지도, 사용자가 고른 값이 지워지지도 않게.
 *
 * 같은지는 키(`keyOf(normalizeCategory(x).value)`)로 본다 — `A › b` 로 쳐 둔 것도 기본값 `a/b`
 * 그대로다. 빈 칸은 글자로 가른다: 잘못된 값도 정규화하면 `null` 이라, 키로 보면 빈 칸과 같아진다.
 */
export function templatePrefill(current: string, prevDefault: string | null, nextDefault: string | null): string {
  const prev = prevDefault === null ? "" : keyOfText(prevDefault);
  const untouched = !current.trim() || (!!prev && keyOfText(current) === prev);
  return untouched ? (nextDefault ?? "") : current;
}

/**
 * 고른 폴더가 업무 폴더면 그 업무. 대화상자는 `\` 를 `/` 로 바꿔 넘기고, Windows 경로라 대소문자와
 * 끝의 `/` 는 가리지 않는다.
 */
export function taskAtFolder(tasks: TaskMeta[], dir: string): TaskMeta | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const want = norm(dir);
  return (want && tasks.find((t) => norm(t.folder) === want)) || null;
}
