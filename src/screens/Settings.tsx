import { useEffect, useState } from "react";
import { AiSignal, AiStep, Box, Input } from "../lib/ui";
import { AI, AI_SIGNAL_KINDS, TEXT, VIOLET } from "../lib/design";
import { OptionCard } from "../modals/Modal";
import { useStore, type Settings as S } from "../store/useStore";
import * as api from "../lib/api";
import AiConnectionsCard from "./settings/AiConnectionsCard";
import AiRoutesCard from "./settings/AiRoutesCard";
import IwmsTab from "./settings/IwmsTab";
import PromptPacksCard from "./settings/PromptPacksCard";
import WebSearchCard from "./settings/WebSearchCard";
import WikiCard from "./settings/WikiCard";
import { Chip, Toggle, cardStyle, headStyle, inputFocus, inputMono, rowStyle } from "./settings/shared";

const TOGGLES: [keyof S, string, string][] = [
  [
    "archMoc",
    "Archive MOC 노트 자동 갱신",
    "보관 목록을 _index/Archive.md 에 표로 유지해 Obsidian에서도 한눈에 조회",
  ],
  [
    "catHubs",
    "카테고리 허브 노트 자동 갱신",
    "카테고리마다 _index/카테고리/ 에 업무 · 위키 목록 노트를 만들어 Obsidian 에서 카테고리별로 봅니다",
  ],
  [
    "autoSnap",
    "컨텍스트 스냅샷 자동 저장",
    "업무 전환·보류 시 열린 탭/미저장 텍스트/메모를 .context_snapshot.json에 기록",
  ],
  ["restoreView", "뷰 레이아웃 복원", "업무별 분할 패널 구성과 열어둔 파일을 그대로 되살림"],
  // "위키링크 실시간 색인"(wikiIndex)은 설계 목업에서 온 토글인데 읽는 곳이 없었다. 새
  // "LLM 위키" 와 이름이 겹쳐 혼동만 낳으므로 화면에서 뺀다(키는 settings.json 에 남는다).
];

/**
 * Vault 가 Obsidian 에 등록돼 있는지 보여 준다.
 *
 * [Obsidian에서 열기] 는 등록된 vault 안의 노트만 열 수 있다. 등록돼 있지 않으면 예전에는
 * Obsidian 이 "Vault not found" 대화상자를 띄웠고, 그 이유가 어디에도 드러나지 않았다.
 * 특히 Vault 루트가 아니라 그 하위 폴더만 vault 로 등록한 경우(업무 노트는 열리는데
 * `_index/Archive.md` 만 안 열린다)가 여기서 드러난다.
 */
function ObsidianRegistration({ vault }: { vault: string }) {
  const [st, setSt] = useState<api.VaultStatus | null>(null);

  useEffect(() => {
    let alive = true;
    setSt(null);
    if (!vault) return;
    void api
      .obsidianVaultStatus(vault)
      .then((r) => alive && setSt(r))
      .catch(() => alive && setSt(null));
    return () => {
      alive = false;
    };
  }, [vault]);

  if (!st) return null;

  // 목록을 못 읽었을 때는 "등록 안 됨" 이 아니라 "알 수 없음" 이다 — 포터블 설치이거나
  // Obsidian 을 아직 한 번도 실행하지 않았을 수 있고, 그 경우에도 열기는 잘 된다.
  const [text, color] = !st.registryFound
    ? ["Obsidian vault 목록을 찾지 못했습니다 · 열기는 절대 경로로 시도합니다", "#a09a8f"]
    : st.registered
      ? [`Obsidian에 등록됨 · vault "${st.vaultName}"`, "#2f7f57"]
      : [
          "Obsidian에 등록되지 않았습니다 · Obsidian에서 [폴더를 vault로 열기]로 이 경로를 한 번 등록하세요" +
            (st.known.length ? ` · Obsidian이 아는 vault: ${st.known.join(", ")}` : ""),
          "#b07520",
        ];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        marginTop: 8,
        fontSize: 11.5,
        lineHeight: 1.6,
        color,
      }}
    >
      <span style={{ flex: "0 0 auto" }}>●</span>
      <span style={{ minWidth: 0 }}>{text}</span>
    </div>
  );
}

