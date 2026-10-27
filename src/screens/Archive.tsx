import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, EASE_OUT, Input, Select, Spinner, reducedMotion } from "../lib/ui";
import { GREEN, TEXT } from "../lib/design";
import { daysSince } from "../lib/format";
import * as api from "../lib/api";
import type { TaskMeta } from "../lib/api";
import { isArchived, openCategoryHub, reportObsidianOpen, useStore } from "../store/useStore";
import { useVirtual } from "../lib/virtual";
import Workspace from "./Workspace";
import { CategoryChip } from "../components/CategoryPicker";
import { isWithin, keyOf, knownCategories, label as categoryLabel } from "../lib/category";
import { archiveDataview, groupArchived } from "../lib/archiveGroups";

/** 목록 ↔ 상세 전환의 길이(m-screen 근처). 카드가 상세 자리까지 펼쳐지고 되접힌다. */
const TRAVEL_MS = 300;
/** 펼친 카드가 걷히며 상세가 드러나는 시간. */
const REVEAL_MS = 160;

/** 검색 범위 — 미끄러지는 표시의 자리를 셈하려고 폭을 고정한다. */
const SCOPES: ["title" | "full", string, number][] = [
  ["title", "제목 · 태그", 78],
  ["full", "본문 전문", 70],
];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 카드 ↔ 상세 전환 중의 잔상. `stage` 0 → 1 이 이동, 열 때만 2 가 걷히기다. */
interface Travel {
  kind: "open" | "close";
  folder: string;
  title: string;
  card: Rect;
  full: Rect;
  stage: 0 | 1 | 2;
}

/**
 * 값이 바뀐 횟수. 처음 그릴 때는 0 이라 움직이지 않는다 — 그 수를 `key` 로 써서 한 번 재생하는
 * 모션 클래스를 다시 돌린다.
 */
function useChanges(value: unknown): number {
  const r = useRef({ v: value, n: 0 });
  if (!Object.is(r.current.v, value)) r.current = { v: value, n: r.current.n + 1 };
  return r.current.n;
}

/** 바뀐 숫자만 아래에서 굴러 올라온다. */
function Roll({ value }: { value: number }) {
  const n = useChanges(value);
  return (
    <span key={n} className={n ? "cf-enter" : undefined} style={{ display: "inline-block" }}>
      {value}
    </span>
  );
}

/** 작업공간을 여는 동안의 자리 — AI 가 채우는 칸이 아니라 회색(보라 빛 없이)이다. */
function Skel({ width, height = 11 }: { width: number | string; height?: number }) {
  return (
    <span
      aria-hidden
      className="cf-skel"
      style={{
        display: "block",
        width,
        height,
        borderRadius: 3,
        backgroundImage: "linear-gradient(90deg, #efebe4 0%, #efebe4 35%, #f8f6f1 50%, #efebe4 65%, #efebe4 100%)",
        backgroundSize: "200% 100%",
      }}
    />
  );
}

/**
 * 상세를 연 업무의 작업공간을 아직 읽는 중. 이미 아는 것(제목 · 태그 · 카테고리 · 폴더)은 그대로
 * 그리고, 탭 · 탐색기 자리만 비워 둔다 — 그 사이 앞 업무의 작업공간이나 빈 화면이 비치지 않게.
 * 머리 줄은 `Workspace` 의 머리와 같은 치수다.
 */
function DetailSkeleton({ task }: { task: TaskMeta }) {
  return (
    <div aria-busy style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 auto",
          borderBottom: "1px solid #e6e2da",
          padding: "8px 12px 7px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "#fdfcfa",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 15.5,
                fontWeight: 600,
                letterSpacing: "-.2px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {task.title}
            </span>
            {task.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11.5,
                  color: "#6a665e",
                  background: "#f0ede7",
                  border: "1px solid #e4e0d8",
                  borderRadius: 3,
                  padding: "1px 5px",
                }}
              >
                #{tag}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 3, minWidth: 0 }}>
            <CategoryChip category={task.category} caret={false} />
            <span
              style={{
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11,
                color: "#6a665e",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {task.relFolder}
            </span>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span role="status" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: TEXT.sub }}>
          <Spinner />
          작업공간을 여는 중
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ flex: "0 0 32px", borderBottom: "1px solid #e6e2da", background: "#f7f5f1" }} />
          <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 11 }}>
            <Skel width="40%" />
            <Skel width="76%" />
            <Skel width="62%" />
            <Skel width="70%" />
          </div>
        </div>
        <div
          style={{
            flex: "0 0 240px",
            borderLeft: "1px solid #e6e2da",
            background: "#faf9f6",
            padding: "9px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 11,
          }}
        >
          <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".4px", color: TEXT.sub }}>탐색기</span>
          <Skel width="70%" />
          <Skel width="55%" />
          <Skel width="62%" />
        </div>
      </div>
    </div>
  );
}

/**
 * 보관함 안에서 연 업무의 작업공간.
 *
 * 워크스페이스 화면으로 넘기지 않는 이유는 그쪽 업무 리스트에 보관된 업무가 없기
 * 때문이다 — 넘어가면 아무것도 고르지 않은 것처럼 보이고, 돌아와도 이미 활성 업무라
 * 같은 항목을 다시 열 수 없었다. 화면(모드)은 보관함에 두고, 목록으로 돌아가는 길을
 * 이 바가 제공한다.
 */
