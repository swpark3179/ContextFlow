/**
 * FabriX 연결 테스트 문장 → 단계 줄. 문장은 `fabrix.rs` 의 `probe_fabrix` 가 내는 그대로다.
 */
import { describe, expect, it } from "vitest";
import { PROBE_CHAT, PROBE_LIST, probeView } from "./probe";

describe("probeView", () => {
  it("lists models in one step", () => {
    const v = probeView(true, "연결됨 — 모델 5개를 조회했습니다.");
    expect(v.ok).toBe(true);
    expect(v.steps).toEqual([{ label: PROBE_LIST, state: "ok", detail: "모델 5개" }]);
    expect(v.summary).toBe("연결됨 — 모델 5개를 조회했습니다.");
  });

  it("falls back to a chat when the list is blocked", () => {
    const v = probeView(true, "연결됨 — 모델 목록은 받지 못했지만 대화로 확인했습니다 (모델: Glm 5.2).");
    expect(v.steps.map((s) => [s.label, s.state])).toEqual([
      [PROBE_LIST, "fail"],
      [PROBE_CHAT, "ok"],
    ]);
    expect(v.steps[1]!.detail).toBe("모델 Glm 5.2");
  });

  it("keeps both reasons when both steps fail", () => {
    const v = probeView(
      false,
      "연결 실패 — 모델 목록: FabriX HTTP 403 Forbidden — denied\n→ 힌트 줄\n대화 확인(019f-uuid): HTTP 401 Unauthorized — no token",
    );
    expect(v.ok).toBe(false);
    expect(v.steps[0]).toEqual({
      label: PROBE_LIST,
      state: "fail",
      detail: "FabriX HTTP 403 Forbidden — denied\n→ 힌트 줄",
    });
    expect(v.steps[1]).toEqual({
      label: PROBE_CHAT,
      state: "fail",
      detail: "019f-uuid · HTTP 401 Unauthorized — no token",
    });
  });

  it("does not show the chat step when there was no model to try", () => {
    const v = probeView(
      false,
      "연결 실패 — 모델 목록: FabriX 연결 실패: timeout\n대화로 확인할 모델이 없습니다. 모델 id 를 직접 지정하면 대화로 확인합니다.",
    );
    expect(v.steps).toEqual([{ label: PROBE_LIST, state: "fail", detail: "FabriX 연결 실패: timeout" }]);
    expect(v.summary).toBe("연결 실패 — 대화로 확인할 모델이 없습니다. 모델 id 를 직접 지정하면 대화로 확인합니다.");
  });

  it("leaves unknown messages as a plain summary", () => {
    const v = probeView(false, "FabriX 연결 정보가 없습니다. 엔드포인트를 먼저 저장하세요.");
    expect(v.steps).toEqual([]);
    expect(v.summary).toBe("FabriX 연결 정보가 없습니다. 엔드포인트를 먼저 저장하세요.");
  });
});
