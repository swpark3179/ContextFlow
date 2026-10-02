import { splitFrontmatter } from "./markdown";

/**
 * 백엔드가 `index.md` 의 frontmatter 를 고친 뒤, 고치던 중이던 버퍼를 디스크 위에 다시
 * 얹는다 — **본문은 버퍼의 것, frontmatter 는 디스크의 것**.
 *
 * 편집기는 index.md 의 본문만 보여 주고, 글자를 칠 때마다 버퍼가 들고 있던 frontmatter 로
 * 파일 전체를 다시 조립한다(`EditorPane` 의 `onEdit`). 그래서 버퍼의 frontmatter 가 낡아
 * 있으면 다음 자동 저장이 상태 · 제목 · Run Log 를 조용히 옛 값으로 되돌린다. 조립은
 * `EditorPane` 과 **똑같이** 한다 — 다르면 다음 입력 때 머리가 또 한 번 바뀐다.
 */
export function rebaseIndexDoc(diskText: string, buf: string): string {
  const disk = splitFrontmatter(diskText);
  const mine = splitFrontmatter(buf);
  // 본문이 같으면 디스크 그대로 — 줄바꿈(CRLF) 차이만으로 버퍼가 더러워지지 않게.
  if (mine.body === disk.body) return diskText;
  // 디스크에 frontmatter 가 없으면 그것도 디스크를 따른다. 버퍼에도 없었으면 손대지 않는다.
  if (!disk.fm) return mine.fm ? mine.body : buf;
  return `---\n${disk.fm}\n---\n${mine.body}`;
}
