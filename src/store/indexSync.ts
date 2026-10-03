import * as api from "../lib/api";
import { TOAST } from "../lib/design";
import { isArchived, useStore } from "./useStore";
import { useWiki } from "./wikiStore";

/**
 * Obsidian 쪽 색인 노트 — 보관함 MOC(`_index/Archive.md`)와 카테고리 허브(`_index/카테고리*`) — 의
 * 자동 갱신.
 *
 * 예전에는 업무를 바꾸는 액션마다 `syncMoc()` 을 불렀다. 부르는 자리가 여섯 곳에 흩어져 있었고,
 * 새 업무 · 분할 · 기록 후 삭제 · 카테고리 변경은 빠져 있었다. 허브까지 그렇게 부르면 빠지는 자리만
 * 늘어난다. 그래서 호출 지점 대신 **서명을 구독한다** — 노트에 실리는 값만 모아 서명을 만들고, 그것이
 * 바뀌었을 때만 쓴다. 새로 생기는 액션도 업무 목록을 바꾸기만 하면 저절로 들어온다.
 *
 * - 리스너는 몇 값만 `Object.is` 로 견주고 타이머를 다시 건다. `useStore` 는 `set` 마다(끌기 · 타자)
 *   리스너를 부르고 `tasks` · `settings` 는 다시 읽거나 패치할 때마다 새 객체라, 서명(JSON)은 리스너가
 *   아니라 타이머가 터질 때 만든다.
 * - MOC 는 위키 반영을 기다리지 않는다. [완료] 는 곧바로 반영 큐를 돌리므로, 기다리면 방금 보관한
 *   업무가 LLM 큐가 끝날 때까지 MOC 에 없다. 허브만 반영이 도는 동안 미루고 끝나면 쓴다 — 반영은
 *   업무마다 위키 페이지를 고치므로, 미루지 않으면 그때마다 허브를 다시 쓴다.
 * - 한 번에 한 쓰기만 돈다. 그 사이에 바뀌면 끝난 뒤 문턱과 서명을 다시 보고 한 번 더 쓴다.
 * - 마지막 서명은 성공한 뒤에만 바꾼다. 실패하면 혼자 다시 시도하지 않고 다음 변화 때 다시 쓴다.
 *   오류는 삼킨다 — 편의 색인이다.
 */

/** 마지막 변화 뒤 이만큼 조용하면 쓴다 — 연달아 오는 변화(목록 다시 읽기 · 설정 칩)를 한 번에 모은다. */
const DELAY = 800;

type St = ReturnType<typeof useStore.getState>;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 보관함 MOC 에 실리는 값 — 보관된 업무만이라 진행 중 업무를 고쳐도 바뀌지 않는다(MOC 쓰기는 Vault
 * 전체를 훑는다). 폴더로 정렬한다: `scan` 순서는 `updated` 를 타서, 그대로 두면 순서만 바뀌어도
 * 서명이 바뀐다.
 */
function mocSig(st: St): string {
  const { vault, archDays, archMoc } = st.settings;
  const rows = st.tasks
    .filter((t) => isArchived(t, archDays))
    .sort((a, b) => cmp(a.folder, b.folder))
    .map((t) => [t.relFolder, t.title, t.completedAt, t.category, t.runs, t.tags]);
  return JSON.stringify([vault, archDays, archMoc, rows]);
}

/** 허브에 실리는 값 — 업무 전체와 위키 페이지. `updated` · `order` · `tagline` 은 넣지 않는다. */
function hubSig(st: St, pages: api.WikiPageMeta[]): string {
  const { vault, archDays, catHubs } = st.settings;
  const tasks = [...st.tasks]
    .sort((a, b) => cmp(a.folder, b.folder))
    .map((t) => [
      t.folder,
      t.relFolder,
      t.id,
      t.title,
      t.status,
      isArchived(t, archDays),
      t.completedAt,
      t.category,
      t.created,
    ]);
  const wiki = [...pages]
    .sort((a, b) => cmp(a.path, b.path))
    .map((p) => [p.path, p.kind, p.title, p.summary, p.sources, p.taskId]);
  return JSON.stringify([vault, archDays, catHubs, tasks, wiki]);
}

/** 쓸 수 있는 상태 — boot 가 끝났고 Vault 가 열렸다. 아니면 `null`. */
function gate(): St | null {
  const st = useStore.getState();
  return st.ready && !st.bootError && st.settings.vault ? st : null;
}

/**
 * 구독을 시작하고 정지 함수를 돌려준다. `App` 의 effect 가 부르고 정리 함수로 끈다 — StrictMode 의
 * 두 번 도는 effect 에서도 구독이 하나만 남는다. 상태는 모두 이 클로저 안에 있다.
 *
 * 곧바로 구독하고 boot 전에는 문턱에서 쉰다. `ready` 의 변화가 첫 쓰기를 깨우고, 이미 준비된 뒤에
 * 열렸어도 시작할 때 한 번 타이머를 걸어 두므로 첫 쓰기를 놓치지 않는다.
 */
