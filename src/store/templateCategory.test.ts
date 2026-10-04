/**
 * 템플릿 기본 카테고리의 프런트 — 새 업무 대화상자의 템플릿 고르기가 카테고리 칸을 채우고
 * (`setNtTemplate`), 그 값이 업무 생성으로 가며, 템플릿 등록 · 기본값 바꾸기가 백엔드에 넘기는 값.
 * 칸이 조용히 덮이거나 남는 것은 화면에서 눈치채기 어려워 커맨드 모킹으로 지킨다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateMeta } from "../lib/api";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

const A = "/v/Tasks/[2026-09] 결제 점검";
const NEW = "/v/Tasks/[2026-09] 9월 보고";

function task(folder: string, title: string, category: string | null) {
  return {
    id: `task-${title}`,
    title,
    status: "in-progress",
    tags: [],
    category,
    created: "2026-09-11 09:00",
    updated: "2026-09-11 09:00",
    parentTask: null,
    templateRef: null,
    completedAt: null,
    archived: null,
    archivedAt: null,
    runs: 1,
    order: null,
    folder,
    relFolder: `${folder.replace("/v/", "")}/`,
    indexPath: `${folder}/index.md`,
    tagline: "",
  };
}

function tpl(id: string, category: string | null): TemplateMeta {
  return {
    id,
    name: id,
    desc: "",
    kind: "note",
    path: `/v/Templates/${id}.md`,
    relPath: `Templates/${id}.md`,
    uses: 0,
    last: "",
    saved: 0,
    runs: [],
    category,
  };
}

let vault = [task(A, "결제 점검", "운영")];
let templates: TemplateMeta[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "create_task": {
        const created = task(NEW, args.title as string, args.category as string | null);
        vault = [...vault, created];
        return created;
      }
      case "scan_vault":
        return vault;
      case "scan_templates":
        return templates;
      case "list_task_files":
        return [];
      case "read_text_file":
        return "";
      case "note_day_entry":
        return { id: 1, day: args.day, folder: args.folder ?? null, title: args.title, body: "", at: args.at };
      case "create_template":
      case "create_template_from_folder":
        return `/v/Templates/${args.name}`;
      case "set_template_category": {
        templates = templates.map((t) => (t.id === args.id ? { ...t, category: args.category as string | null } : t));
        return undefined;
      }
      default:
        return undefined;
    }
  },
}));

vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => undefined });

const { useStore, DEFAULT_SETTINGS, emptyNewTask } = await import("./useStore");

const st = () => useStore.getState();

function argsOf(cmd: string, nth = 0): Record<string, unknown> {
  const hit = calls.filter((c) => c.cmd === cmd)[nth];
  if (!hit) throw new Error(`${cmd} 를 ${nth + 1}번 부르지 않았다`);
  return hit.args;
}

/** 새 업무 대화상자를 연 상태. `category` 는 여는 곳(카테고리 묶음 머리)이 채운 값이다. */
function openNew(category = "") {
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v" },
    tasks: vault,
    templates,
    activeFolder: "",
    uiCache: {},
    toasts: [],
    newOpen: true,
    ntBusy: false,
    nt: { ...emptyNewTask(category), title: "9월 보고" },
  });
}

beforeEach(() => {
  calls.length = 0;
  vault = [task(A, "결제 점검", "운영")];
  templates = [tpl("주간 보고", "운영/보고"), tpl("회고", null), tpl("대문자", "Proj/Sub")];
});

