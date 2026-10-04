import { useEffect, useState } from "react";
import { Box, Input, TextArea } from "../../lib/ui";
import * as api from "../../lib/api";
import { today } from "../../lib/format";
import { patchDesignated } from "../../lib/iwms/categories";
import type { Material } from "../../lib/iwms/material";
import type { Draft } from "../../lib/iwms/parse";
import { refine } from "../../lib/iwms/refine";
import { PRICE_LABEL, categoryKey, type Designated, type Price } from "../../lib/iwms/types";
import { injectionFor } from "../../lib/promptPacks";
import { routeInfo, routeRun, useAi } from "../../store/aiStore";
import { useIwms } from "../../store/iwmsStore";
import { useStore } from "../../store/useStore";
import { Btn, Chip, Toggle, cardStyle, headStyle, hintStyle, inputFocus, inputMono, rowStyle } from "./shared";

const STEPS = [5, 10, 15, 30];

const textArea = {
  ...inputMono,
  fontFamily: "inherit",
  height: "auto",
  width: "100%",
  boxSizing: "border-box",
  padding: "6px 9px",
  lineHeight: 1.6,
  resize: "vertical",
} as const;

/**
 * 상세내용 정제 템플릿 — AI 가 따를 공통 작성 규칙과 카테고리별 샘플 문구, 분 배분 규칙.
 *
 * 샘플은 "이 카테고리의 상세내용은 이런 모양이다" 라는 참고다. i-WMS 에 등록된 상세내용 템플릿을 그대로
 * 가져올 수도 있다. [샘플로 시험] 은 제목 하나로 정제를 돌려 규칙이 어떻게 먹히는지 본다(i-WMS 에 쓰지 않는다).
 */
export default function IwmsTemplatesCard() {
  const iw = useIwms();
  const settings = iw.settings;
  const [style, setStyle] = useState(settings?.styleGuide ?? "");
  const [open, setOpen] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => setStyle(settings?.styleGuide ?? ""), [settings?.styleGuide]);

  if (!settings) return null;
  const designated = settings.categories;

  const save = async (patch: Partial<typeof settings>) => {
    try {
      await iw.saveSettings({ ...settings, ...patch });
    } catch (e) {
      useStore.getState().fail(e, "i-WMS 설정을 저장하지 못했습니다");
    }
  };

  /** 오늘의 i-WMS 화면에 등록된 상세내용 템플릿을 지정한 카테고리의 샘플로 가져온다(같은 글은 건너뛴다). */
  const importTemplates = async () => {
    setImporting(true);
    try {
      const day = await iw.day(today());
      let added = 0;
      const next = designated.map((d) => {
        const c = day.categories.find((x) => categoryKey(x) === categoryKey(d));
        const fresh = (c?.templates ?? []).map((t) => t.content.trim()).filter((t) => t && !d.samples.includes(t));
        added += fresh.length;
        return fresh.length ? { ...d, samples: [...d.samples, ...fresh] } : d;
      });
      if (added) await save({ categories: next });
      useStore.getState().toast(added ? `i-WMS 템플릿 ${added}개를 샘플로 가져왔습니다` : "가져올 새 템플릿이 없습니다");
    } catch (e) {
      useStore.getState().fail(e, "i-WMS 템플릿을 가져오지 못했습니다");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={headStyle}>상세내용 정제 템플릿</div>

      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>남은 시간을 모두 배분</div>
          <div style={{ ...hintStyle, marginTop: 2 }}>
            기준시간에서 그날 이미 입력된 분을 뺀 나머지를 고른 업무들에 나눠 채웁니다. 끄면 업무마다 걸렸을 법한 분만
            제안합니다.
          </div>
        </div>
        <Toggle on={settings.fillToStandard} onClick={() => void save({ fillToStandard: !settings.fillToStandard })} />
      </div>
      <div style={rowStyle}>
        <div style={{ flex: 1, fontSize: 12.5, fontWeight: 500 }}>분 단위</div>
        <div style={{ display: "flex", gap: 4 }}>
          {STEPS.map((v) => (
            <Chip key={v} on={settings.minuteStep === v} label={`${v}분`} onClick={() => void save({ minuteStep: v })} />
          ))}
        </div>
      </div>

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 5 }}>공통 작성 규칙</div>
          <TextArea
            rows={5}
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            onBlur={() => style !== settings.styleGuide && void save({ styleGuide: style })}
            style={textArea}
            focusStyle={inputFocus}
          />
          <div style={{ ...hintStyle, marginTop: 4 }}>비우면 기본 규칙으로 돌아갑니다.</div>
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500 }}>카테고리별 샘플</span>
            <div style={{ flex: 1 }} />
            <Btn
              label="i-WMS 템플릿 가져오기"
              busy={importing}
              busyLabel="가져오는 중"
              disabled={!designated.length}
              onClick={() => void importTemplates()}
            />
          </div>
          {!designated.length && <div style={hintStyle}>위 카드에서 카테고리를 먼저 지정하세요.</div>}
          {designated.map((d) => (
            <SampleRow
              key={categoryKey(d)}
              d={d}
              open={open === categoryKey(d)}
              onToggle={() => setOpen(open === categoryKey(d) ? null : categoryKey(d))}
              onSave={(samples) => void save({ categories: patchDesignated(designated, categoryKey(d), { samples }) })}
            />
          ))}
        </div>

        <TryOut />
      </div>
    </div>
  );
}