export default function Settings() {
  const s = useStore();
  const { settings } = s;
  const [vaultDraft, setVaultDraft] = useState(settings.vault);
  /**
   * 끄는 동안의 임계값(`null` = 끄고 있지 않음). 설정 저장은 디스크에 다 쓰기(fsync)까지 기다리는
   * 원자적 쓰기라 눈금마다 쓰지 않고 손을 뗄 때 한 번 쓴다. 키보드로 옮긴 값은 키를 뗄 때 쓴다.
   */
  const [thrDraft, setThrDraft] = useState<number | null>(null);
  const threshold = thrDraft ?? settings.threshold;
  /** 탭. 숨긴 탭도 마운트를 유지해 고치던 초안이 탭을 오가도 남는다. */
  const [tab, setTab] = useState<"general" | "iwms">("general");
  const commitThreshold = () => {
    if (thrDraft === null) return;
    if (thrDraft !== settings.threshold) s.patchSettings({ threshold: thrDraft });
    setThrDraft(null);
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 22px", background: "#fdfcfa" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-.2px" }}>설정</div>
        <div role="tablist" style={{ display: "flex", gap: 4 }}>
          <Chip on={tab === "general"} label="일반" onClick={() => setTab("general")} />
          <Chip on={tab === "iwms"} label="i-WMS" onClick={() => setTab("iwms")} />
        </div>
      </div>
      <div style={{ maxWidth: 680, marginTop: tab === "iwms" ? 14 : 0 }}>
        <IwmsTab hidden={tab !== "iwms"} />
      </div>
      <div
        style={{
          maxWidth: 680,
          marginTop: 14,
          display: tab === "general" ? "flex" : "none",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Vault -------------------------------------------------------- */}
        <div style={cardStyle}>
          <div style={headStyle}>저장소 (Obsidian Vault)</div>
          <div style={{ padding: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 5 }}>Vault Root 경로</div>
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
                  fontSize: 12.5,
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
                fontFamily: "'Roboto Mono',monospace",
                fontSize: 11,
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
            <ObsidianRegistration vault={settings.vault} />
          </div>
        </div>

        {/* Open defaults ------------------------------------------------ */}
        <div style={cardStyle}>
          <div style={headStyle}>파일 열기 기본값</div>
          <div style={{ ...rowStyle, borderBottom: "none" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>.md 파일 더블클릭</div>
              <div style={{ fontSize: 11.5, color: "#8a857c", marginTop: 2 }}>
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

        {/* AI 작업 표시 -------------------------------------------------- */}
        <div style={cardStyle}>
          <div style={headStyle}>AI 작업 표시</div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>신호 점 모양</div>
              <div style={{ fontSize: 11.5, color: TEXT.sub, marginTop: 2, lineHeight: 1.5 }}>
                AI 가 일하는 동안 단추 · 단계 · 도크에 뜨는 보라 점. 움직이는 보라는 늘 "AI 가 지금 일한다"는 뜻입니다.
              </div>
            </div>
            <div role="radiogroup" style={{ display: "flex", gap: 6 }}>
              {AI_SIGNAL_KINDS.map(([k, name]) => {
                const on = settings.aiSignal === k;
                return (
                  <Box
                    key={k}
                    role="radio"
                    aria-checked={on}
                    onClick={() => s.patchSettings({ aiSignal: k })}
                    style={{
                      width: 74,
                      height: 58,
                      borderRadius: 7,
                      border: `1px solid ${on ? "#bda9f0" : "#e6e2da"}`,
                      background: on ? "#faf7ff" : "#fff",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 8,
                      cursor: "pointer",
                    }}
                    hover={{ borderColor: on ? "#bda9f0" : "#d6d0c6" }}
                  >
                    <span style={{ height: 18, display: "flex", alignItems: "center" }}>
                      <AiSignal size={9} kind={k} />
                    </span>
                    <span style={{ fontSize: 11.5, color: on ? AI.fg : TEXT.body, fontWeight: on ? 600 : 400 }}>
                      {name}
                    </span>
                  </Box>
                );
              })}
            </div>
          </div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>움직임 줄이기</div>
              <div style={{ fontSize: 11.5, color: TEXT.sub, marginTop: 2, lineHeight: 1.5 }}>
                줄이면 흐르는 빛 · 링 · 진행 띠가 모두 느린 깜빡임 하나로 바뀝니다. 신호는 남아서 멈춘 것과 구분됩니다.
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <Chip
                on={settings.motion === "system"}
                label="시스템 설정 따르기"
                onClick={() => s.patchSettings({ motion: "system" })}
              />
              <Chip
                on={settings.motion === "reduce"}
                label="항상 줄이기"
                onClick={() => s.patchSettings({ motion: "reduce" })}
              />
            </div>
          </div>
          {/* 미리보기 — 고른 모양 · 움직임이 실제 화면에서 어떻게 보이는지. */}
          <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 9, background: "#faf9f6" }}>
            <span style={{ fontSize: 11.5, color: TEXT.sub, flex: "0 0 auto" }}>미리보기</span>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12.5,
                fontWeight: 500,
                padding: "5px 9px",
                borderRadius: 6,
                background: AI.soft,
                border: `1px solid ${AI.softBd}`,
              }}
            >
              <span style={{ width: 16, display: "flex", justifyContent: "center" }}>
                <AiSignal />
              </span>
              <AiStep>웹 페이지 읽는 중 2/3 · v2.tauri.app</AiStep>
            </span>
          </div>
        </div>

        {/* Archive ------------------------------------------------------ */}
        <div style={cardStyle}>
          <div style={headStyle}>완료 업무 보관</div>
          <div style={rowStyle}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>자동 보관 기간</div>
              {/*
                앱에서 [완료]를 누르면 이 기간과 무관하게 그 즉시 보관된다(`setStatus`).
                이 값이 다스리는 것은 **앱 밖에서** 완료로 바뀐 업무뿐이다 — Obsidian 에서
                frontmatter 를 직접 고친 경우가 그렇고, 그때는 `archived` 키가 없어서
                `isArchived` 가 이 기간으로 판단한다. 설정이 무엇을 정하는지 그대로 적는다.
              */}
              <div style={{ fontSize: 11.5, color: "#8a857c", marginTop: 2, lineHeight: 1.5 }}>
                Obsidian 등 앱 밖에서 완료로 바꾼 업무는 이 기간이 지나면 업무 리스트에서
                접힙니다. 앱에서 [완료]를 누르면 기다리지 않고 그 즉시 보관됩니다.
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {([7, 14, 30, 90, 0] as const).map((v) => (
                <Chip
                  key={v}
                  on={settings.archDays === v}
                  label={v === 0 ? "끄기" : `${v}일`}
                  onClick={() => s.patchSettings({ archDays: v })}
                />
              ))}
            </div>
          </div>
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>Vault에서의 처리 방식</div>
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
                fontSize: 11.5,
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

        {/* AI 연결 ------------------------------------------------------- */}
        <div style={{ fontSize: 13, fontWeight: 600, color: "#6a665e", marginTop: 4 }}>
          AI 연결
          <span style={{ fontSize: 11.5, fontWeight: 400, color: "#a09a8f", marginLeft: 8 }}>
            세 가지 중 원하는 것만 설정하면 됩니다. 하나도 없어도 로컬 유사도로 추천합니다.
          </span>
        </div>
        <AiConnectionsCard />
        <AiRoutesCard />
        <WikiCard />
        <WebSearchCard />
        <PromptPacksCard />

        {/* 추천 임계값 --------------------------------------------------- */}
        <div style={cardStyle}>
          <div style={headStyle}>유사 업무 추천</div>
          <div style={{ padding: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500 }}>클러스터링 유사도 임계값</span>
              <span
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: VIOLET,
                }}
              >
                {threshold}%
              </span>
              <span style={{ fontSize: 11.5, color: "#a09a8f" }}>
                새 업무 추가 시 추천 클러스터를 접는 기준
              </span>
            </div>
            <input
              type="range"
              min={70}
              max={95}
              step={1}
              value={threshold}
              onChange={(e) => setThrDraft(parseInt(e.target.value, 10))}
              onPointerUp={commitThreshold}
              onKeyUp={commitThreshold}
              onBlur={commitThreshold}
              style={{ width: "100%", accentColor: VIOLET }}
            />
            <div
              style={{
                fontSize: 11.5,
                color: "#a09a8f",
                lineHeight: 1.7,
                marginTop: 7,
                paddingTop: 6,
                borderTop: "1px dashed #eae6de",
              }}
            >
              AI 연결을 골랐으면 이 값이 프롬프트에 실려 "거의 같은 업무" 의 기준이 되고, 로컬
              유사도에서는 클러스터를 접는 임계값으로 쓰입니다.
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
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{label}</div>
                <div style={{ fontSize: 11.5, color: "#8a857c", marginTop: 2 }}>{desc}</div>
              </div>
              <Toggle
                on={!!settings[k]}
                onClick={() => s.patchSettings({ [k]: !settings[k] } as Partial<S>)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
