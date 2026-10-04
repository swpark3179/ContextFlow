import { create } from "zustand";
import * as api from "../lib/api";
import { overviewOf } from "../lib/iwms/material";
import { useStore } from "./useStore";

/**
 * 업무 AI 도우미(위키 가이드 · 간략 입력 정리) 팝업의 열림 상태.
 *
 * 업무 상태(`useStore`)와 수명이 달라 스토어를 나눈다(`iwmsStore` 와 같은 까닭). 생성 중인 글 · 질문 · 답은
 * 팝업 컴포넌트의 상태다 — 닫으면 버린다(읽고 닫기가 곧 버리기다). 팝업은 연 업무의 폴더를 들고 있다가,
 * 쓰기 직전에 지금 열린 업무와 같은지 다시 본다(`applyToTaskFile`).
 */
interface AssistState {
  guide: { folder: string } | null;
  brief: { folder: string } | null;
  /** 파일에 쓰는 중. Esc 로 닫지 않는다(실패 사유를 적을 자리가 사라진다). */
  busy: boolean;
  openGuide: (folder: string) => void;
  openBrief: (folder: string) => void;
  close: () => void;
  setBusy: (busy: boolean) => void;
}

export const useAssist = create<AssistState>((set) => ({
  guide: null,
  brief: null,
  busy: false,
  // 이 앱은 모달을 겹치지 않는다 — 하나를 열면 다른 하나는 닫는다.
  openGuide: (folder) => {
    if (folder) set({ guide: { folder }, brief: null, busy: false });
  },
  openBrief: (folder) => {
    if (folder) set({ brief: { folder }, guide: null, busy: false });
  },
  close: () => set({ guide: null, brief: null, busy: false }),
  setBusy: (busy) => set({ busy }),
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
