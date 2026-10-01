import { create } from "zustand";
import * as api from "../lib/api";
import { TOAST } from "../lib/design";
import { CANCELED } from "../lib/runOnce";
import { ingestTask } from "../lib/wiki/pipeline";
import { routeRun, useAi } from "./aiStore";
import { useStore } from "./useStore";

/**
 * LLM 위키 상태 — 위키 카탈로그와 반영 큐.
 *
 * Vault · 업무(`useStore`)나 AI 연결(`aiStore`)과 수명이 달라 스토어를 나눈다. 반영은 업무를
 * 오가는 동안에도 뒤에서 계속 돌아야 하고, 화면이 위키에 있지 않아도 진행 상황이 사이드바에
 * 보여야 한다.
 *
 * 큐는 **한 번에 한 건**만 돈다. 같은 위키 페이지를 두 반영이 동시에 고치면 뒤의 쓰기가 앞의
 * 것을 지우고(읽은 뒤 바뀐 페이지는 건너뛰므로 내용을 잃지는 않지만), 사내 게이트웨이에
 * 요청을 겹쳐 보내 속도 제한에 걸리기 쉽다.
 *
 * 큐는 파일에 남기지 않는다. 앱을 닫으면 대기 중이던 업무는 사라지지만 잃는 것은 없다 —
 * 반영되지 않은 업무는 위키 화면의 "반영 대기" 에 그대로 뜬다(소스 페이지가 없거나 서명이
 * 다르면 대기다). 진실은 파일에 있고 큐는 그것을 처리하는 순서일 뿐이다.
 */

export type QueueState = "queued" | "running" | "done" | "failed" | "canceled";

export interface QueueItem {
  taskId: string;
  title: string;
  state: QueueState;
  /** 진행 단계 한 줄 — "소스 페이지 쓰는 중" 등. */
  step: string;
  error?: string;
  /** 쓴 페이지 수(성공 시). */
  written?: number;
}

interface WikiState {
  status: api.WikiStatus | null;
  loading: boolean;
  error: string | null;
  queue: QueueItem[];
  running: boolean;

  refresh: () => Promise<void>;
  /** 반영 대기열에 넣는다. 이미 대기 중이거나 도는 중이면 무시한다. */
  enqueue: (taskId: string, title: string) => void;
  /** 반영 안 됨 · 바뀜 상태인 보관 업무를 전부 넣는다. 넣은 수를 돌려준다. */
  enqueuePending: () => number;
  /** 도는 반영을 끊고 대기열을 비운다. */
  cancel: () => void;
  /** 끝난 항목(성공 · 실패 · 취소)을 목록에서 치운다. */
  clearFinished: () => void;
}

/** 지금 도는 반영의 취소 손잡이. 상태가 아니라 손잡이라 스토어 밖에 둔다. */
let controller: AbortController | null = null;

/** 이번 큐를 비우는 동안의 집계 — 끝날 때 토스트 한 번으로 알린다. */
let batch = { done: 0, failed: 0, pages: 0 };

export const useWiki = create<WikiState>((set, get) => {
  const patch = (taskId: string, p: Partial<QueueItem>) =>
    set((s) => ({ queue: s.queue.map((q) => (q.taskId === taskId ? { ...q, ...p } : q)) }));

  const pump = async () => {
    if (get().running) return;
    set({ running: true });
    try {
      for (;;) {
        const next = get().queue.find((q) => q.state === "queued");
        if (!next) break;

        const st = useStore.getState().settings;
        const route = routeRun(useAi.getState(), "wiki.ingest");
        if (!route) {
          // 연결이 사라졌다 — 남은 것을 실패로 표시하고 멈춘다(다음에 다시 넣으면 된다).
          set((s) => ({
            queue: s.queue.map((q) =>
              q.state === "queued"
                ? { ...q, state: "failed", step: "", error: "위키 반영에 쓸 AI 연결이 없습니다" }
                : q,
            ),
          }));
          batch.failed += 1;
          break;
        }

        controller = new AbortController();
        patch(next.taskId, { state: "running", step: "준비 중", error: undefined });
        try {
          const ai = useAi.getState();
          const out = await ingestTask({
            root: st.vault,
            taskId: next.taskId,
            route,
            depth: st.wikiDepth,
            maxPages: st.wikiMaxPages,
            ai: { packs: ai.packs, settings: ai.settings },
            signal: controller.signal,
            onStep: (step) => patch(next.taskId, { step }),
          });
          const n = out.result.written.length;
          patch(next.taskId, { state: "done", step: "", written: n });
          batch.done += 1;
          batch.pages += n;
        } catch (e) {
          const msg = api.errMessage(e);
          if (msg === CANCELED || controller.signal.aborted) {
            patch(next.taskId, { state: "canceled", step: "" });
          } else {
            patch(next.taskId, { state: "failed", step: "", error: msg });
            batch.failed += 1;
          }
        } finally {
          controller = null;
        }
        // 한 건 끝날 때마다 카탈로그를 다시 읽는다 — 다음 반영이 방금 만든 페이지를 보고
        // 링크하고, 화면의 대기 수도 줄어든다.
        await get().refresh();
      }
    } finally {
      set({ running: false });
      const { done, failed, pages } = batch;
      batch = { done: 0, failed: 0, pages: 0 };
      // 반영은 화면에 보이지 않는 곳(Wiki/ 폴더)에서 일어난다 — 끝났다는 사실 자체를 알린다.
      if (done || failed) {
        const toast = useStore.getState().toast;
        if (failed && !done) {
          toast("위키 반영 실패", `${failed}건 · 위키 화면에서 사유를 볼 수 있습니다`, TOAST.danger);
        } else if (failed) {
          toast("위키 반영 일부 실패", `성공 ${done}건(페이지 ${pages}장) · 실패 ${failed}건`, TOAST.warn);
        } else {
          toast("위키에 반영했습니다", `업무 ${done}건 · 페이지 ${pages}장`, TOAST.violet);
        }
      }
    }
  };

  return {
    status: null,
    loading: false,
    error: null,
    queue: [],
    running: false,

    refresh: async () => {
      const { vault, archDays } = useStore.getState().settings;
      if (!vault) return;
      set({ loading: true });
      try {
        set({ status: await api.wikiStatus(vault, archDays), error: null });
      } catch (e) {
        set({ error: api.errMessage(e) });
      } finally {
        set({ loading: false });
      }
    },

    enqueue: (taskId, title) => {
      const busy = get().queue.some(
        (q) => q.taskId === taskId && (q.state === "queued" || q.state === "running"),
      );
      if (busy) return;
      set((s) => ({
        queue: [
          ...s.queue.filter((q) => q.taskId !== taskId),
          { taskId, title, state: "queued", step: "" },
        ],
      }));
      void pump();
    },

    enqueuePending: () => {
      const pending = (get().status?.tasks ?? []).filter((t) => t.state !== "fresh");
      for (const t of pending) get().enqueue(t.taskId, t.title);
      return pending.length;
    },

    cancel: () => {
      set((s) => ({
        queue: s.queue.map((q) => (q.state === "queued" ? { ...q, state: "canceled", step: "" } : q)),
      }));
      controller?.abort();
    },

    clearFinished: () =>
      set((s) => ({ queue: s.queue.filter((q) => q.state === "queued" || q.state === "running") })),
  };
});
