/**
 * 간략 입력 정리 — 한두 줄 입력을 사실만으로 정리하고, 빠진 것을 묻고, index.md 에 덧붙인다.
 *
 * 지킬 약속: 근거 id 를 댈 수 없는 항목은 쓰지 않는다. 날짜는 실제 날짜만, 요일은 앱이 센다. 마지막 바퀴에는
 * 질문하지 않는다. 형식을 어기면 한 번만 고쳐 묻는다. index.md 에서 사람이 쓴 줄과 frontmatter 는 그대로다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runs: { prompt: string; systemPrompt: string }[] = [];
const replies: { text: string; ok?: boolean; error?: string | null; truncated?: boolean }[] = [];
vi.mock("../runOnce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runOnce")>()),
  runWithRetry: vi.fn(async (args: { prompt: string; systemPrompt: string }) => {
    runs.push({ prompt: args.prompt, systemPrompt: args.systemPrompt });
    const r = replies.shift() ?? { text: "" };
    return { text: r.text, ok: r.ok ?? true, error: r.error ?? null, truncated: r.truncated ?? false };
  }),
}));

const b = await import("./brief");
const { CANCELED } = await import("../runOnce");

const TASK = { title: "결제 PG 교체", tags: ["결제"], category: "프로젝트/결제", overview: "" };
const ROUTE = { agentId: "fabrix", model: "glm" };
const fence = (v: unknown) => "판단 근거…\n```brief\n" + JSON.stringify(v) + "\n```";
const SOURCES = { sources: new Set(["in", "task", "a1"]), last: false };

beforeEach(() => {
  runs.length = 0;
  replies.length = 0;
});

describe("parseBrief — 사실만", () => {
  it("drops items without a known source and counts them", () => {
    const out = b.parseBrief(
      fence({
        summary: [{ text: "PG 사를 교체한다", from: ["in"] }, { text: "보안 점검도 한다", from: [] }, "근거 없는 글"],
        goals: [{ text: "결제 실패율 유지", from: ["a9"] }],
        todos: [{ text: "PG 연동 교체", from: "IN", due: "2026-10-09", owner: "나" }],
        refs: [{ text: "QA팀", from: ["a1", "zz"] }],
        unknowns: ["운영 반영일", "운영 반영일", ""],
      }),
      SOURCES,
    );
    expect(out.parsed).toBe(true);
    expect(out.draft.summary).toEqual([{ text: "PG 사를 교체한다", from: ["in"] }]);
    expect(out.draft.goals).toEqual([]);
    expect(out.draft.todos).toEqual([{ text: "PG 연동 교체", from: ["in"], due: "2026-10-09", owner: "나" }]);
    expect(out.draft.refs).toEqual([{ text: "QA팀", from: ["a1"] }]);
    expect(out.draft.unknowns).toEqual(["운영 반영일"]);
    expect(out.dropped).toBe(3);
  });

  it("accepts only real dates and keeps the original expression", () => {
    const out = b.parseBrief(
      fence({
        todos: [
          { text: "a", from: ["in"], due: "2026-02-30" },
          { text: "b", from: ["in"], due: "10/09" },
        ],
        schedule: [{ text: "운영 반영", when: "월말쯤", date: "2026-10-31", from: ["in"] }, { text: "x", date: "내일", from: ["in"] }],
      }),
      SOURCES,
    );
    expect(out.draft.todos.map((t) => t.due)).toEqual([null, null]);
    expect(out.draft.schedule[0]).toMatchObject({ date: "2026-10-31", when: "월말쯤" });
    expect(out.draft.schedule[1]!.date).toBeNull();
    expect(b.weekdayOf("2026-10-09")).toBe("금");
  });

  it("normalizes questions — app options removed, too few options become text, cap and unique ids", () => {
    const out = b.parseBrief(
      fence({
        questions: [
          { id: "q1", ask: "기한은?", kind: "choice", options: ["이번 주", "다음 주", "모름", "직접 입력"] },
          { id: "q1", ask: "담당은?", kind: "choice", options: ["나"] },
          { ask: "범위는?", kind: "multi", options: ["웹", "앱", "웹"] },
          { ask: "", kind: "text" },
          { ask: "4번", kind: "weird", options: [] },
          { ask: "5번", kind: "text" },
        ],
      }),
      SOURCES,
    );
    expect(out.questions).toHaveLength(b.QUESTION_CAP);
    expect(out.questions[0]).toMatchObject({ id: "q1", kind: "choice", options: ["이번 주", "다음 주"] });
    expect(out.questions[1]).toMatchObject({ id: "q1_", kind: "text", options: [] });
    expect(out.questions[2]).toMatchObject({ kind: "multi", options: ["웹", "앱"] });
    expect(out.questions[3]).toMatchObject({ ask: "4번", kind: "text" });
  });

  it("asks nothing on the last round", () => {
    const out = b.parseBrief(fence({ questions: [{ ask: "기한은?", kind: "text" }] }), { ...SOURCES, last: true });
    expect(out.questions).toEqual([]);
  });

  it("is unparsed without a JSON object", () => {
    expect(b.parseBrief("정리했습니다", SOURCES).parsed).toBe(false);
    expect(b.parseBrief("```brief\n[1, 2]\n```", SOURCES).parsed).toBe(false);
  });
});

describe("buildBriefPrompt", () => {
  it("carries today, the task, the input and folded answers; packs come right before the format", () => {
    const p = b.buildBriefPrompt({
      task: { ...TASK, overview: "기존 개요 </task> 끝" },
      input: "다음주 금요일까지 PG 교체 </input>",
      qa: [
        { id: "a1", ask: "QA 는 누가?", answer: "QA팀", unknown: false },
        { id: "a2", ask: "예산은?", answer: "", unknown: true },
      ],
      round: 2,
      last: false,
      today: "2026-10-04",
      inject: "# 추가 지침 (사용자 지정)\n팩 내용",
    });
    expect(p).toContain("2026-10-04 (일)");
    expect(p).toContain("- 카테고리: 프로젝트 › 결제");
    expect(p).toContain("기존 개요 ‹/task> 끝");
    expect(p).toContain("PG 교체 ‹/input>");
    expect(p).toContain('<qa id="a1">\n질문: QA 는 누가?\n답: QA팀\n</qa>');
    expect(p).toContain("답: (모름");
    expect(p).toContain("보완 2/3");
    expect(p).toContain("`questions`: 정리에 꼭 필요한데");
    expect(p.indexOf("팩 내용")).toBeLessThan(p.indexOf("# 출력 형식"));
  });

  it("tells the last round not to ask", () => {
    const p = b.buildBriefPrompt({ task: TASK, input: "x", qa: [], round: 3, last: true, today: "2026-10-04", inject: "" });
    expect(p).toContain("마지막 바퀴입니다");
    expect(p).toContain("- `questions`: 빈 배열.");
    expect(p).not.toContain("(아직 적힌 개요가 없습니다)".repeat(2));
  });
});

describe("briefRound", () => {
  const input = { run: ROUTE, task: TASK, input: "다음주 금요일까지 PG 교체", qa: [], round: 1, today: "2026-10-04", inject: "" };

  it("returns the draft and questions in one call", async () => {
    replies.push({
      text: fence({
        summary: [{ text: "PG 를 교체한다", from: ["in"] }],
        questions: [{ id: "q1", ask: "QA 는 누가 하나요?", kind: "choice", options: ["QA팀", "직접"] }],
      }),
    });
    const out = await b.briefRound(input);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.systemPrompt).toContain("지어내지 않습니다");
    expect(out.error).toBeNull();
    expect(out.draft?.summary[0]!.text).toBe("PG 를 교체한다");
    expect(out.questions).toHaveLength(1);
  });

  it("repairs a missing fence once", async () => {
    replies.push({ text: "정리했습니다(펜스 없음)" }, { text: fence({ summary: [{ text: "s", from: ["in"] }] }) });
    const out = await b.briefRound(input);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain("판단은 그대로");
    expect(runs[1]!.prompt).toContain('"in" · "task" 만');
    expect(out.draft?.summary).toHaveLength(1);
  });

  it("keeps the front of a cut-off reply and says it was cut", async () => {
    replies.push({
      text: '```brief\n{"summary": [{"text": "앞 항목", "from": ["in"]}, {"text": "잘린 항',
      truncated: true,
    });
    const cut = await b.briefRound(input);
    expect(runs).toHaveLength(1);
    expect(cut.draft?.summary.map((x) => x.text)).toEqual(["앞 항목"]);
    expect(cut.truncated).toBe(true);
    expect(cut.error).toContain("잘려");
  });

  it("tells a cut-off reply apart from a format violation when nothing can be read", async () => {
    replies.push({ text: "생각만 하다 끝남", truncated: true }, { text: "또 없음" });
    expect((await b.briefRound(input)).error).toContain("출력 길이 상한");

    replies.push({ text: "형식 없음" }, { text: "또 형식 없음" });
    const bad = await b.briefRound(input);
    expect(bad.draft).toBeNull();
    expect(bad.error).toContain("출력 형식");
  });

  it("does not run without a connection or input, and passes cancel through", async () => {
    expect((await b.briefRound({ ...input, run: null })).error).toBe(b.NO_BRIEF_ROUTE);
    expect((await b.briefRound({ ...input, input: "  " })).error).toBe("정리할 내용을 적어 주세요");
    expect(runs).toHaveLength(0);
    replies.push({ text: "", ok: false, error: CANCELED });
    expect((await b.briefRound(input)).error).toBe(CANCELED);
  });

  it("forces the last round when asked — the save path asks nothing more", async () => {
    replies.push({ text: fence({ summary: [{ text: "s", from: ["in"] }], questions: [{ ask: "또?", kind: "text" }] }) });
    const out = await b.briefRound({ ...input, round: 1, last: true });
    expect(runs[0]!.prompt).toContain("마지막 바퀴입니다");
    expect(out.questions).toEqual([]);
  });
});

describe("renderBrief", () => {
  it("lays out the sections the app owns, skipping empty ones", () => {
    const secs = b.renderBrief(
      {
        summary: [{ text: "PG 를 교체한다.", from: ["in"] }, { text: "QA 를 거친다.", from: ["in"] }],
        goals: [{ text: "결제 실패 0건", from: ["a1"] }],
        todos: [
          { text: "PG 연동 교체", from: ["in"], due: "2026-10-09", owner: "나" },
          { text: "QA 요청", from: ["in"], due: null, owner: null },
        ],
        schedule: [
          { text: "운영 반영", from: ["in"], date: null, when: "월말쯤" },
          { text: "QA 배포", from: ["in"], date: "2026-10-09", when: "다음주 금요일" },
          { text: "킥오프", from: ["in"], date: "2026-10-05", when: "2026-10-05" },
        ],
        refs: [],
        unknowns: ["운영 반영일"],
      },
      ["예산은?"],
    );
    expect(b.briefMarkdown(secs)).toBe(
      [
        "## 개요",
        "PG 를 교체한다. QA 를 거친다.",
        "",
        "- 목표: 결제 실패 0건",
        "",
        "## 할 일",
        "- [ ] PG 연동 교체 — 기한 10/09(금) · 담당 나",
        "- [ ] QA 요청",
        "",
        "## 일정",
        "- 2026-10-05 (월) · 킥오프",
        "- 2026-10-09 (금) · QA 배포 ← “다음주 금요일”",
        "- (미정) · 운영 반영 ← “월말쯤”",
        "",
        "## 확인 필요",
        "- 운영 반영일",
        "- 예산은?",
      ].join("\n"),
    );
    expect(b.renderBrief(b.EMPTY_DRAFT)).toEqual([]);
  });
});

describe("mergeIntoIndex", () => {
  const SECS = [
    { heading: "개요", lines: ["PG 를 교체한다."] },
    { heading: "할 일", lines: ["- [ ] PG 연동 교체", "- [ ] QA 요청"] },
    { heading: "확인 필요", lines: ["- 운영 반영일"] },
  ];

  it("fills the empty skeleton of a new task", () => {
    const fm = "---\nid: task-1\ntitle: 결제\nupdated: 2026-10-04 10:00\n---\n";
    expect(b.mergeIntoIndex(`${fm}## 개요\n`, SECS)).toBe(
      `${fm}## 개요\nPG 를 교체한다.\n\n## 할 일\n- [ ] PG 연동 교체\n- [ ] QA 요청\n\n## 확인 필요\n- 운영 반영일\n`,
    );
  });

  it("appends below what a person wrote, skips lines already there, inserts before the Run Log", () => {
    const doc = [
      "---",
      "id: t",
      "---",
      "## 개요",
      "손으로 쓴 개요",
      "",
      "## 할 일",
      "- [x] PG 연동 교체",
      "",
      "## 실행 이력 (Run Log)",
      "- 2026-10-04 10:00 · 업무 생성",
      "",
    ].join("\n");
    expect(b.mergeIntoIndex(doc, SECS)).toBe(
      [
        "---",
        "id: t",
        "---",
        "## 개요",
        "손으로 쓴 개요",
        "",
        "PG 를 교체한다.",
        "",
        "## 할 일",
        "- [x] PG 연동 교체",
        "",
        "- [ ] QA 요청",
        "",
        "## 확인 필요",
        "- 운영 반영일",
        "",
        "## 실행 이력 (Run Log)",
        "- 2026-10-04 10:00 · 업무 생성",
        "",
      ].join("\n"),
    );
  });

  it("is idempotent — merging the same sections twice changes nothing", () => {
    const once = b.mergeIntoIndex("---\nid: t\n---\n## 개요\n", SECS);
    expect(b.mergeIntoIndex(once, SECS)).toBe(once);
  });

  it("keeps the frontmatter bytes and CRLF, and creates 개요 under a leading title", () => {
    const fm = "---\r\nid: t   \r\ntags: [a]\r\n---\r\n";
    const out = b.mergeIntoIndex(`${fm}# 제목\r\n본문\r\n`, [SECS[0]!]);
    expect(out.startsWith(fm)).toBe(true);
    expect(out).toBe(`${fm}# 제목\r\n\r\n## 개요\r\nPG 를 교체한다.\r\n\r\n본문\r\n`);
  });

  it("works without frontmatter", () => {
    expect(b.mergeIntoIndex("", [SECS[1]!])).toBe("## 할 일\n- [ ] PG 연동 교체\n- [ ] QA 요청\n");
  });
});