export function startIndexSync(): () => void {
  let timer: number | undefined;
  /** 마지막으로 쓰기에 **성공한** 서명. 끈 쪽은 비워 두어 다시 켜면 곧 쓴다. */
  let lastMoc = "";
  let lastHub = "";
  let inflight = false;
  /** 쓰는 사이에 타이머가 터졌다 — 끝난 뒤 한 번 더 본다. */
  let dirty = false;
  /** 위키 반영이 도는 동안 미뤄 둔 허브 쓰기가 있다. */
  let held = false;
  /** 마지막으로 알린 충돌(Vault + 정렬한 경로). 같은 충돌을 갱신마다 다시 알리지 않는다. */
  let conflictKey = "";
  let stopped = false;

  const notifyConflicts = (vault: string, conflicts: string[]) => {
    // 비면 잊는다 — 고쳤다가 나중에 다시 생긴 충돌은 또 알린다.
    if (!conflicts.length) {
      conflictKey = "";
      return;
    }
    const sorted = [...conflicts].sort(cmp);
    const key = JSON.stringify([vault, sorted]);
    if (key === conflictKey) return;
    conflictKey = key;
    const { toast } = useStore.getState();
    // 충돌은 표식 없는 사용자 노트만이 아니다 — 앱의 허브라도 읽지 못하면 덮어쓰지 않고 여기로 온다
    // (hub.rs `HubReport::conflicts`). 그래서 "만들지 않았다" 대신 "쓰지 못했다" 고 두 경우를 함께 말한다.
    toast(
      `카테고리 허브 ${sorted.length}개를 쓰지 못했습니다`,
      `같은 이름의 노트가 있거나 읽을 수 없습니다 · ${sorted[0]}`,
      TOAST.warn,
    );
  };

  /** 문턱을 보고 서명이 바뀐 쪽만 쓴다. 쓰는 사이에 상태가 바뀔 수 있어 허브 앞에서 다시 읽는다. */
  const writeOnce = async () => {
    let st = gate();
    if (!st) return;
    if (!st.settings.archMoc) {
      // 꺼 둔 동안의 변화는 따라가지 않는다 — 다시 켜면 목록이 그대로여도 곧 쓴다.
      lastMoc = "";
    } else {
      const sig = mocSig(st);
      if (sig !== lastMoc) {
        try {
          await api.writeArchiveMoc(st.settings.vault, st.settings.archDays);
          lastMoc = sig;
        } catch (e) {
          console.warn("[contextflow] 보관함 MOC 를 갱신하지 못했습니다:", e);
        }
      }
    }

    st = gate();
    if (stopped || !st) return;
    if (!st.settings.catHubs) {
      lastHub = "";
      held = false;
      return;
    }
    const wiki = useWiki.getState();
    if (wiki.running) {
      held = true;
      return;
    }
    held = false;
    const sig = hubSig(st, wiki.status?.pages ?? []);
    if (sig === lastHub) return;
    const { vault, archDays } = st.settings;
    try {
      const report = await api.writeCategoryHubs(vault, archDays);
      lastHub = sig;
      if (!stopped) notifyConflicts(vault, report.conflicts);
    } catch (e) {
      console.warn("[contextflow] 카테고리 허브를 갱신하지 못했습니다:", e);
    }
  };

  const run = async () => {
    if (stopped) return;
    if (inflight) {
      dirty = true;
      return;
    }
    inflight = true;
    try {
      do {
        dirty = false;
        await writeOnce();
      } while (dirty && !stopped);
    } finally {
      inflight = false;
    }
  };

  const arm = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(), DELAY);
  };

  const offStore = useStore.subscribe((s, p) => {
    if (
      !Object.is(s.tasks, p.tasks) ||
      !Object.is(s.ready, p.ready) ||
      !Object.is(s.bootError, p.bootError) ||
      !Object.is(s.settings.vault, p.settings.vault) ||
      !Object.is(s.settings.archDays, p.settings.archDays) ||
      !Object.is(s.settings.archMoc, p.settings.archMoc) ||
      !Object.is(s.settings.catHubs, p.settings.catHubs)
    ) {
      arm();
    }
  });
  const offWiki = useWiki.subscribe((s, p) => {
    if (p.running && !s.running && held) {
      // 미뤄 둔 허브를 곧 쓴다. 반영 큐는 업무마다 `refresh()` 를 기다린 뒤 running 을 내리므로
      // 위키 페이지는 이미 최신이다.
      window.clearTimeout(timer);
      void run();
    } else if (!Object.is(s.status, p.status)) {
      arm();
    }
  });
  arm();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    offStore();
    offWiki();
  };
}
