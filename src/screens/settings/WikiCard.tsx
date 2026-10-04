import { useStore, reportObsidianOpen } from "../../store/useStore";
import { routeInfo, useAi } from "../../store/aiStore";
import * as api from "../../lib/api";
import { joinPath } from "../../lib/format";
import { Btn, Chip, Toggle, cardStyle, headStyle, hintStyle, rowStyle } from "./shared";

/**
 * LLM 위키 설정 — 언제 · 얼마나 반영할지.
 *
 * 연결(어느 AI 로 반영하나)은 여기가 아니라 "기능별 AI 연결" 카드가 정한다. 이 카드는 그
 * 결과를 한 줄로 보여 주기만 한다 — 같은 선택을 두 곳에서 고칠 수 있으면 어느 쪽이 이기는지
 * 알 수 없다.
 */
export default function WikiCard() {
  const s = useStore();
  const ai = useAi();
  const { settings } = s;
  const info = routeInfo(ai, "wiki.ingest");

  const route = info.run
    ? `${info.name} · ${info.modelLabel}${info.via === "default" ? " (기본 연결)" : ""}`
    : info.via === "route"
      ? `지정한 연결(${info.name})을 지금 쓸 수 없습니다 — 반영하지 않습니다`
      : "반영에 쓸 연결이 없습니다 — 위 \"기능별 AI 연결\" 에서 고르세요";

  const open = (rel: string) =>
    void api
      .openInObsidian(settings.vault, joinPath(settings.vault, rel))
      .then(reportObsidianOpen)
      .catch((e) => s.fail(e, "Obsidian 에서 열지 못했습니다"));

  return (
    <div style={cardStyle}>
      <div style={headStyle}>LLM 위키</div>
      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>완료한 업무를 위키에 자동 반영</div>
          <div style={{ ...hintStyle, marginTop: 2 }}>
            [완료] 를 누르면 그 업무 폴더의 텍스트 파일을 아래 연결로 보내 Vault 의 Wiki/ 에
            페이지를 씁니다. 업무 폴더 자체는 바꾸지 않습니다. 완료 없이 보관한 업무는 위키
            화면의 "반영 대기" 에 남습니다.
          </div>
        </div>
        <Toggle
          on={settings.wikiAuto}
          onClick={() => s.patchSettings({ wikiAuto: !settings.wikiAuto })}
        />
      </div>
      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>반영 깊이</div>
          <div style={{ ...hintStyle, marginTop: 2 }}>
            소스 페이지만 쓰면 AI 호출이 한 번이고, 관련 페이지까지 고치면 한 번 더 부릅니다.
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <Chip
            on={settings.wikiDepth === "light"}
            label="소스 페이지만"
            onClick={() => s.patchSettings({ wikiDepth: "light" })}
          />
          <Chip
            on={settings.wikiDepth === "full"}
            label="관련 페이지까지"
            onClick={() => s.patchSettings({ wikiDepth: "full" })}
          />
        </div>
      </div>
      {settings.wikiDepth === "full" && (
        <div style={rowStyle}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>업무 하나가 고칠 수 있는 페이지 수</div>
            <div style={{ ...hintStyle, marginTop: 2 }}>
              절차 · 주제 · 시스템 페이지를 한 번의 응답으로 씁니다. 많을수록 출력이 길어져
              잘리기 쉽습니다.
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[1, 2, 3, 5].map((n) => (
              <Chip
                key={n}
                on={settings.wikiMaxPages === n}
                label={`${n}장`}
                onClick={() => s.patchSettings({ wikiMaxPages: n })}
              />
            ))}
          </div>
        </div>
      )}
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ ...hintStyle, color: info.run ? "#3c7d5c" : "#a06a3b" }}>반영 연결: {route}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Btn label="위키 열기" onClick={() => s.setScreen("wiki")} />
          <Btn label="SCHEMA.md (규약) 열기" onClick={() => open("Wiki/SCHEMA.md")} />
          <Btn
            label="폴더 열기"
            onClick={() => void api.revealPath(joinPath(settings.vault, "Wiki")).catch(() => {})}
          />
        </div>
        <div
          style={{
            ...hintStyle,
            color: "#6a665e",
            paddingTop: 6,
            borderTop: "1px dashed #eae6de",
          }}
        >
          SCHEMA.md 는 처음 한 번만 만들어지고 그 뒤로는 사용자의 파일입니다 — 위키를 어떻게 쓸지
          (페이지 유형 · 문체 · 빼야 할 내용)를 고쳐 적으면 다음 반영부터 그대로 따릅니다.
        </div>
      </div>
    </div>
  );
}
