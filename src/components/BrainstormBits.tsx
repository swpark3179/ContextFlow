/**
 * 브레인스토밍 화면 셋이 함께 쓰는 조각 — 상태 배지와, 문서와 싸우지 않는 입력칸.
 *
 * 캔버스 · 개요 · 결정 로그가 같은 문서를 본다. 상태를 보여 주는 방식이 화면마다 다르면
 * "이 생각이 채택인가"를 화면마다 다시 배워야 하므로, 배지는 여기 하나만 둔다.
 */
import { useEffect, useState, type CSSProperties, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Input, TextArea } from "../lib/ui";
import { BS_STATUS } from "../lib/design";
import { STATUS_MARK, trimmedBlock, trimmedLine, type BsStatus } from "../lib/bstorm";

/**
 * 상태 하나를 글자로 못박는 배지.
 *
 * 점 하나로만 그리던 것을 배지로 바꾼 이유는, 7px 점의 색차만으로는 채택(초록)과
 * 유력(보라)이 축소된 캔버스에서 갈리지 않았기 때문이다. 이모지는 파일에 적히는 것과
 * 같은 글자다(`STATUS_MARK`) — 캔버스의 ✅ 와 Obsidian 의 ✅ 가 같은 뜻이어야 한다.
 */
export function StatusBadge({ status, big = false }: { status: BsStatus; big?: boolean }) {
  const st = BS_STATUS[status];
  const mark = STATUS_MARK[status];
  return (
    <span
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: big ? 10.5 : 9.5,
        fontWeight: 700,
        letterSpacing: ".2px",
        lineHeight: 1.5,
        padding: big ? "1px 7px" : "1px 5px",
        borderRadius: 3,
        whiteSpace: "nowrap",
        color: st.fg,
        background: st.bg,
        border: `1px solid ${st.bd}`,
      }}
    >
      {mark ? (
        <span style={{ fontSize: big ? 9.5 : 8.5 }}>{mark}</span>
      ) : (
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: st.dot }} />
      )}
      {st.label}
    </span>
  );
}

/**
 * 문서에서 되짚어 온 값과 싸우지 않는 입력칸.
 *
 * 인스펙터가 만지는 값은 `serializeBstorm → parseBstorm` 을 한 바퀴 돌아서 돌아온다.
 * 그 왕복은 줄 끝 공백과 빈 줄을 걷어내므로(`bstorm.ts`), 돌아온 값을 그대로 `value` 에
 * 물리면 스페이스바를 누르는 순간 그 공백이 지워지고 Enter 로 연 새 줄이 사라진다.
 * 낱말을 띄어 쓸 수도, 줄을 나눌 수도 없었던 것이 이것 때문이다.
 *
 * 그래서 **타이핑 중인 글자는 여기 로컬에 두고**, 문서에는 매 글자 그대로 올려 보낸다 —
 * 자동 저장 · 미저장 점 · Ctrl+S · 되돌리기는 종전과 똑같이 따라온다. 돌아온 값이 내가
 * 보낸 글의 왕복 결과와 같으면 내 메아리라서 무시하고, 다르면 밖에서 바뀐 것이라서
 * (되돌리기 · 다른 화면에서 고침 · 다른 노드 선택) 그 값을 따른다.
 */
function useDraft(value: string, echo: (v: string) => string) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft((d) => (echo(d) === value ? d : value));
  }, [value, echo]);
  return [draft, setDraft] as const;
}

type DraftInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onCommit: (v: string) => void;
  style?: CSSProperties;
  focusStyle?: CSSProperties;
};

/** 한 줄 값(제목 · 근거 · 폐기 이유). */
export function DraftInput({ value, onCommit, ...rest }: DraftInputProps) {
  const [draft, setDraft] = useDraft(value, trimmedLine);
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(e.target.value);
      }}
    />
  );
}

type DraftTextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onCommit: (v: string) => void;
  style?: CSSProperties;
  focusStyle?: CSSProperties;
};

/** 여러 줄 값(상세). Enter 는 줄바꿈이다 — 여기서 가로채는 단축키는 없다. */
export function DraftTextArea({ value, onCommit, ...rest }: DraftTextAreaProps) {
  const [draft, setDraft] = useDraft(value, trimmedBlock);
  return (
    <TextArea
      {...rest}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(e.target.value);
      }}
    />
  );
}
