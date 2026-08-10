import { describe, expect, it } from "vitest";
import type { RecCandidate } from "./api";
import {
  RECOMMEND_FENCE,
  buildRecommendPrompt,
  buildRepairPrompt,
  parseRecommend,
} from "./recommendPrompt";

function cand(id: string, title: string, date = "2026-01-01"): RecCandidate {
  return { id, title, tags: [], path: `${id}/index.md`, date, text: title };
}

const CANDS = [
  cand("Tasks/q3", "Q3 보고서 작성", "2026-07-30"),
  cand("Tasks/q2", "Q2 보고서 작성", "2026-04-30"),
  cand("Tasks/db", "DB 백업 스크립트", "2026-02-01"),
];

const fence = (body: string) => "```recommend\n" + body + "\n```";

describe("buildRecommendPrompt", () => {
  it("lists every candidate id in the allowed set", () => {
    const p = buildRecommendPrompt({
      query: "Q4 보고서 작성",
      candidates: CANDS,
      threshold: 85,
      maxItems: 3,
    });
    for (const c of CANDS) expect(p).toContain(c.id);
    expect(p).toContain("85%");
    expect(p).toContain(RECOMMEND_FENCE);
  });

  /**
   * 사용자 지침은 출력 계약보다 **앞**에 놓여야 한다. 그것이 지침으로 펜스 규격을
   * 덮어쓸 수 없게 하는 진짜 방어선이다.
   */
  it("puts the user injection before the output contract", () => {
    const p = buildRecommendPrompt({
      query: "q",
      candidates: CANDS,
      threshold: 85,
      maxItems: 3,
      inject: "# 추가 지침 (사용자 지정)\n반복 업무를 위로",
    });
    expect(p.indexOf("반복 업무를 위로")).toBeLessThan(p.indexOf(RECOMMEND_FENCE));
  });

  it("omits the injection block when there is none", () => {
    const p = buildRecommendPrompt({ query: "q", candidates: CANDS, threshold: 85, maxItems: 3 });
    expect(p).not.toContain("추가 지침");
  });

  /** 최초 요청과 재질의가 같은 규격 문자열을 봐야 두 번째 답이 흔들리지 않는다. */
  it("reuses the identical fence spec in the repair prompt", () => {
    expect(buildRepairPrompt("이전 답변", ["Tasks/q3"])).toContain(RECOMMEND_FENCE);
  });
});

describe("parseRecommend", () => {
  it("maps a clean answer to recommendations", () => {
    const text = `같은 패턴입니다.\n\n${fence(
      '{"items":[{"id":"Tasks/q3","sim":92,"reason":"분기 보고서"}],"clusters":[]}',
    )}`;
    const got = parseRecommend(text, CANDS, 3);
    expect(got.parsed).toBe(true);
    expect(got.items).toEqual([
      { id: "Tasks/q3", sim: 92, title: "Q3 보고서 작성", path: "Tasks/q3/index.md", cluster: null },
    ]);
  });

  /** 모델은 그럴듯한 폴더명을 만들어 낸다. 그것이 통과하면 없는 노트를 열려고 한다. */
  it("drops ids that are not real candidates", () => {
    const text = fence('{"items":[{"id":"Tasks/없음","sim":99},{"id":"Tasks/db","sim":40}]}');
    const got = parseRecommend(text, CANDS, 3);
    expect(got.items.map((i) => i.id)).toEqual(["Tasks/db"]);
  });

  /**
   * `Number(null) === 0` 은 유한수라 NaN 가드를 통과한다. 점수를 안 매긴 후보가 0% 로
   * 기록되면 안 되고, 그 후보는 아예 빠져야 한다.
   */
  it("drops candidates whose sim is not a real number", () => {
    const text = fence(
      '{"items":[{"id":"Tasks/q3","sim":null},{"id":"Tasks/q2","sim":""},{"id":"Tasks/db","sim":"70"}]}',
    );
    const got = parseRecommend(text, CANDS, 3);
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({ id: "Tasks/db", sim: 70 });
  });

  it("clamps sim into 0..100 and sorts by it", () => {
    const text = fence(
      '{"items":[{"id":"Tasks/db","sim":10},{"id":"Tasks/q3","sim":140},{"id":"Tasks/q2","sim":-5}]}',
    );
    const got = parseRecommend(text, CANDS, 3);
    expect(got.items.map((i) => [i.id, i.sim])).toEqual([
      ["Tasks/q3", 100],
      ["Tasks/db", 10],
      ["Tasks/q2", 0],
    ]);
  });

  it("folds a cluster under its representative, newest child first", () => {
    const text = fence(
      '{"items":[{"id":"Tasks/q3","sim":92},{"id":"Tasks/q2","sim":88},{"id":"Tasks/db","sim":20}],' +
        '"clusters":[{"repId":"Tasks/q3","memberIds":["Tasks/q2"]}]}',
    );
    const got = parseRecommend(text, CANDS, 3);
    // 접힌 자식은 자기 카드를 갖지 않는다.
    expect(got.items.map((i) => i.id)).toEqual(["Tasks/q3", "Tasks/db"]);
    const cluster = got.items[0]!.cluster!;
    expect(cluster.map((c) => c.title)).toEqual(["Q3 보고서 작성 (대표)", "Q2 보고서 작성"]);
    expect(cluster[0]!.sim).toBe(92);
  });

  it("ignores clusters whose representative or members are unknown", () => {
    const text = fence(
      '{"items":[{"id":"Tasks/q3","sim":90}],"clusters":[{"repId":"Tasks/없음","memberIds":["Tasks/q3"]},' +
        '{"repId":"Tasks/q3","memberIds":["Tasks/없음"]}]}',
    );
    const got = parseRecommend(text, CANDS, 3);
    expect(got.items).toHaveLength(1);
    expect(got.items[0]!.cluster).toBeNull();
  });

  it("honours maxItems", () => {
    const text = fence(
      '{"items":[{"id":"Tasks/q3","sim":90},{"id":"Tasks/q2","sim":80},{"id":"Tasks/db","sim":70}]}',
    );
    expect(parseRecommend(text, CANDS, 2).items).toHaveLength(2);
  });

  it("de-duplicates a candidate the model listed twice", () => {
    const text = fence('{"items":[{"id":"Tasks/q3","sim":90},{"id":"Tasks/q3","sim":50}]}');
    const got = parseRecommend(text, CANDS, 3);
    expect(got.items).toHaveLength(1);
    expect(got.items[0]!.sim).toBe(90);
  });

  /**
   * "같은 패턴이 없다" 는 정당한 답이다. 이것을 미파싱으로 보면 재질의를 한 번 더 태우고
   * 로컬 유사도가 억지로 뭔가를 끼워 넣는다.
   */
  it("treats an empty item list as a parsed answer", () => {
    const got = parseRecommend(fence('{"items":[],"clusters":[]}'), CANDS, 3);
    expect(got.parsed).toBe(true);
    expect(got.items).toEqual([]);
  });

  it("reports not-parsed when the fence is missing or unusable", () => {
    expect(parseRecommend("펜스를 안 썼습니다", CANDS, 3).parsed).toBe(false);
    expect(parseRecommend("", CANDS, 3).parsed).toBe(false);
  });

  it("flags a salvaged truncated answer but keeps what survived", () => {
    const text = '```recommend\n{"items":[{"id":"Tasks/q3","sim":92},{"id":"Tasks/q2","si';
    const got = parseRecommend(text, CANDS, 3);
    expect(got.parsed).toBe(true);
    expect(got.truncated).toBe(true);
    expect(got.items.map((i) => i.id)).toEqual(["Tasks/q3"]);
  });
});