function SampleRow({
  d,
  open,
  onToggle,
  onSave,
}: {
  d: Designated;
  open: boolean;
  onToggle: () => void;
  onSave: (samples: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[]>(d.samples);
  useEffect(() => setDraft(d.samples), [d.samples]);
  const commit = (next: string[]) => {
    const clean = next.map((x) => x.trim()).filter(Boolean);
    if (clean.join("\u0000") !== d.samples.join("\u0000")) onSave(clean);
  };
  return (
    <div style={{ borderBottom: "1px solid #f4f1ec" }}>
      <Box
        onClick={onToggle}
        style={{ display: "flex", alignItems: "center", gap: 7, minHeight: 26, fontSize: 12, cursor: "pointer" }}
        hover={{ background: "#faf9f6" }}
      >
        <span style={{ fontSize: 10.5, color: d.priceType === "O" ? "#2f5cbb" : "#6a54c6", whiteSpace: "nowrap" }}>
          {PRICE_LABEL[d.priceType as Price] ?? d.priceType}
        </span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.ciName} › {d.task}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ ...hintStyle, fontSize: 10.5 }}>샘플 {d.samples.length}</span>
        <span style={{ fontSize: 9, color: "#a09a8f" }}>{open ? "▲" : "▼"}</span>
      </Box>
      {open && (
        <div style={{ padding: "4px 0 10px 0", display: "flex", flexDirection: "column", gap: 5 }}>
          {draft.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 5, alignItems: "flex-start" }}>
              <TextArea
                rows={2}
                value={s}
                onChange={(e) => setDraft(draft.map((x, j) => (j === i ? e.target.value : x)))}
                onBlur={() => commit(draft)}
                style={textArea}
                focusStyle={inputFocus}
              />
              <Box
                onClick={() => {
                  const next = draft.filter((_, j) => j !== i);
                  setDraft(next);
                  commit(next);
                }}
                title="이 샘플을 지웁니다"
                style={{ color: "#a09a8f", cursor: "pointer", padding: "4px" }}
                hover={{ color: "#4e4a43" }}
              >
                ✕
              </Box>
            </div>
          ))}
          <Box
            onClick={() => setDraft([...draft, ""])}
            style={{ fontSize: 11.5, color: "#3a6fd8", cursor: "pointer", alignSelf: "flex-start" }}
            hover={{ textDecoration: "underline" }}
          >
            ＋ 샘플
          </Box>
        </div>
      )}
    </div>
  );
}

/** 제목 하나로 정제를 돌려 본다 — i-WMS 에는 쓰지 않는다. */
function TryOut() {
  const settings = useIwms((s) => s.settings);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [price, setPrice] = useState<Price>("O");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ draft: Draft | null; error: string | null } | null>(null);
  if (!settings) return null;

  const ai = routeInfo(useAi.getState(), "iwms.refine");

  const run = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const day = await useIwms.getState().day(today());
      const item: Material = {
        entryId: 1,
        title: title.trim(),
        body: body.trim(),
        price,
        taskCategory: null,
        tags: [],
        overview: "",
        runLog: [],
        fixed: null,
      };
      const st = useAi.getState();
      const res = await refine({
        run: routeRun(st, "iwms.refine"),
        day,
        items: [item],
        settings,
        examples: [],
        inject: injectionFor("iwms.refine", st.packs, st.settings),
      });
      setResult({ draft: res.drafts[0] ?? null, error: res.error });
    } catch (e) {
      setResult({ draft: null, error: api.errMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ paddingTop: 8, borderTop: "1px dashed #eae6de", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500 }}>샘플로 시험</span>
        <span style={{ ...hintStyle, fontSize: 11 }}>
          {ai.run ? `${ai.name} · ${ai.modelLabel ?? "기본 모델"}` : "AI 연결 없음 — 설정 → AI 연결"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <Input
          value={title}
          placeholder="업무 제목 — 예: S-PCS-Plus Standalone 서버 기동"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void run()}
          style={{ ...inputMono, fontFamily: "inherit", flex: 1 }}
          focusStyle={inputFocus}
        />
        <Chip on={price === "O"} label="대가포함" onClick={() => setPrice("O")} />
        <Chip on={price === "N"} label="대가미포함" onClick={() => setPrice("N")} />
        <Btn label="시험" busy={busy} busyLabel="정제 중" ai disabled={!title.trim()} onClick={() => void run()} />
      </div>
      <Input
        value={body}
        placeholder="메모 (선택)"
        onChange={(e) => setBody(e.target.value)}
        style={{ ...inputMono, fontFamily: "inherit" }}
        focusStyle={inputFocus}
      />
      {result && (
        <div style={{ fontSize: 12, lineHeight: 1.7, background: "#faf9f6", borderRadius: 5, padding: "7px 9px" }}>
          {result.error && <div style={{ color: "#8a6420" }}>{result.error}</div>}
          {result.draft && (
            <>
              <div>
                <b>카테고리</b> {result.draft.category ? `${result.draft.category.ciName} › ${result.draft.category.path} > ${result.draft.category.task}` : "(고르지 못함)"}
                {result.draft.confidence !== null && <span style={{ color: "#a09a8f" }}> · 확신도 {result.draft.confidence}</span>}
              </div>
              <div style={{ whiteSpace: "pre-wrap" }}>
                <b>상세내용</b> {result.draft.note}
              </div>
              <div style={{ color: "#a09a8f" }}>분은 실제 입력 때 그날 고른 업무들 사이에서 다시 나눕니다.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
