import { useMemo, useState } from "react";
import { Box } from "../lib/ui";
import { extOf, LANG, statusOf } from "../lib/design";
import { fmValue, mdParse, splitFrontmatter } from "../lib/markdown";
import { basename } from "../lib/format";
import { useStore } from "../store/useStore";

/** Tab strip + one of: empty state / binary card / markdown viewer / editor. */
export default function EditorPane() {
  const s = useStore();
  const { ui, files, activeFolder } = s;
  const [caret, setCaret] = useState({ ln: 1, col: 1 });

  const task = s.tasks.find((t) => t.folder === activeFolder);
  const tab = ui.openTabs.find((t) => `${t.mode}|${t.path}` === ui.activeTab) ?? null;
  const meta = tab ? files.find((f) => f.p === tab.path) : undefined;
  const isBinary = !!meta?.bin;
  const doc = tab ? ui.docs[tab.path] : undefined;
  const body = doc?.text ?? "";
  const dirty = !!doc && doc.text !== doc.saved;
  const ext = tab ? extOf(tab.path) : "";

  const split = useMemo(() => splitFrontmatter(body), [body]);
  const blocks = useMemo(
    () => (tab && !isBinary && tab.mode === "md" ? mdParse(split.body) : []),
    [tab, isBinary, split.body],
  );
  // The frontmatter is rendered as a summary header, so the textarea edits only
  // the body — otherwise the same YAML would appear twice on screen. Edits are
  // reassembled with the original block so metadata survives a save.
  const fm = split.fm;
  const editingBodyOnly = !!tab && tab.path === "index.md" && !!fm;
  const editorValue = editingBodyOnly ? split.body : body;
  const onEdit = (next: string) => {
    if (!tab) return;
    s.editDoc(tab.path, editingBodyOnly ? `---\n${fm}\n---\n${next}` : next);
  };

  const onCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const pos = el.selectionStart ?? 0;
    const upto = el.value.slice(0, pos);
    setCaret({ ln: upto.split("\n").length, col: pos - upto.lastIndexOf("\n") });
  };

  return (
    <div
      style={{
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        borderBottom: "1px solid #e6e2da",
        flex: s.noteMin ? "1 1 auto" : "0 0 auto",
        height: s.noteMin ? "auto" : `${Math.round(ui.rowPct * 10) / 10}%`,
      }}
    >
      <div
        style={{
          flex: "0 0 27px",
          display: "flex",
          alignItems: "stretch",
          background: "#f7f5f1",
          borderBottom: "1px solid #e6e2da",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            flex: "1 1 auto",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {ui.openTabs.map((t) => {
            const key = `${t.mode}|${t.path}`;
            const on = key === ui.activeTab;
            const tDoc = ui.docs[t.path];
            const tDirty = t.mode === "text" && !!tDoc && tDoc.text !== tDoc.saved;
            return (
              <div
                key={key}
                onClick={() => s.setUi({ activeTab: key })}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 8px 0 9px",
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 10.5,
                  cursor: "pointer",
                  borderRight: "1px solid #e6e2da",
                  whiteSpace: "nowrap",
                  flex: "0 1 auto",
                  minWidth: 0,
                  maxWidth: 180,
                  background: on ? "#fff" : "transparent",
                  color: on ? "#23211e" : "#8a857c",
                  boxShadow: on
                    ? `inset 0 -2px 0 ${t.mode === "md" ? "#6a54c6" : "#3a6fd8"}`
                    : "none",
                }}
              >
                <span
                  style={{
                    flex: "0 0 auto",
                    fontSize: 8,
                    fontWeight: 600,
                    letterSpacing: ".3px",
                    borderRadius: 2,
                    padding: "1px 3px",
                    color: t.mode === "md" ? "#5a44b4" : "#2f5cbb",
                    background: t.mode === "md" ? "#f2eefc" : "#eef3fd",
                  }}
                >
                  {t.mode === "md" ? "MD" : "TXT"}
                </span>
                <span
                  style={{
                    flex: "0 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {basename(t.path)}
                </span>
                {tDirty && (
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      flex: "0 0 5px",
                      background: "#b07520",
                      display: "block",
                    }}
                  />
                )}
                <Box
                  onClick={(e) => {
                    e.stopPropagation();
                    s.closeTab(key);
                  }}
                  style={{
                    width: 13,
                    height: 13,
                    flex: "0 0 13px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 3,
                    fontSize: 9,
                    color: "#a09a8f",
                  }}
                  hover={{ background: "#e0dcd4", color: "#4e4a43" }}
                >
                  ✕
                </Box>
              </div>
            );
          })}
        </div>
      </div>

      {!tab && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            background: "#fdfcfa",
          }}
        >
          <div style={{ fontSize: 12, color: "#8a857c" }}>열려 있는 파일이 없습니다</div>
          <div
            style={{ fontSize: 10.5, color: "#a09a8f", textAlign: "center", lineHeight: 1.7 }}
          >
            오른쪽 탐색기에서 파일을 더블클릭하거나,
            <br />
            우클릭해 열기 방식을 선택하세요.
          </div>
        </div>
      )}

      {tab && isBinary && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
            background: "#fdfcfa",
            padding: 20,
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 6,
              border: "1px solid #e4e0d8",
              background: "#f2efe9",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "'IBM Plex Mono',monospace",
              fontSize: 10,
              color: "#8a857c",
            }}
          >
            {ext.toUpperCase()}
          </div>
          <div style={{ fontSize: 12, fontWeight: 500 }}>{basename(tab.path)}</div>
          <div
            style={{ fontSize: 10.5, color: "#a09a8f", textAlign: "center", lineHeight: 1.7 }}
          >
            텍스트로 표시할 수 없는 형식입니다 · {meta?.size ?? ""}
            <br />
            연결 프로그램으로 열어 확인하세요.
          </div>
          <Box
            onClick={() => s.openWith(tab.path)}
            style={{
              height: 27,
              padding: "0 13px",
              display: "flex",
              alignItems: "center",
              borderRadius: 5,
              border: "1px solid #cddcf8",
              background: "#eef3fd",
              color: "#2f5cbb",
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
            hover={{ background: "#e2ebfb" }}
          >
            연결 프로그램으로 열기
          </Box>
        </div>
      )}

      {tab && !isBinary && tab.mode === "md" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#fff" }}>
          <div
            style={{
              flex: "0 0 25px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 12px",
              background: "#fbfaf7",
              borderBottom: "1px dashed #e4e0d8",
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".4px", color: "#6a665e" }}>
              마크다운 뷰어
            </span>
            <span style={{ fontSize: 10, color: "#a09a8f" }}>읽기 전용 · 위키링크 활성</span>
            <div style={{ flex: 1 }} />
            <Box
              onClick={() => void s.openFile(tab.path, "text", true)}
              style={{ fontSize: 10, color: "#3a6fd8", cursor: "pointer" }}
              hover={{ textDecoration: "underline" }}
            >
              텍스트로 편집
            </Box>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 20px 24px 20px" }}>
            {blocks.map((b) => {
              if (b.isH2)
                return (
                  <div
                    key={b.key}
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      letterSpacing: "-.2px",
                      color: "#23211e",
                      margin: "16px 0 6px 0",
                      paddingBottom: 4,
                      borderBottom: "1px solid #f0ede7",
                    }}
                  >
                    {b.text}
                  </div>
                );
              if (b.isH3)
                return (
                  <div
                    key={b.key}
                    style={{ fontSize: 12.5, fontWeight: 600, color: "#3a3630", margin: "12px 0 4px 0" }}
                  >
                    {b.text}
                  </div>
                );
              if (b.isHr)
                return <div key={b.key} style={{ height: 1, background: "#e6e2da", margin: "12px 0" }} />;
              return (
                <div
                  key={b.key}
                  style={{ display: "flex", gap: 7, marginTop: 3, paddingLeft: b.indent }}
                >
                  {b.hasMark && (
                    <span
                      style={{ flex: "0 0 auto", fontSize: 11.5, lineHeight: 1.8, color: b.markFg }}
                    >
                      {b.mark}
                    </span>
                  )}
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      lineHeight: 1.8,
                      color: b.fg,
                    }}
                  >
                    {b.segs.map((g) => {
                      if (g.isB)
                        return (
                          <span key={g.key} style={{ fontWeight: 600, color: "#23211e" }}>
                            {g.text}
                          </span>
                        );
                      if (g.isCode)
                        return (
                          <span
                            key={g.key}
                            style={{
                              fontFamily: "'IBM Plex Mono',monospace",
                              fontSize: 11,
                              background: "#f4f2ed",
                              border: "1px solid #e6e2da",
                              borderRadius: 3,
                              padding: "1px 4px",
                            }}
                          >
                            {g.text}
                          </span>
                        );
                      if (g.isLink)
                        return (
                          <Box
                            key={g.key}
                            onClick={() => s.toast("위키링크", g.text, "#a78bfa")}
                            style={{
                              display: "inline",
                              color: "#3a6fd8",
                              borderBottom: "1px solid #cddcf8",
                              cursor: "pointer",
                            }}
                            hover={{ background: "#eef3fd" }}
                          >
                            {g.text}
                          </Box>
                        );
                      return <span key={g.key}>{g.text}</span>;
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab && !isBinary && tab.mode === "text" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {editingBodyOnly && (
            <div
              style={{
                flex: "0 0 auto",
                padding: "8px 12px",
                background: "#faf9f6",
                borderBottom: "1px dashed #e4e0d8",
                fontFamily: "'IBM Plex Mono',monospace",
                fontSize: 10.5,
                lineHeight: 1.65,
                color: "#6a665e",
              }}
            >
              <div style={{ color: "#b5afa2" }}>---</div>
              <div>
                <span style={{ color: "#6a54c6" }}>id:</span> {fmValue(fm, "id")}
              </div>
              <div>
                <span style={{ color: "#6a54c6" }}>status:</span>{" "}
                <span style={{ color: statusOf(fmValue(fm, "status")).dot }}>
                  {fmValue(fm, "status")}
                </span>{" "}
                <span style={{ color: "#b5afa2" }}>&nbsp;tags:</span> {fmValue(fm, "tags")}
              </div>
              <div>
                <span style={{ color: "#6a54c6" }}>updated:</span> {fmValue(fm, "updated")}{" "}
                <span style={{ color: "#b5afa2" }}>&nbsp;template_ref:</span>{" "}
                <span style={{ color: "#3a6fd8" }}>{fmValue(fm, "template_ref") || "null"}</span>
              </div>
              <div style={{ color: "#b5afa2" }}>---</div>
            </div>
          )}
          <textarea
            value={editorValue}
            onChange={(e) => onEdit(e.target.value)}
            onKeyUp={onCaret}
            onClick={onCaret}
            spellCheck={false}
            style={{
              flex: 1,
              minHeight: 0,
              width: "100%",
              border: 0,
              outline: "none",
              padding: "10px 12px",
              fontFamily: "'IBM Plex Mono',monospace",
              fontSize: 12,
              lineHeight: 1.72,
              color: "#2c2a26",
              background: "#fff",
            }}
          />
          <div
            style={{
              flex: "0 0 22px",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "0 12px",
              background: "#f7f5f1",
              borderTop: "1px solid #e6e2da",
              fontFamily: "'IBM Plex Mono',monospace",
              fontSize: 9.5,
              color: "#8a857c",
            }}
          >
            <span>
              Ln {caret.ln}, Col {caret.col}
            </span>
            <span>{LANG[ext] ?? "Plain Text"}</span>
            <span>UTF-8</span>
            <div style={{ flex: 1 }} />
            <span
              style={{ color: dirty ? "#b07520" : "#8a857c" }}
              title={task ? `${task.relFolder}${tab.path}` : ""}
            >
              {dirty ? "미저장 변경 · 자동 저장 대기" : `저장됨 ${s.snapAt}`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
