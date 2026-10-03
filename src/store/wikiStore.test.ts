/**
 * 위키 반영 큐의 **순서**를 지킨다.
 *
 * 이 앱의 테스트는 순수 로직만 덮는 것이 관례지만, 여기는 사용자의 Vault 에 쓰는 경로라
 * 예외를 둔다. 지켜야 할 약속은 둘이다 — LLM 호출이 끝나기 전에는 위키에 쓰지 않고
 * (`wiki_apply` 는 마지막에 한 번), 실패하거나 취소하면 아예 쓰지 않는다. 어긋나면 반쯤 쓴
 * 위키가 남는데 화면에서는 티가 나지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../lib/ai";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];
/** 다음 `run_agent` 가 흘려보낼 응답. `null` 이면 실패로 끝낸다. */
let reply: string | null = "";
/** 응답을 보내기 전에 기다릴 것 — 취소 시험용. */
let hold: Promise<void> = Promise.resolve();
/** 반영할 업무의 카테고리. */
let category: string | null = null;

const SOURCE_OK = [
  "<<<PAGE source>>>",
  "# 배포 정리",
  "## 한 일",
  "- 스크립트를 고쳤다",
  "<<<END>>>",
  "```wikiplan",
  '{"summary":"배포 스크립트 정리","tags":["dev"],"pages":[]}',
  "```",
].join("\n");

function task() {
  return {
    id: "task-1",
    title: "배포 정리",
    status: "completed",
    tags: ["dev"],
    category,
    created: "",
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
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((ev: RunEvent) => void) | null = null;
  },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "wiki_init":
        return { dir: "/v/Wiki", seeded: false };
      case "wiki_read_source":
        return {
          task: task(),
          sig: "s",
          sourcePath: "sources/task-1.md",
          sourceStem: "task-1",
          reingest: false,
          files: [{ rel: "index.md", chars: 4, text: "개요", truncated: false, skipped: null }],
          totalChars: 4,
        };
      case "read_text_file":
        return "# 규약";
      case "wiki_status":
        return { dir: "/v/Wiki", exists: true, pages: [], tasks: [], orphans: [], moved: [], logTail: [] };
      case "wiki_search":
        return [];
      case "wiki_apply":
        return { written: [{ path: "sources/task-1.md", stem: "task-1", title: "배포 정리", action: "created" }], skipped: [] };
      case "run_agent": {
        const ch = args.onEvent as { onmessage: (ev: RunEvent) => void };
        const text = reply;
        void hold.then(() => {
          if (text === null) {
            ch.onmessage({ type: "error", message: "HTTP 403 — 권한 없음" });
            ch.onmessage({ type: "end", code: null, status: "failed" });
          } else {
            ch.onmessage({ type: "textDelta", delta: text });
            ch.onmessage({ type: "end", code: null, status: "succeeded" });
          }
        });
        return "run-1";
      }
      default:
        return null;
    }
  },
}));

vi.stubGlobal("window", { setTimeout, clearTimeout });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");
const { useAi } = await import("./aiStore");
const { useWiki } = await import("./wikiStore");

/** 큐가 빌 때까지 기다린다. */
async function drained() {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 0));
    if (!useWiki.getState().running) return;
  }
  throw new Error("큐가 끝나지 않았다");
}

const cmds = () => calls.map((c) => c.cmd);

beforeEach(() => {
  calls.length = 0;
  reply = SOURCE_OK;
  hold = Promise.resolve();
  category = null;
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v", wikiDepth: "light" },
    toasts: [],
  });
  useAi.setState({
    settings: { agents: {}, active: { agentId: "claude", model: "" } },
    detected: {
      claude: {
        id: "claude",
        name: "Claude Code",
        available: true,
        path: "c",
        version: null,
        source: "path",
        models: [],
        modelsSource: "fallback",
        diagnostic: null,
      },
    },
    packs: [],
  });
  useWiki.setState({ queue: [], running: false, status: null });
});

