import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Material } from "./material";
import { parseRefine } from "./parse";
import { buildIwmsPrompt, codeTable } from "./prompts";
import type { Designated, IwmsCategory, IwmsDay, IwmsSettings } from "./types";

const runs: string[] = [];
const replies: string[] = [];
vi.mock("../runOnce", () => ({
  runWithRetry: vi.fn(async (args: { prompt: string }) => {
    runs.push(args.prompt);
    const text = replies.shift() ?? "";
    return { text, ok: true, error: null, truncated: false };
  }),
}));

function cat(ciKey: string, wbsid: string, priceType: string, task = wbsid): IwmsCategory {
  return { ciKey, ciName: ciKey === "NON-OBJECT" ? "비대상" : "공통", wbsid, priceType, path: "대 > 중", task, templates: [], rows: [], minutes: 0, blocked: null };
}

const day: IwmsDay = {
  workDate: "2026-10-02",
  userId: "u",
  standardMinutes: 480,
  maxMinutes: 480,
  totalMinutes: 360,
  approved: false,
  holiday: false,
  tabs: [],
  categories: [
    cat("A", "w1", "O", "시스템 모니터링"),
    cat("A", "w2", "O", "SW 운영환경 구축"),
    cat("NON-OBJECT", "w1", "N", "내부 회의"),
  ],
};

const des = (c: IwmsCategory, extra: Partial<Designated> = {}): Designated => ({
  ciKey: c.ciKey,
  ciName: c.ciName,
  wbsid: c.wbsid,
  path: c.path,
  task: c.task,
  priceType: c.priceType,
  hint: "",
  mapFrom: [],
  samples: [],
  ...extra,
});

const mat = (entryId: number, price: "O" | "N", extra: Partial<Material> = {}): Material => ({
  entryId,
  title: `업무 ${entryId}`,
  body: "",
  price,
  taskCategory: null,
  tags: [],
  overview: "",
  runLog: [],
  fixed: null,
  ...extra,
});

const settings: IwmsSettings = {
  baseUrl: "http://x",
  fillToStandard: true,
  minuteStep: 10,
  styleGuide: "명사형으로 끝낸다",
  categories: [des(day.categories[1], { hint: "서버 기동 · 배포", samples: ["운영 서버 기동 및 점검"] })],
};

const fence = (items: unknown[]) => "판단 근거…\n```iwms\n" + JSON.stringify({ items }) + "\n```";

describe("프롬프트", () => {
  it("대가 구분별로 코드를 매기고, 지정한 것만 싣는다(없는 구분은 그날 전체)", () => {
    const t = codeTable(day, ["O", "N"], settings.categories);
    expect([...t.byCode.keys()]).toEqual(["O1", "N1"]);
    expect(t.byCode.get("O1")?.wbsid).toBe("w2");
    expect(t.groups.map((g) => g.fallback)).toEqual([false, true]);
  });

  it("남은 시간 · 설명 · 샘플 · 고정 · 작업 이력 · 작성 규칙이 실린다", () => {
    const items = [
      mat(1, "O", { fixed: settings.categories[0], runLog: ["2026-10-02 13:19 · 서버 기동"], overview: "standalone 옵션" }),
      mat(2, "N"),
    ];
    const p = buildIwmsPrompt({
      day,
      items,
      table: codeTable(day, ["O", "N"], settings.categories),
      designated: settings.categories,
      styleGuide: settings.styleGuide,
      remaining: 120,
      fill: true,
      step: 10,
      examples: [],
      inject: "",
    });
    expect(p).toContain("남은 시간 **120분**");
    expect(p).toContain("- O1: 공통 · 대 > 중 > SW 운영환경 구축");
    expect(p).toContain("설명: 서버 기동 · 배포");
    expect(p).toContain("    샘플:\n      | 운영 서버 기동 및 점검");
    expect(p).toContain("카테고리 고정: O1");
    expect(p).toContain("  - 2026-10-02 13:19 · 서버 기동");
    expect(p).toContain("  > standalone 옵션");
    expect(p).toContain("명사형으로 끝낸다");
    expect(p).toContain("```iwms");
    // wbsid 는 싣지 않는다 — 코드로만 주고받는다.
    expect(p).not.toContain("w2");
  });
});

