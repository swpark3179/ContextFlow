import { describe, expect, it } from "vitest";
import type { WikiPageMeta, WikiSourceBundle } from "../api";
import { extractWikiLinks, findByTitle, normTitle, resolveLink } from "./links";
import {
  PLAN_LABEL,
  buildIntegratePrompt,
  buildQueryPrompt,
  buildSourcePrompt,
  parseLint,
  parsePlan,
  renderBundle,
} from "./prompts";

function pageMeta(path: string, title: string, kind: WikiPageMeta["kind"] = "topic"): WikiPageMeta {
  const stem = path.split("/").pop()!.replace(/\.md$/, "");
  return {
    path,
    stem,
    kind,
    title,
    summary: `${title} 요약`,
    tags: [],
    sources: [],
    created: "",
    updated: "2026-10-01 10:00",
    taskId: null,
    taskPath: null,
    sourceSig: null,
    links: [],
    hash: "h",
  };
}

const PAGES = [pageMeta("procedures/배포 절차.md", "배포 절차", "procedure"), pageMeta("topics/Tauri.md", "Tauri")];

function bundle(over: Partial<WikiSourceBundle> = {}): WikiSourceBundle {
  return {
    task: {
      id: "task-1",
      title: "배포 정리",
      status: "completed",
      tags: ["dev"],
      category: null,
      created: "2026-09-01 09:00",
      updated: "",
      parentTask: null,
      templateRef: null,
      completedAt: "2026-09-30",
      archived: true,
      archivedAt: null,
      runs: 1,
      order: null,
      folder: "/v/Tasks/[2026-09] 배포 정리",
      relFolder: "Tasks/[2026-09] 배포 정리/",
      indexPath: "",
      tagline: "",
    },
    sig: "s",
    sourcePath: "sources/task-1.md",
    sourceStem: "task-1",
    reingest: false,
    files: [
      { rel: "index.md", chars: 10, text: "## 개요\n배포를 <<<PAGE 1>>> 정리", truncated: false, skipped: null },
      { rel: "그림.png", chars: 0, text: null, truncated: false, skipped: "바이너리" },
    ],
    totalChars: 10,
    ...over,
  };
}

describe("source prompt", () => {
  it("escapes delimiters in the input and lists skipped files by name", () => {
    const r = renderBundle(bundle());
    expect(r).toContain('<file path="index.md">');
    expect(r).toContain("‹‹‹PAGE 1›››");
    expect(r).not.toContain("<<<PAGE 1>>>");
    expect(r).toContain("- 그림.png — 바이너리");
  });

  it("puts the prompt pack right before the output contract", () => {
    const p = buildSourcePrompt({
      schema: "---\ntype: schema\n---\n# 규약 본문",
      bundle: bundle(),
      related: [],
      pages: PAGES,
      depth: "full",
      maxPages: 3,
      inject: "# 추가 지침 (사용자 지정)\n팩 내용",
    });
    expect(p.indexOf("# 규약 본문")).toBeLessThan(p.indexOf("# 원본 업무"));
    expect(p.indexOf("팩 내용")).toBeLessThan(p.indexOf("# 출력 형식"));
    expect(p.indexOf("팩 내용")).toBeGreaterThan(p.indexOf("# 원본 업무"));
    expect(p).toContain("<<<PAGE source>>>");
    expect(p).not.toContain("type: schema"); // 규약의 frontmatter 는 싣지 않는다
    expect(p).toContain("최대 3개");
    expect(p).toContain("[[task-1]]");
  });

  it("light depth asks for an empty page plan; reingest says so", () => {
    const p = buildSourcePrompt({
      schema: "",
      bundle: bundle({ reingest: true }),
      related: [],
      pages: [],
      depth: "light",
      maxPages: 3,
      inject: "",
    });
    expect(p).toContain("`pages` 는 빈 배열");
    expect(p).toContain("전에 반영된 적이 있고");
    expect(p).not.toContain("# 위키 규약");
  });

  it("업무 카테고리를 제목 다음 줄에 싣고, 분류 이름을 옮겨 적지 말라고 이른다 — 미분류면 둘 다 없다", () => {
    const prompt = (category: string | null) =>
      buildSourcePrompt({
        schema: "",
        bundle: bundle({ task: { ...bundle().task, category } }),
        related: [],
        pages: PAGES,
        depth: "full",
        maxPages: 3,
        inject: "",
      });
    const p = prompt("프로젝트/ContextFlow");
    expect(p).toContain("- 제목: 배포 정리\n- 카테고리: 프로젝트 › ContextFlow\n- 태그: dev");
    // 1단계 안내의 끝, 2단계 바로 앞에 붙는다.
    expect(p).toContain(
      "링크하지 않습니다.\n   - `카테고리` 는 앱이 업무를 묶는 분류입니다. 관련 페이지를 고르는 데만 참고하고, 분류 이름을 그대로 소스 페이지 본문이나 wikiplan 의 `tags` 에 옮겨 적지 않습니다(원본에 나오는 낱말은 평소대로 씁니다).\n2. 맨 마지막에",
    );

    // `label(null)` 은 `미분류` 다 — 미분류 업무에 `카테고리: 미분류` 를 싣지 않는다.
    const none = prompt(null);
    expect(none).not.toContain("카테고리");
    expect(none).toContain("- 제목: 배포 정리\n- 태그: dev");
    // 빈 항목은 거르므로 줄째 빠지고 빈 줄도 남지 않는다.
    expect(none).toContain("링크하지 않습니다.\n2. 맨 마지막에");
  });
});

