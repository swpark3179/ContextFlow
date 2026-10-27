/**
 * FabriX 연결 테스트 결과를 단계 줄로 편다.
 *
 * 백엔드(`fabrix.rs` 의 `probe_fabrix`)는 두 단계(① 모델 목록 조회 → 실패하면 ② 첫 모델로 최소 대화
 * 1회)를 한 번에 돌고 문장 하나만 돌려준다. 화면은 그 문장을 단계마다 한 줄로 나눠 보인다 — 목록만
 * 막힌 게이트웨이에서 "연결 실패" 한 덩어리로 보이면 실제로는 대화가 되는 연결을 버리게 된다.
 * 문장 모양은 백엔드와 짝이다. 모르는 문장이면 단계 없이 그대로 둔다.
 */
import type { StepState } from "./shared";

export const PROBE_LIST = "① 모델 목록 조회";
export const PROBE_CHAT = "② 첫 모델로 최소 대화 1회";

export interface ProbeStep {
  label: string;
  state: StepState;
  detail: string;
}

export interface ProbeView {
  ok: boolean;
  steps: ProbeStep[];
  /** 단계 아래 한 줄 — 결론. */
  summary: string;
}

/** 결과를 기다리는 동안 — 백엔드는 ① 부터 돈다. */
export const PROBE_RUNNING: ProbeStep[] = [{ label: PROBE_LIST, state: "run", detail: "" }];

const FAIL_HEAD = "연결 실패 — 모델 목록: ";
const NO_MODEL = "\n대화로 확인할 모델이 없습니다.";
const CHAT_HEAD = "\n대화 확인(";

/** `ok` 는 명령이 성공으로 끝났는가(실패면 오류 문장), `msg` 는 그 문장. */
export function probeView(ok: boolean, msg: string): ProbeView {
  const text = msg.trim();
  if (ok) {
    const listed = /모델 (\d+)개를 조회했습니다/.exec(text);
    if (listed) {
      return { ok, steps: [{ label: PROBE_LIST, state: "ok", detail: `모델 ${listed[1]}개` }], summary: text };
    }
    const chat = /대화로 확인했습니다 \(모델: ([\s\S]+)\)\.?$/.exec(text);
    if (chat) {
      return {
        ok,
        steps: [
          { label: PROBE_LIST, state: "fail", detail: "목록을 받지 못했습니다" },
          { label: PROBE_CHAT, state: "ok", detail: `모델 ${chat[1]}` },
        ],
        summary: text,
      };
    }
    return { ok, steps: [], summary: text };
  }

  if (!text.startsWith(FAIL_HEAD)) return { ok, steps: [], summary: text };
  const rest = text.slice(FAIL_HEAD.length);
  const noModel = rest.indexOf(NO_MODEL);
  if (noModel >= 0) {
    return {
      ok,
      steps: [{ label: PROBE_LIST, state: "fail", detail: rest.slice(0, noModel).trim() }],
      summary: `연결 실패 — ${rest.slice(noModel + 1).trim()}`,
    };
  }
  const chatAt = rest.indexOf(CHAT_HEAD);
  if (chatAt >= 0) {
    const tail = rest.slice(chatAt + CHAT_HEAD.length);
    const m = /^([\s\S]*?)\): ([\s\S]*)$/.exec(tail);
    return {
      ok,
      steps: [
        { label: PROBE_LIST, state: "fail", detail: rest.slice(0, chatAt).trim() },
        {
          label: PROBE_CHAT,
          state: "fail",
          detail: m ? `${m[1]} · ${m[2].trim()}` : tail.trim(),
        },
      ],
      summary: "연결 실패 — 두 단계 모두 실패했습니다",
    };
  }
  return { ok, steps: [{ label: PROBE_LIST, state: "fail", detail: rest.trim() }], summary: "연결 실패" };
}
