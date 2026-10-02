import { useEffect, useMemo, useState } from "react";
import { Box, Input, Select } from "../lib/ui";
import { GREEN, VIOLET } from "../lib/design";
import { daysSince } from "../lib/format";
import * as api from "../lib/api";
import type { TaskMeta } from "../lib/api";
import { isArchived, reportObsidianOpen, useStore } from "../store/useStore";
import { useVirtual } from "../lib/virtual";
import Workspace from "./Workspace";
import { CategoryChip } from "../components/CategoryPicker";
import { isWithin, keyOf, knownCategories, label as categoryLabel } from "../lib/category";
import { groupArchived } from "../lib/archiveGroups";

/**
 * 보관함 안에서 연 업무의 작업공간.
 *
 * 워크스페이스 화면으로 넘기지 않는 이유는 그쪽 업무 리스트에 보관된 업무가 없기
 * 때문이다 — 넘어가면 아무것도 고르지 않은 것처럼 보이고, 돌아와도 이미 활성 업무라
 * 같은 항목을 다시 열 수 없었다. 화면(모드)은 보관함에 두고, 목록으로 돌아가는 길을
 * 이 바가 제공한다.
 */
function ArchiveDetail({ task }: { task: TaskMeta }) {
  const s = useStore();
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
          onClick={() => s.closeArchived()}
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
          hover={{ borderColor: "#a78bfa", color: "#5a44b4" }}
        >
          Obsidian
        </Box>
        <Box
          onClick={() => void s.restoreTask(task.folder)}
          style={{
            ...btn,
            padding: "0 11px",
            border: "1px solid #e0d6f8",
            background: "#f4f0fd",
            color: "#5a44b4",
            fontSize: 12,
            fontWeight: 600,
          }}
          hover={{ background: "#ece5fb" }}
        >
          여기서 재개
        </Box>
      </div>
      <Workspace />
    </div>
  );
}