describe("위키 반영 큐", () => {
  it("읽고 → 묻고 → 마지막에 한 번 쓴다", async () => {
    useWiki.getState().enqueue("task-1", "배포 정리");
    await drained();

    const c = cmds();
    expect(c.indexOf("wiki_init")).toBeLessThan(c.indexOf("wiki_read_source"));
    expect(c.indexOf("wiki_read_source")).toBeLessThan(c.indexOf("run_agent"));
    expect(c.indexOf("run_agent")).toBeLessThan(c.indexOf("wiki_apply"));
    expect(c.filter((x) => x === "wiki_apply")).toHaveLength(1);

    const req = calls.find((x) => x.cmd === "wiki_apply")!.args.req as {
      op: string;
      taskId: string;
      pages: { kind: string; title: string; summary: string; tags: string[]; body: string }[];
    };
    expect(req.op).toBe("ingest");
    expect(req.taskId).toBe("task-1");
    expect(req.pages).toHaveLength(1);
    expect(req.pages[0]).toMatchObject({ kind: "source", title: "배포 정리", summary: "배포 스크립트 정리", tags: ["dev"] });
    expect(req.pages[0]!.body).toContain("## 한 일");

    // 위키 호출은 온도를 낮춰 보낸다.
    const run = calls.find((x) => x.cmd === "run_agent")!.args.args as { temperature: number };
    expect(run.temperature).toBe(0.2);

    expect(useWiki.getState().queue[0]).toMatchObject({ state: "done", written: 1 });
    expect(useStore.getState().toasts.at(-1)?.title).toBe("위키에 반영했습니다");
  });

  it("업무 카테고리를 관련 페이지 검색어와 프롬프트에 싣는다", async () => {
    category = "프로젝트/ContextFlow";
    useWiki.getState().enqueue("task-1", "배포 정리");
    await drained();

    expect(calls.find((c) => c.cmd === "wiki_search")!.args.query).toContain("프로젝트 ContextFlow");
    const { prompt } = calls.find((c) => c.cmd === "run_agent")!.args.args as { prompt: string };
    expect(prompt).toContain("- 카테고리: 프로젝트 › ContextFlow");
    expect(prompt).toContain("`카테고리` 는 앱이 업무를 묶는 분류입니다");
  });

  it("미분류 업무는 카테고리 줄도 안내도 싣지 않는다", async () => {
    useWiki.getState().enqueue("task-1", "배포 정리");
    await drained();

    const { prompt } = calls.find((c) => c.cmd === "run_agent")!.args.args as { prompt: string };
    expect(prompt).not.toContain("- 카테고리:");
    expect(prompt).not.toContain("`카테고리` 는 앱이 업무를 묶는 분류입니다");
  });

  it("AI 가 실패하면 위키에 쓰지 않고 사유를 남긴다", async () => {
    reply = null;
    useWiki.getState().enqueue("task-1", "배포 정리");
    await drained();
    expect(cmds()).not.toContain("wiki_apply");
    expect(useWiki.getState().queue[0]).toMatchObject({ state: "failed" });
    expect(useWiki.getState().queue[0]!.error).toContain("403");
  });

  it("형식을 어긴 응답도 쓰지 않는다", async () => {
    reply = "그냥 요약만 했습니다";
    useWiki.getState().enqueue("task-1", "배포 정리");
    await drained();
    expect(cmds()).not.toContain("wiki_apply");
    expect(useWiki.getState().queue[0]!.error).toContain("<<<PAGE source>>>");
  });

  it("취소하면 쓰지 않고 실행을 끊는다", async () => {
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    useWiki.getState().enqueue("task-1", "배포 정리");
    // run_agent 가 불릴 때까지 기다린 뒤 취소한다.
    for (let i = 0; i < 100 && !cmds().includes("run_agent"); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    useWiki.getState().cancel();
    release();
    await drained();
    expect(cmds()).toContain("cancel_run");
    expect(cmds()).not.toContain("wiki_apply");
    expect(useWiki.getState().queue[0]!.state).toBe("canceled");
  });

  it("같은 업무를 두 번 넣어도 한 번만 돈다", async () => {
    useWiki.getState().enqueue("task-1", "배포 정리");
    useWiki.getState().enqueue("task-1", "배포 정리");
    await drained();
    expect(cmds().filter((x) => x === "run_agent")).toHaveLength(1);
  });

  it("반영 연결이 없으면 돌지 않는다", async () => {
    useAi.setState({ settings: { agents: {}, active: { agentId: "", model: "" } } });
    useWiki.getState().enqueue("task-1", "배포 정리");
    await drained();
    expect(cmds()).not.toContain("run_agent");
    expect(useWiki.getState().queue[0]!.error).toContain("연결이 없습니다");
  });
});
