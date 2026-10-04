import { useCallback, useMemo, useState } from "react";
import { Box, BusyLabel, Input, Span } from "../lib/ui";
import { statusOf } from "../lib/design";
import type { TaskMeta } from "../lib/api";
import {
  isWithin,
  keyOf,
  knownCategories,
  label,
  MAX_DEPTH,
  movePlan,
  normalizeCategory,
  parentOf,
  retarget,
  revealKeys,
  segments,
  snapToExisting,
  UNCAT_LABEL,
  type CategoryNode,
  type MovePlan,
} from "../lib/category";
import { isArchived, openCategoryHub, useStore } from "../store/useStore";
import CategoryPicker from "../components/CategoryPicker";
import {
  GhostButton,
  inputFocus,
  inputStyle,
  labelStyle,
  Modal,
  ModalFooter,
  OptionCard,
  PrimaryButton,
} from "./Modal";

/** 백엔드(`category::broken_error`)와 같은 문구 — 누르기 전에 같은 말로 보여 준다. */
const BROKEN = {
  depth: `${MAX_DEPTH + 1}단계 이상이 됩니다 — 카테고리는 ${MAX_DEPTH}단계까지입니다`,
  reserved: `최상위에서 ‘${UNCAT_LABEL}’ 가 됩니다`,
} as const;

/** 규칙을 어기는 업무를 사유별 한 줄로 — 이름은 세 개까지, 나머지는 `외 n건`. */
function brokenLines(errors: MovePlan<TaskMeta>["errors"]): string[] {
  return (["depth", "reserved"] as const).flatMap((code) => {
    const titles = errors.filter((e) => e.code === code).map((e) => `‘${e.title}’`);
    if (!titles.length) return [];
    const more = titles.length > 3 ? ` 외 ${titles.length - 3}건` : "";
    return [`${titles.slice(0, 3).join(" · ")}${more} 이(가) ${BROKEN[code]}`];
  });
}

const quote = (cat: string | null) => (cat ? `‘${label(cat)}’` : UNCAT_LABEL);

const MERGE_NOTE = "합친 뒤에는 업무별로 다시 지정해야 나눌 수 있습니다";

/**
 * 경로 폼의 입력이 목적지 사유를 띄울 만한가. 규칙 오류(`depth` · `reserved`)는 picker 가 입력칸
 * 밑에 이미 적는다. 빈 칸은 아직 치지 않은 것이라 버튼만 끈다 — 미분류를 뜻하게 친 것만 [해제] 로
 * 안내한다.
 */
function showInvalid(value: string): boolean {
  const norm = normalizeCategory(value);
  if (norm.error) return false;
  return norm.value !== null || [UNCAT_LABEL, "null", "~"].includes(value.trim().toLowerCase());
}

/**
 * 카테고리 관리 — 일괄 지정 · 경로 바꾸기 · 해제.
 *
 * 카테고리는 업무에 붙은 이름일 뿐이라(레지스트리가 없다) 정리하는 길도 업무를 고쳐 쓰는 것
 * 하나다. 왼쪽에서 카테고리를 고르면 오른쪽은 그 서브트리의 업무다. 고른 업무에 새 이름을
 * 붙이거나(지정 줄), 카테고리 자체를 옮기거나 지운다(노드 줄의 폼).
 *
 * **미분류를 맨 위에 고정한다.** 정리는 대개 아직 이름이 없는 업무에서 시작한다 — 오늘의
 * 한일의 '오늘' 줄과 같은 자리다. 보관 업무도 함께 다룬다. 쌓인 보관 업무를 정리하는 것이
 * 이 대화상자의 주된 쓸 일이고, 경로 바꾸기는 보관 쪽에 옛 이름을 남기면 안 된다.
 *
 * 판정은 백엔드가 한다. 여기서 보이는 미리보기 · 경고는 같은 규칙(`movePlan`)으로 먼저
 * 보여 줄 뿐이고, 실패한 업무는 토스트가 아니라 대화상자 안에 남는다 — 어느 파일을 닫아야
 * 하는지 읽기 전에 사라지면 안 된다.
 *
 * 닫혀 있을 때는 열림만 본다 — 트리 · 개수 · 미리보기는 업무가 바뀔 때마다 다시 세는 것이라,
 * 훅을 모두 본문(`CategoryBody`)에 두어 열려 있을 때만 돈다.
 */
