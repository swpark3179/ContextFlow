import { useEffect, useRef, useState } from "react";
import { Input } from "../../lib/ui";
import * as api from "../../lib/api";
import { routeInfo, useAi } from "../../store/aiStore";
import { browserOptions, useStore } from "../../store/useStore";
import {
  Btn,
  Chip,
  ReadOnlyRow,
  Toggle,
  cardStyle,
  headStyle,
  hintStyle,
  inputFocus,
  inputMono,
  rowStyle,
} from "./shared";

const ENGINES: { id: api.WebEngine; label: string }[] = [
  { id: "google", label: "Google" },
  { id: "bing", label: "Bing" },
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "naver", label: "네이버" },
];

/** 검색 테스트의 검색어 — 결과가 늘 있고 업무 내용이 아닌 것. */
const TEST_QUERY = "Chrome DevTools Protocol";

interface Probe {
  running: boolean;
  ok?: boolean;
  msg?: string;
  results?: api.WebResult[];
  secs?: number;
}

/**
 * 웹 검색 브라우저 — 위키 질의 중 AI 가 웹을 찾을 때 띄우는 PC 의 브라우저.
 *
 * 어느 모델이 검색 결과를 읽을지는 여기가 아니라 "기능별 AI 연결" 의 **웹 검색** 행이 정한다
 * (같은 선택을 두 곳에서 고칠 수 없게). 이 카드는 브라우저 · 검색 엔진 · 읽을 분량만 정하고, 그
 * 연결을 한 줄로 보여 준다. 묻기 패널의 [웹 검색] 이 켜져 있을 때만 쓰인다.
 */