export default function Archive() {
  const s = useStore();
  const { tasks, settings, archQuery, archScope, archYear, archMonth, archCat, archGroup } = s;
  const [hits, setHits] = useState<Record<string, string>>({});

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
  useEffect(() => {
    const q = archQuery.trim();
    if (archScope !== "full" || !q) {
      setHits({});
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .searchFullText(settings.vault, q)
        .then((res) => {
          if (cancelled) return;
          setHits(Object.fromEntries(res.map((h) => [h.folder, h.snippet])));
        })
        .catch(() => setHits({}));
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
        if (archScope === "full") return !!hits[t.folder];
        // 카테고리는 저장 형태(`a/b`)와 화면 형태(`a › b`) 둘 다로 찾는다(업무 리스트와 같다).
        const cat = t.category ? `${t.category} ${categoryLabel(t.category)}` : "";
        return `${t.title} ${t.tags.join(" ")} ${cat} ${t.relFolder}`.toLowerCase().includes(q);
      })
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
    return groupArchived(hit, effGroup, nodes);
  }, [archived, archQuery, archScope, archYear, archMonth, hits, effCat, effGroup, nodes]);

  /**
   * 가상 스크롤은 한 줄짜리 목록만 다룰 수 있으므로, 묶음 헤더와 카드를 한 배열로 편다.
   * 화면에 보이는 구간만 그리려면 렌더 순서가 곧 인덱스여야 한다.
   */
  const rows = useMemo(() => {
    const out: (
      | { kind: "header"; key: string; label: string; count: number }
      | { kind: "card"; key: string; task: (typeof archived)[number] }
    )[] = [];
    groups.forEach((g) => {
      out.push({ kind: "header", key: g.key, label: g.label, count: g.count });
      g.items.forEach((t) => out.push({ kind: "card", key: t.folder, task: t }));
    });
    return out;
  }, [groups]);

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

  const stats = [
    { key: "n", value: archived.length, label: "보관된 업무", color: "#3a3630" },
    { key: "r", value: archived.reduce((n, t) => n + t.runs, 0), label: "누적 회차", color: VIOLET },
    { key: "v", value: live, label: "목록에 남은 업무", color: GREEN },
  ];

  /**
   * 상세로 들어간 업무. 사라진 업무(외부에서 삭제 · 재개)를 가리키고 있으면 목록을
   * 그린다 — 빈 상세보다 목록이 낫다.
   */
  const opened = s.archOpen ? tasks.find((t) => t.folder === s.archOpen) : undefined;

  const chip = (on: boolean) => ({
    height: 30,
    padding: "0 11px",
    display: "flex",
    alignItems: "center",
    borderRadius: 5,
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    border: `1px solid ${on ? "#cddcf8" : "#ddd8cf"}`,
    background: on ? "#eef3fd" : "#fff",
    color: on ? "#2f5cbb" : "#6a665e",
    fontWeight: on ? 600 : 400,
  });

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
    color: on ? "#23211e" : "#8a857c",
    fontWeight: on ? 600 : 400,
  });

  if (opened) return <ArchiveDetail task={opened} />;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#fdfcfa" }}>
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
                  }}
                >
                  {st.value}
                </div>
                <div
                  style={{ fontSize: 11, color: "#8a857c", marginTop: 2, whiteSpace: "nowrap" }}
                >
                  {st.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 13 }}>
          <Input
            value={archQuery}
            onChange={(e) => s.set({ archQuery: e.target.value })}
            placeholder="보관된 업무 검색 — 제목, 태그, 본문 내용"
            style={{
              flex: 1,
              minWidth: 0,
              height: 30,
              border: "1px solid #ddd8cf",
              borderRadius: 5,
              background: "#fff",
              padding: "0 10px",
              fontSize: 13,
              color: "#23211e",
              outline: "none",
            }}
            focusStyle={{ borderColor: "#3a6fd8", boxShadow: "0 0 0 2px #e6eefc" }}
          />
          <div style={{ display: "flex", gap: 4, flex: "0 0 auto" }}>
            {(
              [
                ["title", "제목 · 태그"],
                ["full", "본문 전문"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} onClick={() => s.set({ archScope: k })} style={chip(archScope === k)}>
                {label}
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
          {years.map((y) => (
            <div
              key={y}
              // 연도를 바꾸면 월은 무조건 처음으로 — 새 연도에 없는 달이 남아 있으면
              // 목록이 비어 버리고, 사용자는 왜 비었는지 알 길이 없다.
              onClick={() => s.set({ archYear: y, archMonth: "all" })}
              style={smallChip(archYear === y)}
            >
              {y === "all" ? "전체" : `${y}년`}
            </div>
          ))}
          {/* 카테고리를 쓰지 않는 Vault 에는 거를 것도 묶을 것도 없다 — 지금 화면 그대로. */}
          {nodes.length > 0 && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
              {/* 바로 옆이 연도의 [전체] 라, 이름 없이는 또 하나의 기간 선택으로 읽힌다. */}
              <span style={{ fontSize: 11, color: "#a09a8f", marginRight: 2 }}>카테고리</span>
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
              <span style={{ fontSize: 11, color: "#a09a8f", margin: "0 2px 0 8px" }}>묶기</span>
              {(
                [
                  ["quarter", "분기"],
                  ["category", "카테고리"],
                ] as const
              ).map(([k, label]) => (
                <div key={k} onClick={() => s.set({ archGroup: k })} style={smallChip(archGroup === k)}>
                  {label}
                </div>
              ))}
            </div>
          )}
        </div>

        {months.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 5 }}>
            <span
              style={{ fontSize: 10.5, color: "#b5afa2", flex: "0 0 auto", padding: "0 4px 0 10px" }}
            >
              ↳
            </span>
            {["all", ...months].map((m) => {
              const on = archMonth === m;
              return (
                <div
                  key={m}
                  onClick={() => s.set({ archMonth: m })}
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
                    color: on ? "#2f5cbb" : "#8a857c",
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {m === "all" ? "12개월" : `${parseInt(m, 10)}월`}
                </div>
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
          ref={v.scrollRef}
          style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "12px 22px 20px 22px" }}
        >
          <div style={{ position: "relative", height: v.total }}>
            {rows.slice(v.start, v.end).map((row, n) => {
              const i = v.start + n;
              if (row.kind === "header") {
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
                        fontSize: 10.5,
                        color: "#b5afa2",
                      }}
                    >
                      {row.count}
                    </span>
                    <div style={{ flex: 1, height: 1, background: "#eae6de" }} />
                  </div>
                );
              }
              const t = row.task;
              return (
                <div
                  key={row.key}
                  ref={v.measure(i)}
                  // 카드 사이 간격은 래퍼의 padding 이다 — margin 이면 재는 높이에
                  // 잡히지 않아 카드가 서로 붙는다.
                  style={{
                    position: "absolute",
                    top: v.offsetOf(i),
                    left: 0,
                    right: 0,
                    paddingBottom: 4,
                  }}
                >
                <Box
                  onClick={() => void s.peekArchived(t.folder)}
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
                            fontSize: 10,
                            color: "#8a857c",
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
                            fontSize: 10,
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
                          fontSize: 10.5,
                          color: "#a09a8f",
                          flex: "0 0 auto",
                        }}
                      >
                        {t.completedAt ?? "—"} · {daysSince(t.completedAt)}일 전
                      </span>
                      <span
                        style={{
                          fontSize: 11.5,
                          color: "#a09a8f",
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
                      fontSize: 10.5,
                      color: "#b5afa2",
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
                      hover={{ borderColor: "#a78bfa", color: "#5a44b4" }}
                    >
                      Obsidian
                    </Box>
                    <Box
                      onClick={(e) => {
                        e.stopPropagation();
                        void s.restoreTask(t.folder);
                      }}
                      style={{
                        height: 24,
                        padding: "0 10px",
                        display: "flex",
                        alignItems: "center",
                        borderRadius: 4,
                        border: "1px solid #e0d6f8",
                        background: "#f4f0fd",
                        color: "#5a44b4",
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                      hover={{ background: "#ece5fb" }}
                    >
                      재개
                    </Box>
                  </div>
                </Box>
                </div>
              );
            })}
          </div>

          {archived.length > 0 && groups.length === 0 && (
            <div style={{ padding: "8px 2px", fontSize: 12, color: "#b5afa2", lineHeight: 1.7 }}>
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
                color: "#a09a8f",
                lineHeight: 1.8,
              }}
            >
              아직 보관된 업무가 없습니다.
              <br />
              완료 후 설정한 기간이 지나면 여기로 접힙니다.
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
              color: "#8a857c",
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
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: ".3px",
                color: "#8a857c",
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
              color: "#8a857c",
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
              fontSize: 10.5,
              lineHeight: 1.8,
            }}
          >
            {["```dataview", "TABLE completed_at, runs", 'FROM "Tasks"', "WHERE archived = true", "SORT completed_at DESC", "```"].map(
              (t, i) => (
                <div
                  key={i}
                  style={{ whiteSpace: "pre-wrap", color: i === 0 || i === 5 ? "#b5afa2" : "#3a3630" }}
                >
                  {t}
                </div>
              ),
            )}
          </div>
          <Box
            onClick={() => {
              void (async () => {
                try {
                  // MOC 는 열기 직전에 항상 새로 쓴다 — 파일이 없어서 실패하는 일은 없다.
                  const path = await api.writeArchiveMoc(settings.vault, settings.archDays);
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
              border: "1px solid #e0d6f8",
              background: "#f4f0fd",
              cursor: "pointer",
            }}
            hover={{ background: "#ece5fb" }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "#5a44b4", flex: 1, minWidth: 0 }}>
              Archive MOC 노트 열기
            </span>
            <span style={{ fontSize: 11, color: "#8a7fc0" }}>↗</span>
          </Box>
          <div
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 10.5,
              color: "#b5afa2",
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
  );
}
