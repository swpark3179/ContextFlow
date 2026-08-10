import { useEffect, useMemo, useState } from "react";
import { Box, Input } from "../lib/ui";
import { GREEN, VIOLET } from "../lib/design";
import { daysSince, qLabel } from "../lib/format";
import * as api from "../lib/api";
import { isArchived, useStore } from "../store/useStore";

export default function Archive() {
  const s = useStore();
  const { tasks, settings, archQuery, archScope, archYear } = s;
  const [hits, setHits] = useState<Record<string, string>>({});

  const archived = useMemo(
    () => tasks.filter((t) => isArchived(t, settings.archDays)),
    [tasks, settings.archDays],
  );
  const live = tasks.length - archived.length;

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

  const groups = useMemo(() => {
    const q = archQuery.trim().toLowerCase();
    const hit = archived
      .filter((t) => {
        if (archYear !== "all" && (t.completedAt ?? "").slice(0, 4) !== archYear) return false;
        if (!q) return true;
        if (archScope === "full") return !!hits[t.folder];
        return `${t.title} ${t.tags.join(" ")} ${t.relFolder}`.toLowerCase().includes(q);
      })
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

    const out: { label: string; count: number; items: typeof archived }[] = [];
    hit.forEach((t) => {
      const label = qLabel(t.completedAt ?? t.archivedAt ?? "");
      let g = out[out.length - 1];
      if (!g || g.label !== label) {
        g = { label, count: 0, items: [] };
        out.push(g);
      }
      g.items.push(t);
      g.count = g.items.length;
    });
    return out;
  }, [archived, archQuery, archScope, archYear, hits]);

  const rule =
    settings.archDays > 0
      ? `완료 후 ${settings.archDays}일이 지나면 목록에서 자동으로 접힙니다. ${
          settings.archMode === "move"
            ? "Archive/[연도]/ 로 실제 이동합니다."
            : "파일은 이동하지 않고 frontmatter에 archived 표시만 남기므로 Obsidian 링크와 그래프는 그대로 유지됩니다."
        }`
      : "자동 보관이 꺼져 있습니다. 완료 업무는 [지금 보관함으로]를 눌러 직접 접을 수 있습니다.";

  const stats = [
    { key: "n", value: archived.length, label: "보관된 업무", color: "#3a3630" },
    { key: "r", value: archived.reduce((n, t) => n + t.runs, 0), label: "누적 회차", color: VIOLET },
    { key: "v", value: live, label: "목록에 남은 업무", color: GREEN },
  ];

  const chip = (on: boolean) => ({
    height: 30,
    padding: "0 11px",
    display: "flex",
    alignItems: "center",
    borderRadius: 5,
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
    border: `1px solid ${on ? "#cddcf8" : "#ddd8cf"}`,
    background: on ? "#eef3fd" : "#fff",
    color: on ? "#2f5cbb" : "#6a665e",
    fontWeight: on ? 600 : 400,
  });

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#fdfcfa" }}>
      <div
        style={{ flex: "0 0 auto", padding: "16px 22px 12px 22px", borderBottom: "1px solid #eae6de" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-.2px" }}>보관함</div>
            <div
              style={{
                fontSize: 11.5,
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
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 17,
                    fontWeight: 600,
                    color: st.color,
                    lineHeight: 1.1,
                  }}
                >
                  {st.value}
                </div>
                <div
                  style={{ fontSize: 10, color: "#8a857c", marginTop: 2, whiteSpace: "nowrap" }}
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
              fontSize: 12,
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

        <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
          {years.map((y) => {
            const on = archYear === y;
            return (
              <div
                key={y}
                onClick={() => s.set({ archYear: y })}
                style={{
                  height: 22,
                  padding: "0 10px",
                  display: "flex",
                  alignItems: "center",
                  borderRadius: 4,
                  fontSize: 10.5,
                  cursor: "pointer",
                  border: `1px solid ${on ? "#d9d4ca" : "transparent"}`,
                  background: on ? "#fff" : "transparent",
                  color: on ? "#23211e" : "#8a857c",
                  fontWeight: on ? 600 : 400,
                }}
              >
                {y === "all" ? "전체" : `${y}년`}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "12px 22px 20px 22px" }}>
          {groups.map((g) => (
            <div key={g.label} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span
                  style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".3px", color: "#6a665e" }}
                >
                  {g.label}
                </span>
                <span
                  style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, color: "#b5afa2" }}
                >
                  {g.count}
                </span>
                <div style={{ flex: 1, height: 1, background: "#eae6de" }} />
              </div>
              {g.items.map((t) => (
                <Box
                  key={t.folder}
                  onClick={() => void s.peekArchived(t.folder)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "9px 11px",
                    border: "1px solid #eae6de",
                    borderRadius: 6,
                    background: "#fff",
                    marginBottom: 4,
                    cursor: "pointer",
                  }}
                  hover={{ borderColor: "#d9d4ca", background: "#fffdf9" }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 12,
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
                            fontFamily: "'IBM Plex Mono',monospace",
                            fontSize: 9,
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
                      {t.archived === true && (
                        <span
                          style={{
                            fontSize: 9,
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
                          fontFamily: "'IBM Plex Mono',monospace",
                          fontSize: 9.5,
                          color: "#a09a8f",
                          flex: "0 0 auto",
                        }}
                      >
                        {t.completedAt ?? "—"} · {daysSince(t.completedAt)}일 전
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
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
                          fontFamily: "'IBM Plex Mono',monospace",
                          fontSize: 10,
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
                      fontFamily: "'IBM Plex Mono',monospace",
                      fontSize: 9.5,
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
                        fontSize: 10.5,
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
                        fontSize: 10.5,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                      hover={{ background: "#ece5fb" }}
                    >
                      재개
                    </Box>
                  </div>
                </Box>
              ))}
            </div>
          ))}

          {archived.length > 0 && groups.length === 0 && archQuery.trim() && (
            <div style={{ padding: "8px 2px", fontSize: 11, color: "#b5afa2", lineHeight: 1.7 }}>
              찾는 내용이 없다면 검색 범위를 [본문 전문]으로 바꿔보세요. 보관된 노트의 본문과 첨부
              텍스트까지 훑습니다.
            </div>
          )}
          {archived.length === 0 && (
            <div
              style={{
                padding: "48px 12px",
                textAlign: "center",
                fontSize: 11.5,
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
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: ".4px", color: "#6a665e" }}>
            Obsidian 연계
          </div>
          <div
            style={{
              fontSize: 10.5,
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
                fontSize: 9.5,
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
                fontFamily: "'IBM Plex Mono',monospace",
                fontSize: 10,
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
              fontSize: 10,
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
              fontFamily: "'IBM Plex Mono',monospace",
              fontSize: 9.5,
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
                  const path = await api.writeArchiveMoc(settings.vault, settings.archDays);
                  const res = await api.openInObsidian(settings.vault, path);
                  if (res.opened === "obsidian")
                    s.toast("Obsidian에서 열었습니다", res.detail, "#a78bfa");
                  else s.toast("탐색기에서 열었습니다", res.detail, "#a8a29a");
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
            <span style={{ fontSize: 11, fontWeight: 600, color: "#5a44b4", flex: 1, minWidth: 0 }}>
              Archive MOC 노트 열기
            </span>
            <span style={{ fontSize: 10, color: "#8a7fc0" }}>↗</span>
          </Box>
          <div
            style={{
              fontFamily: "'IBM Plex Mono',monospace",
              fontSize: 9.5,
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
                fontSize: 10,
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