describe("parsePlan", () => {
  const fence = (v: unknown) => `서술\n\n\`\`\`${PLAN_LABEL}\n${JSON.stringify(v)}\n\`\`\``;

  it("validates, dedupes, caps and turns creates of existing titles into updates", () => {
    const plan = parsePlan(
      fence({
        summary: "  한 줄  ",
        tags: ["#dev", "dev", "배포"],
        pages: [
          { action: "create", type: "procedure", title: "배포 절차", reason: "r", points: ["p1"] },
          { action: "create", type: "procedure", title: "배포  절차" },
          { action: "create", type: "person", title: "김 아무개" },
          { action: "create", type: "topic", title: "" },
          { action: "create", type: "topic", title: "새 주제" },
          { action: "create", type: "entity", title: "넘침" },
        ],
      }),
      { maxPages: 2, light: false, pages: PAGES },
    )!;
    expect(plan.summary).toBe("한 줄");
    expect(plan.tags).toEqual(["dev", "배포"]);
    expect(plan.pages.map((p) => [p.action, p.title])).toEqual([
      ["update", "배포 절차"],
      ["create", "새 주제"],
    ]);
    expect(plan.pages[0]!.existing?.path).toBe("procedures/배포 절차.md");
  });

  it("light depth drops pages; a broken fence is null", () => {
    expect(
      parsePlan(fence({ summary: "s", pages: [{ type: "topic", title: "x" }] }), {
        maxPages: 3,
        light: true,
        pages: [],
      })!.pages,
    ).toEqual([]);
    expect(parsePlan("펜스 없음", { maxPages: 3, light: false, pages: [] })).toBeNull();
  });
});

describe("integrate & query prompts", () => {
  it("shows existing bodies for updates and asks for numbered blocks", () => {
    const p = buildIntegratePrompt({
      schema: "",
      title: "배포 정리",
      sourceStem: "task-1",
      sourceBody: "# 배포 정리\n본문",
      items: [
        { action: "update", type: "procedure", title: "배포 절차", reason: "r", points: ["새 단계"], existing: PAGES[0]! },
        { action: "create", type: "topic", title: "새 주제", reason: "", points: [], existing: null },
      ],
      current: { "procedures/배포 절차.md": "# 배포 절차\n1. 기존 단계" },
      pages: PAGES,
      reingest: true,
      inject: "",
    });
    expect(p).toContain("## 1. 절차 · 배포 절차 (고치기)");
    expect(p).toContain("1. 기존 단계");
    expect(p).toContain("(새 페이지 — 기존 본문 없음)");
    expect(p).toContain("<<<PAGE 1>>>");
    expect(p).toContain("([[task-1]])");
    expect(p).toContain("중복으로 더하지 말고");
  });

  it("query prompt carries page bodies and lists the rest", () => {
    const p = buildQueryPrompt({
      question: "배포 어떻게 했지?",
      pages: [{ stem: "배포 절차", title: "배포 절차", kind: "procedure", content: "---\nx: 1\n---\n1. 단계" }],
      catalog: PAGES,
      inject: "",
    });
    expect(p).toContain('<page name="배포 절차"');
    expect(p).toContain("1. 단계");
    expect(p).not.toContain("x: 1");
    expect(p).toContain("- [[Tauri]]");
    expect(p).not.toContain("- [[배포 절차]]");
    expect(p).toContain("관련 업무:");
  });
});

