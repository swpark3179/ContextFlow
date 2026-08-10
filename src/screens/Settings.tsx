import { useState } from "react";
import { Box, Input } from "../lib/ui";
import { GREEN, VIOLET } from "../lib/design";
import { OptionCard } from "../modals/Modal";
import { useStore, type Settings as S } from "../store/useStore";
import * as api from "../lib/api";

const cardStyle: React.CSSProperties = {
  border: "1px solid #e6e2da",
  borderRadius: 7,
  background: "#fff",
  overflow: "hidden",
};

const headStyle: React.CSSProperties = {
  padding: "8px 12px",
  background: "#f7f5f1",
  borderBottom: "1px solid #e6e2da",
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: ".4px",
  color: "#6a665e",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  borderBottom: "1px solid #f4f1ec",
};

const inputMono: React.CSSProperties = {
  height: 28,
  border: "1px solid #ddd8cf",
  borderRadius: 5,
  padding: "0 9px",
  fontFamily: "'IBM Plex Mono',monospace",
  fontSize: 11,
  outline: "none",
  background: "#fff",
  color: "#23211e",
};

const inputFocus = { borderColor: "#3a6fd8", boxShadow: "0 0 0 2px #e6eefc" };

function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        height: 24,
        padding: "0 10px",
        display: "flex",
        alignItems: "center",
        borderRadius: 4,
        fontSize: 10.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
        border: `1px solid ${on ? "#cddcf8" : "#ddd8cf"}`,
        background: on ? "#eef3fd" : "#fff",
        color: on ? "#2f5cbb" : "#6a665e",
        fontWeight: on ? 600 : 400,
      }}
    >
      {label}
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: "0 0 34px",
        width: 34,
        height: 19,
        borderRadius: 11,
        padding: 2,
        cursor: "pointer",
        background: on ? VIOLET : "#d5d0c6",
        display: "flex",
        justifyContent: on ? "flex-end" : "flex-start",
        transition: "background .15s",
      }}
    >
      <div
        style={{
          width: 15,
          height: 15,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 2px rgba(0,0,0,.2)",
        }}
      />
    </div>
  );
}

const TOGGLES: [keyof S, string, string][] = [
  [
    "archMoc",
    "Archive MOC 노트 자동 갱신",
    "보관 목록을 _index/Archive.md 에 표로 유지해 Obsidian에서도 한눈에 조회",
  ],
  [
    "autoSnap",
    "컨텍스트 스냅샷 자동 저장",
    "업무 전환·보류 시 열린 탭/미저장 텍스트/메모를 .context_snapshot.json에 기록",
  ],
  ["restoreView", "뷰 레이아웃 복원", "업무별 분할 패널 구성과 열어둔 파일을 그대로 되살림"],
  ["wikiIndex", "위키링크 실시간 색인", "[[링크]] 변경 시 Vault 그래프를 즉시 갱신"],
];

