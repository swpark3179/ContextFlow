/**
 * 위키링크 해석 — Rust `wiki.rs` 의 `link_targets` · `stem_of` 와 같은 규칙.
 *
 * 링크 대상은 페이지의 **stem**(확장자를 뺀 파일 이름)이고 대소문자를 가리지 않는다.
 * `Wiki/` 접두사나 `topics/…` 같은 경로형도 받는다(색인 · 규약이 그렇게 쓴다).
 */
import type { WikiPageMeta } from "../api";

export interface WikiLink {
  target: string;
  label: string;
}

/** `[[대상|별칭]]` · `[[대상#제목]]` 들. 줄을 넘는 것은 링크가 아니다. */
export function extractWikiLinks(md: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of md.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const [rawTarget, ...rest] = m[1]!.split("|");
    const target = (rawTarget ?? "").split(/[#^]/)[0]!.trim();
    if (!target) continue;
    out.push({ target, label: rest.join("|").trim() || target });
  }
  return out;
}

/** 제목 비교용 정규화 — `stem_of` 를 흉내 낸다(괄호 제거 · 공백 접기 · 소문자). */
export function normTitle(title: string): string {
  return title
    .replace(/[[\]]/g, " ")
    .replace(/[\\/:*?"<>|#^]/g, "-")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** 링크 대상 → 페이지. 루트 파일(index · log · SCHEMA)과 못 찾은 대상은 `null`. */
export function resolveLink(target: string, pages: WikiPageMeta[]): WikiPageMeta | null {
  let t = target.trim().replace(/\.md$/i, "").replace(/\\/g, "/");
  t = t.replace(/^wiki\//i, "");
  const low = t.toLowerCase();
  if (low.includes("/")) {
    return pages.find((p) => p.path.replace(/\.md$/i, "").toLowerCase() === low) ?? null;
  }
  return pages.find((p) => p.stem.toLowerCase() === low) ?? null;
}

/** 제목으로 기존 페이지를 찾는다 — 계획의 "만들기" 가 사실은 "고치기" 인지 가린다. */
export function findByTitle(title: string, pages: WikiPageMeta[]): WikiPageMeta | null {
  const n = normTitle(title);
  if (!n) return null;
  return (
    pages.find((p) => p.kind !== "source" && (normTitle(p.title) === n || p.stem.toLowerCase() === n)) ??
    null
  );
}
