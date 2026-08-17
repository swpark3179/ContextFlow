import { useMemo, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Box } from "../lib/ui";
import { extOf, LANG, statusOf } from "../lib/design";
import { fmValue, mdParse, splitFrontmatter } from "../lib/markdown";
import { cutLine } from "../lib/editing";
import { basename, joinPath } from "../lib/format";
import { useStore, viewerFor, type TabMode } from "../store/useStore";

const MODE_BADGE: Record<TabMode, { label: string; fg: string; bg: string; bar: string }> = {
  md: { label: "MD", fg: "#5a44b4", bg: "#f2eefc", bar: "#6a54c6" },
  html: { label: "HTML", fg: "#8f5d17", bg: "#fbf3e6", bar: "#b07520" },
  text: { label: "TXT", fg: "#2f5cbb", bg: "#eef3fd", bar: "#3a6fd8" },
};

/**
 * 뷰어와 편집기가 공유하는 머리띠. 오른쪽 끝의 전환 링크는 **같은 탭**의 모드만
 * 바꾼다 — 예전처럼 탭을 하나 더 만들지 않는다.
 */
function PaneHeader({
  label,
  hint,
  action,
  onAction,
  children,
}: {
  label: string;
  hint: string;
  action?: string;
  onAction?: () => void;
  /** 전환 링크 왼쪽에 붙는 뷰어별 스위치. */
  children?: ReactNode;
}) {
  return (
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
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: ".4px", color: "#6a665e" }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: "#a09a8f" }}>{hint}</span>
      <div style={{ flex: 1 }} />
      {children}
      {action && onAction && (
        <Box
          onClick={onAction}
          style={{ fontSize: 11, color: "#3a6fd8", cursor: "pointer" }}
          hover={{ textDecoration: "underline" }}
        >
          {action}
        </Box>
      )}
    </div>
  );
}

/** 파일 내용이 바뀌면 값이 바뀌는 짧은 키. asset: URL 의 캐시를 무르는 데만 쓴다. */
function contentKey(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return `${(h >>> 0).toString(36)}${text.length.toString(36)}`;
}