describe("setNtTemplate — 템플릿 기본 카테고리를 칸에 채운다", () => {
  it("고른 템플릿의 기본값이 칸에 들어가고 업무 생성으로 간다", async () => {
    openNew();
    st().setNtTemplate("주간 보고");
    expect(st().nt).toMatchObject({ template: "주간 보고", category: "운영/보고" });

    await st().createTask();

    expect(argsOf("create_task")).toMatchObject({ template: "주간 보고", category: "운영/보고" });
    expect(st().tasks.find((t) => t.folder === NEW)?.category).toBe("운영/보고");
  });

  it("템플릿을 바꿔 보는 동안 앞 기본값은 갈아 끼우고, 손으로 고친 값은 남긴다", async () => {
    openNew();
    st().setNtTemplate("주간 보고");
    st().setNtTemplate("회고");
    expect(st().nt.category).toBe("");
    st().setNtTemplate("주간 보고");
    expect(st().nt.category).toBe("운영/보고");

    st().set({ nt: { ...st().nt, category: "개인" } });
    st().setNtTemplate("회고");
    st().setNtTemplate("(없음)");
    expect(st().nt).toMatchObject({ template: "(없음)", category: "개인" });

    await st().createTask();
    expect(argsOf("create_task")).toMatchObject({ template: null, category: "개인" });
  });

  it("앞 기본값과 키가 같으면 철자를 고쳐 둔 것도 그대로 본다", () => {
    openNew();
    st().setNtTemplate("대문자");
    st().set({ nt: { ...st().nt, category: "proj › sub" } });
    st().setNtTemplate("주간 보고");
    expect(st().nt.category).toBe("운영/보고");
  });

  it("카테고리 묶음 머리에서 연 창은 그 카테고리를 지킨다", async () => {
    openNew("프로젝트");
    st().setNtTemplate("주간 보고");
    expect(st().nt.category).toBe("프로젝트");

    await st().createTask();
    expect(argsOf("create_task").category).toBe("프로젝트");
  });
});

describe("템플릿 등록 · 기본값 바꾸기", () => {
  function draft(over: Record<string, unknown>) {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, vault: "/v" },
      tasks: vault,
      toasts: [],
      tplNew: { name: "주간 보고 2", desc: "", sections: "배경", fromTask: false, mode: "sections", src: "", category: "", ...over },
    });
  }

  it("섹션 템플릿은 기본 카테고리를 정규화해 싣는다 — 이미 있는 상위는 아는 철자로", async () => {
    vault = [task(A, "결제 점검", "Ops")];
    draft({ category: " ops › 보고 " });

    await st().createTemplate();

    expect(argsOf("create_template")).toEqual({
      root: "/v",
      name: "주간 보고 2",
      desc: "",
      sections: "배경",
      category: "Ops/보고",
    });
    expect(st().tplNew).toBeNull();
  });

  it("폴더 템플릿은 늘 값을 보낸다 — 빈 칸이면 null(업무 폴더에서 따라온 category: 를 지운다)", async () => {
    draft({ mode: "folder", src: A, category: "" });
    await st().createTemplate();
    expect(argsOf("create_template_from_folder")).toEqual({
      root: "/v",
      name: "주간 보고 2",
      desc: "",
      source: A,
      category: null,
    });

    draft({ mode: "folder", src: A, category: "운영" });
    await st().createTemplate();
    expect(argsOf("create_template_from_folder", 1).category).toBe("운영");
  });

  it("잘못된 기본 카테고리면 아무것도 부르지 않고 대화상자를 남긴다", async () => {
    draft({ category: "a/b/c/d" });
    await st().createTemplate();
    expect(calls).toEqual([]);
    expect(st().tplNew).not.toBeNull();
    expect(st().toasts.map((t) => t.title)).toEqual(["등록하지 못했습니다"]);
  });

  it("기본값 바꾸기는 정규화해 보내고 목록을 다시 읽는다 — null 은 해제", async () => {
    draft({});
    await st().setTemplateCategory("주간 보고", " 운영 › 회의 ");
    expect(argsOf("set_template_category")).toEqual({ root: "/v", id: "주간 보고", category: "운영/회의" });
    expect(calls.map((c) => c.cmd)).toEqual(["set_template_category", "scan_templates"]);
    expect(st().templates.find((t) => t.id === "주간 보고")?.category).toBe("운영/회의");

    await st().setTemplateCategory("주간 보고", null);
    expect(argsOf("set_template_category", 1).category).toBeNull();
    expect(st().toasts).toEqual([]);
  });
});
