/**
 * 백엔드가 `index.md` 의 frontmatter 를 고친 뒤 **열려 있던 버퍼가 그것을 되돌리지 않는다**.
 *
 * 편집기는 index.md 의 본문만 보여 주고 글자를 칠 때마다 버퍼의 frontmatter 로 파일 전체를
 * 다시 조립한다(`EditorPane`). 버퍼가 낡아 있으면 상태 · 제목 · Run Log 를 고친 직후의 첫
 * 자동 저장이 그 값을 옛 것으로 덮어쓰는데, 화면에서는 아무 일도 없었던 것처럼 보인다.
 * `taskMergeSplit` 과 같은 이유로 커맨드 모킹으로 순서와 내용을 지킨다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitFrontmatter } from "../lib/markdown";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

const calls: Call[] = [];

const A = "/v/Tasks/[2026-09] 결제 점검";
const B = "/v/Tasks/[2026-09] 인프라 정비";
const RENAMED = "/v/Tasks/[2026-09] 결제 재점검";
const NEW = "/v/Tasks/[2026-09] 결제 점검 — 설계";

const head = (status: string, title = "결제 점검") =>
  `---\nid: task-1\ntitle: "${title}"\nstatus: ${status}\n---\n`;
const BODY = "## 개요\n처음 글\n";

function task(folder: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id: `task-${title}`,
    title,
    status: "in-progress",
    tags: [],
    category: null,
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
    ...over,
  };
}

/** 디스크. 경로 → 전문. 백엔드 커맨드가 실제로 고치듯 갈아 끼운다. */
let disk: Record<string, string> = {};
let vault = [task(A, "결제 점검"), task(B, "인프라 정비")];
let snapshot: Record<string, unknown> | null = null;

const idx = (folder: string) => `${folder}/index.md`;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "read_text_file": {
        const text = disk[args.path as string];
        if (text === undefined) throw { kind: "io", message: "읽을 수 없습니다" };
        return text;
      }
      case "write_text_file":
        disk[args.path as string] = args.content as string;
        return undefined;
      case "set_task_status": {
        const f = args.folder as string;
        disk[idx(f)] = disk[idx(f)].replace(/status: .*/, `status: ${args.status}`);
        return task(f, "결제 점검", { status: args.status });
      }
      case "rename_task": {
        disk[idx(RENAMED)] = disk[idx(A)].replace(/title: .*/, `title: "${args.title}"`);
        delete disk[idx(A)];
        return task(RENAMED, args.title as string);
      }
      case "set_task_archived": {
        const f = args.folder as string;
        disk[idx(f)] = disk[idx(f)]
          .replace("archived: true\n", "")
          .replace(/status: .*/, "status: in-progress");
        return task(f, "결제 점검");
      }
      case "split_task":
        disk[idx(A)] += "\n## Run Log\n- 분할\n";
        return { task: task(NEW, "결제 점검 — 설계"), moved: ["설계.md"] };
      case "reorder_tasks": {
        const folders = args.folders as string[];
        folders.forEach((f, i) => {
          if (disk[idx(f)]) disk[idx(f)] = disk[idx(f)].replace("---\n## ", `order: ${i}\n---\n## `);
        });
        return folders.map((f, i) => ({ ...vault.find((t) => t.folder === f)!, order: i }));
      }
      case "load_snapshot":
        return snapshot;
      case "scan_vault":
        return vault;
      case "list_task_files":
        return [{ p: "index.md", name: "index.md", dir: false }];
      case "note_day_entry":
        return { id: 1, day: args.day, folder: args.folder ?? null, title: args.title, body: "", at: args.at };
      case "day_entries":
      case "scan_templates":
        return [];
      default:
        return undefined;
    }
  },
}));

// 타이머는 돌리지 않는다 — 자동 저장을 기다리는 대신 `saveDoc` 을 직접 부르고, 앞선
// 테스트의 900ms 저장이 다음 테스트의 상태 위에서 터지지 않게 한다.
vi.stubGlobal("window", { setTimeout: () => 0, clearTimeout: () => undefined });