describe("parseRefine", () => {
  const table = codeTable(day, ["O", "N"], []);
  // 지정이 없어 그날 전체: O1=w1 · O2=w2 · N1=회의

  it("코드를 카테고리로 되돌린다", () => {
    const r = parseRefine(fence([{ entryId: 1, category: "o2", minutes: "60", note: " 배포 수행 ", confidence: 88, alternatives: ["O1"] }]), [mat(1, "O")], table);
    expect(r.parsed).toBe(true);
    const d = r.drafts[0];
    expect(d.category?.wbsid).toBe("w2");
    expect(d.minutes).toBe(60);
    expect(d.note).toBe("배포 수행");
    expect(d.alternatives.map((c) => c.wbsid)).toEqual(["w1"]);
    expect(d.issues).toEqual([]);
  });

  it("없는 코드 · 대가 구분이 다른 코드는 비우고 알린다", () => {
    const r = parseRefine(
      fence([
        { entryId: 1, category: "O9", minutes: 30, note: "a" },
        { entryId: 2, category: "O1", minutes: 30, note: "b" },
      ]),
      [mat(1, "O"), mat(2, "N")],
      table,
    );
    expect(r.drafts.map((d) => d.category)).toEqual([null, null]);
    expect(r.drafts.every((d) => d.issues.length === 1)).toBe(true);
  });

  it("고정 카테고리는 AI 의 선택보다 이긴다", () => {
    const fixed = des(day.categories[0]);
    const r = parseRefine(fence([{ entryId: 1, category: "O2", minutes: 30, note: "a" }]), [mat(1, "O", { fixed })], table);
    expect(r.drafts[0].category?.wbsid).toBe("w1");
    expect(r.drafts[0].fixed).toBe(true);
  });

  it("빠뜨린 줄 · 빈 내용 · 긴 내용 · 범위 밖 분", () => {
    const r = parseRefine(
      fence([{ entryId: 1, category: "O1", minutes: 5000, note: "가".repeat(1200), confidence: 300 }, { entryId: 2, category: "N1", minutes: -5, note: "" }]),
      [mat(1, "O"), mat(2, "N", { body: "주간 회의" }), mat(3, "O")],
      table,
    );
    const [a, b, c] = r.drafts;
    expect(a.minutes).toBe(1440);
    expect(a.note.length).toBe(1000);
    expect(a.confidence).toBe(100);
    expect(b.minutes).toBe(0);
    expect(b.note).toBe("주간 회의");
    expect(c.confidence).toBeNull();
    expect(c.issues[0]).toContain("빠뜨렸습니다");
  });

  it("한 줄로 접힌 목록은 줄바꿈으로 편다", async () => {
    const { unfold } = await import("./parse");
    expect(unfold("서버 기동 / - 스크립트 적용 / - 옵션 추가")).toBe("서버 기동\n- 스크립트 적용\n- 옵션 추가");
    expect(unfold("A/B 테스트 / 결과 정리")).toBe("A/B 테스트 / 결과 정리");
  });

  it("형식이 아니면 parsed=false, 잘린 응답은 살려서 truncated", () => {
    expect(parseRefine("그냥 글", [mat(1, "O")], table).parsed).toBe(false);
    const cut = parseRefine('```iwms\n{"items":[{"entryId":1,"category":"O1","minutes":30,"note":"a"},{"entryId":2,"cat', [mat(1, "O"), mat(2, "O")], table);
    expect(cut.parsed).toBe(true);
    expect(cut.truncated).toBe(true);
    expect(cut.drafts[0].category?.wbsid).toBe("w1");
  });
});

describe("실제 응답 모양(사내 FabriX, 익명화)", () => {
  it("판단 근거 뒤의 펜스를 읽고, 접힌 목록을 펴고, 없는 대안은 버린다", async () => {
    const raw = await import("./fixtures/response.fabrix.txt?raw");
    const d: IwmsDay = {
      ...day,
      totalMinutes: 420,
      categories: [cat("A", "w9", "O", "요청조사/조치/종료"), cat("A", "w8", "O", "비정기 인프라 작업/지원"), cat("A", "w7", "O", "SW 운영환경 구축"), cat("NON-OBJECT", "n1", "N", "애플리케이션 운영")],
    };
    const table = codeTable(d, ["O", "N"], []);
    const r = parseRefine(raw.default, [mat(101, "O"), mat(102, "O"), mat(103, "N")], table);
    expect(r.parsed).toBe(true);
    expect(r.drafts.map((x) => [x.category?.task, x.minutes])).toEqual([
      ["비정기 인프라 작업/지원", 20],
      ["요청조사/조치/종료", 30],
      ["애플리케이션 운영", 10],
    ]);
    expect(r.drafts[1].note).toBe("협력사 임직원 등록현황 확인\n- 임직원관리 화면 데이터 미조회 현상 확인\n- 배치프로그램 실행 조치");
    expect(r.drafts[2].alternatives).toEqual([]);
  });
});

describe("mergeDrafts", () => {
  it("다시 정제해도 사람이 고친 칸은 남는다", async () => {
    const { mergeDrafts } = await import("./parse");
    const table = codeTable(day, ["O"], []);
    const [prev] = parseRefine(fence([{ entryId: 1, category: "O1", minutes: 30, note: "AI 1" }]), [mat(1, "O")], table).drafts;
    const edited = { ...prev, note: "사람이 고침", minutes: 90, edited: { note: true, minutes: true } };
    const [fresh] = parseRefine(fence([{ entryId: 1, category: "O2", minutes: 10, note: "AI 2" }]), [mat(1, "O")], table).drafts;
    const [m] = mergeDrafts([edited], [fresh]);
    expect(m).toMatchObject({ note: "사람이 고침", minutes: 90, edited: { note: true, minutes: true } });
    expect(m.category?.wbsid).toBe("w2");
  });
});

describe("refine", () => {
  beforeEach(() => {
    runs.length = 0;
    replies.length = 0;
  });

  it("형식을 어기면 한 번 고쳐 묻고, 분을 남은 시간에 맞춘다", async () => {
    const { refine } = await import("./refine");
    replies.push("펜스를 깜빡했습니다", fence([{ entryId: 1, category: "O1", minutes: 30, note: "a" }, { entryId: 2, category: "N1", minutes: 30, note: "b" }]));
    const r = await refine({
      run: { agentId: "claude", model: "default" },
      day,
      items: [mat(1, "O"), mat(2, "N")],
      settings,
      examples: [],
      inject: "",
    });
    expect(runs.length).toBe(2);
    expect(runs[1]).toContain("출력 형식");
    expect(r.error).toBeNull();
    expect(r.drafts.map((d) => d.minutes)).toEqual([60, 60]);
  });

  it("연결이 없으면 AI 없이 빈 초안과 사유", async () => {
    const { refine } = await import("./refine");
    const r = await refine({ run: null, day, items: [mat(1, "O", { body: "메모" })], settings, examples: [], inject: "" });
    expect(runs.length).toBe(0);
    expect(r.error).toContain("AI 연결");
    expect(r.drafts[0]).toMatchObject({ note: "메모", minutes: 120, category: null });
  });
});