function ArchiveDetail({
  task,
  resuming,
  onResume,
  onBack,
}: {
  task: TaskMeta;
  /** 재개 중인 업무 — 이 업무면 단추가 돌고, 다른 업무여도 누르지 못한다. */
  resuming: string | null;
  onResume: () => void;
  onBack: () => void;
}) {
  const s = useStore();
  // 작업공간은 `selectTask` 가 이 업무로 바꿔 놓은 뒤에야 맞는 내용을 그린다. 그 전에는 앞 업무의
  // 작업공간이 비치므로 자리만 그린다.
  const loading = s.activeFolder !== task.folder || s.pendingFolder === task.folder;
  const busy = resuming === task.folder;
  const btn: React.CSSProperties = {
    flex: "0 0 auto",
    height: 24,
    padding: "0 10px",
    display: "flex",
    alignItems: "center",
    borderRadius: 4,
    border: "1px solid #e0dcd4",
    background: "#fff",
    color: "#6a665e",
    fontSize: 11.5,
    cursor: "pointer",
  };
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "7px 12px",
          background: "#f4f2ee",
          borderBottom: "1px solid #e6e2da",
        }}
      >
        <Box
          onClick={onBack}
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 24,
            padding: "0 10px 0 8px",
            borderRadius: 4,
            border: "1px solid #d9d4ca",
            background: "#fff",
            color: "#3a3630",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
          hover={{ borderColor: "#3a6fd8", color: "#2f5cbb" }}
        >
          <span style={{ fontSize: 11 }}>←</span> 보관함 목록
        </Box>
        <span style={{ fontSize: 12, color: "#6a665e", flex: 1, minWidth: 0 }}>
          보관된 업무입니다 · 읽기 참조용으로 열려 있으며 업무 리스트에는 표시되지 않습니다
        </span>
        <Box
          onClick={() => void s.openTaskInObsidian(task.folder)}
          style={btn}
          hover={{ borderColor: "#c9dbf7", color: "#2f5cbb" }}
        >
          Obsidian
        </Box>
        <Box
          role="button"
          aria-disabled={!!resuming}
          onClick={() => {
            if (!resuming) onResume();
          }}
          style={{
            ...btn,
            gap: 6,
            padding: "0 11px",
            border: "1px solid #cddcf8",
            background: "#eef3fd",
            color: "#2f5cbb",
            fontSize: 12,
            fontWeight: 600,
            cursor: resuming ? "default" : "pointer",
          }}
          hover={resuming ? undefined : { background: "#e2ebfc" }}
        >
          {busy && <Spinner track="#cddcf8" />}
          {busy ? "재개하는 중" : "여기서 재개"}
        </Box>
      </div>
      {loading ? (
        <DetailSkeleton task={task} />
      ) : (
        <div className="cf-fade" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <Workspace />
        </div>
      )}
    </div>
  );
}