export default function CategoryModal() {
  const open = useStore((s) => !!s.catMgr);
  return open ? <CategoryBody /> : null;
}

function CategoryBody() {
  const s = useStore();
  // 감싸개가 열려 있을 때만 그린다.
  const m = s.catMgr!;
  const { tasks } = s;
  const { archDays } = s.settings;
  /** [다시 시도] 가 도는 중 — `busy` 만으로는 지정 줄의 [지정] 과 가를 수 없다. */
  const [retrying, setRetrying] = useState(false);

  /** 트리는 진행 · 보관 전체에서 만든다 — 범위를 바꿔도 왼쪽이 흔들리지 않게. */
  const nodes = useMemo(() => knownCategories(tasks), [tasks]);
  /** 노드(그 하위 포함)마다 [진행, 보관] 업무 수. 미분류는 `""`. */
  const counts = useMemo(() => {
    const out = new Map<string, [number, number]>();
    for (const t of tasks) {
      const i = isArchived(t, archDays) ? 1 : 0;
      for (const k of revealKeys(t.category)) {
        const c = out.get(k) ?? [0, 0];
        c[i]++;
        out.set(k, c);
      }
    }
    return out;
  }, [tasks, archDays]);

  const { node, scope, query, sel } = m;
  const { scoped, rows } = useMemo(() => {
    const order = new Map(nodes.map((n, i) => [n.key, i]));
    const arch = (t: TaskMeta) => isArchived(t, archDays);
    // 트리 순서대로(직속 먼저, 그다음 하위) — 하위 경로 라벨이 줄줄이 섞이지 않게. 같은
    // 카테고리 안에서는 진행 중이 먼저다.
    const inNode = tasks
      .filter((t) => isWithin(t.category, node))
      .sort(
        (a, b) =>
          (order.get(keyOf(a.category)) ?? -1) - (order.get(keyOf(b.category)) ?? -1) ||
          Number(arch(a)) - Number(arch(b)),
      );
    const scoped = scope === "all" ? inNode : inNode.filter((t) => !arch(t));
    const q = query.trim().toLowerCase();
    // 사이드바 검색과 같은 범위 — 카테고리는 저장 형태와 화면 형태 둘 다로 찾는다.
    const hit = (t: TaskMeta) =>
      `${t.title} ${t.tags.join(" ")} ${t.category ?? ""} ${t.category ? label(t.category) : ""} ${t.relFolder}`
        .toLowerCase()
        .includes(q);
    return { scoped, rows: q ? scoped.filter(hit) : scoped };
  }, [tasks, archDays, nodes, node, scope, query]);

  // 고르는 목록에서 자기 철자는 세지 않고(`exclude`), 경로 폼은 자기 자신 · 하위를 내놓지 않는다
  // (`hideNode`). 렌더마다 새 함수를 넘기면 picker 가 철자 목록을 매번 다시 만든다.
  const excludeSel = useCallback((t: TaskMeta) => sel.includes(t.folder), [sel]);
  const excludeNode = useCallback((t: TaskMeta) => isWithin(t.category, node), [node]);
  const hideOwn = useCallback((n: CategoryNode) => isWithin(n.path, node), [node]);

  const arch = (t: TaskMeta) => isArchived(t, archDays);
  // 바꾸는 중에는 닫지 않는다 — 대화상자를 치워도 쓰기는 멈추지 않고, 실패를 적을 자리만 사라진다.
  const close = () => !m.busy && s.set({ catMgr: null });

  const nodePath = node === "" ? null : (nodes.find((n) => n.key === node)?.path ?? node);
  const [nLive, nArch] = counts.get(node) ?? [0, 0];
  const visible = rows.map((t) => t.folder);
  const shown = new Set(visible);
  const picked = new Set(m.sel);
  const hidden = m.sel.filter((f) => !shown.has(f)).length;
  const allOn = visible.length > 0 && visible.every((f) => picked.has(f));
  const someOn = !allOn && visible.some((f) => picked.has(f));

  // -- 지정 줄 ---------------------------------------------------------------
  const norm = normalizeCategory(m.target);
  // 저장될 철자 — 스토어(`writeCategory`)처럼 고른 업무 자신의 철자는 세지 않는다.
  const assignTo =
    norm.value && snapToExisting(norm.value, knownCategories(tasks.filter((t) => !picked.has(t.folder))));
  const assignReady = !m.busy && m.sel.length > 0 && !norm.error && (m.targetNone || assignTo !== null);

  // -- 경로 바꾸기 · 해제 폼 --------------------------------------------------
  const edit = m.edit;
  // 상위로 올리기는 상위의 표시 철자로 — 스토어(`clearCategoryNode`)가 보내는 값과 같다.
  const up = parentOf(node);
  const upPath = up && (nodes.find((n) => n.key === up)?.path ?? up);
  const plan = edit ? movePlan(tasks, node, edit.mode === "path" ? edit.value : upPath, arch) : null;
  const toNone = edit?.mode === "remove" && edit.to === "none";
  const ok = !!plan && (toNone || (!plan.invalid && !plan.errors.length));
  /** 미리보기 — 줄마다 옮긴 뒤의 값. 옮길 수 없는 폼이면 `undefined`. */
  const after = (t: TaskMeta): string | null | undefined =>
    !plan || !ok ? undefined : toNone ? null : retarget(t.category, node, plan.value)?.value;
  const merging = !!plan?.merge || !!edit?.confirmMerge;
  const warnings = !plan
    ? []
    : toNone
      ? []
      : [
          ...(plan.invalid && (edit?.mode !== "path" || showInvalid(edit.value)) ? [plan.invalid] : []),
          ...brokenLines(plan.errors),
        ];
  const mergeNote =
    !plan || toNone || plan.invalid || !merging
      ? null
      : plan.merge
        ? `‘${plan.merge.label}’ 카테고리가 이미 있어 합칩니다 · ${MERGE_NOTE}`
        : // 화면 미리보기와 달리 백엔드가 찾은 합치기 — 이름은 백엔드 문구에만 있다.
          `이미 있는 카테고리와 합칩니다 · ${MERGE_NOTE}`;
  // 값이 실제로 바뀌는 업무만 센다 — 이미 그 값인 업무는 백엔드도 쓰지 않는다. 그런 업무뿐이면
  // 누를 것이 없다(대소문자 고치기도 한 업무라도 바뀌면 누른다).
  const changing = !plan
    ? []
    : plan.targets.filter(
        (t) => toNone || !!plan.invalid || retarget(t.category, node, plan.value)?.value !== t.category,
      );
  const n = changing.length;
  const nKept = changing.filter(arch).length;
  // 예시는 실제로 바뀌는 업무 가운데 가장 깊은 것 — 제자리로 가는 업무로는 보여 줄 것이 없다.
  const example = (() => {
    if (!plan || plan.invalid) return null;
    let best: { from: string; to: string | null; depth: number } | null = null;
    for (const t of plan.targets) {
      const r = retarget(t.category, node, plan.value);
      if (!r || r.error || r.value === t.category) continue;
      const depth = segments(t.category).length;
      if (!best || depth > best.depth) best = { from: t.category!, to: r.value, depth };
    }
    return best;
  })();
  const editReady = !m.busy && ok && n > 0;

  const retry = async () => {
    setRetrying(true);
    try {
      await s.retryCatMgr();
    } finally {
      setRetrying(false);
    }
  };

  const empty =
    nLive + nArch === 0
      ? node === ""
        ? { main: "미분류 업무가 없습니다", sub: "모두 정리했습니다" }
        : // 일괄 지정으로 모두 다른 곳에 보냈다 — 트리에서는 이미 사라졌다.
          { main: "이 카테고리에 남은 업무가 없어 목록에서 사라집니다", sub: "카테고리는 업무에 붙은 이름입니다" }
      : !scoped.length
        ? { main: "진행 중인 업무가 없습니다", more: true }
        : !rows.length
          ? { main: "검색과 맞는 업무가 없습니다" }
          : null;

  return (
    <Modal width={880} zIndex={74} onClose={close} panelStyle={{ height: 560, maxHeight: "90vh" }}>
      <div
        style={{
          flex: "0 0 40px",
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 14px",
          borderBottom: "1px solid #e6e2da",
          background: "#faf9f6",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>카테고리 관리</span>
        <span style={{ fontSize: 11.5, color: "#6a665e" }}>업무에 붙은 카테고리를 한꺼번에 정리합니다</span>
        <div style={{ flex: 1 }} />
        <Box
          onClick={close}
          style={{
            width: 24,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            cursor: "pointer",
            color: "#8a857c",
            fontSize: 13,
          }}
          hover={{ background: "#ece8e0" }}
        >
          ✕
        </Box>
      </div>

      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          ...(m.busy && { pointerEvents: "none", opacity: 0.6 }),
        }}
      >
        {/* -- 왼쪽: 카테고리 트리 ------------------------------------------- */}
        <div
          style={{
            flex: "0 0 240px",
            borderRight: "1px solid #e6e2da",
            background: "#faf9f6",
            overflowY: "auto",
            paddingBottom: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", padding: "9px 9px 5px 11px" }}>
            <span style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>카테고리</span>
            <span style={{ fontSize: 11, color: "#6a665e" }} title="줄마다 진행 중 · 보관 업무 수">
              진행 <span style={{ color: "#c5c0b6" }}>· 보관</span>
            </span>
          </div>
          <TreeRow
            name={UNCAT_LABEL}
            path={null}
            depth={1}
            counts={counts.get("")}
            on={node === ""}
            onClick={() => s.setCatNode("")}
          />
          <div style={{ height: 1, background: "#e6e2da", margin: "4px 0" }} />
          {nodes.map((c) => (
            <TreeRow
              key={c.key}
              name={c.name}
              path={c.path}
              depth={c.depth}
              counts={counts.get(c.key)}
              on={node === c.key}
              onClick={() => s.setCatNode(c.key)}
            />
          ))}
          {!nodes.length && (
            <div style={{ padding: "6px 11px", fontSize: 11, color: "#6a665e", lineHeight: 1.6 }}>
              아직 카테고리가 없습니다 · 업무를 골라 지정하면 여기에 생깁니다
            </div>
          )}
        </div>

        {/* -- 오른쪽: 고른 카테고리의 업무 ----------------------------------
            목록이 먼저 줄어든다(폼 · 고르는 목록 · 실패 상자가 열리면 0 까지). 그래도 넘치면 칸
            전체가 스크롤한다 — 폼의 [바꾸기] 나 실패 상자가 패널 밖으로 잘리지 않게.
            스크롤 막대 자리는 비워 두지 않는다(global.css 의 `stable` 을 끈다). 넘치는 것은 목록 밖의
            줄들이 전체 폭에서도 넘칠 때뿐이라, 막대가 생겨 폭이 줄어도 사라지지 않아 흔들리지 않는다. */}
        <div
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            overflowY: "auto",
            scrollbarGutter: "auto",
          }}
        >
          {/* ① 노드 줄 */}
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "11px 13px 9px 13px",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: nodePath ? "#23211e" : "#8a857c",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {label(nodePath)}
              </div>
              <div style={{ fontSize: 11, color: "#6a665e", marginTop: 2 }}>
                진행 {nLive} · 보관 {nArch}
                {/* 허브는 업무가 있는 노드에만 있다 — 미분류도 같다. 오른쪽 버튼 줄에 하나 더 두지 않는다. */}
                {nLive + nArch > 0 && (
                  <Span
                    onClick={() => void openCategoryHub(node)}
                    style={{
                      marginLeft: 8,
                      fontSize: 11.5,
                      color: "#3a6fd8",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                    hover={{ textDecoration: "underline" }}
                  >
                    Obsidian에서 보기 ↗
                  </Span>
                )}
              </div>
            </div>
            {/* 미분류는 이름이 아니라 이름이 없는 것이라 바꾸거나 해제할 것이 없다. */}
            {nodePath && nLive + nArch > 0 && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6, flex: "0 0 auto" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                  <GhostButton
                    onClick={() =>
                      s.setCatEdit(
                        edit?.mode === "path" ? null : { mode: "path", value: nodePath, confirmMerge: false },
                      )
                    }
                  >
                    경로 바꾸기
                  </GhostButton>
                  <span style={{ fontSize: 11, color: "#6a665e", whiteSpace: "nowrap" }}>
                    이름 바꾸기 · 다른 카테고리 아래로 · 합치기
                  </span>
                </div>
                <GhostButton
                  onClick={() =>
                    s.setCatEdit(
                      edit?.mode === "remove" ? null : { mode: "remove", to: "parent", confirmMerge: false },
                    )
                  }
                >
                  해제
                </GhostButton>
              </div>
            )}
          </div>

          {/* 경로 바꾸기 · 해제 폼 — 노드 줄 바로 아래. */}
          {edit && plan && (
            <div
              style={{
                flex: "0 0 auto",
                margin: "0 13px 9px 13px",
                padding: "10px 11px",
                border: "1px solid #e6e2da",
                borderRadius: 6,
                background: "#faf9f6",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {edit.mode === "path" ? (
                <>
                  <div style={{ ...labelStyle, marginBottom: 0 }}>새 경로</div>
                  <CategoryPicker
                    autoFocus
                    allowNone={false}
                    exclude={excludeNode}
                    hideNode={hideOwn}
                    value={edit.value}
                    // 합치기 확인은 그 목적지에 대한 것이다 — 목적지를 바꾸면 다시 묻는다.
                    onChange={(v) => s.setCatEdit({ ...edit, value: v, confirmMerge: false })}
                    onCommit={(v) => s.setCatEdit({ ...edit, value: v ?? "", confirmMerge: false })}
                  />
                  {!plan.invalid && (
                    <div style={{ fontSize: 11.5, color: "#6a665e", lineHeight: 1.6 }}>
                      바뀌는 업무 {n}건{nKept > 0 && ` (보관 ${nKept} 포함)`}
                      {plan.subcats > 0 && ` · 하위 카테고리 ${plan.subcats}개`}
                      {example && (
                        <div style={{ color: "#6a665e", wordBreak: "break-all" }}>
                          예: {quote(example.from)} → {quote(example.to)}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <OptionCard
                    on={edit.to === "parent"}
                    label="상위 카테고리로 올리기"
                    desc={
                      upPath === null
                        ? "직속 업무는 미분류로, 하위 카테고리는 최상위로"
                        : `${quote(upPath)} 로 올립니다${
                            example ? ` · ${quote(example.from)} → ${quote(example.to)}` : ""
                          }`
                    }
                    onClick={() => s.setCatEdit({ ...edit, to: "parent", confirmMerge: false })}
                  />
                  <OptionCard
                    on={edit.to === "none"}
                    label="모두 미분류로"
                    desc={`업무 ${n}건이 미분류가 됩니다${nKept ? ` · 보관 ${nKept}건 포함` : ""}`}
                    onClick={() => s.setCatEdit({ ...edit, to: "none", confirmMerge: false })}
                  />
                </>
              )}

              {warnings.map((w) => (
                <Note key={w} tone="error">
                  {w}
                </Note>
              ))}
              {mergeNote && <Note tone="merge">{mergeNote}</Note>}

              <div style={{ display: "flex", gap: 7 }}>
                <div style={{ flex: 1 }} />
                <GhostButton onClick={() => s.setCatEdit(null)}>취소</GhostButton>
                {edit.mode === "path" ? (
                  <PrimaryButton
                    disabled={!editReady}
                    busy={m.busy}
                    minWidth={118}
                    onClick={() => void s.moveCategoryNode(node, edit.value, merging)}
                  >
                    <BusyLabel busy={m.busy} color="#fff" idle={`${merging ? "합치기" : "바꾸기"} (${n}건)`}>
                      바꾸는 중
                    </BusyLabel>
                  </PrimaryButton>
                ) : (
                  <PrimaryButton
                    disabled={!editReady}
                    busy={m.busy}
                    minWidth={118}
                    onClick={() => void s.clearCategoryNode(node, edit.to)}
                  >
                    <BusyLabel busy={m.busy} color="#fff" idle={`해제 (${n}건)`}>
                      해제하는 중
                    </BusyLabel>
                  </PrimaryButton>
                )}
              </div>
            </div>
          )}

          {/* ② 도구 줄 */}
          <div
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "0 13px 8px 13px",
            }}
          >
            <Input
              autoFocus
              value={m.query}
              onChange={(e) => s.setCatQuery(e.target.value)}
              placeholder="업무 · 태그 · 경로 검색"
              style={{ ...inputStyle, height: 27, flex: 1, minWidth: 0 }}
              focusStyle={inputFocus}
            />
            <div
              style={{
                flex: "0 0 auto",
                display: "flex",
                border: "1px solid #ddd8cf",
                borderRadius: 5,
                overflow: "hidden",
              }}
            >
              {(
                [
                  ["live", "진행 중만"],
                  ["all", "보관 포함"],
                ] as const
              ).map(([k, text], i) => {
                const on = m.scope === k;
                return (
                  <Box
                    key={k}
                    onClick={() => s.setCatScope(k)}
                    style={{
                      height: 25,
                      padding: "0 10px",
                      display: "flex",
                      alignItems: "center",
                      fontSize: 11.5,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      borderLeft: i ? "1px solid #ddd8cf" : "none",
                      background: on ? "#eef3fd" : "#fff",
                      color: on ? "#2f5cbb" : "#6a665e",
                      fontWeight: on ? 600 : 400,
                    }}
                    hover={on ? undefined : { background: "#f2efe9" }}
                  >
                    {text}
                  </Box>
                );
              })}
            </div>
          </div>

          {/* ③ 지정 줄 — 목록 위. 폼이 열려 있으면 숨긴다(목록은 그 폼의 미리보기가 된다). */}
          {!edit && (
            <div
              style={{
                flex: "0 0 auto",
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "0 13px 8px 13px",
              }}
            >
              <Box
                onClick={() => s.toggleCatAll(visible)}
                style={{
                  flex: "0 0 auto",
                  height: 29,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "#4e4a43",
                  cursor: visible.length ? "pointer" : "default",
                  userSelect: "none",
                }}
              >
                <Check on={allOn} part={someOn} />
                모두 선택
              </Box>
              <div style={{ flex: "0 0 auto", paddingTop: 6, fontSize: 12, color: "#4e4a43", lineHeight: 1.4 }}>
                · 선택한 {m.sel.length}건을
                {hidden > 0 && (
                  <div style={{ fontSize: 11, color: "#6a665e" }}>({hidden}건은 검색에 가려짐)</div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <CategoryPicker
                  value={m.target}
                  exclude={excludeSel}
                  onChange={(v) => s.setCatTarget(v, false)}
                  onCommit={(v) => s.setCatTarget(v ?? "", v === null)}
                />
              </div>
              <PrimaryButton
                disabled={!assignReady}
                busy={m.busy && !retrying}
                minWidth={118}
                onClick={() => void s.applyCatMgr()}
              >
                <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <BusyLabel
                    busy={m.busy && !retrying}
                    color="#fff"
                    idle={m.targetNone ? "미분류로 되돌리기" : assignTo ? `‘${label(assignTo)}’ 로 지정` : "지정"}
                  >
                    지정하는 중
                  </BusyLabel>
                </span>
              </PrimaryButton>
            </div>
          )}

          {/* ④ 업무 목록 */}
          <div
            style={{
              flex: "1 1 auto",
              minHeight: 0,
              overflowY: "auto",
              padding: "4px 9px 8px 9px",
              borderTop: "1px solid #efece5",
              ...(edit && { opacity: 0.55, pointerEvents: "none" }),
            }}
          >
            {empty && (
              <div style={{ padding: "20px 12px", fontSize: 12, color: "#8a857c", textAlign: "center", lineHeight: 1.7 }}>
                <div style={{ color: "#8a857c" }}>{empty.main}</div>
                {empty.sub && <div>{empty.sub}</div>}
                {empty.more && (
                  <Box
                    onClick={() => s.setCatScope("all")}
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
                    보관 포함으로 보기
                  </Box>
                )}
              </div>
            )}
            {rows.map((t) => (
              <TaskLine
                key={t.folder}
                task={t}
                depth={segments(node).length}
                archived={arch(t)}
                on={!edit && picked.has(t.folder)}
                check={!edit}
                after={after(t)}
                onClick={(shift) => s.toggleCatSel(t.folder, shift, visible)}
              />
            ))}
          </div>

          {/* ⑤ 바꾸지 못한 업무 */}
          {m.failed.length > 0 && (
            <div
              style={{
                flex: "0 0 auto",
                margin: "0 13px 10px 13px",
                border: "1px solid #f0d6d2",
                background: "#fdf2f1",
                borderRadius: 6,
                padding: "8px 10px",
                fontSize: 11.5,
                color: "#a83c3c",
                lineHeight: 1.6,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {m.failed.length}건을 바꾸지 못했습니다 · 파일이 다른 프로그램(OneDrive · 백신 · 편집기)에서
                  열려 있으면 바뀌지 않습니다
                </span>
                {m.retry && (
                  <Box
                    onClick={() => void retry()}
                    title="바꾸지 못한 업무만 다시 보냅니다"
                    style={{
                      flex: "0 0 auto",
                      height: 22,
                      padding: "0 9px",
                      display: "flex",
                      alignItems: "center",
                      borderRadius: 4,
                      border: "1px solid #e8c4bf",
                      background: "#fff",
                      color: "#a83c3c",
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                    hover={{ background: "#fbe9e7" }}
                  >
                    <BusyLabel busy={retrying} idle="다시 시도">
                      다시 시도하는 중
                    </BusyLabel>
                  </Box>
                )}
                <Box
                  onClick={() => s.set({ catMgr: { ...m, failed: [], retry: null } })}
                  title="목록을 닫습니다"
                  style={{
                    flex: "0 0 22px",
                    height: 22,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                  hover={{ background: "#f6dcd8" }}
                >
                  ✕
                </Box>
              </div>
              {/* 네 줄까지 보이고 나머지는 스크롤 — 상자가 목록 자리를 다 먹지 않게. */}
              <div style={{ maxHeight: 74, overflowY: "auto", marginTop: 4 }}>
                {m.failed.map((f) => (
                  <div
                    key={f.folder}
                    title={`${f.title} · ${f.reason}`}
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    <b>{f.title}</b> · {f.reason}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ModalFooter>
        <span style={{ fontSize: 11, color: "#6a665e", flex: 1, minWidth: 0 }}>
          폴더는 그대로 두고 index.md 의 category 한 줄만 고칩니다 · updated 는 바뀌지 않습니다
        </span>
        <GhostButton onClick={close}>닫기</GhostButton>
      </ModalFooter>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** 왼쪽 트리의 한 줄. 들여쓰기는 사이드바 카테고리 트리와 같은 13px 이다. */
function TreeRow({
  name,
  path,
  depth,
  counts: [live, kept] = [0, 0],
  on,
  onClick,
}: {
  name: string;
  /** `null` = 미분류. */
  path: string | null;
  depth: number;
  counts?: [number, number];
  on: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      onClick={onClick}
      title={path ? label(path) : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: `0 9px 0 ${11 + (depth - 1) * 13}px`,
        cursor: "pointer",
        background: on ? "#e9edf6" : "transparent",
        borderLeft: `2px solid ${on ? "#3a6fd8" : "transparent"}`,
      }}
      hover={on ? undefined : { background: "#f2efe9" }}
    >
      <span
        style={{
          fontSize: 12.5,
          color: on ? "#2f5cbb" : path === null ? "#8a857c" : "#4e4a43",
          fontWeight: on ? 600 : 400,
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      <span
        title={`진행 ${live} · 보관 ${kept}`}
        style={{
          fontFamily: "'Roboto Mono',monospace",
          fontSize: 11.5,
          color: live ? "#6a665e" : "#c5c0b6",
          flex: "0 0 auto",
        }}
      >
        {live}
        <span style={{ color: "#c5c0b6" }}> · {kept}</span>
      </span>
    </Box>
  );
}

function Check({ on, part }: { on: boolean; part?: boolean }) {
  return (
    <div
      style={{
        width: 14,
        height: 14,
        borderRadius: 3,
        flex: "0 0 14px",
        border: `1px solid ${on || part ? "#3a6fd8" : "#cfcabf"}`,
        background: on ? "#3a6fd8" : "#fff",
        color: on ? "#fff" : "#3a6fd8",
        fontSize: 11,
        lineHeight: "13px",
        textAlign: "center",
      }}
    >
      {on ? "✓" : part ? "–" : ""}
    </div>
  );
}

/**
 * 목록의 업무 한 줄. 보조 줄은 고른 카테고리 아래의 경로와 보관 여부다 — 제목만으로는 같은
 * 이름의 하위 업무 · 끝난 업무가 갈리지 않는다. `after` 가 있으면 폼의 미리보기로 옮긴 뒤의
 * 값을 오른쪽에 적는다.
 */
function TaskLine({
  task: t,
  depth,
  archived,
  on,
  check,
  after,
  onClick,
}: {
  task: TaskMeta;
  /** 고른 카테고리의 단계 수 — 그 아래만 보조 줄에 적는다. */
  depth: number;
  archived: boolean;
  on: boolean;
  check: boolean;
  after: string | null | undefined;
  onClick: (shift: boolean) => void;
}) {
  const tail = segments(t.category).slice(depth);
  const sub = [
    tail.length ? label(tail.join("/")) : "",
    archived ? [t.completedAt?.slice(0, 10), "보관"].filter(Boolean).join(" · ") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box
      onClick={(e) => onClick(e.shiftKey)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        marginBottom: 1,
        borderRadius: 5,
        cursor: "pointer",
        // Shift+클릭으로 범위를 고를 때 글자가 잡히지 않게.
        userSelect: "none",
        border: `1px solid ${on ? "#cddcf8" : "transparent"}`,
        background: on ? "#f7fafe" : "transparent",
      }}
      hover={on ? undefined : { background: "#f4f2ee" }}
    >
      {check && <Check on={on} />}
      <div style={{ width: 6, height: 6, borderRadius: "50%", flex: "0 0 6px", background: statusOf(t.status).dot }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            color: "#23211e",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t.title}
        </div>
        {sub && (
          <div
            style={{
              fontSize: 11,
              color: "#6a665e",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {after !== undefined && (
        <span
          style={{
            flex: "0 1 auto",
            maxWidth: "45%",
            fontSize: 11,
            color: after ? "#2f5cbb" : "#6a665e",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          → {label(after)}
        </span>
      )}
    </Box>
  );
}

/** 폼 안의 경고. 규칙 오류는 붉게(아무것도 쓰지 않는다), 합치기는 누를 수 있지만 되돌리기 어렵다. */
function Note({ tone, children }: { tone: "error" | "merge"; children: React.ReactNode }) {
  const c =
    tone === "error"
      ? { border: "#f0d6d2", bg: "#fdf2f1", fg: "#a83c3c" }
      : { border: "#efdcbc", bg: "#fdf8ef", fg: "#8f5d17" };
  return (
    <div
      style={{
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.fg,
        borderRadius: 5,
        padding: "6px 9px",
        fontSize: 11.5,
        lineHeight: 1.6,
        wordBreak: "break-all",
      }}
    >
      {children}
    </div>
  );
}