const { useStore, DEFAULT_SETTINGS } = await import("./useStore");

/** `A` 를 열고 index.md 를 편집기 탭으로 띄운 상태. `text` 를 주면 고치던 중이다. */
function openA(text?: string) {
  const s = useStore.getState();
  const saved = disk[idx(A)];
  const ui = {
    ...s.ui,
    openTabs: [{ path: "index.md", mode: "text" as const }],
    activeTab: "text|index.md",
    sel: "index.md",
    docs: { "index.md": { text: text ?? saved, saved } },
  };
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, vault: "/v" },
    tasks: vault,
    activeFolder: A,
    ui,
    uiCache: { [A]: ui },
    dayLog: { day: "2026-09-11", entries: [] },
    toasts: [],
    split: null,
  });
}

/** 편집기에서 본문을 고친다 — `EditorPane` 의 `onEdit` 이 조립하는 그대로. */
async function typeBody(body: string) {
  const st = useStore.getState();
  const { fm } = splitFrontmatter(st.ui.docs["index.md"].text);
  st.editDoc("index.md", `---\n${fm}\n---\n${body}`);
  await useStore.getState().saveDoc("index.md");
}

function lastWrite(path: string): string | undefined {
  const hit = calls.filter((c) => c.cmd === "write_text_file" && c.args.path === path).pop();
  return hit?.args.content as string | undefined;
}

beforeEach(() => {
  calls.length = 0;
  snapshot = null;
  vault = [task(A, "결제 점검"), task(B, "인프라 정비")];
  disk = { [idx(A)]: head("in-progress") + BODY, [idx(B)]: head("in-progress", "인프라 정비") + BODY };
});

describe("상태를 바꾼 뒤", () => {
  it("깨끗한 버퍼는 디스크 내용이 되고, 이어서 친 글이 새 상태를 지킨다", async () => {
    openA();
    await useStore.getState().setStatus("on-hold");

    const doc = useStore.getState().ui.docs["index.md"];
    expect(doc.text).toBe(head("on-hold") + BODY);
    expect(doc.saved).toBe(doc.text);

    await typeBody("## 개요\n처음 글\n덧붙인 글\n");
    // 고치기 전에는 여기서 `status: in-progress` 가 다시 쓰였다.
    expect(lastWrite(idx(A))).toBe(head("on-hold") + "## 개요\n처음 글\n덧붙인 글\n");
  });
});

describe("resyncIndexDocs", () => {
  it("고치던 버퍼는 본문을 지키고 frontmatter 만 디스크를 따른다", async () => {
    openA(head("in-progress") + "## 개요\n고치던 글\n");
    disk[idx(A)] = head("on-hold") + BODY;

    await useStore.getState().resyncIndexDocs([A]);

    const doc = useStore.getState().ui.docs["index.md"];
    expect(doc.text).toBe(head("on-hold") + "## 개요\n고치던 글\n");
    expect(doc.saved).toBe(disk[idx(A)]);
    // 캐시도 같은 것을 든다 — 업무를 오갈 때 되살아나는 쪽이 저쪽이다.
    expect(useStore.getState().uiCache[A].docs["index.md"]).toEqual(doc);
  });

  it("다른 업무의 깨끗한 버퍼는 버리고 고치던 버퍼는 다시 얹는다", async () => {
    openA();
    const other = (text: string) => ({
      ...useStore.getState().ui,
      docs: {
        "index.md": { text, saved: head("in-progress", "인프라 정비") + BODY },
        "메모.md": { text: "그대로", saved: "그대로" },
      },
    });
    disk[idx(B)] = head("on-hold", "인프라 정비") + BODY;

    useStore.setState({ uiCache: { [B]: other(head("in-progress", "인프라 정비") + BODY) } });
    await useStore.getState().resyncIndexDocs([B]);
    expect(Object.keys(useStore.getState().uiCache[B].docs)).toEqual(["메모.md"]);
    // 깨끗한 버퍼를 버리는 데 디스크를 읽을 필요는 없다.
    expect(calls.map((c) => c.cmd)).not.toContain("read_text_file");

    useStore.setState({ uiCache: { [B]: other(head("in-progress", "인프라 정비") + "## 개요\n고친 글\n") } });
    await useStore.getState().resyncIndexDocs([B]);
    expect(useStore.getState().uiCache[B].docs["index.md"]).toEqual({
      text: head("on-hold", "인프라 정비") + "## 개요\n고친 글\n",
      saved: disk[idx(B)],
    });
  });

  it("디스크를 못 읽어도 던지지 않고 버퍼를 그대로 둔다", async () => {
    openA(head("in-progress") + "## 개요\n고치던 글\n");
    delete disk[idx(A)];

    await expect(useStore.getState().resyncIndexDocs([A])).resolves.toBeUndefined();
    expect(useStore.getState().ui.docs["index.md"].text).toBe(head("in-progress") + "## 개요\n고치던 글\n");
  });
});

