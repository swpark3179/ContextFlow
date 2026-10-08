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
    expect(out.draft.todos).toEqual([{ text: "PG 연동 교체", from: ["in"], due: "2026-10-09", owner: "나", to: null }]);
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

describe("planBrief", () => {
  it("lays out the index.md sections the app owns, skipping empty ones", () => {
    const plan = b.planBrief(
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
        done: [],
        notes: [],
      },
      ["예산은?"],
      "2026-10-04",
    );
    expect(plan.blocks.every((x) => x.path === "index.md")).toBe(true);
    expect(plan.checks).toEqual([]);
    expect(b.planMarkdown(plan.blocks)).toBe(
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
    expect(b.planBrief(b.EMPTY_DRAFT, [], "2026-10-04")).toEqual({ blocks: [], checks: [] });
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

// ---------------------------------------------------------------------------
// 끝낸 일 · 상황 — 알맞은 파일 · 섹션에
// ---------------------------------------------------------------------------

const INDEX_DOC = [
  "---",
  "id: t",
  "---",
  "## 개요",
  "결제 PG 를 교체한다.",
  "",
  "## 할 일",
  "- [ ] PG 연동 교체",
  "- [ ] QA팀 검증 받기",
  "",
  "## 실행 이력 (Run Log)",
  "- 2026-10-04 10:00 · 업무 생성",
  "",
].join("\n");
const ISSUE_DOC = [
  "# B카드사 결제 실패",
  "",
  "## 처리할 일",
  "- [ ] B카드사 3DS 실패 원인 확인",
  "",
  "## 처리 기록",
  "",
].join("\n");
const FILES = b.briefFiles([
  { path: "index.md", text: INDEX_DOC },
  { path: "이슈/2026-10-05 B카드사 실패.md", text: ISSUE_DOC },
]);
const WITH_FILES = { sources: new Set(["in", "task"]), last: false, files: FILES };

describe("briefFiles", () => {
  it("gives every file, heading and open to-do an id", () => {
    expect(FILES.map((f) => f.id)).toEqual(["f1", "f2"]);
    // Run Log 는 앱이 회차를 적는 자리라 쓸 곳 후보가 아니다.
    expect(FILES[0]!.headings.map((h) => `${h.id} ${h.raw}`)).toEqual(["f1.h1 ## 개요", "f1.h2 ## 할 일"]);
    expect(FILES[0]!.todos.map((t) => `${t.id} ${t.text} @${t.heading}`)).toEqual([
      "f1.c1 PG 연동 교체 @## 할 일",
      "f1.c2 QA팀 검증 받기 @## 할 일",
    ]);
    expect(FILES[1]!.todos[0]).toMatchObject({ id: "f2.c1", raw: "- [ ] B카드사 3DS 실패 원인 확인" });
  });
});

describe("parseBrief — 쓸 곳", () => {
  it("resolves places and to-dos only to candidate ids, and sends unknown ones to the default place", () => {
    const out = b.parseBrief(
      fence({
        todos: [
          { text: "재테스트 요청", to: "f2.h2", from: ["in"] },
          { text: "운영 반영", to: "f9.h1", from: ["in"] },
        ],
        notes: [
          { text: "PG사가 API 키 발급을 다음 주로 미룸", to: "F1", from: ["in"] },
          { text: "B카드사 회신 대기", to: { file: "f2", section: "f2.h3" }, from: ["in"] },
          { text: "파일에서 옮겨 온 글", to: "f2.h3", from: ["f2"] },
        ],
        done: [{ text: "QA팀 검증 완료", todo: "f1.c2", to: null, from: ["in"] }],
      }),
      WITH_FILES,
    );
    expect(out.draft.todos.map((t) => t.to)).toEqual([
      { path: "이슈/2026-10-05 B카드사 실패.md", heading: "## 처리할 일" },
      null,
    ]);
    expect(out.draft.notes.map((n) => n.to)).toEqual([
      { path: "index.md", heading: null },
      { path: "이슈/2026-10-05 B카드사 실패.md", heading: "## 처리 기록" },
    ]);
    // 파일은 근거가 아니다.
    expect(out.dropped).toBe(1);
    expect(out.unplaced).toBe(1);
    expect(out.draft.done[0]!.todo).toEqual({ id: "f1.c2", path: "index.md", raw: "- [ ] QA팀 검증 받기", text: "QA팀 검증 받기" });
    // 고르지 않았으면 그 할 일이 있는 파일의 기본 기록 섹션.
    expect(out.draft.done[0]!.to).toEqual({ path: "index.md", heading: null });
  });

  it("logs a done item in the to-do's file record section, and never checks one to-do twice", () => {
    const out = b.parseBrief(
      fence({
        done: [
          { text: "원인 확인함 — 인증서 만료", todo: "f2.c1", from: ["in"] },
          { text: "또 같은 일", todo: "f2.c1", from: ["in"] },
          { text: "없는 할 일", todo: "f1.c9", from: ["in"] },
        ],
      }),
      WITH_FILES,
    );
    expect(out.draft.done.map((d) => d.todo?.id ?? null)).toEqual(["f2.c1", null, null]);
    expect(out.draft.done[0]!.to).toEqual({ path: "이슈/2026-10-05 B카드사 실패.md", heading: "## 처리 기록" });
    expect(out.unplaced).toBe(1);
  });

  it("works without candidate files — everything goes to index.md", () => {
    const out = b.parseBrief(fence({ notes: [{ text: "상황", to: "f1.h1", from: ["in"] }] }), SOURCES);
    expect(out.draft.notes).toEqual([{ text: "상황", from: ["in"], to: null }]);
    expect(out.unplaced).toBe(1);
  });
});

describe("buildBriefPrompt — 파일", () => {
  it("lists headings and open to-dos with ids, and says files are not evidence", () => {
    const p = b.buildBriefPrompt({
      task: TASK,
      input: "QA 검증 끝남",
      qa: [],
      files: FILES,
      round: 1,
      last: false,
      today: "2026-10-08",
      inject: "",
    });
    expect(p).toContain('<file id="f1" path="index.md">');
    expect(p).toContain("- f1.h2 ## 할 일");
    expect(p).toContain("- f1.c2 (f1.h2 아래) QA팀 검증 받기");
    expect(p).toContain("- f2.h3 ## 처리 기록");
    expect(p).toContain("사실의 근거가 아닙니다");
    expect(p).toContain('"done":[{"text":"…","todo":"f1.c2"');
    expect(p.indexOf("# 업무 폴더의 파일")).toBeLessThan(p.indexOf("# 출력 형식"));
  });

  it("names only the leading files when the outline is too long", () => {
    const many = b.briefFiles(
      Array.from({ length: 30 }, (_, i) => ({
        path: `노트 ${i}.md`,
        text: Array.from({ length: 20 }, (_, k) => `## 꽤 긴 제목을 가진 섹션 ${i}-${k}\n- [ ] 할 일 ${k}`).join("\n"),
      })),
    );
    const p = b.buildBriefPrompt({ task: TASK, input: "x", qa: [], files: many, round: 1, last: false, today: "2026-10-08", inject: "" });
    expect(p).toContain('<file id="f30" path="노트 29.md">(분량 상한으로 생략)</file>');
    expect(b.buildBriefPrompt({ task: TASK, input: "x", qa: [], round: 1, last: false, today: "2026-10-08", inject: "" })).toContain(
      "(글 파일이 없습니다",
    );
  });
});

describe("planBrief — 파일별 계획", () => {
  const ISSUE = "이슈/2026-10-05 B카드사 실패.md";
  const draft = {
    ...b.EMPTY_DRAFT,
    todos: [
      { text: "재테스트 요청", from: ["in"], due: null, owner: null, to: { path: ISSUE, heading: "## 처리할 일" } },
      { text: "운영 반영 준비", from: ["in"], due: "2026-10-16", owner: null },
    ],
    done: [
      {
        text: "QA팀 검증 완료, 결제 실패 0건",
        from: ["in"],
        todo: { id: "f1.c2", path: "index.md", raw: "- [ ] QA팀 검증 받기", text: "QA팀 검증 받기" },
        to: null,
      },
      {
        text: "원인 확인 — 인증서 만료",
        from: ["in"],
        todo: { id: "f2.c1", path: ISSUE, raw: "- [ ] B카드사 3DS 실패 원인 확인", text: "B카드사 3DS 실패 원인 확인" },
        to: { path: ISSUE, heading: "## 처리 기록" },
      },
    ],
    notes: [
      { text: "PG사가 API 키 발급을 다음 주로 미룸", from: ["in"], to: null },
      { text: "카드사 담당자 회신 대기", from: ["in"], to: { path: ISSUE, heading: null } },
    ],
  };

  it("groups lines by file and section with the app's line format, index.md first", () => {
    const plan = b.planBrief(draft, [], "2026-10-08");
    expect(plan.blocks.map((x) => `${x.path} › ${x.heading} (${x.fallback})`)).toEqual([
      "index.md › ## 할 일 (## 할 일)",
      "index.md › ## 진행 기록 (## 진행 기록)",
      `${ISSUE} › ## 처리할 일 (## 할 일)`,
      `${ISSUE} › ## 처리 기록 (## 진행 기록)`,
      `${ISSUE} › ## 진행 기록 (## 진행 기록)`,
    ]);
    expect(b.planMarkdown(plan.blocks.slice(0, 2))).toBe(
      [
        "## 할 일",
        "- [ ] 운영 반영 준비 — 기한 10/16(금)",
        "",
        "## 진행 기록",
        "- 10/08(목) 완료 — QA팀 검증 완료, 결제 실패 0건",
        "- 10/08(목) PG사가 API 키 발급을 다음 주로 미룸",
      ].join("\n"),
    );
    expect(plan.checks.map((c) => `${c.path} ${c.raw}`)).toEqual([
      "index.md - [ ] QA팀 검증 받기",
      `${ISSUE} - [ ] B카드사 3DS 실패 원인 확인`,
    ]);
    expect(b.planFiles(plan).map((g) => `${g.path}: ${g.blocks.length}+${g.checks.length}`)).toEqual([
      "index.md: 2+1",
      `${ISSUE}: 3+1`,
    ]);
  });

  it("moves a block to another place — the same place merges — and drops what is switched off", () => {
    const plan = b.planBrief(draft, [], "2026-10-08");
    const log = plan.blocks.find((x) => x.path === ISSUE && x.heading === "## 진행 기록")!;
    const moved = b.movePlan(plan, { [log.key]: { path: ISSUE, heading: "## 처리 기록" } });
    const rec = moved.blocks.filter((x) => x.path === ISSUE && x.heading === "## 처리 기록");
    expect(rec).toHaveLength(1);
    expect(rec[0]!.lines).toEqual(["- 10/08(목) 완료 — 원인 확인 — 인증서 만료", "- 10/08(목) 카드사 담당자 회신 대기"]);
    expect(rec[0]!.from).toEqual([b.blockKey(ISSUE, "## 처리 기록"), log.key]);
    // 기본 섹션으로 옮기면 그 블록의 기본 제목.
    const todo = plan.blocks.find((x) => x.heading === "## 처리할 일")!;
    const back = b.movePlan(plan, { [todo.key]: { path: "index.md", heading: null } });
    expect(back.blocks.find((x) => x.key === b.blockKey("index.md", "## 할 일"))!.lines).toEqual([
      "- [ ] 운영 반영 준비 — 기한 10/16(금)",
      "- [ ] 재테스트 요청",
    ]);

    const off = b.withoutOff(plan, new Set([plan.checks[0]!.key, plan.blocks[0]!.key]));
    expect(off.checks).toHaveLength(1);
    expect(off.blocks).toHaveLength(plan.blocks.length - 1);
    expect(b.planSize(b.withoutOff(plan, new Set([...plan.blocks, ...plan.checks].map((x) => x.key))))).toBe(0);
  });
});

describe("mergeSections", () => {
  it("appends at the end of a deeper section, including its sub-sections, ignoring headings in fences", () => {
    const doc = [
      "# 테스트",
      "",
      "```md",
      "### 2차",
      "```",
      "",
      "### 2차",
      "- a",
      "#### 세부",
      "- a1",
      "",
      "### 3차",
      "- c",
    ].join("\n");
    const out = b.mergeSections(doc, [{ heading: "### 2차", lines: ["- b", "- a"] }]);
    expect(out.fellBack).toBe(0);
    expect(out.text).toBe(
      ["# 테스트", "", "```md", "### 2차", "```", "", "### 2차", "- a", "#### 세부", "- a1", "", "- b", "", "### 3차", "- c", ""].join(
        "\n",
      ),
    );
  });

  it("falls back to the default section when the chosen heading is gone, and creates it before the Run Log", () => {
    const out = b.mergeSections(INDEX_DOC, [{ heading: "## 사라진 섹션", fallback: "## 진행 기록", lines: ["- 10/08(목) 상황"] }]);
    expect(out.fellBack).toBe(1);
    expect(out.text).toContain("- [ ] QA팀 검증 받기\n\n## 진행 기록\n- 10/08(목) 상황\n\n## 실행 이력 (Run Log)");
    // 두 번 넣어도 그대로.
    expect(b.mergeSections(out.text, [{ heading: "## 진행 기록", lines: ["- 10/08(목) 상황"] }]).text).toBe(out.text);
  });

  it("keeps frontmatter bytes and CRLF", () => {
    const crlf = INDEX_DOC.replace(/\n/g, "\r\n");
    const out = b.mergeSections(crlf, [{ heading: "## 할 일", lines: ["- [ ] 새 일"] }]).text;
    expect(out.startsWith("---\r\nid: t\r\n---\r\n")).toBe(true);
    expect(out).toContain("- [ ] QA팀 검증 받기\r\n\r\n- [ ] 새 일\r\n\r\n## 실행 이력");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("checkTodo", () => {
  it("checks only the exact open line, keeping indentation, bullet and line endings", () => {
    const doc = "---\r\nid: t\r\n---\r\n```\r\n  * [ ] 하위 일\r\n```\r\n- [ ] 위 일\r\n  * [ ] 하위 일\r\n";
    const out = b.checkTodo(doc, "* [ ] 하위 일");
    expect(out.found).toBe(true);
    expect(out.text).toBe("---\r\nid: t\r\n---\r\n```\r\n  * [ ] 하위 일\r\n```\r\n- [ ] 위 일\r\n  * [x] 하위 일\r\n");
    expect(out.line).toBe(7);
    // 이미 체크됐으면 건드리지 않는다.
    expect(b.checkTodo(out.text, "* [ ] 하위 일")).toEqual({ text: out.text, found: false, line: -1 });
  });
});

describe("applyBriefFile", () => {
  it("checks first, then appends, and points at the first block's section", () => {
    const r = b.applyBriefFile(
      INDEX_DOC,
      [{ heading: "## 진행 기록", fallback: "## 진행 기록", lines: ["- 10/08(목) 완료 — QA팀 검증 완료"] }],
      [{ raw: "- [ ] QA팀 검증 받기" }, { raw: "- [ ] 그 사이 지운 일" }],
    );
    expect(r.missed).toBe(1);
    expect(r.fellBack).toBe(0);
    expect(r.text).toBe(
      [
        "---",
        "id: t",
        "---",
        "## 개요",
        "결제 PG 를 교체한다.",
        "",
        "## 할 일",
        "- [ ] PG 연동 교체",
        "- [x] QA팀 검증 받기",
        "",
        "## 진행 기록",
        "- 10/08(목) 완료 — QA팀 검증 완료",
        "",
        "## 실행 이력 (Run Log)",
        "- 2026-10-04 10:00 · 업무 생성",
        "",
      ].join("\n"),
    );
    expect(r.text.split("\n")[r.line]).toBe("## 진행 기록");
    // 같은 계획을 다시 넣어도 그대로.
    const again = b.applyBriefFile(r.text, [{ heading: "## 진행 기록", fallback: "## 진행 기록", lines: ["- 10/08(목) 완료 — QA팀 검증 완료"] }], [
      { raw: "- [ ] QA팀 검증 받기" },
    ]);
    expect(again.text).toBe(r.text);
    expect(again.missed).toBe(1);
  });

  it("leaves the rest of the file alone when there is only a check", () => {
    const r = b.applyBriefFile(ISSUE_DOC, [], [{ raw: "- [ ] B카드사 3DS 실패 원인 확인" }]);
    expect(r.text).toBe(ISSUE_DOC.replace("- [ ] B카드사", "- [x] B카드사"));
    expect(r.line).toBe(3);
  });
});

describe("briefRound — 파일", () => {
  it("sends the candidate files and returns done items and notes with their places", async () => {
    replies.push({
      text: fence({
        done: [{ text: "QA팀 검증 완료", todo: "f1.c2", from: ["in"] }],
        notes: [{ text: "키 발급 지연", to: "zz", from: ["in"] }],
      }),
    });
    const out = await b.briefRound({
      run: ROUTE,
      task: TASK,
      input: "QA 검증 끝남, 키 발급 지연",
      qa: [],
      files: FILES,
      round: 1,
      today: "2026-10-08",
      inject: "",
    });
    expect(runs[0]!.prompt).toContain("- f1.c2 (f1.h2 아래) QA팀 검증 받기");
    expect(runs[0]!.systemPrompt).toContain("끝낸 일");
    expect(out.draft?.done[0]!.todo?.raw).toBe("- [ ] QA팀 검증 받기");
    expect(out.draft?.notes[0]!.to).toBeNull();
    expect(out.unplaced).toBe(1);
  });
});