export default function Settings() {
  const s = useStore();
  const { settings } = s;
  const [vaultDraft, setVaultDraft] = useState(settings.vault);
  const [probe, setProbe] = useState<{ ok: boolean; msg: string } | null>(null);

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 22px", background: "#fdfcfa" }}>
      <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-.2px" }}>설정</div>
      <div
        style={{ maxWidth: 680, marginTop: 14, display: "flex", flexDirection: "column", gap: 16 }}
      >
        {/* Vault -------------------------------------------------------- */}
        <div style={cardStyle}>
          <div style={headStyle}>저장소 (Obsidian Vault)</div>
          <div style={{ padding: 12 }}>
            <div style={{ fontSize: 11.5, fontWeight: 500, marginBottom: 5 }}>Vault Root 경로</div>
            <div style={{ display: "flex", gap: 6 }}>
              <Input
                value={vaultDraft}
                onChange={(e) => setVaultDraft(e.target.value)}
                onBlur={() => {
                  const v = vaultDraft.trim().replace(/\\/g, "/");
                  if (v && v !== settings.vault) {
                    s.patchSettings({ vault: v });
                    void (async () => {
                      try {
                        await api.initVault(v, false);
                        await s.reloadVault(false);
                        await s.reloadTemplates();
                        s.toast("Vault를 변경했습니다", v, "#5fbf8d");
                      } catch (e) {
                        s.fail(e, "Vault를 열지 못했습니다");
                      }
                    })();
                  }
                }}
                style={{ ...inputMono, flex: 1 }}
                focusStyle={inputFocus}
              />
              <Box
                onClick={() => void s.chooseVault().then(() => setVaultDraft(useStore.getState().settings.vault))}
                style={{
                  height: 28,
                  padding: "0 12px",
                  display: "flex",
                  alignItems: "center",
                  border: "1px solid #ddd8cf",
                  borderRadius: 5,
                  background: "#f7f5f1",
                  fontSize: 11.5,
                  color: "#4e4a43",
                  cursor: "pointer",
                }}
                hover={{ background: "#ece8e0" }}
              >
                찾아보기
              </Box>
            </div>
            <div
              style={{
                fontFamily: "'IBM Plex Mono',monospace",
                fontSize: 10,
                color: "#a09a8f",
                marginTop: 7,
                lineHeight: 1.7,
                wordBreak: "break-all",
              }}
            >
              {settings.vault}/Tasks/[YYYY-MM] 업무명/index.md
              <br />
              {settings.vault}/Templates/
            </div>
          </div>
        </div>

        {/* Open defaults ------------------------------------------------ */}
        <div style={cardStyle}>
          <div style={headStyle}>파일 열기 기본값</div>
          <div style={{ ...rowStyle, borderBottom: "none" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11.5, fontWeight: 500 }}>.md 파일 더블클릭</div>
              <div style={{ fontSize: 10.5, color: "#8a857c", marginTop: 2 }}>
                탐색기에서 마크다운 파일을 더블클릭했을 때의 기본 동작
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <Chip
                on={settings.mdDefault === "markdown"}
                label="마크다운 뷰어"
                onClick={() => s.patchSettings({ mdDefault: "markdown" })}
              />
              <Chip
                on={settings.mdDefault === "text"}
                label="텍스트 에디터"
                onClick={() => s.patchSettings({ mdDefault: "text" })}
              />
            </div>
          </div>
        </div>

        {/* Archive ------------------------------------------------------ */}
        <div style={cardStyle}>
          <div style={headStyle}>완료 업무 보관</div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11.5, fontWeight: 500 }}>자동 보관 기간</div>
              <div style={{ fontSize: 10.5, color: "#8a857c", marginTop: 2 }}>
                완료 후 이 기간이 지나면 업무 리스트에서 접힙니다
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {([7, 14, 30, 90, 0] as const).map((v) => (
                <Chip
                  key={v}
                  on={settings.archDays === v}
                  label={v === 0 ? "끄기" : `${v}일`}
                  onClick={() => {
                    s.patchSettings({ archDays: v });
                    void s.syncMoc();
                  }}
                />
              ))}
            </div>
          </div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11.5, fontWeight: 500 }}>Vault에서의 처리 방식</div>
            <OptionCard
              on={settings.archMode === "tag"}
              label="frontmatter 태그"
              desc="파일을 옮기지 않고 archived: true 만 기록합니다. 위키링크·그래프·심볼릭 링크가 모두 살아 있고, Obsidian 검색에도 그대로 잡힙니다."
              onClick={() => s.patchSettings({ archMode: "tag" })}
            />
            <OptionCard
              on={settings.archMode === "move"}
              label="Archive 폴더로 이동"
              desc="Tasks/ → Archive/[연도]/ 로 실제 이동합니다. Vault 트리는 깔끔해지지만 외부 심볼릭 링크는 다시 걸어야 합니다."
              onClick={() => s.patchSettings({ archMode: "move" })}
            />
            <div
              style={{
                fontSize: 10.5,
                color: "#a09a8f",
                lineHeight: 1.7,
                paddingTop: 6,
                borderTop: "1px dashed #eae6de",
              }}
            >
              보관은 삭제가 아닙니다. 좌측 검색창에 입력하면 보관된 업무도 함께 검색되고, 보관함
              화면에서 본문 전문 검색과 재개가 가능합니다.
            </div>
          </div>
        </div>

        {/* LLM ---------------------------------------------------------- */}
        <div style={cardStyle}>
          <div style={headStyle}>사내 LLM API</div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 500, marginBottom: 5 }}>Endpoint</div>
              <Input
                value={settings.api}
                onChange={(e) => s.patchSettings({ api: e.target.value })}
                placeholder="https://llm.internal.corp/v1 (비워두면 로컬 유사도 사용)"
                style={{ ...inputMono, width: "100%" }}
                focusStyle={inputFocus}
              />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <Input
                  value={settings.model}
                  onChange={(e) => s.patchSettings({ model: e.target.value })}
                  placeholder="임베딩 모델"
                  style={{ ...inputMono, flex: 1 }}
                  focusStyle={inputFocus}
                />
                <Input
                  type="password"
                  value={settings.apiKey}
                  onChange={(e) => s.patchSettings({ apiKey: e.target.value })}
                  placeholder="API Key (선택)"
                  style={{ ...inputMono, flex: 1 }}
                  focusStyle={inputFocus}
                />
                <Box
                  onClick={() => {
                    void (async () => {
                      if (!settings.api.trim()) {
                        setProbe({ ok: false, msg: "Endpoint가 비어 있습니다" });
                        return;
                      }
                      const res = await api.recommendTasks(
                        "연결 확인",
                        [
                          {
                            id: "probe",
                            title: "연결 확인",
                            tags: [],
                            path: "",
                            date: "",
                            text: "연결 확인",
                          },
                        ],
                        settings.threshold,
                        {
                          endpoint: settings.api,
                          model: settings.model,
                          apiKey: settings.apiKey,
                        },
                      );
                      setProbe({
                        ok: res.engine === "llm",
                        msg: res.note || (res.engine === "llm" ? "연결됨" : "로컬로 대체됨"),
                      });
                    })().catch((e) => setProbe({ ok: false, msg: api.errMessage(e) }));
                  }}
                  style={{
                    height: 28,
                    padding: "0 12px",
                    display: "flex",
                    alignItems: "center",
                    border: "1px solid #ddd8cf",
                    borderRadius: 5,
                    background: "#f7f5f1",
                    fontSize: 11.5,
                    color: "#4e4a43",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                  hover={{ background: "#ece8e0" }}
                >
                  연결 확인
                </Box>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: probe ? (probe.ok ? GREEN : "#c04a4a") : "#b5afa2",
                    flex: "0 0 6px",
                  }}
                />
                <span style={{ fontSize: 10.5, color: "#8a857c", lineHeight: 1.5 }}>
                  {probe
                    ? probe.msg
                    : settings.api.trim()
                      ? "미확인 · [연결 확인]을 눌러 사내 LLM 응답을 검사하세요"
                      : "Endpoint 미설정 · 로컬 유사도(외부 통신 없음)로 추천합니다"}
                </span>
              </div>
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 11.5, fontWeight: 500 }}>클러스터링 유사도 임계값</span>
                <span
                  style={{
                    fontFamily: "'IBM Plex Mono',monospace",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: VIOLET,
                  }}
                >
                  {settings.threshold}%
                </span>
                <span style={{ fontSize: 10.5, color: "#a09a8f" }}>
                  새 업무 추가 시 추천 클러스터를 접는 기준
                </span>
              </div>
              <input
                type="range"
                min={70}
                max={95}
                step={1}
                value={settings.threshold}
                onChange={(e) => s.patchSettings({ threshold: parseInt(e.target.value, 10) })}
                style={{ width: "100%", accentColor: VIOLET }}
              />
            </div>
          </div>
        </div>

        {/* Context preservation ----------------------------------------- */}
        <div style={cardStyle}>
          <div style={headStyle}>컨텍스트 보존</div>
          {TOGGLES.map(([k, label, desc], i) => (
            <div
              key={k}
              style={{ ...rowStyle, borderBottom: i === TOGGLES.length - 1 ? "none" : rowStyle.borderBottom }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11.5, fontWeight: 500 }}>{label}</div>
                <div style={{ fontSize: 10.5, color: "#8a857c", marginTop: 2 }}>{desc}</div>
              </div>
              <Toggle
                on={!!settings[k]}
                onClick={() => {
                  s.patchSettings({ [k]: !settings[k] } as Partial<S>);
                  if (k === "archMoc" && !settings.archMoc) void s.syncMoc();
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