describe("다른 메타데이터 쓰기 뒤에도", () => {
  it("업무명을 바꾸면 새 경로의 버퍼가 새 제목을 든다", async () => {
    openA();
    vault = [task(RENAMED, "결제 재점검"), task(B, "인프라 정비")];

    await useStore.getState().renameTask(A, "결제 재점검");

    const st = useStore.getState();
    expect(st.activeFolder).toBe(RENAMED);
    expect(st.ui.docs["index.md"].text).toBe(head("in-progress", "결제 재점검") + BODY);
  });

  it("재개한 업무의 버퍼가 보관 표시를 되살리지 않는다", async () => {
    disk[idx(A)] = head("completed").replace("status: completed\n", "status: completed\narchived: true\n") + BODY;
    openA();

    await useStore.getState().restoreTask(A);

    expect(useStore.getState().ui.docs["index.md"].text).toBe(head("in-progress") + BODY);
    const writes = calls.filter((c) => c.cmd === "write_text_file");
    expect(writes.map((c) => c.args.content as string).join("")).not.toContain("archived: true");
  });

  it("분할한 원본의 버퍼가 Run Log 이전 내용으로 남지 않는다", async () => {
    openA();
    useStore.setState({
      split: {
        source: A,
        sel: { "설계.md": true },
        title: "결제 점검 — 설계",
        summary: "",
        tags: "",
        category: "",
        busy: false,
        error: "",
      },
    });
    vault = [task(A, "결제 점검"), task(NEW, "결제 점검 — 설계")];
    disk[idx(NEW)] = head("in-progress", "결제 점검 — 설계");

    await useStore.getState().doSplit();

    const left = useStore.getState().uiCache[A].docs["index.md"];
    expect(left.text).toContain("## Run Log");
    expect(left.text).toBe(left.saved);
    // 새 업무로 넘어가며 도는 `saveAll` 이 원본의 index.md 를 옛 글로 덮어쓰지 않는다.
    expect(lastWrite(idx(A))).toBeUndefined();
  });

  it("순서를 바꾼 업무의 버퍼가 order 를 지킨다", async () => {
    openA();

    await useStore.getState().reorderTask(B, 0);

    expect(useStore.getState().ui.docs["index.md"].text).toContain("order: 1");
  });
});

describe("스냅샷에서 되살릴 때", () => {
  it("고치던 index.md 를 지금의 frontmatter 위에 얹는다", async () => {
    disk[idx(A)] = head("on-hold") + BODY;
    snapshot = {
      openTabs: [{ path: "index.md", mode: "text" }],
      activeTab: "text|index.md",
      docs: { "index.md": { text: head("in-progress") + "## 개요\n접어 둔 글\n", saved: head("in-progress") + BODY } },
    };
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, vault: "/v" },
      tasks: vault,
      activeFolder: "",
      uiCache: {},
      dayLog: { day: "2026-09-11", entries: [] },
    });

    await useStore.getState().selectTask(A);

    expect(useStore.getState().ui.docs["index.md"]).toEqual({
      text: head("on-hold") + "## 개요\n접어 둔 글\n",
      saved: head("on-hold") + BODY,
    });
  });
});