export default function WebSearchCard() {
  const s = useStore();
  const ai = useAi();
  const { settings } = s;
  const info = routeInfo(ai, "wiki.web");
  const [found, setFound] = useState<api.BrowserInfo | null>(null);
  const [draft, setDraft] = useState(settings.webBrowser);
  const [probe, setProbe] = useState<Probe | null>(null);
  // 화면을 떠난 뒤 도착한 결과는 버린다. 마운트마다 다시 세운다 — StrictMode 는 개발 중에
  // 한 번 내렸다 다시 올리므로, 내릴 때만 끄면 그 뒤의 결과가 전부 버려진다.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => setDraft(settings.webBrowser), [settings.webBrowser]);

  const detect = () =>
    void api
      .browserDetect(settings.webBrowser.trim() || null)
      .then((r) => alive.current && setFound(r))
      .catch(() => alive.current && setFound(null));
  useEffect(detect, [settings.webBrowser]);

  const browse = () => {
    void (async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        directory: false,
        title: "브라우저 실행 파일 선택",
        filters: [{ name: "실행 파일", extensions: ["exe"] }],
      });
      if (typeof picked === "string") s.patchSettings({ webBrowser: picked });
    })();
  };

  const test = () => {
    setProbe({ running: true });
    const t0 = Date.now();
    void api
      .webSearch(browserOptions(useStore.getState().settings), TEST_QUERY)
      .then((r) => {
        if (!alive.current) return;
        setProbe({
          running: false,
          ok: r.results.length > 0,
          msg: r.results.length ? `결과 ${r.results.length}건` : "결과를 읽지 못했습니다 — 다른 검색 엔진을 골라 보세요",
          results: r.results.slice(0, 3),
          secs: (Date.now() - t0) / 1000,
        });
        detect();
      })
      .catch((e) => alive.current && setProbe({ running: false, ok: false, msg: api.errMessage(e) }));
  };

  const route = info.run
    ? `${info.name} · ${info.modelLabel}${info.via === "default" ? " (기본 연결)" : ""}`
    : info.via === "route"
      ? `지정한 연결(${info.name})을 지금 쓸 수 없습니다`
      : "연결이 없습니다 — 위 \"기능별 AI 연결\" 의 웹 검색에서 고르세요";

  return (
    <div style={cardStyle}>
      <div style={headStyle}>웹 검색 브라우저</div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={hintStyle}>
          위키 질의에서 [웹 검색] 을 켜 두면, 위키만으로 답할 수 없을 때 AI 가 이 PC 의 브라우저를
          띄워 검색하고 결과 페이지 몇 장을 읽습니다. 브라우저는 앱 전용 프로필(~/.contextflow/browser)로
          뜨므로 평소 쓰는 계정 · 쿠키에는 손대지 않고, 검색 결과 읽기와 페이지 본문 읽기만 합니다.
        </div>
        <ReadOnlyRow
          label="브라우저"
          value={found?.path ?? (found ? "찾지 못했습니다" : "")}
          badge={found?.name ? `${found.name}${found.source === "custom" ? " · 지정" : ""}${found.running ? " · 실행 중" : ""}` : null}
        />
        <div style={{ display: "flex", gap: 6 }}>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft.trim() !== settings.webBrowser && s.patchSettings({ webBrowser: draft.trim() })}
            placeholder="비워 두면 Chrome → Edge 순으로 찾습니다"
            style={{ ...inputMono, flex: 1, minWidth: 0 }}
            focusStyle={inputFocus}
          />
          <Btn label="찾아보기" onClick={browse} />
          {settings.webBrowser && <Btn label="지정 해제" onClick={() => s.patchSettings({ webBrowser: "" })} />}
        </div>
      </div>
      <div style={{ ...rowStyle, borderTop: "1px solid #f4f1ec" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>검색 엔진</div>
          <div style={{ ...hintStyle, marginTop: 2 }}>
            결과가 안 나오거나 보안 문자가 뜨면 다른 엔진을 고르세요.
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {ENGINES.map((e) => (
            <Chip
              key={e.id}
              on={settings.webEngine === e.id}
              label={e.label}
              onClick={() => s.patchSettings({ webEngine: e.id })}
            />
          ))}
        </div>
      </div>
      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>검색어마다 읽을 페이지</div>
          <div style={{ ...hintStyle, marginTop: 2 }}>
            많을수록 정확하지만 느리고 길어집니다. 0 이면 결과 목록의 요약만 씁니다.
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {[0, 1, 2, 3, 5].map((n) => (
            <Chip
              key={n}
              on={settings.webPages === n}
              label={n === 0 ? "요약만" : `${n}장`}
              onClick={() => s.patchSettings({ webPages: n })}
            />
          ))}
        </div>
      </div>
      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>브라우저 창 보이기</div>
          <div style={{ ...hintStyle, marginTop: 2 }}>
            켜면 AI 가 검색하는 창이 보입니다. 검색 엔진이 보안 문자를 내밀 때 켜고 한 번 풀면 됩니다.
          </div>
        </div>
        <Toggle on={settings.webShow} onClick={() => s.patchSettings({ webShow: !settings.webShow })} />
      </div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ ...hintStyle, color: info.run ? "#3c7d5c" : "#a06a3b" }}>
          검색 결과를 읽을 연결: {route}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <Btn
            label="검색 테스트"
            busy={!!probe?.running}
            busyLabel="검색 중"
            onClick={test}
            disabled={found?.source === "not-found"}
          />
          {found?.running && (
            <Btn label="브라우저 닫기" onClick={() => void api.browserClose().then(detect).catch(() => {})} />
          )}
          <span style={hintStyle}>"{TEST_QUERY}" 를 검색해 봅니다 — AI 는 쓰지 않습니다.</span>
        </div>
        {probe && !probe.running && (
          <div style={{ ...hintStyle, color: probe.ok ? "#3c7d5c" : "#c04a4a", whiteSpace: "pre-wrap" }}>
            {probe.msg}
            {probe.secs != null && ` · ${probe.secs.toFixed(1)}초`}
            {probe.results?.map((r) => (
              <div key={r.url} style={{ color: "#4e4a43" }}>
                · {r.title} <span style={{ color: "#a09a8f" }}>{r.url}</span>
              </div>
            ))}
          </div>
        )}
        <div
          style={{
            ...hintStyle,
            color: "#a09a8f",
            paddingTop: 6,
            borderTop: "1px dashed #eae6de",
          }}
        >
          검색어는 고른 검색 엔진으로 나갑니다. AI 에게는 사내 시스템 이름 · 업무 고유 정보를 검색어에
          넣지 말라고 지시하고, 검색한 말은 답 위에 그대로 보여 줍니다.
        </div>
      </div>
    </div>
  );
}