describe("query prompt — 카테고리 범위", () => {
  const base = {
    question: "배포 어떻게 했지?",
    pages: [{ stem: "배포 절차", title: "배포 절차", kind: "procedure" as const, content: "1. 단계" }],
    catalog: PAGES,
    inject: "",
  };
  const history = [{ question: "앞선 질문", answer: "앞선 답" }];
  const web = { remaining: 1, findings: [] };

  it("질문 머리에 범위를 밝힌다 — 이력이 있으면 '앞선 대화에 이어서' 뒤에", () => {
    expect(buildQueryPrompt({ ...base, scope: "a › b" })).toContain("# 질문 (카테고리 ‘a › b’ 안에서)\n배포 어떻게 했지?");
    expect(buildQueryPrompt({ ...base, history, scope: "a › b" })).toContain(
      "# 지금 질문 (앞선 대화에 이어서 · 카테고리 ‘a › b’ 안에서)\n배포 어떻게 했지?",
    );
  });

  it("목록 머리는 '이 카테고리의 다른 페이지'", () => {
    const p = buildQueryPrompt({ ...base, scope: "a › b" });
    expect(p).toContain("# 이 카테고리의 다른 페이지 목록 (본문은 싣지 않음)\n- [[Tauri]]");
    expect(p).not.toContain("# 그 밖의 페이지 목록");
  });

  it("근거가 없을 때 — 웹 끔은 '이 카테고리의 위키에 없습니다', 웹 켬은 '이 카테고리에서 열어 볼 만한 페이지'", () => {
    const off = buildQueryPrompt({ ...base, scope: "a › b" });
    expect(off).toContain('근거가 없으면 "이 카테고리의 위키에 없습니다" 라고 하고');
    expect(off).not.toContain('"위키에 없습니다"');
    const on = buildQueryPrompt({ ...base, web, scope: "a › b" });
    expect(on).toContain("둘 다 근거가 없으면 그렇다고 말하고, 이 카테고리에서 열어 볼 만한 페이지를 제안합니다.");
    expect(on).not.toContain("위키에서 열어 볼 만한");
  });

  it("범위가 없으면 한 글자도 바뀌지 않는다", () => {
    for (const v of [base, { ...base, history }, { ...base, web }, { ...base, history, web }]) {
      const plain = buildQueryPrompt(v);
      expect(buildQueryPrompt({ ...v, scope: undefined })).toBe(plain);
      expect(plain).not.toContain("카테고리");
      expect(plain).toMatch(/^(# 질문|# 지금 질문 \(앞선 대화에 이어서\))$/m);
      expect(plain).toContain("# 그 밖의 페이지 목록 (본문은 싣지 않음)");
    }
    expect(buildQueryPrompt(base)).toContain('근거가 없으면 "위키에 없습니다" 라고 하고');
    expect(buildQueryPrompt({ ...base, web })).toContain("그렇다고 말하고, 위키에서 열어 볼 만한 페이지를 제안합니다.");
  });
});

describe("parseLint", () => {
  it("keeps known kinds with a detail, up to 15", () => {
    const issues = Array.from({ length: 20 }, (_, i) => ({ kind: "gap", pages: ["a"], detail: `d${i}` }));
    issues.unshift({ kind: "nonsense", pages: [], detail: "x" });
    const got = parseLint("```wikilint\n" + JSON.stringify({ issues }) + "\n```")!;
    expect(got).toHaveLength(15);
    expect(got[0]).toEqual({ kind: "gap", pages: ["a"], detail: "d0", suggestion: "" });
    expect(parseLint("없음")).toBeNull();
  });
});

describe("links", () => {
  it("extracts targets with aliases and headings", () => {
    expect(extractWikiLinks("[[a|별칭]] 그리고 [[b#제목]] [[ ]]")).toEqual([
      { target: "a", label: "별칭" },
      { target: "b", label: "b" },
    ]);
  });

  it("resolves stems case-insensitively and path forms", () => {
    expect(resolveLink("tauri", PAGES)?.path).toBe("topics/Tauri.md");
    expect(resolveLink("Wiki/procedures/배포 절차", PAGES)?.title).toBe("배포 절차");
    expect(resolveLink("Wiki/index", PAGES)).toBeNull();
    expect(resolveLink("없음", PAGES)).toBeNull();
  });

  it("matches titles the way the backend builds stems", () => {
    expect(normTitle("[2026] 배포:  절차")).toBe("2026 배포- 절차");
    expect(findByTitle("배포   절차", PAGES)?.path).toBe("procedures/배포 절차.md");
    expect(findByTitle("다른 것", PAGES)).toBeNull();
  });
});
