import { useEffect, useMemo, useState } from "react";
import { Box, Input } from "../../lib/ui";
import * as api from "../../lib/api";
import { today } from "../../lib/format";
import { label as cfLabel } from "../../lib/category";
import { patchDesignated, toggleDesignated } from "../../lib/iwms/categories";
import {
  PRICE_LABEL,
  categoryKey,
  designate,
  type Designated,
  type IwmsCategory,
  type IwmsDay,
  type Price,
} from "../../lib/iwms/types";
import CategoryPicker from "../../components/CategoryPicker";
import { useIwms } from "../../store/iwmsStore";
import { useStore } from "../../store/useStore";
import { Btn, cardStyle, headStyle, hintStyle, inputFocus, inputMono } from "./shared";

const PRICES: Price[] = ["O", "N"];

/**
 * 사용할 i-WMS 카테고리 지정.
 *
 * 카테고리 목록은 날짜마다 다를 수 있다(i-WMS '나의 MH 설정' 의 등록 · 해제, 마감). 그래서 기준일을
 * 골라 그날 입력 가능한 목록을 불러와 고른다. 지정한 것은 이름 · 경로의 사본과 함께 `iwms.json` 에
 * 남아 i-WMS 에 연결하지 않아도 보인다. 줄마다 AI 가 읽는 설명(`hint`)과, 그 ContextFlow 카테고리의
 * 업무는 이 카테고리로 고정하는 매핑(`mapFrom`)을 둘 수 있다.
 */
export default function IwmsCategoriesCard() {
  const iw = useIwms();
  const settings = iw.settings;
  const [date, setDate] = useState(today());
  const [day, setDay] = useState<IwmsDay | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const designated = settings?.categories ?? [];
  const chosen = useMemo(() => new Set(designated.map(categoryKey)), [designated]);

  if (!settings) return null;

  const load = async () => {
    setLoading(true);
    setErr("");
    try {
      setDay(await iw.day(date));
    } catch (e) {
      setDay(null);
      setErr(api.errMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async (categories: Designated[]) => {
    try {
      await iw.saveSettings({ ...settings, categories });
    } catch (e) {
      useStore.getState().fail(e, "i-WMS 카테고리를 저장하지 못했습니다");
    }
  };

  const toggle = (c: IwmsCategory, on: boolean) => {
    const prev = designated.find((d) => categoryKey(d) === categoryKey(c));
    void save(toggleDesignated(designated, designate(c, prev), on));
  };

  const onDay = new Set(day?.categories.map(categoryKey) ?? []);
  const absent = day ? designated.filter((d) => !onDay.has(categoryKey(d))) : designated;

  return (
    <div style={cardStyle}>
      <div style={headStyle}>i-WMS 카테고리</div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 500 }}>기준일</span>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ ...inputMono, width: 140 }}
            focusStyle={inputFocus}
          />
          <Btn label="불러오기" busy={loading} busyLabel="불러오는 중" disabled={!date} onClick={() => void load()} />
          <span style={{ ...hintStyle, marginLeft: 4 }}>
            {day
              ? `탭 ${day.tabs.length} · 카테고리 ${day.categories.length} · 지정 ${designated.length}`
              : `지정 ${designated.length}개`}
          </span>
        </div>
        {err && <div style={{ ...hintStyle, color: "#9b4b42" }}>{err}</div>}

        {day &&
          PRICES.map((price) => (
            <PriceSection
              key={price}
              price={price}
              day={day}
              chosen={chosen}
              designated={designated}
              onToggle={toggle}
              onPatch={(key, patch) => void save(patchDesignated(designated, key, patch))}
            />
          ))}

        {absent.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6a665e", marginBottom: 4 }}>
              {day ? `지정했지만 ${day.workDate} 에는 없는 카테고리` : "지정한 카테고리"}
            </div>
            {absent.map((d) => (
              <DesignatedRow
                key={categoryKey(d)}
                d={d}
                dim={!!day}
                onRemove={() => void save(designated.filter((x) => categoryKey(x) !== categoryKey(d)))}
                onPatch={(patch) => void save(patchDesignated(designated, categoryKey(d), patch))}
              />
            ))}
          </div>
        )}

        <div style={{ ...hintStyle, paddingTop: 6, borderTop: "1px dashed #eae6de" }}>
          {day
            ? "체크한 카테고리만 AI 가 고릅니다. 한 대가 구분에 하나도 체크하지 않으면 그날 그 구분의 전체에서 고릅니다."
            : "기준일을 불러오면 그날 입력할 수 있는 카테고리가 대가포함 · 대가미포함으로 나뉘어 보입니다."}
        </div>
      </div>
    </div>
  );
}

function PriceSection({
  price,
  day,
  chosen,
  designated,
  onToggle,
  onPatch,
}: {
  price: Price;
  day: IwmsDay;
  chosen: Set<string>;
  designated: Designated[];
  onToggle: (c: IwmsCategory, on: boolean) => void;
  onPatch: (key: string, patch: Partial<Pick<Designated, "hint" | "mapFrom">>) => void;
}) {
  const cats = day.categories.filter((c) => c.priceType === price);
  const tabs = [...new Set(cats.map((c) => c.ciName))];
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: price === "O" ? "#2f5cbb" : "#6a54c6", marginBottom: 4 }}>
        {PRICE_LABEL[price]} <span style={{ fontWeight: 400, color: "#a09a8f" }}>({price === "O" ? "운영" : "비대상"} · {cats.length})</span>
      </div>
      {!cats.length && <div style={hintStyle}>이 날짜에는 없습니다.</div>}
      {tabs.map((tab) => (
        <div key={tab} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: "#8a857c", padding: "2px 0" }}>{tab}</div>
          {cats
            .filter((c) => c.ciName === tab)
            .map((c) => {
              const key = categoryKey(c);
              const d = designated.find((x) => categoryKey(x) === key);
              return (
                <CategoryRow
                  key={key}
                  c={c}
                  on={chosen.has(key)}
                  d={d}
                  onToggle={(on) => onToggle(c, on)}
                  onPatch={(patch) => onPatch(key, patch)}
                />
              );
            })}
        </div>
      ))}
    </div>
  );
}

