import { create } from "zustand";
import * as api from "../lib/api";
import { mergeIntoIndex } from "../lib/assist/brief";
import { ISSUE_INDEX_HEADING, insertEntry, issueFiles, pickIssueFiles, type IssueFile } from "../lib/assist/issue";
import { joinPath } from "../lib/format";
import { overviewOf } from "../lib/iwms/material";
import { useStore } from "./useStore";

/** 넣은 자리로 한 번 스크롤하라는 요청 — 편집기가 그 탭을 그릴 때 받아 쓰고 지운다. */
export interface Reveal {
  folder: string;
  path: string;
  /** 원문(frontmatter 포함) 기준 줄 번호, 0부터. */
  line: number;
}

/**
 * 업무 AI 도우미(위키 가이드 · 간략 입력 정리 · 이슈 추가) 팝업의 열림 상태.
 *
 * 업무 상태(`useStore`)와 수명이 달라 스토어를 나눈다(`iwmsStore` 와 같은 까닭). 생성 중인 글 · 질문 · 답은
 * 팝업 컴포넌트의 상태다 — 닫으면 버린다(읽고 닫기가 곧 버리기다). 팝업은 연 업무의 폴더를 들고 있다가,
 * 쓰기 직전에 지금 열린 업무와 같은지 다시 본다(`applyToTaskFile`).
 */
interface AssistState {
  guide: { folder: string } | null;
  brief: { folder: string } | null;
  issue: { folder: string } | null;
  /** 파일에 쓰는 중. Esc 로 닫지 않는다(실패 사유를 적을 자리가 사라진다). */
  busy: boolean;
  /**
   * 업무 스냅샷(`useStore` 의 `ui`)에 섞이지 않게 여기 둔다 — 한 번 쓰고 버리는 요청이라 업무를 오가며
   * 되살아나면 안 된다.
   */
  reveal: Reveal | null;
  openGuide: (folder: string) => void;
  openBrief: (folder: string) => void;
  openIssue: (folder: string) => void;
  /** 열린 도우미 팝업이 있는가. */
  isOpen: () => boolean;
  close: () => void;
  setBusy: (busy: boolean) => void;
  setReveal: (reveal: Reveal | null) => void;
}

const CLOSED = { guide: null, brief: null, issue: null, busy: false };

export const useAssist = create<AssistState>((set, get) => ({
  ...CLOSED,
  reveal: null,
  // 이 앱은 모달을 겹치지 않는다 — 하나를 열면 다른 것은 닫는다.
  openGuide: (folder) => {
    if (folder) set({ ...CLOSED, guide: { folder } });
  },
  openBrief: (folder) => {
    if (folder) set({ ...CLOSED, brief: { folder } });
  },
  openIssue: (folder) => {
    if (folder) set({ ...CLOSED, issue: { folder } });
  },
  isOpen: () => {
    const s = get();
    return !!(s.guide || s.brief || s.issue);
  },
  close: () => set(CLOSED),
  setBusy: (busy) => set({ busy }),
  setReveal: (reveal) => set({ reveal }),
}));

/**
 * 업무 폴더의 파일 하나를 고쳐 쓴다 — **사람이 편집기에서 친 것과 같은 길**로.
 *
 * 파일을 탭으로 열어 버퍼를 올리고(`defaultOpen` → `openFile`), 그 버퍼에 `transform` 을 얹고(`editDoc`),
 * 바로 내려쓴다(`saveDoc`). 새 커맨드 없이 저장 줄 · 메타데이터 쓰기 게이트 · index.md 의 frontmatter 규칙을
 * 그대로 탄다. 고치던 글이 있으면 그 위에 얹으므로 지워지지 않는다. 결과는 열린 탭으로 바로 보인다.
 *
 * 실패는 던진다. 저장 실패는 `saveDoc` 이 이미 토스트로 알리므로 문구만 돌려준다.
 */
export async function applyToTaskFile(
  folder: string,
  rel: string,
  transform: (text: string) => string,
  opts: { create?: boolean } = {},
): Promise<void> {
  const s = useStore.getState();
  if (s.activeFolder !== folder) throw new Error("그 사이 다른 업무로 옮겨 갔습니다 — 쓰지 않았습니다");
  if (opts.create) {
    try {
      await api.createTaskFile(folder, rel);
    } catch (e) {
      if (api.errKind(e) !== "already_exists") throw e;
    }
    await s.refreshFiles();
  }
  // 이미 열린 탭이면 그 모드(편집기 · 뷰어) 그대로 — 사람이 고르던 화면을 바꾸지 않는다.
  const tab = useStore.getState().ui.openTabs.find((t) => t.path === rel);
  if (tab) await s.openFile(rel, tab.mode);
  else await s.defaultOpen(rel, false);
  const doc = useStore.getState().ui.docs[rel];
  if (!doc || useStore.getState().activeFolder !== folder) throw new Error(`${rel} 을 열지 못했습니다`);
  const next = transform(doc.text);
  if (next !== doc.text) useStore.getState().editDoc(rel, next);
  await useStore.getState().saveDoc(rel);
  const after = useStore.getState().ui.docs[rel];
  if (after && after.text !== after.saved) throw new Error(`${rel} 에 저장하지 못했습니다`);
}

