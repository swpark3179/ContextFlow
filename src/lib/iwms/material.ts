import type { TaskMeta } from "../api";
import { composeDiscardBody } from "../daylog";
import { splitFrontmatter } from "../markdown";
import { mappedCategory } from "./categories";
import type { Target } from "./marks";
import type { Designated, Price } from "./types";

/**
 * 정제의 재료 — 오늘의 한일 한 줄이 AI 에게 넘어가는 모양.
 *
 * 오늘의 한일의 내용은 비어 있는 날이 대부분이다(2026-10-02 실측: 10줄 모두 빈 내용). 그래서 그 줄이
 * 가리키는 **업무 폴더**에서 맥락을 끌어온다 — ContextFlow 카테고리 · 태그, `index.md` 개요, 그날의 Run
 * Log 줄. 자유 항목(회의 · 전화)은 제목과 내용뿐이다.
 */
export interface Material {
  entryId: number;
  title: string;
  body: string;
  price: Price;
  /** ContextFlow 업무 카테고리(`프로젝트/S-PCS-Plus`). 자유 항목 · 미분류는 `null`. */
  taskCategory: string | null;
  tags: string[];
  /** `index.md` 본문 앞부분(골격 머리말 · Run Log 절 제외). */
  overview: string;
  /** 그날의 Run Log 줄(`- 2026-10-02 13:19 · …` 에서 앞의 `- ` 를 뗀 것). */
  runLog: string[];
  /** 설정의 매핑으로 정해진 카테고리. 있으면 AI 는 이것을 고른다. */
  fixed: Designated | null;
}

/** 개요 상한. 길면 카테고리를 고르는 신호가 묻힌다. */
export const OVERVIEW_CAP = 600;
const RUN_LOG_HEADING = "## 실행 이력 (Run Log)";

/**
 * `index.md` → 개요(앞 `cap` 자). 앱이 만든 `## 개요` 머리말과 Run Log 절은 빼고, 코드 블록은 `(코드 생략)`
 * 으로 접는다 — 설정 파일 · SQL 은 카테고리를 고르는 데 잡음이고 상한만 먹는다(2026-10-02 실데이터).
 */
export function overviewOf(indexText: string, cap = OVERVIEW_CAP): string {
  const { body } = splitFrontmatter(indexText);
  const cut = body.indexOf(RUN_LOG_HEADING);
  const main = composeDiscardBody("", cut >= 0 ? body.slice(0, cut) : body);
  const text = main
    .replace(/```[\s\S]*?(```|$)/g, "(코드 생략)")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** 그날의 Run Log 줄. */
export function runLogOf(indexText: string, day: string): string[] {
  const text = indexText.replace(/\r\n/g, "\n");
  const at = text.indexOf(RUN_LOG_HEADING);
  if (at < 0) return [];
  const out: string[] = [];
  for (const line of text.slice(at + RUN_LOG_HEADING.length).split("\n").slice(1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const m = /^-\s+(.*)$/.exec(line.trim());
    if (m && m[1].startsWith(day)) out.push(m[1]);
  }
  return out;
}

/** 경로 비교 — 오늘의 한일에는 `\` 와 `/` 가 섞여 들어 있다. Windows 경로라 대소문자도 가리지 않는다. */
export function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

/**
 * 재료를 모은다. `read` 는 파일 읽기(`api.readTextFile`)다 — 못 읽으면 그 줄은 제목 · 내용만으로 간다.
 */
export async function collectMaterial(
  targets: Target[],
  tasks: TaskMeta[],
  designated: Designated[],
  day: string,
  read: (path: string) => Promise<string>,
): Promise<Material[]> {
  return Promise.all(
    targets.map(async ({ entry, price }) => {
      const task = entry.folder ? tasks.find((t) => samePath(t.folder, entry.folder!)) : undefined;
      let overview = "";
      let runLog: string[] = [];
      if (entry.folder) {
        const path = task?.indexPath ?? `${entry.folder.replace(/[\\/]+$/, "")}/index.md`;
        try {
          const text = await read(path);
          overview = overviewOf(text);
          runLog = runLogOf(text, day);
        } catch {
          /* 지워졌거나 옮겨진 업무 — 제목과 내용만으로 간다 */
        }
      }
      const taskCategory = task?.category ?? null;
      return {
        entryId: entry.id,
        title: entry.title,
        body: entry.body.trim(),
        price,
        taskCategory,
        tags: task?.tags ?? [],
        overview,
        runLog,
        fixed: mappedCategory(taskCategory, designated, price),
      };
    }),
  );
}
