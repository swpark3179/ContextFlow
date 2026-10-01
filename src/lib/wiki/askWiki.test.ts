/**
 * 위키 질의의 진행 — 대화 이력과 웹 검색 바퀴.
 *
 * 지킬 약속: 웹 검색은 질의 모델이 요청할 때만 하고, 검색 결과는 **웹 검색 연결**의 모델이
 * 추리며, 바퀴 수에는 끝이 있다. 검색이 실패해도 질의는 위키로 답한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../ai";

interface Run {
  agentId: string;
  model: string;
  prompt: string;
}

const runs: Run[] = [];
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
/** 다음 `run_agent` 들이 차례로 돌려줄 답. */
let replies: string[] = [];
let searchFails = false;

const meta = (path: string, title: string, kind = "procedure") => ({
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
});
const PAGES = [meta("procedures/QA 배포.md", "QA 배포"), meta("topics/Jenkins.md", "Jenkins", "topic")];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((ev: RunEvent) => void) | null = null;
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "wiki_status":
        return { dir: "/v/Wiki", exists: true, pages: PAGES, tasks: [], orphans: [], moved: [], logTail: [] };
      case "wiki_search": {
        const q = String(args.query);
        // 이어지는 질문("두 번째 단계는?")은 그것만으로는 아무것도 안 걸린다.
        if (!/배포|Jenkins/.test(q)) return [];
        return [{ path: "procedures/QA 배포.md", stem: "QA 배포", kind: "procedure", title: "QA 배포", summary: "", snippet: "", score: 1 }];
      }
      case "wiki_read_pages":
        return (args.paths as string[]).map((path) => ({ path, content: `# ${path}\n1. 빌드\n2. 헬스 체크`, hash: "h" }));
      case "web_search":
        if (searchFails) throw "검색 엔진(google)이 자동 검색을 막았습니다(보안 문자).";
        // 한 글자 검색어는 저마다 다른 결과 한 건.
        if (String(args.query).length === 1) {
          const q = String(args.query);
          return { query: q, engine: "google", url: "", results: [{ title: q, url: `https://${q}.test/`, snippet: `${q} 요약` }] };
        }
        return {
          query: args.query,
          engine: "google",
          url: "https://www.google.com/search",
          results: [
            { title: "retry 문서", url: "https://www.jenkins.io/doc/retry", snippet: "retry(3)" },
            { title: "블로그", url: "https://blog.test/a", snippet: "재시도 이야기" },
            { title: "세 번째", url: "https://third.test", snippet: "" },
          ],
        };
      case "web_read":
        return { url: args.url, finalUrl: args.url, title: "읽은 페이지", text: `본문 of ${args.url}`, truncated: false };
      case "run_agent": {
        const a = args.args as Run;
        runs.push({ agentId: a.agentId, model: a.model, prompt: a.prompt });
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

const { askWiki } = await import("./pipeline");
const { WEB_LABEL } = await import("./web");

const QUERY = { agentId: "fabrix", model: "glm" };
const WEB = { route: { agentId: "fabrix", model: "oss" }, browser: { path: null, show: false, engine: "google" as const }, pages: 2 };
const AI = { packs: [], settings: null };
const searchFence = (q: string) => "```" + WEB_LABEL + `\n{"queries": ["${q}"], "reason": "문서 확인"}\n` + "```";

beforeEach(() => {
  runs.length = 0;
  calls.length = 0;
  replies = [];
  searchFails = false;
});

describe("askWiki — conversation", () => {
  it("answers in one call without web search, never touching the browser", async () => {
    replies = ["QA 배포는 Jenkins 로 [[QA 배포]]"];
    const out = await askWiki({ root: "/v", question: "QA 배포 어떻게 해?", route: QUERY, ai: AI });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).not.toContain("```" + WEB_LABEL);
    expect(out.cited.map((p) => p.title)).toEqual(["QA 배포"]);
    expect(out.searches).toEqual([]);
    expect(calls.some((c) => c.cmd.startsWith("web_"))).toBe(false);
  });

  it("finds pages for a follow-up through the previous question and citations", async () => {
    replies = ["두 번째는 헬스 체크 [[QA 배포]]"];
    const out = await askWiki({
      root: "/v",
      question: "그럼 두 번째 단계는?",
      route: QUERY,
      ai: AI,
      history: [{ question: "QA 배포 어떻게 해?", answer: "1. 빌드 2. 헬스 체크" }],
      carry: ["topics/Jenkins.md"],
    });
    expect(out.used.map((p) => p.path).sort()).toEqual(["procedures/QA 배포.md", "topics/Jenkins.md"]);
    expect(runs[0]!.prompt.startsWith("# 지금까지의 대화")).toBe(true);
    // 앞선 질문과 합친 검색을 한 번 더 했다.
    expect(calls.filter((c) => c.cmd === "wiki_search").map((c) => c.args.query)).toEqual([
      "그럼 두 번째 단계는?",
      "그럼 두 번째 단계는? QA 배포 어떻게 해?",
    ]);
  });
});