/** 업무 파일의 글 — 지금 업무의 열린 버퍼(미저장 포함)가 있으면 그것을, 없으면 디스크를 읽는다. */
export async function readTaskText(folder: string, rel: string): Promise<string> {
  const s = useStore.getState();
  const buf = s.activeFolder === folder ? s.ui.docs[rel]?.text : undefined;
  return buf ?? (await api.readTextFile(joinPath(folder, rel)));
}

/**
 * 이슈 추가가 프롬프트에 싣는 업무 폴더의 글 파일 개요(`pickIssueFiles` → 제목 목록 · 앞부분). 지금 열린 업무의
 * 파일 목록을 쓴다. 읽지 못한 파일은 뺀다 — 후보가 하나 줄 뿐 정리는 된다.
 */
export async function taskIssueFiles(folder: string): Promise<IssueFile[]> {
  const s = useStore.getState();
  if (s.activeFolder !== folder) return [];
  const docs: { path: string; text: string }[] = [];
  for (const f of pickIssueFiles(s.files)) {
    try {
      docs.push({ path: f.p, text: await readTaskText(folder, f.p) });
    } catch {
      // 지워졌거나 읽을 수 없는 파일 — 건너뛴다.
    }
  }
  return issueFiles(docs);
}

/** 이슈를 쓸 곳과 쓸 글 — 팝업이 사람이 고른 대로 만든다. */
export type IssuePlan =
  | {
      mode: "new";
      /** `이슈/2026-10-05 제목.md`. */
      rel: string;
      /** 새 파일 본문(`renderIssueFile`). */
      body: string;
      /** 그 사이 같은 이름의 파일이 생겼으면 덮지 않고 이 한 건을 덧붙인다(`renderIssueEntry`). */
      entry: string;
      /** index.md 의 `## 이슈` 에 남길 줄. `null` 이면 남기지 않는다. */
      indexLine: string | null;
    }
  | {
      mode: "existing";
      rel: string;
      /** 넣을 섹션의 제목 줄. `null` 이면 파일 끝. */
      heading: string | null;
      entry: string;
      indexLine: string | null;
    };

export interface IssueApplied {
  rel: string;
  /** 고른 섹션을 찾아 넣었다. `false` 면 그 사이 제목이 바뀌어 파일 끝에 넣었다. */
  placed: boolean;
  /** 이슈는 썼지만 index.md 에 줄을 남기지 못했다. */
  indexError: string | null;
}

/**
 * 이슈를 쓴다 — 대상 파일에 먼저(`applyToTaskFile`, 편집기와 같은 길), 그다음 index.md 의 `## 이슈` 에 한 줄
 * (`mergeIntoIndex` — 같은 줄은 다시 넣지 않는다). 끝나면 대상 파일 탭으로 돌아가 넣은 자리를 보인다.
 *
 * 대상 파일 쓰기가 실패하면 던진다(아무것도 남지 않는다). index.md 쓰기 실패는 던지지 않고 `indexError` 로 돌려준다 —
 * 이슈는 이미 쓰였으므로 실패로 보이면 다시 눌러 같은 이슈를 또 쓰게 된다.
 */
export async function applyIssue(folder: string, plan: IssuePlan): Promise<IssueApplied> {
  let line = 0;
  let placed = true;
  await applyToTaskFile(
    folder,
    plan.rel,
    (old) => {
      if (plan.mode === "new" && !old.trim()) {
        line = 0;
        return plan.body;
      }
      const r = insertEntry(old, plan.mode === "existing" ? plan.heading : null, plan.entry);
      line = r.line;
      placed = plan.mode === "new" || !plan.heading || r.placed;
      return r.text;
    },
    { create: plan.mode === "new" },
  );

  let indexError: string | null = null;
  if (plan.indexLine && plan.rel !== "index.md") {
    const indexLine = plan.indexLine;
    try {
      await applyToTaskFile(folder, "index.md", (old) =>
        mergeIntoIndex(old, [{ heading: ISSUE_INDEX_HEADING, lines: [indexLine] }]),
      );
    } catch (e) {
      indexError = api.errMessage(e);
    }
    // 대상 파일 탭으로 돌아간다 — 그 탭의 모드 그대로.
    const s = useStore.getState();
    const tab = s.ui.openTabs.find((t) => t.path === plan.rel);
    if (s.activeFolder === folder && tab) await s.openFile(plan.rel, tab.mode);
  }
  useAssist.getState().setReveal({ folder, path: plan.rel, line });
  return { rel: plan.rel, placed, indexError };
}

/**
 * 업무의 개요 — 열린 편집기 버퍼(미저장 포함)가 있으면 그것을, 없으면 디스크의 `index.md` 를 읽는다. 골격
 * 머리말 · Run Log 는 뺀다(`overviewOf`). 사람이 방금 친 글이 가장 새 사실이다.
 */
export async function taskOverview(task: api.TaskMeta, cap: number): Promise<string> {
  const s = useStore.getState();
  const buf = s.activeFolder === task.folder ? s.ui.docs["index.md"]?.text : undefined;
  const text = buf ?? (await api.readTextFile(task.indexPath));
  return overviewOf(text, cap);
}
