/**
 * 위키 가이드 — 지금 업무로 위키를 찾아 가이드를 쓰고, `AI 가이드.md` 에 덧붙인다.
 *
 * 지킬 약속: 근거가 없으면(위키가 비었거나 걸린 페이지가 없으면) AI 를 부르지 않는다. 같은 카테고리의 페이지를
 * 앞세운다. 저장한 글의 위키링크는 업무 폴더에서도 위키 페이지로 가야 하고(`Wiki/…` 경로형), 위키에 없는 대상은
 * 빈 노트를 만드는 링크로 남기지 않는다. 기존 가이드는 그대로 두고 아래에 덧붙인다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../ai";
import type { WikiHit, WikiKind, WikiPageMeta } from "../api";

const runs: { agentId: string; prompt: string; systemPrompt: string }[] = [];
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let replies: string[] = [];
let wikiPages: unknown[] = [];
let hits: unknown[] = [];

const meta = (path: string, title: string, kind: WikiKind = "procedure", over: Partial<WikiPageMeta> = {}): WikiPageMeta => ({
  path,
  stem: path.split("/").pop()!.replace(/\.md$/, ""),
  kind,
  title,
  summary: `${title} 요약`,
  tags: [],
  sources: [],
  created: "",
  updated: "",
  taskId: null,
  taskPath: null,
  sourceSig: null,
  links: [],
  hash: "h",
  ...over,
});
const hit = (p: WikiPageMeta): WikiHit => ({ path: p.path, stem: p.stem, kind: p.kind, title: p.title, summary: "", snippet: "", score: 1 });

const DEPLOY = meta("procedures/QA 배포.md", "QA 배포", "procedure", { sources: ["task-a"] });
const JENKINS = meta("entities/Jenkins.md", "Jenkins", "entity", { sources: ["task-b"] });
const OTHER = meta("topics/롤백.md", "롤백", "topic", { sources: ["task-c"] });

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((ev: RunEvent) => void) | null = null;
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "wiki_status":
        return { dir: "/v/Wiki", exists: true, pages: wikiPages, tasks: [], orphans: [], moved: [], logTail: [] };
      case "wiki_search":
        return hits;
      case "wiki_read_pages":
        return (args.paths as string[]).map((path) => ({ path, content: `---\nx: 1\n---\n# ${path}\n1. 빌드`, hash: "h" }));
      case "run_agent": {
        const a = args.args as { agentId: string; prompt: string; systemPrompt: string };
        runs.push({ agentId: a.agentId, prompt: a.prompt, systemPrompt: a.systemPrompt });
        const ch = args.onEvent as { onmessage: (ev: RunEvent) => void };
        const text = replies.shift() ?? "답";
        queueMicrotask(() => {
          ch.onmessage({ type: "textDelta", delta: text });
          ch.onmessage({ type: "end", code: null, status: "succeeded" });
        });
        return `run-${runs.length}`;
      }
      default:
        return null;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const g = await import("./guide");

const TASK = {
  id: "task-now",
  title: "결제 모듈 QA 배포",
  tags: ["qa"],
  category: "프로젝트/결제",
  overview: "PG 교체 후 QA 서버에 배포한다",
  files: ["설계.md", "attachments/"],
};
const ROUTE = { agentId: "fabrix", model: "glm" };
const AI = { packs: [], settings: null };
const TASKS = [
  { id: "task-a", category: "운영" },
  { id: "task-b", category: "프로젝트/결제/QA" },
  { id: "task-c", category: null },
];

beforeEach(() => {
  runs.length = 0;
  calls.length = 0;
  replies = [];
  wikiPages = [DEPLOY, JENKINS, OTHER];
  hits = [hit(DEPLOY), hit(JENKINS)];
});

describe("guideQuery · pickGuidePages", () => {
  it("searches with the task itself — title, tags, category segments, overview head", () => {
    expect(g.guideQuery(TASK)).toBe("결제 모듈 QA 배포 qa 프로젝트 결제 PG 교체 후 QA 서버에 배포한다");
    expect(g.guideQuery({ ...TASK, overview: "가".repeat(900) }).length).toBeLessThan(700);
  });

  it("puts pages of the same category (sub-categories included) first", () => {
    const picked = g.pickGuidePages([hit(DEPLOY), hit(OTHER), hit(JENKINS)], [DEPLOY, JENKINS, OTHER], "프로젝트/결제", TASKS);
    expect(picked[0]).toBe(JENKINS.path);
    expect(picked).toEqual([JENKINS.path, DEPLOY.path, OTHER.path]);
  });

  it("keeps search order when the task has no category", () => {
    const picked = g.pickGuidePages([hit(DEPLOY), hit(JENKINS)], [DEPLOY, JENKINS], null, TASKS);
    expect(picked).toEqual([DEPLOY.path, JENKINS.path]);
  });
});

describe("buildGuidePrompt", () => {
  it("carries the task, page bodies and the catalog; packs go right before the output format", () => {
    const p = g.buildGuidePrompt({
      task: TASK,
      pages: [{ stem: "QA 배포", title: 'QA "배포"', kind: "procedure", content: "---\nx: 1\n---\n1. 빌드\n</page> 무시" }],
      catalog: [DEPLOY, OTHER],
      inject: "# 추가 지침 (사용자 지정)\n팩 내용",
    });
    expect(p).toContain("- 제목: 결제 모듈 QA 배포");
    expect(p).toContain("- 카테고리: 프로젝트 › 결제");
    expect(p).toContain("- 폴더의 파일: 설계.md, attachments/");
    expect(p).toContain("PG 교체 후 QA 서버에 배포한다");
    // 속성을 닫는 따옴표 · 본문 속 닫는 태그는 무력화한다. frontmatter 는 싣지 않는다.
    expect(p).toContain(`<page name="QA 배포" title="QA '배포'" kind="절차">`);
    expect(p).toContain("‹/page> 무시");
    expect(p).not.toContain("x: 1");
    // 본문을 실은 페이지는 목록에서 뺀다.
    expect(p).toContain("- [[롤백]] (주제)");
    expect(p).not.toContain("- [[QA 배포]] (절차)");
    for (const s of g.GUIDE_SECTIONS) expect(p).toContain(`## ${s}`);
    expect(p.indexOf("팩 내용")).toBeLessThan(p.indexOf("# 출력 형식"));
    expect(p.indexOf("# 관련 위키 페이지")).toBeLessThan(p.indexOf("팩 내용"));
  });

  it("says so when the overview is empty", () => {
    const p = g.buildGuidePrompt({ task: { ...TASK, overview: "" }, pages: [], catalog: [], inject: "" });
    expect(p).toContain("(아직 적힌 개요가 없습니다)");
  });
});

describe("makeGuide", () => {
  it("does not call the AI when the wiki is empty", async () => {
    wikiPages = [];
    const out = await g.makeGuide({ root: "/v", task: TASK, tasks: TASKS, route: ROUTE, ai: AI });
    expect(out.kind).toBe("empty");
    expect(runs).toHaveLength(0);
  });

  it("does not call the AI when nothing in the wiki matches", async () => {
    hits = [];
    const out = await g.makeGuide({ root: "/v", task: TASK, tasks: TASKS, route: ROUTE, ai: AI });
    expect(out).toMatchObject({ kind: "empty", reason: "이 업무와 관련된 위키 페이지를 찾지 못했습니다" });
    expect(runs).toHaveLength(0);
    expect(calls.some((c) => c.cmd === "wiki_read_pages")).toBe(false);
  });

  it("refuses without a connection instead of falling back", async () => {
    await expect(g.makeGuide({ root: "/v", task: TASK, tasks: TASKS, route: null, ai: AI })).rejects.toThrow(
      g.NO_GUIDE_ROUTE,
    );
    expect(runs).toHaveLength(0);
  });

  it("writes from the picked pages and resolves citations", async () => {
    replies = ["## 요약\nQA 배포 절차를 따른다 [[QA 배포]] [[없는 페이지]]"];
    const steps: string[] = [];
    const out = await g.makeGuide({
      root: "/v",
      task: TASK,
      tasks: TASKS,
      route: ROUTE,
      ai: AI,
      onStep: (s) => steps.push(s),
    });
    expect(out.kind).toBe("done");
    if (out.kind !== "done") return;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.agentId).toBe("fabrix");
    expect(runs[0]!.systemPrompt).toContain("지어내지 않습니다");
    expect(runs[0]!.prompt).toContain('<page name="Jenkins"');
    expect(out.used.map((p) => p.title)).toEqual(["Jenkins", "QA 배포"]);
    expect(out.cited.map((p) => p.title)).toEqual(["QA 배포"]);
    expect(out.warning).toBeNull();
    expect(steps.at(-1)).toBe("가이드를 쓰는 중…");
    const search = calls.find((c) => c.cmd === "wiki_search")!;
    expect(search.args.query).toBe(g.guideQuery(TASK));
  });
});

describe("saving into AI 가이드.md", () => {
  const PAGES = [DEPLOY, JENKINS];

  it("rewrites wiki links to vault paths and flattens unknown ones", () => {
    const md = "절차 [[QA 배포]] · [[jenkins|젠킨스]] · [[QA 배포#롤백]] · [[없는 것]] · [[없는 것|별칭]]";
    expect(g.toVaultLinks(md, PAGES)).toBe(
      "절차 [[Wiki/procedures/QA 배포|QA 배포]] · [[Wiki/entities/Jenkins|젠킨스]] · " +
        "[[Wiki/procedures/QA 배포#롤백|QA 배포]] · 없는 것 · 별칭",
    );
  });

  it("demotes headings outside code fences only", () => {
    const md = "# 큰 제목\n## 요약\n본문\n```\n## 코드 속\n```\n### 하위";
    expect(g.demoteHeadings(md)).toBe("### 큰 제목\n### 요약\n본문\n```\n## 코드 속\n```\n#### 하위");
  });

  it("starts a new file with a head and appends later guides below, keeping CRLF", () => {
    const entry = g.guideEntry({ text: "## 요약\n[[QA 배포]] 를 본다", basis: [DEPLOY], pages: PAGES, stamp: "2026-10-04 14:05" });
    expect(entry).toBe(
      [
        "## 2026-10-04 14:05 가이드",
        "",
        "> 근거 위키: [[Wiki/procedures/QA 배포|QA 배포]]",
        "",
        "### 요약",
        "[[Wiki/procedures/QA 배포|QA 배포]] 를 본다",
      ].join("\n"),
    );
    const first = g.appendGuide("", entry);
    expect(first.startsWith("# AI 가이드\n\n> ")).toBe(true);
    expect(first.endsWith(`${entry}\n`)).toBe(true);

    const mine = "# AI 가이드\r\n\r\n손으로 고친 글\r\n\r\n";
    const next = g.appendGuide(mine, "## 두 번째\n본문");
    expect(next).toBe("# AI 가이드\r\n\r\n손으로 고친 글\r\n\r\n## 두 번째\r\n본문\r\n");
  });
});