function CategoryRow({
  c,
  on,
  d,
  onToggle,
  onPatch,
}: {
  c: IwmsCategory;
  on: boolean;
  d: Designated | undefined;
  onToggle: (on: boolean) => void;
  onPatch: (patch: Partial<Pick<Designated, "hint" | "mapFrom">>) => void;
}) {
  return (
    <div style={{ borderBottom: "1px solid #f4f1ec" }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          minHeight: 26,
          fontSize: 12,
          cursor: c.blocked ? "default" : "pointer",
          opacity: c.blocked ? 0.55 : 1,
        }}
        title={c.blocked ?? `${c.wbsid}`}
      >
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <span style={{ color: "#8a857c", flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.path}
        </span>
        <span style={{ color: "#3a3630", fontWeight: on ? 600 : 400, whiteSpace: "nowrap" }}>› {c.task}</span>
        <span style={{ flex: 1 }} />
        {c.minutes > 0 && <span style={{ ...hintStyle, fontSize: 10.5 }}>입력됨 {c.minutes}분</span>}
        {c.blocked && <span style={{ ...hintStyle, fontSize: 10.5, color: "#b07520" }}>{c.blocked}</span>}
      </label>
      {on && d && <Extras d={d} onPatch={onPatch} />}
    </div>
  );
}

/** 지정한 줄의 힌트 · 매핑. */
function Extras({ d, onPatch }: { d: Designated; onPatch: (patch: Partial<Pick<Designated, "hint" | "mapFrom">>) => void }) {
  const [hint, setHint] = useState(d.hint);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => setHint(d.hint), [d.hint]);

  return (
    <div style={{ padding: "2px 0 8px 22px", display: "flex", flexDirection: "column", gap: 5 }}>
      <Input
        value={hint}
        placeholder="이 카테고리에 넣는 일 (AI 가 고를 때 읽습니다) — 예: 사내 시스템 배포 · 서버 기동 · 장애 조치"
        onChange={(e) => setHint(e.target.value)}
        onBlur={() => hint.trim() !== d.hint && onPatch({ hint: hint.trim() })}
        style={{ ...inputMono, fontFamily: "inherit", width: "100%", boxSizing: "border-box", height: 26 }}
        focusStyle={inputFocus}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", fontSize: 11 }}>
        <span style={{ color: "#8a857c" }}>이 업무 카테고리는 여기로:</span>
        {d.mapFrom.map((m) => (
          <Box
            key={m}
            onClick={() => onPatch({ mapFrom: d.mapFrom.filter((x) => x !== m) })}
            title="매핑을 지웁니다"
            style={{ background: "#f0ede7", borderRadius: 3, padding: "0 5px", lineHeight: "18px", cursor: "pointer" }}
            hover={{ background: "#e6e1d8" }}
          >
            {cfLabel(m)} ✕
          </Box>
        ))}
        {adding === null ? (
          <Box
            onClick={() => setAdding("")}
            style={{ color: "#3a6fd8", cursor: "pointer", padding: "0 4px" }}
            hover={{ textDecoration: "underline" }}
          >
            ＋ 매핑
          </Box>
        ) : null}
      </div>
      {adding !== null && (
        <CategoryPicker
          value={adding}
          autoFocus
          allowNone={false}
          onChange={setAdding}
          onCommit={(v) => {
            setAdding(null);
            if (v && !d.mapFrom.includes(v)) onPatch({ mapFrom: [...d.mapFrom, v] });
          }}
          onCancel={() => setAdding(null)}
        />
      )}
    </div>
  );
}

function DesignatedRow({
  d,
  dim,
  onRemove,
  onPatch,
}: {
  d: Designated;
  dim: boolean;
  onRemove: () => void;
  onPatch: (patch: Partial<Pick<Designated, "hint" | "mapFrom">>) => void;
}) {
  return (
    <div style={{ borderBottom: "1px solid #f4f1ec" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, minHeight: 26, fontSize: 12, opacity: dim ? 0.6 : 1 }}>
        <span style={{ fontSize: 10.5, color: d.priceType === "O" ? "#2f5cbb" : "#6a54c6", whiteSpace: "nowrap" }}>
          {PRICE_LABEL[d.priceType as Price] ?? d.priceType}
        </span>
        <span style={{ color: "#8a857c", whiteSpace: "nowrap" }}>{d.ciName}</span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {d.path} › {d.task}
        </span>
        <span style={{ flex: 1 }} />
        <Box onClick={onRemove} style={{ color: "#a09a8f", cursor: "pointer", padding: "0 4px" }} hover={{ color: "#4e4a43" }}>
          해제
        </Box>
      </div>
      {!dim && <Extras d={d} onPatch={onPatch} />}
    </div>
  );
}