/** Tab strip + one of: empty state / binary card / markdown viewer / HTML viewer / editor. */
export default function EditorPane() {
  const s = useStore();
  const { ui, files, activeFolder } = s;
  const [caret, setCaret] = useState({ ln: 1, col: 1 });
  /** 스크립트를 끈 HTML 탭. 기본은 실행이고, 여기 들어온 경로만 srcdoc 으로 되돌아간다. */
  const [noScript, setNoScript] = useState<Record<string, boolean>>({});

  const task = s.tasks.find((t) => t.folder === activeFolder);
  const tab = ui.openTabs.find((t) => `${t.mode}|${t.path}` === ui.activeTab) ?? null;
  const meta = tab ? files.find((f) => f.p === tab.path) : undefined;
  const isBinary = !!meta?.bin;
  const doc = tab ? ui.docs[tab.path] : undefined;
  const body = doc?.text ?? "";
  const dirty = !!doc && doc.text !== doc.saved;
  const ext = tab ? extOf(tab.path) : "";
  /** 이 파일에 준비된 뷰어. 편집기 머리띠의 [뷰어로 열기] 는 이게 있을 때만 뜬다. */
  const viewer = tab && !isBinary ? viewerFor(tab.path) : null;

  const scripts = !!tab && !noScript[tab.path];
  /**
   * HTML 뷰어가 읽을 파일의 `asset:` URL.
   *
   * srcdoc 을 쓰지 않는 이유는 그 문서가 **부모 창의 CSP 를 물려받기** 때문이다 —
   * `script-src 'self'` 아래에서는 문서 안의 `<script>` 가 한 줄도 돌지 않는다.
   * asset: 로 읽으면 별도 출처의 평범한 문서라 CSP 를 물려받지 않고, 옆에 있는 CSS ·
   * 이미지 · 스크립트 파일도 상대 경로 그대로 따라온다.
   *
   * 쿼리는 캐시를 무르기 위한 것이다(백엔드는 경로만 본다). 편집기에서 고친 뒤
   * 뷰어로 돌아왔을 때 예전 내용이 남아 있으면 고친 것이 반영되지 않은 것처럼 보인다.
   */
  const htmlSrc = useMemo(() => {
    if (!tab || isBinary || tab.mode !== "html" || !scripts) return "";
    return `${convertFileSrc(joinPath(activeFolder, tab.path))}?v=${contentKey(
      doc?.saved ?? "",
    )}`;
  }, [tab, isBinary, scripts, activeFolder, doc?.saved]);

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

  const showCaret = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    const upto = el.value.slice(0, pos);
    setCaret({ ln: upto.split("\n").length, col: pos - upto.lastIndexOf("\n") });
  };
  const onCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => showCaret(e.currentTarget);

  /**
   * 고른 구간이 없을 때의 Ctrl+X 는 **커서가 놓인 줄 하나**를 잘라낸다(에디터의 관례).
   *
   * 잘라내기 자체는 그 줄을 선택해 두고 웹뷰에게 맡긴다 — 클립보드도 되돌리기(Ctrl+Z)도
   * 네이티브 그대로 남고, 값은 평소처럼 onChange 로 따라온다. 웹뷰가 거절하면 그때만
   * 클립보드 API 로 옮기고 본문은 직접 지운다. 클립보드에 못 올렸다고 줄까지 지우지
   * 않으려면 순서가 이대로여야 한다.
   */
  const onCut = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "x" && e.key !== "X") return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const el = e.currentTarget;
    const at = el.selectionStart ?? 0;
    if (at !== (el.selectionEnd ?? at)) return; // 구간을 골랐으면 평범한 잘라내기
    const cut = cutLine(el.value, at);
    if (!cut) return;
    e.preventDefault();
    el.setSelectionRange(cut.from, cut.to);
    let native = false;
    try {
      native = document.execCommand("cut");
    } catch {
      native = false;
    }
    if (native) return;
    void navigator.clipboard?.writeText(cut.text).catch(() => {});
    onEdit(cut.next);
    // 새 값이 그려진 뒤라야 캐럿이 붙는다 — 지금 놓으면 다시 그리면서 끝으로 밀린다.
    requestAnimationFrame(() => {
      el.setSelectionRange(cut.from, cut.from);
      showCaret(el);
    });
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
            const badge = MODE_BADGE[t.mode];
            return (
              <div
                key={key}
                onClick={() => s.setUi({ activeTab: key })}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 8px 0 9px",
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 11.5,
                  cursor: "pointer",
                  borderRight: "1px solid #e6e2da",
                  whiteSpace: "nowrap",
                  flex: "0 1 auto",
                  minWidth: 0,
                  maxWidth: 180,
                  background: on ? "#fff" : "transparent",
                  color: on ? "#23211e" : "#8a857c",
                  boxShadow: on ? `inset 0 -2px 0 ${badge.bar}` : "none",
                }}
              >
                <span
                  style={{
                    flex: "0 0 auto",
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: ".3px",
                    borderRadius: 2,
                    padding: "1px 3px",
                    color: badge.fg,
                    background: badge.bg,
                  }}
                >
                  {badge.label}
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
                    fontSize: 10,
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
          <div style={{ fontSize: 13, color: "#8a857c" }}>열려 있는 파일이 없습니다</div>
          <div
            style={{ fontSize: 11.5, color: "#a09a8f", textAlign: "center", lineHeight: 1.7 }}
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
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11,
              color: "#8a857c",
            }}
          >
            {ext.toUpperCase()}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{basename(tab.path)}</div>
          <div
            style={{ fontSize: 11.5, color: "#a09a8f", textAlign: "center", lineHeight: 1.7 }}
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
              fontSize: 12.5,
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
          <PaneHeader
            label="마크다운 뷰어"
            hint="읽기 전용 · 위키링크 활성"
            action="텍스트로 편집"
            onAction={() => void s.setTabMode(tab.path, "md", "text")}
          />
          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "14px 20px 24px 20px" }}>
            {blocks.map((b) => {
              if (b.isH2)
                return (
                  <div
                    key={b.key}
                    style={{
                      fontSize: 16,
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
                    style={{ fontSize: 13.5, fontWeight: 600, color: "#3a3630", margin: "12px 0 4px 0" }}
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
                      style={{ flex: "0 0 auto", fontSize: 12.5, lineHeight: 1.8, color: b.markFg }}
                    >
                      {b.mark}
                    </span>
                  )}
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 13.5,
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
                      if (g.isStrike)
                        // 그어 지운 글은 이미 지나간 이야기다. 완료된 체크 항목과
                        // 같은 회색으로 낮춰 본문의 시선을 뺏지 않게 둔다.
                        return (
                          <span
                            key={g.key}
                            style={{ textDecoration: "line-through", color: "#8a857c" }}
                          >
                            {g.text}
                          </span>
                        );
                      if (g.isCode)
                        return (
                          <span
                            key={g.key}
                            style={{
                              fontFamily: "'Roboto Mono',monospace",
                              fontSize: 12,
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
                        // 위키링크는 아직 이동을 지원하지 않는다. 눌렀을 때 링크 텍스트를
                        // 그대로 되읽어 주는 토스트를 띄우느니, 누를 수 있는 것처럼
                        // 보이지 않게 두는 편이 정직하다.
                        return (
                          <span
                            key={g.key}
                            title={g.text}
                            style={{
                              display: "inline",
                              color: "#3a6fd8",
                              borderBottom: "1px solid #cddcf8",
                            }}
                          >
                            {g.text}
                          </span>
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

      {tab && !isBinary && tab.mode === "html" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "#fff" }}>
          <PaneHeader
            label="HTML 뷰어"
            hint={
              scripts ? "스크립트 실행 · 앱 창과 격리됨" : "읽기 전용 · 스크립트와 외부 리소스 차단"
            }
            action="텍스트로 편집"
            onAction={() => void s.setTabMode(tab.path, "html", "text")}
          >
            <Box
              onClick={() => setNoScript((m) => ({ ...m, [tab.path]: scripts }))}
              title={
                scripts
                  ? "문서 안의 스크립트를 멈추고 전부 차단된 화면으로 봅니다"
                  : "문서 안의 스크립트를 실행합니다"
              }
              style={{
                fontSize: 11,
                color: scripts ? "#8f5d17" : "#a09a8f",
                cursor: "pointer",
                marginRight: 4,
              }}
              hover={{ textDecoration: "underline" }}
            >
              {scripts ? "스크립트 끄기" : "스크립트 켜기"}
            </Box>
          </PaneHeader>
          {/*
            두 모드가 있고, 갈리는 지점은 **문서를 어디서 읽는가** 다.

            기본(scripts)은 asset: 로 파일을 직접 읽는다. 별도 출처의 평범한 문서라
            앱 창의 CSP 를 물려받지 않으므로 안의 <script> 가 실제로 돌고, 옆에 있는
            CSS · 이미지도 상대 경로 그대로 따라온다. 대신 sandbox 는 `allow-scripts`
            하나뿐이다 — allow-same-origin 을 함께 주면 샌드박스가 무의미해지므로 절대
            같이 쓰지 않는다. 불투명 출처라 앱 창 · IPC · 로컬 저장소에 닿지 못한다.

            [스크립트 끄기] 는 예전 방식인 srcdoc 으로 되돌아간다. sandbox 에 아무
            토큰도 없고 부모 CSP 까지 물려받아 스크립트 · 외부 리소스가 전부 막히며,
            디스크가 아니라 편집 중인 버퍼를 그린다.
          */}
          <iframe
            key={scripts ? htmlSrc : `srcdoc|${tab.path}`}
            title="HTML 미리보기"
            sandbox={scripts ? "allow-scripts" : ""}
            src={scripts ? htmlSrc : undefined}
            srcDoc={scripts ? undefined : body}
            style={{ flex: 1, minHeight: 0, width: "100%", border: 0, background: "#fff" }}
          />
        </div>
      )}

      {tab && !isBinary && tab.mode === "text" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <PaneHeader
            label="텍스트 에디터"
            // 언어 · 인코딩은 아래 상태줄이 이미 말한다. 여기서 보탤 것이 있는 파일은
            // 뷰어가 있는 파일뿐이다 — 지금 보고 있는 것이 렌더 결과가 아니라 원본이다.
            hint={viewer ? "원본 텍스트" : ""}
            action={
              viewer ? (dirty ? "저장 후 뷰어로 열기" : "뷰어로 열기") : undefined
            }
            onAction={viewer ? () => void s.setTabMode(tab.path, "text", viewer) : undefined}
          />
          {editingBodyOnly && (
            <div
              style={{
                flex: "0 0 auto",
                padding: "8px 12px",
                background: "#faf9f6",
                borderBottom: "1px dashed #e4e0d8",
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11.5,
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
            onKeyDown={onCut}
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
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 13,
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
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 10.5,
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