export default function Archive() {
  const s = useStore();
  const { tasks, settings, archQuery, archScope, archYear, archMonth, archCat, archGroup } = s;
  const [hits, setHits] = useState<Record<string, string>>({});
  /** `hits` 가 답한 검색어. `null` 이면 본문 검색 결과가 아직 없다(처음 · 실패). */
  const [hitsFor, setHitsFor] = useState<string | null>(null);
  /** 본문 검색이 도는 중 — 앞 결과를 흐리게 두고 입력칸에 돌기를 띄운다. */
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  /** 재개 중인 업무. 끝나면 작업공간으로 넘어가므로 실패했을 때만 되돌아온다. */
  const [resuming, setResuming] = useState<string | null>(null);
  const resume = (folder: string) => {
    if (resuming) return;
    setResuming(folder);
    void s.restoreTask(folder).finally(() => setResuming((r) => (r === folder ? null : r)));
  };

  const archived = useMemo(
    () => tasks.filter((t) => isArchived(t, settings.archDays)),
    [tasks, settings.archDays],
  );
  const live = tasks.length - archived.length;
  /** 순서 · 표시 철자 · 개수는 보관 전체에서 — 연도나 검색으로 거른다고 선택지가 바뀌지 않게. */
  const nodes = useMemo(() => knownCategories(archived), [archived]);
  const uncat = useMemo(() => archived.filter((t) => !t.category).length, [archived]);
  /**
   * 실제로 거르는 카테고리. 고른 카테고리의 보관 업무가 모두 사라지면(재개 · 카테고리 변경)
   * 전체로 돌아간다 — 선택지에 없는 값을 쥔 채 빈 목록을 보이면 왜 비었는지 알 수 없다.
   */
  const effCat =
    archCat !== null && (archCat === "" ? uncat > 0 : nodes.some((n) => n.key === archCat))
      ? archCat
      : null;
  // 고른 값도 지운다. 쥐고 있으면 그 카테고리의 업무가 다시 보관될 때, 아무것도 하지 않았는데
  // 거르기가 되살아난다(선택지에서 [전체] 를 다시 골라도 값이 같아 바뀌지 않는다).
  useEffect(() => {
    if (archCat !== null && effCat === null) s.set({ archCat: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archCat, effCat]);
  /** 보관 업무에 카테고리가 없으면 묶는 기준 칸도 숨으므로 분기로 돌아간다 — 돌아갈 길 없이 미분류 하나로 묶이지 않게. */
  const effGroup = nodes.length > 0 ? archGroup : "quarter";

  // Full-text scope needs the backend to read the notes, so run it on demand.
  // 기다리는 동안 앞 결과를 지우지 않는다 — 비웠다가 채우면 그 사이 "맞는 업무가 없습니다" 가 거짓으로
  // 뜬다. 실패도 빈 결과로 삼키지 않고 따로 알린다.
  useEffect(() => {
    const q = archQuery.trim();
    if (archScope !== "full" || !q) {
      setHits({});
      setHitsFor(null);
      setSearching(false);
      setSearchErr(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api
        .searchFullText(settings.vault, q)
        .then((res) => {
          if (cancelled) return;
          setHits(Object.fromEntries(res.map((h) => [h.folder, h.snippet])));
          setHitsFor(q);
          setSearchErr(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setHits({});
          setHitsFor(null);
          setSearchErr(api.errMessage(e));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [archQuery, archScope, settings.vault]);

  const years = useMemo(
    () => [
      "all",
      ...Array.from(new Set(archived.map((t) => (t.completedAt ?? "").slice(0, 4)).filter(Boolean)))
        .sort()
        .reverse(),
    ],
    [archived],
  );

  /** 고른 연도 안에서 실제로 완료된 달만. 빈 달은 칩으로 만들지 않는다. */
  const months = useMemo(() => {
    if (archYear === "all") return [];
    return Array.from(
      new Set(
        archived
          .filter((t) => (t.completedAt ?? "").slice(0, 4) === archYear)
          .map((t) => (t.completedAt ?? "").slice(5, 7))
          .filter(Boolean),
      ),
    ).sort();
  }, [archived, archYear]);

  const groups = useMemo(() => {
    const q = archQuery.trim().toLowerCase();
    const hit = archived
      .filter((t) => {
        const done = t.completedAt ?? "";
        if (archYear !== "all" && done.slice(0, 4) !== archYear) return false;
        if (archMonth !== "all" && done.slice(5, 7) !== archMonth) return false;
        if (effCat !== null && !isWithin(t.category, effCat)) return false;
        if (!q) return true;
        // 본문 결과가 있으면 그것으로. 아직 없으면(처음 받는 중 · 실패) 제목 · 태그로 찾은 것을 둔다.
        if (archScope === "full" && hitsFor !== null) return !!hits[t.folder];
        // 카테고리는 저장 형태(`a/b`)와 화면 형태(`a › b`) 둘 다로 찾는다(업무 리스트와 같다).
        const cat = t.category ? `${t.category} ${categoryLabel(t.category)}` : "";
        return `${t.title} ${t.tags.join(" ")} ${cat} ${t.relFolder}`.toLowerCase().includes(q);
      })
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
    return groupArchived(hit, effGroup, nodes);
  }, [archived, archQuery, archScope, archYear, archMonth, hits, hitsFor, effCat, effGroup, nodes]);

  /**
   * 가상 스크롤은 한 줄짜리 목록만 다룰 수 있으므로, 묶음 헤더와 카드를 한 배열로 편다.
   * 화면에 보이는 구간만 그리려면 렌더 순서가 곧 인덱스여야 한다.
   */
  const rows = useMemo(() => {
    const out: (
      | { kind: "header"; key: string; label: string; count: number; cat?: string }
      | { kind: "card"; key: string; task: (typeof archived)[number] }
    )[] = [];
    groups.forEach((g) => {
      out.push({ kind: "header", key: g.key, label: g.label, count: g.count, cat: g.cat });
      g.items.forEach((t) => out.push({ kind: "card", key: t.folder, task: t }));
    });
    return out;
  }, [groups]);

  /**
   * 걸러서 새로 나타난 카드 — 이것만 `cf-enter` 로 들어온다. 남아 있던 카드는 가만히 두고, 스크롤로
   * 그려지는 카드도 움직이지 않는다(이미 목록에 있던 것이다). 처음 화면을 열 때는 아무것도 없다.
   */
  const fresh = useRef<{ of: typeof rows | null; seen: Set<string>; fresh: Set<string> }>({
    of: null,
    seen: new Set(),
    fresh: new Set(),
  });
  if (fresh.current.of !== rows) {
    const now = new Set(rows.filter((r) => r.kind === "card").map((r) => r.key));
    const first = fresh.current.of === null;
    const was = fresh.current.seen;
    fresh.current = { of: rows, seen: now, fresh: first ? new Set() : new Set([...now].filter((k) => !was.has(k))) };
  }

  const v = useVirtual({
    count: rows.length,
    // 헤더는 한 줄, 카드는 태그 한 줄 기준. 재기 전까지만 쓰는 값이다.
    estimate: (i) => (rows[i]?.kind === "header" ? 28 : 62),
    // 필터가 바뀌면 같은 인덱스가 다른 업무를 가리키므로 재어 둔 높이를 버린다. 줄 수가 같아도
    // 머리 행 자리가 바뀔 수 있으니(묶는 기준 · 재개) 묶음 키도 넣는다.
    resetKey:
      `${archYear}|${archMonth}|${archScope}|${archQuery.trim()}|${effCat ?? "*"}|${effGroup}|` +
      `${rows.length}|${groups.map((g) => g.key).join("|")}`,
  });

  /**
   * 이 화면의 규칙 한 줄. 보관으로 들어오는 길이 둘이라 둘 다 말해야 한다 — 앱에서 누른
   * [완료]는 그 자리에서 보관하고(`setStatus`), Obsidian 등 앱 밖에서 완료로 바뀐 업무는
   * `archDays` 가 지나면 접힌다(`isArchived`).
   */
  const rule = `앱에서 [완료]를 누르면 그 즉시 보관됩니다. ${
    settings.archDays > 0
      ? `Obsidian 등 앱 밖에서 완료로 바꾼 업무는 ${settings.archDays}일이 지나면 목록에서 접힙니다.`
      : "앱 밖에서 완료로 바꾼 업무는 자동으로 접히지 않으므로 [지금 보관함으로]로 직접 접습니다."
  } ${
    settings.archMode === "move"
      ? "Archive/[연도]/ 로 실제 이동합니다."
      : "파일은 이동하지 않고 frontmatter에 archived 표시만 남기므로 Obsidian 링크와 그래프는 그대로 유지됩니다."
  }`;

  /**
   * 상세로 들어간 업무. 사라진 업무(외부에서 삭제 · 재개)를 가리키고 있으면 목록을
   * 그린다 — 빈 상세보다 목록이 낫다.
   */
  const opened = s.archOpen ? tasks.find((t) => t.folder === s.archOpen) : undefined;
  // 카드 ↔ 상세 전환 ------------------------------------------------------------------------
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listScroll = useRef<HTMLDivElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [travel, setTravel] = useState<Travel | null>(null);
  /** 상세가 보이는가 — 카드가 펼쳐지는 동안은 아직 아니다. */
  const detailOn = !!opened && !(travel?.kind === "open" && travel.stage < 2);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const later = (ms: number, f: () => void) => timers.current.push(window.setTimeout(f, ms));
  /** 두 프레임 뒤 — 첫 자리가 그려진 다음에 옮겨야 전환이 돈다. */
  const nextFrame = (f: () => void) => requestAnimationFrame(() => requestAnimationFrame(f));
  /** 방금 목록으로 돌아온 카드 — 한 번 파랗게 빛나 어디로 돌아왔는지 보인다. */
  const [flash, setFlash] = useState<{ folder: string; n: number } | null>(null);
  const flashN = useRef(0);
  const flashCard = (folder: string) => {
    const n = ++flashN.current;
    setFlash({ folder, n });
    // 빛난 뒤에는 지운다 — 남겨 두면 스크롤로 다시 그려질 때 또 빛난다.
    later(1000, () => setFlash((f) => (f?.n === n ? null : f)));
  };
  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      v.scrollRef(el);
      listScroll.current = el;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v.scrollRef],
  );

  /** 목록에서 보이는 카드의 자리(이 화면 기준). 스크롤 밖에 있으면 `null` — 그때는 날지 않는다. */
  const cardRect = (folder: string): { card: Rect; full: Rect } | null => {
    const el = cards.current.get(folder);
    const root = rootRef.current;
    const box = listScroll.current;
    if (!el?.isConnected || !root || !box || reducedMotion()) return null;
    const R = root.getBoundingClientRect();
    const C = el.getBoundingClientRect();
    const B = box.getBoundingClientRect();
    if (C.bottom <= B.top || C.top >= B.bottom) return null;
    return {
      card: { x: C.left - R.left, y: C.top - R.top, w: C.width, h: C.height },
      full: { x: 0, y: 0, w: R.width, h: R.height },
    };
  };

  /** 카드를 눌렀다 — 카드 모양이 상세 자리까지 펼쳐진 뒤 걷히며 상세가 드러난다. 그동안 업무를 연다. */
  const openCard = (t: TaskMeta) => {
    if (travel || resuming) return;
    const at = cardRect(t.folder);
    void s.peekArchived(t.folder);
    if (!at) return;
    setTravel({ kind: "open", folder: t.folder, title: t.title, ...at, stage: 0 });
    nextFrame(() => setTravel((x) => (x?.kind === "open" ? { ...x, stage: 1 } : x)));
    later(TRAVEL_MS, () => setTravel((x) => (x?.kind === "open" ? { ...x, stage: 2 } : x)));
    later(TRAVEL_MS + REVEAL_MS, () => setTravel((x) => (x?.kind === "open" ? null : x)));
  };

  /** [← 보관함 목록] — 상세가 같은 카드로 되접히고, 그 카드가 한 번 빛난다. 목록은 스크롤 그대로다. */
  const backToList = () => {
    const folder = s.archOpen;
    const title = opened?.title ?? "";
    const at = cardRect(folder);
    s.closeArchived();
    if (!at) {
      flashCard(folder);
      return;
    }
    setTravel({ kind: "close", folder, title, ...at, stage: 0 });
    nextFrame(() => setTravel((x) => (x?.kind === "close" ? { ...x, stage: 1 } : x)));
    later(TRAVEL_MS, () => {
      setTravel((x) => (x?.kind === "close" ? null : x));
      flashCard(folder);
    });
  };

  const stats = [
    { key: "n", value: archived.length, label: "보관된 업무", color: "#3a3630" },
    { key: "r", value: archived.reduce((n, t) => n + t.runs, 0), label: "누적 회차", color: "#2f6f80" },
    { key: "v", value: live, label: "목록에 남은 업무", color: GREEN },
  ];


  /** 연도 줄의 작은 칩 — 연도와 `묶기` 가 같은 모양이다. */
  const smallChip = (on: boolean): React.CSSProperties => ({
    height: 22,
    padding: "0 10px",
    display: "flex",
    alignItems: "center",
    borderRadius: 4,
    fontSize: 11.5,
    cursor: "pointer",
    border: `1px solid ${on ? "#d9d4ca" : "transparent"}`,
    background: on ? "#fff" : "transparent",
    color: on ? "#23211e" : "#6a665e",
    fontWeight: on ? 600 : 400,
  });
  /** 고르지 않은 칩의 호버 — 고른 칩은 그대로다. */
  const chipHover = (on: boolean): React.CSSProperties | undefined =>
    on ? undefined : { background: "#f2efe9", color: TEXT.ink };
  const scopeAt = SCOPES.findIndex(([k]) => k === archScope);

  /** 연도 줄 끝의 카테고리 관리 링크 — 지금 거르는 카테고리에서, 보관 업무까지 함께 보며 연다. */
  const manageLink = (text: string) => (
    <Box
      onClick={() => s.openCatMgr(effCat ?? "", "all")}
      style={{ marginLeft: 8, fontSize: 11.5, color: "#3a6fd8", cursor: "pointer", whiteSpace: "nowrap" }}
      hover={{ textDecoration: "underline" }}
    >
      {text}
    </Box>
  );

  /** 펼치거나 되접는 카드의 지금 자리. */
  const ghost = travel
    ? (travel.kind === "open" ? travel.stage === 0 : travel.stage === 1)
      ? { ...travel.card, r: 6 }
      : { ...travel.full, r: 0 }
    : null;

  return (
    <div ref={rootRef} style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0, display: "flex", overflow: "hidden" }}>
    {/*
      목록은 상세를 여는 동안에도 내리지 않는다 — 다시 그리면 스크롤이 맨 위로 돌아가 방금 보던 카드를
      다시 찾아야 했다. 숨기는 것은 `visibility` 라 스크롤 자리가 그대로 남는다.
    */}
    <div
      aria-hidden={detailOn}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "#fdfcfa",
        visibility: detailOn ? "hidden" : "visible",
        opacity: opened ? 0 : 1,
        transition: `opacity ${REVEAL_MS}ms linear`,
      }}
    >
      <div
        style={{ flex: "0 0 auto", padding: "16px 22px 12px 22px", borderBottom: "1px solid #eae6de" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-.2px" }}>보관함</div>
            <div
              style={{
                fontSize: 12.5,
                color: "#8a857c",
                marginTop: 3,
                lineHeight: 1.65,
                maxWidth: 640,
              }}
            >
              {rule}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
            {stats.map((st) => (
              <div
                key={st.key}
                style={{
                  minWidth: 96,
                  border: "1px solid #e6e2da",
                  borderRadius: 6,
                  padding: "7px 11px",
                  background: "#fff",
                }}
              >
                <div
                  style={{
                    fontFamily: "'Roboto Mono',monospace",
                    fontSize: 18,
                    fontWeight: 600,
                    color: st.color,
                    lineHeight: 1.1,
                    // 바뀐 숫자가 아래에서 올라올 때 칸 밖이 비치지 않게.
                    overflow: "hidden",
                  }}
                >
                  <Roll value={st.value} />
                </div>
                <div
                  style={{ fontSize: 11, color: "#6a665e", marginTop: 2, whiteSpace: "nowrap" }}
                >
                  {st.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 13 }}>
          <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}>
            <Input
              value={archQuery}
              onChange={(e) => s.set({ archQuery: e.target.value })}
              placeholder="보관된 업무 검색 — 제목, 태그, 본문 내용"
              aria-label="보관된 업무 검색"
              style={{
                flex: 1,
                minWidth: 0,
                height: 30,
                border: "1px solid #ddd8cf",
                borderRadius: 5,
                background: "#fff",
                padding: "0 28px 0 10px",
                fontSize: 13,
                color: "#23211e",
                outline: "none",
              }}
              focusStyle={{ borderColor: "#3a6fd8", boxShadow: "0 0 0 2px #e6eefc" }}
            />
            {searching && (
              <span
                role="status"
                aria-label="본문에서 찾는 중"
                title="본문에서 찾는 중"
                style={{ position: "absolute", right: 10, top: 10, display: "flex" }}
              >
                <Spinner />
              </span>
            )}
          </div>
          {/* 검색 범위 — 고른 쪽 뒤로 표시가 미끄러진다. */}
          <div
            role="radiogroup"
            aria-label="검색 범위"
            style={{
              position: "relative",
              flex: "0 0 auto",
              display: "flex",
              height: 30,
              boxSizing: "border-box",
              padding: 2,
              border: "1px solid #ddd8cf",
              borderRadius: 5,
              background: "#fff",
            }}
          >
            <span
              aria-hidden
              className="cf-mv"
              style={{
                position: "absolute",
                top: 2,
                left: 2,
                height: 24,
                width: SCOPES[scopeAt]![2],
                borderRadius: 3,
                background: "#eef3fd",
                boxShadow: "inset 0 0 0 1px #cddcf8",
                transform: `translateX(${scopeAt ? SCOPES[0]![2] : 0}px)`,
                transition: `transform 180ms ${EASE_OUT}, width 180ms ${EASE_OUT}`,
              }}
            />
            {SCOPES.map(([k, label, w]) => {
              const on = archScope === k;
              return (
                <Box
                  key={k}
                  role="radio"
                  aria-checked={on}
                  onClick={() => s.set({ archScope: k })}
                  style={{
                    position: "relative",
                    width: w,
                    height: 24,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 3,
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                    color: on ? "#2f5cbb" : TEXT.sub,
                    fontWeight: on ? 600 : 400,
                  }}
                  hover={on ? undefined : { color: TEXT.ink }}
                >
                  {label}
                </Box>
              );
            })}
          </div>
        </div>
        {searchErr && archScope === "full" && archQuery.trim() && (
          <div
            role="status"
            style={{ display: "flex", gap: 6, marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: TEXT.warn }}
          >
            <span style={{ flex: "0 0 auto" }}>●</span>
            <span style={{ minWidth: 0, wordBreak: "break-word" }}>
              본문을 검색하지 못해 제목 · 태그로 찾은 결과만 보입니다 — {searchErr}
            </span>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
          {years.map((y) => (
            <Box
              key={y}
              // 연도를 바꾸면 월은 무조건 처음으로 — 새 연도에 없는 달이 남아 있으면
              // 목록이 비어 버리고, 사용자는 왜 비었는지 알 길이 없다.
              onClick={() => s.set({ archYear: y, archMonth: "all" })}
              style={smallChip(archYear === y)}
              hover={chipHover(archYear === y)}
            >
              {y === "all" ? "전체" : `${y}년`}
            </Box>
          ))}
          {/* 카테고리를 쓰지 않는 Vault 에는 거를 것도 묶을 것도 없다 — 지금 화면 그대로. */}
          {nodes.length > 0 && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
              {/* 바로 옆이 연도의 [전체] 라, 이름 없이는 또 하나의 기간 선택으로 읽힌다. */}
              <span style={{ fontSize: 11, color: "#6a665e", marginRight: 2 }}>카테고리</span>
              <Select
                // `*` 는 카테고리에 쓸 수 없는 글자라 어떤 키와도 겹치지 않는다.
                value={effCat ?? "*"}
                onChange={(e) => s.set({ archCat: e.target.value === "*" ? null : e.target.value })}
                title="카테고리로 거르기"
                style={{
                  height: 22,
                  maxWidth: 220,
                  padding: "0 4px",
                  border: "1px solid #ddd8cf",
                  borderRadius: 4,
                  background: "#fff",
                  color: "#4e4a43",
                  fontSize: 11.5,
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value="*">전체 ({archived.length})</option>
                {nodes.map((n) => (
                  // option 은 앞의 ASCII 공백을 지우므로 들여쓰기는 NBSP 로.
                  <option key={n.key} value={n.key}>
                    {`${"\u00a0\u00a0".repeat(n.depth - 1)}${n.name} (${n.count})`}
                  </option>
                ))}
                {uncat > 0 && <option value="">미분류 ({uncat})</option>}
              </Select>
              <span style={{ fontSize: 11, color: "#6a665e", margin: "0 2px 0 8px" }}>묶기</span>
              {(
                [
                  ["quarter", "분기"],
                  ["category", "카테고리"],
                ] as const
              ).map(([k, label]) => (
                <Box
                  key={k}
                  onClick={() => s.set({ archGroup: k })}
                  style={smallChip(archGroup === k)}
                  hover={chipHover(archGroup === k)}
                >
                  {label}
                </Box>
              ))}
              {manageLink("관리…")}
            </div>
          )}
          {/* 카테고리가 하나도 없으면 거르기 · 묶기 대신 정리를 시작하는 길만 둔다. */}
          {nodes.length === 0 && archived.length > 0 && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
              {manageLink("카테고리 정리…")}
            </div>
          )}
        </div>

        {months.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 5 }}>
            <span
              style={{ fontSize: 11, color: "#6a665e", flex: "0 0 auto", padding: "0 4px 0 10px" }}
            >
              ↳
            </span>
            {["all", ...months].map((m) => {
              const on = archMonth === m;
              return (
                <Box
                  key={m}
                  onClick={() => s.set({ archMonth: m })}
                  hover={chipHover(on)}
                  style={{
                    height: 20,
                    padding: "0 9px",
                    display: "flex",
                    alignItems: "center",
                    borderRadius: 4,
                    fontSize: 11,
                    cursor: "pointer",
                    border: `1px solid ${on ? "#cddcf8" : "transparent"}`,
                    background: on ? "#eef3fd" : "transparent",
                    color: on ? "#2f5cbb" : "#6a665e",
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {m === "all" ? "12개월" : `${parseInt(m, 10)}월`}
                </Box>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/*
          가상 스크롤. 보이는 구간만 그리되, 스크롤바가 흔들리지 않도록 안쪽 스페이서가
          전체 높이를 유지한다. 카드 높이는 태그 줄 수와 스니펫 유무로 달라지므로
          그려진 것만 실제로 재어(`v.measure`) 다음 배치에 반영한다.
        */}
        <div
          ref={scrollRef}
          style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "12px 22px 20px 22px" }}
        >
          {/* 본문을 찾는 동안은 앞 결과를 흐리게 둔다 — 비웠다 채우면 그 사이가 "없음" 으로 보인다. */}
          <div
            style={{
              position: "relative",
              height: v.total,
              opacity: searching ? 0.5 : 1,
              transition: "opacity 140ms linear",
            }}
          >
            {rows.slice(v.start, v.end).map((row, n) => {
              const i = v.start + n;
              if (row.kind === "header") {
                const cat = row.cat;
                return (
                  <div
                    key={row.key}
                    ref={v.measure(i)}
                    style={{
                      position: "absolute",
                      top: v.offsetOf(i),
                      left: 0,
                      right: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      paddingTop: i === 0 ? 0 : 12,
                      paddingBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: ".3px",
                        color: "#6a665e",
                      }}
                    >
                      {row.label}
                    </span>
                    <span
                      style={{
                        fontFamily: "'Roboto Mono',monospace",
                        fontSize: 11.5,
                        color: "#6a665e",
                      }}
                    >
                      {row.count}
                    </span>
                    <div style={{ flex: 1, height: 1, background: "#eae6de" }} />
                    {/* 카테고리로 묶었을 때만 있다 — 미분류는 `""` 라 참 · 거짓으로 가르면 빠진다. 테두리까지
                        18px 로 묶는다. 머리 행은 재어 쓰는 높이라 버튼이 크면 행이 커진다. */}
                    {cat !== undefined && (
                      <Box
                        onClick={(e) => {
                          e.stopPropagation();
                          void openCategoryHub(cat);
                        }}
                        title="이 카테고리의 허브 노트를 Obsidian에서 엽니다"
                        style={{
                          flex: "0 0 auto",
                          height: 18,
                          fontSize: 11,
                          lineHeight: "16px",
                          padding: "0 7px",
                          borderRadius: 4,
                          border: "1px solid #e0dcd4",
                          background: "#fff",
                          color: "#6a665e",
                          cursor: "pointer",
                        }}
                        hover={{ borderColor: "#c9dbf7", color: "#2f5cbb" }}
                      >
                        Obsidian
                      </Box>
                    )}
                  </div>
                );
              }
              const t = row.task;
              const lit = flash?.folder === t.folder;
              const busy = resuming === t.folder;
              return (
                <div
                  key={row.key}
                  ref={v.measure(i)}
                  className={fresh.current.fresh.has(row.key) ? "cf-enter" : undefined}
                  // 카드 사이 간격은 래퍼의 padding 이다 — margin 이면 재는 높이에
                  // 잡히지 않아 카드가 서로 붙는다.
                  style={{
                    position: "absolute",
                    top: v.offsetOf(i),
                    left: 0,
                    right: 0,
                    paddingBottom: 4,
                    animationDelay: `${Math.min(n, 8) * 18}ms`,
                  }}
                >
                <Box
                  key={lit ? `lit${flash!.n}` : "card"}
                  ref={(el) => {
                    if (el) cards.current.set(t.folder, el);
                  }}
                  className={lit ? "cf-flash" : undefined}
                  onClick={() => openCard(t)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "9px 11px",
                    border: "1px solid #eae6de",
                    borderRadius: 6,
                    background: "#fff",
                    cursor: "pointer",
                  }}
                  hover={{ borderColor: "#d9d4ca", background: "#fffdf9" }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: "#3a3630",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t.title}
                      </span>
                      {t.tags.map((tg) => (
                        <span
                          key={tg}
                          style={{
                            fontFamily: "'Roboto Mono',monospace",
                            fontSize: 11.5,
                            color: "#6a665e",
                            background: "#f2efe9",
                            borderRadius: 3,
                            padding: "1px 5px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          #{tg}
                        </span>
                      ))}
                      {t.category && (
                        <CategoryChip
                          category={t.category}
                          // 카드를 누르면 상세로 들어가므로 칩 클릭은 거기까지 가지 않게 막는다.
                          onClick={(e) => {
                            e.stopPropagation();
                            s.set({ archCat: keyOf(t.category) });
                          }}
                          title="이 카테고리로 거르기"
                          caret={false}
                        />
                      )}
                      {t.archived === true && (
                        <span
                          style={{
                            fontSize: 12,
                            color: "#8f5d17",
                            background: "#fbf3e6",
                            borderRadius: 3,
                            padding: "1px 5px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          직접 보관
                        </span>
                      )}
                    </div>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, minWidth: 0 }}
                    >
                      <span
                        style={{
                          fontFamily: "'Roboto Mono',monospace",
                          fontSize: 11.5,
                          color: "#6a665e",
                          flex: "0 0 auto",
                        }}
                      >
                        {t.completedAt ?? "—"} · {daysSince(t.completedAt)}일 전
                      </span>
                      <span
                        style={{
                          fontSize: 11.5,
                          color: "#6a665e",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t.tagline}
                      </span>
                    </div>
                    {archScope === "full" && hits[t.folder] && (
                      <div
                        style={{
                          marginTop: 5,
                          padding: "5px 8px",
                          borderLeft: "2px solid #cddcf8",
                          background: "#f7fafe",
                          fontFamily: "'Roboto Mono',monospace",
                          fontSize: 11,
                          color: "#4e4a43",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {hits[t.folder]}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontFamily: "'Roboto Mono',monospace",
                      fontSize: 11.5,
                      color: "#6a665e",
                      flex: "0 0 auto",
                    }}
                  >
                    ×{t.runs}
                  </span>
                  <div style={{ display: "flex", gap: 5, flex: "0 0 auto" }}>
                    <Box
                      onClick={(e) => {
                        e.stopPropagation();
                        void s.openTaskInObsidian(t.folder);
                      }}
                      style={{
                        height: 24,
                        padding: "0 9px",
                        display: "flex",
                        alignItems: "center",
                        borderRadius: 4,
                        border: "1px solid #e0dcd4",
                        background: "#fff",
                        color: "#6a665e",
                        fontSize: 11.5,
                        cursor: "pointer",
                      }}
                      hover={{ borderColor: "#c9dbf7", color: "#2f5cbb" }}
                    >
                      Obsidian
                    </Box>
                    <Box
                      role="button"
                      aria-disabled={!!resuming}
                      onClick={(e) => {
                        e.stopPropagation();
                        resume(t.folder);
                      }}
                      style={{
                        height: 24,
                        padding: "0 10px",
                        display: "flex",
                        alignItems: "center",
                        gap: 5,
                        borderRadius: 4,
                        border: "1px solid #cddcf8",
                        background: "#eef3fd",
                        color: "#2f5cbb",
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: resuming ? "default" : "pointer",
                        opacity: resuming && !busy ? 0.55 : 1,
                      }}
                      hover={resuming ? undefined : { background: "#e2ebfc" }}
                    >
                      {busy && <Spinner size={9} track="#cddcf8" />}
                      {busy ? "재개하는 중" : "재개"}
                    </Box>
                  </div>
                </Box>
                </div>
              );
            })}
          </div>

          {searching && groups.length === 0 && (
            <div style={{ padding: "8px 2px", fontSize: 12, color: TEXT.sub, display: "flex", alignItems: "center", gap: 7 }}>
              <Spinner />
              본문에서 찾는 중입니다
            </div>
          )}
          {archived.length > 0 && groups.length === 0 && !searching && (
            <div className="cf-fade" style={{ padding: "8px 2px", fontSize: 12, color: "#8a857c", lineHeight: 1.7 }}>
              <div style={{ color: "#8a857c" }}>이 조건에 맞는 보관 업무가 없습니다.</div>
              {/* 카테고리는 카드 칩 한 번으로도 걸려 눈에 덜 띄는 조건이다 — 푸는 길을 먼저 둔다. */}
              {effCat !== null && (
                <Box
                  onClick={() => s.set({ archCat: null })}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    height: 24,
                    marginTop: 6,
                    padding: "0 9px",
                    borderRadius: 4,
                    border: "1px solid #e0dcd4",
                    background: "#fff",
                    color: "#6a665e",
                    fontSize: 11.5,
                    cursor: "pointer",
                  }}
                  hover={{ borderColor: "#3a6fd8", color: "#2f5cbb" }}
                >
                  카테고리 전체 보기
                </Box>
              )}
              {archQuery.trim() && archScope === "title" && (
                <div style={{ marginTop: 6 }}>
                  찾는 내용이 없다면 검색 범위를 [본문 전문]으로 바꿔보세요. 보관된 노트의 본문과
                  첨부 텍스트까지 훑습니다.
                </div>
              )}
            </div>
          )}
          {archived.length === 0 && (
            <div
              style={{
                padding: "48px 12px",
                textAlign: "center",
                fontSize: 12.5,
                color: "#8a857c",
                lineHeight: 1.8,
              }}
            >
              아직 보관된 업무가 없습니다.
              <br />
              업무를 [완료]하면 그 즉시 여기로 옵니다.
            </div>
          )}
        </div>

        <div
          style={{
            flex: "0 0 272px",
            borderLeft: "1px solid #eae6de",
            background: "#faf9f6",
            overflow: "auto",
            padding: "13px 14px 18px 14px",
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: ".4px", color: "#6a665e" }}>
            Obsidian 연계
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "#6a665e",
              marginTop: 5,
              lineHeight: 1.7,
            }}
          >
            보관은 ContextFlow 목록에서만 접는 동작입니다. Vault 안의 노트는 그대로 남아 Obsidian
            검색·그래프·Dataview에서 계속 조회됩니다.
          </div>
          <div
            style={{
              marginTop: 11,
              border: "1px solid #e6e2da",
              borderRadius: 6,
              background: "#fff",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "6px 9px",
                background: "#f4f2ee",
                borderBottom: "1px solid #eae6de",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: ".3px",
                color: "#6a665e",
              }}
            >
              현재 방식 ·{" "}
              {settings.archMode === "tag"
                ? "frontmatter 태그 (파일 이동 없음)"
                : "Archive 폴더로 이동"}
            </div>
            <div
              style={{
                padding: "8px 10px",
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11,
                lineHeight: 1.75,
              }}
            >
              <div style={{ color: "#3a3630" }}>status: completed</div>
              <div style={{ color: "#1f6b45" }}>archived: true</div>
              <div style={{ color: "#1f6b45" }}>archived_at: {new Date().toISOString().slice(0, 10)}</div>
              <div style={{ color: "#3a3630" }}>runs: n</div>
            </div>
          </div>
          <div
            style={{
              marginTop: 11,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: ".3px",
              color: "#6a665e",
            }}
          >
            Obsidian에서 같은 목록 보기
          </div>
          <div
            style={{
              marginTop: 5,
              border: "1px solid #e6e2da",
              borderRadius: 6,
              background: "#fff",
              padding: "8px 10px",
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              lineHeight: 1.8,
            }}
          >
            {archiveDataview(settings.archDays).map((t, i, lines) => (
              <div
                key={i}
                style={{
                  whiteSpace: "pre-wrap",
                  color: i === 0 || i === lines.length - 1 ? "#b5afa2" : "#3a3630",
                }}
              >
                {t}
              </div>
            ))}
          </div>
          <Box
            onClick={() => {
              void (async () => {
                try {
                  // MOC 는 열기 직전에 새로 쓴다. 보관 업무가 하나도 없어도 직접 열 때는 만든다
                  // (`force`) — 자동 갱신만 빈 Vault 에 MOC 를 만들지 않는다.
                  const path = await api.writeArchiveMoc(settings.vault, settings.archDays, true);
                  reportObsidianOpen(await api.openInObsidian(settings.vault, path));
                } catch (e) {
                  s.fail(e, "MOC 노트를 열지 못했습니다");
                }
              })();
            }}
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 29,
              padding: "0 10px",
              borderRadius: 5,
              border: "1px solid #cddcf8",
              background: "#eef3fd",
              cursor: "pointer",
            }}
            hover={{ background: "#e2ebfc" }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "#2f5cbb", flex: 1, minWidth: 0 }}>
              Archive MOC 노트 열기
            </span>
            <span style={{ fontSize: 11, color: "#6f8fcf" }}>↗</span>
          </Box>
          <div
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              color: "#6a665e",
              marginTop: 5,
              lineHeight: 1.6,
              wordBreak: "break-all",
            }}
          >
            {settings.vault.split("/").pop()}/_index/Archive.md
          </div>
          {!s.obsidianOk && (
            <div
              style={{
                marginTop: 9,
                padding: "7px 9px",
                borderRadius: 5,
                background: "#fbf3e6",
                border: "1px solid #eeddc0",
                fontSize: 11,
                color: "#8f5d17",
                lineHeight: 1.6,
              }}
            >
              이 PC에 Obsidian이 설치되어 있지 않습니다. [Obsidian] 버튼은 해당 폴더를 Windows
              탐색기에서 엽니다.
            </div>
          )}
        </div>
      </div>
    </div>

    {opened && (
      <div
        className="cf-fade"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          // 카드가 펼쳐지는 동안에는 밑에서 업무를 읽어 두기만 한다.
          visibility: detailOn ? "visible" : "hidden",
        }}
      >
        <ArchiveDetail
          task={opened}
          resuming={resuming}
          onResume={() => resume(opened.folder)}
          onBack={backToList}
        />
      </div>
    )}

    {/* 카드 ↔ 상세 사이를 잇는 카드 모양. 눌리지 않고 화면 읽기에도 잡히지 않는다. */}
    {travel && ghost && (
      <div
        aria-hidden
        className="cf-mv"
        style={{
          position: "absolute",
          left: ghost.x,
          top: ghost.y,
          width: ghost.w,
          height: ghost.h,
          zIndex: 20,
          boxSizing: "border-box",
          borderRadius: ghost.r,
          border: "1px solid #d9d4ca",
          background: "#fff",
          boxShadow: "0 12px 30px rgba(35,33,30,.16)",
          overflow: "hidden",
          pointerEvents: "none",
          opacity: travel.kind === "open" && travel.stage === 2 ? 0 : 1,
          transition: [
            `left ${TRAVEL_MS}ms ${EASE_OUT}`,
            `top ${TRAVEL_MS}ms ${EASE_OUT}`,
            `width ${TRAVEL_MS}ms ${EASE_OUT}`,
            `height ${TRAVEL_MS}ms ${EASE_OUT}`,
            `border-radius ${TRAVEL_MS}ms ${EASE_OUT}`,
            `opacity ${REVEAL_MS}ms linear`,
          ].join(", "),
        }}
      >
        <div
          style={{
            padding: "9px 11px",
            fontSize: 13,
            fontWeight: 500,
            color: "#3a3630",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {travel.title}
        </div>
      </div>
    )}
    </div>
  );
}
