import { useEffect } from "react";
import { useIwms } from "../../store/iwmsStore";
import IwmsCategoriesCard from "./IwmsCategoriesCard";
import IwmsConnectionCard from "./IwmsConnectionCard";
import { hintStyle } from "./shared";

/**
 * 설정의 i-WMS 탭 — 오늘의 한일을 i-WMS 업무량(MH)으로 입력하는 기능의 설정.
 *
 * 숨겨져도 마운트를 유지한다(`display: none`). 고치던 힌트 · 샘플 초안이 탭을 오가도 남는다
 * (`AiConnectionsCard` 의 탭과 같은 규칙).
 */
export default function IwmsTab({ hidden }: { hidden: boolean }) {
  const load = useIwms((s) => s.load);
  const error = useIwms((s) => s.error);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: hidden ? "none" : "flex", flexDirection: "column", gap: 16 }}>
      <div style={hintStyle}>
        오늘의 한일에서 업무마다 대가포함 여부를 고르고 [i-WMS 업무량 입력] 을 누르면, AI 가 카테고리 ·
        분 · 상세내용을 제안하고 확인한 뒤 그날 i-WMS 에 입력합니다.
      </div>
      {error && <div style={{ ...hintStyle, color: "#9b4b42" }}>{error}</div>}
      <IwmsConnectionCard />
      <IwmsCategoriesCard />
    </div>
  );
}