describe("askWiki — web search", () => {
  it("searches when asked, has the web model condense the pages, then answers citing [웹n]", async () => {
    replies = [
      "위키에 없어 찾아봅니다.\n" + searchFence("Jenkins retry"),
      "- retry(3) 으로 세 번 재시도 [웹1]",
      "위키 절차대로 하되 실패하면 retry 를 씁니다 [웹1] [[QA 배포]]",
    ];
    const steps: string[] = [];
    const partials: string[] = [];
    const out = await askWiki({
      root: "/v",
      question: "Jenkins 재시도 옵션은?",
      route: QUERY,
      ai: AI,
      web: WEB,
      onStep: (s) => steps.push(s),
      onPartial: (t) => partials.push(t),
    });

    expect(runs.map((r) => r.model)).toEqual(["glm", "oss", "glm"]);
    expect(runs[0]!.prompt).toContain("```" + WEB_LABEL);
    // 검색어 그대로, 결과 앞 두 장만 읽는다.
    expect(calls.filter((c) => c.cmd === "web_search").map((c) => c.args.query)).toEqual(["Jenkins retry"]);
    expect(calls.filter((c) => c.cmd === "web_read").map((c) => c.args.url)).toEqual([
      "https://www.jenkins.io/doc/retry",
      "https://blog.test/a",
    ]);
    // 정리 모델은 페이지 본문을 받는다.
    expect(runs[1]!.prompt).toContain("본문 of https://www.jenkins.io/doc/retry");
    // 다시 묻는 질의에는 추린 결과가 실리고, 남은 검색 한 번이 더 열려 있다.
    expect(runs[2]!.prompt).toContain("# 웹 검색 결과");
    expect(runs[2]!.prompt).toContain("[웹1] retry 문서 — https://www.jenkins.io/doc/retry");
    expect(runs[2]!.prompt).toContain("```" + WEB_LABEL);

    expect(out.answer).toBe("위키 절차대로 하되 실패하면 retry 를 씁니다 [웹1] [[QA 배포]]");
    expect(out.searches).toEqual(["Jenkins retry"]);
    expect(out.webCited.map((s) => s.url)).toEqual(["https://www.jenkins.io/doc/retry"]);
    expect(out.webErrors).toEqual([]);
    expect(steps).toContain("웹 검색: Jenkins retry");
    expect(steps.some((s) => s.startsWith("웹 페이지 읽는 중 1/2"))).toBe(true);
    // 검색 요청 펜스는 답처럼 흘러나오지 않는다.
    expect(partials.some((p) => p.includes(WEB_LABEL))).toBe(false);
  });

  it("answers from the wiki when the browser search fails, telling the model why", async () => {
    searchFails = true;
    replies = [searchFence("x"), "위키로만 답합니다 [[QA 배포]]"];
    const out = await askWiki({ root: "/v", question: "q 배포", route: QUERY, ai: AI, web: WEB });
    expect(runs).toHaveLength(2); // 정리 모델은 부르지 않는다
    expect(runs[1]!.prompt).toContain("검색하지 못했습니다");
    expect(out.webErrors[0]).toContain("보안 문자");
    expect(out.answer).toBe("위키로만 답합니다 [[QA 배포]]");
  });

  it("stops after the last round even if the model keeps asking", async () => {
    replies = [searchFence("a"), "- 사실 [웹1]", searchFence("b"), "- 사실 [웹4]", searchFence("c")];
    await expect(askWiki({ root: "/v", question: "q 배포", route: QUERY, ai: AI, web: WEB })).rejects.toThrow(
      "검색만 요청",
    );
    // 질의 3번(마지막은 검색이 닫힌 프롬프트) + 정리 2번.
    expect(runs).toHaveLength(5);
    expect(runs[4]!.prompt).toContain("더 할 수 없습니다");
    expect(calls.filter((c) => c.cmd === "web_search")).toHaveLength(2);
    // 두 번째 바퀴는 번호를 이어 매긴다.
    expect(runs[3]!.prompt).toContain("- [웹2] b — https://b.test/");
    expect(runs[3]!.prompt).not.toContain("- [웹1] ");
  });

  it("does not re-read pages a second search finds again", async () => {
    replies = [searchFence("Jenkins retry"), "- 사실 [웹1]", searchFence("Jenkins retry 옵션"), "답 [웹1]"];
    const out = await askWiki({ root: "/v", question: "q 배포", route: QUERY, ai: AI, web: WEB });
    // 질의 3번 + 정리 1번 — 두 번째 검색은 본 페이지뿐이라 정리하지 않는다.
    expect(runs.map((r) => r.model)).toEqual(["glm", "oss", "glm", "glm"]);
    expect(calls.filter((c) => c.cmd === "web_read")).toHaveLength(2);
    expect(out.webErrors).toEqual(["새 검색 결과가 없습니다 — 앞서 찾은 페이지와 같습니다"]);
    expect(out.webCited.map((s) => s.n)).toEqual([1]);
  });
});
