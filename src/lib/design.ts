/**
 * Design tokens lifted verbatim from design/ContextFlow.dc.html (script block,
 * lines 1043-1070). Changing a value here changes it everywhere, which is why
 * no component hardcodes these four hues.
 */
export const BLUE = "#3a6fd8";
export const AMBER = "#b07520";
export const GREEN = "#2f7f57";
export const VIOLET = "#6a54c6";

export type StatusKey = "in-progress" | "on-hold" | "completed" | "reopened";

export interface StatusStyle {
  label: string;
  dot: string;
  bg: string;
  fg: string;
  bd: string;
}

export const STATUS: Record<StatusKey, StatusStyle> = {
  "in-progress": { label: "진행 중", dot: BLUE, bg: "#eef3fd", fg: "#2f5cbb", bd: "#cddcf8" },
  "on-hold": { label: "보류", dot: AMBER, bg: "#fbf3e6", fg: "#8f5d17", bd: "#eeddc0" },
  completed: { label: "완료", dot: GREEN, bg: "#e9f4ee", fg: "#256b47", bd: "#c9e4d5" },
  reopened: { label: "재개됨", dot: VIOLET, bg: "#f4f0fd", fg: "#5a44b4", bd: "#e0d6f8" },
};

export function statusOf(key: string): StatusStyle {
  return STATUS[key as StatusKey] ?? STATUS["in-progress"];
}

export const LANG: Record<string, string> = {
  md: "Markdown",
  json: "JSON",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  sql: "SQL",
  ps1: "PowerShell",
  csv: "CSV",
  log: "Plain Text",
  txt: "Plain Text",
  har: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  rs: "Rust",
  py: "Python",
  html: "HTML",
  css: "CSS",
  xml: "XML",
  png: "Binary",
  pdf: "Binary",
  xlsx: "Binary",
};

export interface AppChoice {
  n: string;
  d: string;
  c: string;
}

const NOTEPAD: AppChoice = { n: "메모장", d: "Windows 기본 텍스트 편집기", c: "#8a857c" };
const VSCODE: AppChoice = { n: "Visual Studio Code", d: "소스 편집기", c: BLUE };

export const APPS: Record<string, AppChoice[]> = {
  md: [
    { n: "Obsidian", d: "기본 앱 · 이 Vault에 연결됨", c: VIOLET },
    VSCODE,
    NOTEPAD,
  ],
  json: [{ ...VSCODE, d: "기본 앱 · 소스 편집기" }, NOTEPAD],
  ts: [{ ...VSCODE, d: "기본 앱 · 소스 편집기" }, NOTEPAD],
  tsx: [{ ...VSCODE, d: "기본 앱 · 소스 편집기" }, NOTEPAD],
  rs: [{ ...VSCODE, d: "기본 앱 · 소스 편집기" }, NOTEPAD],
  sql: [
    { n: "DBeaver", d: "기본 앱 · SQL 클라이언트", c: GREEN },
    VSCODE,
  ],
  ps1: [
    { n: "Windows PowerShell ISE", d: "기본 앱 · 스크립트 편집기", c: "#2f5cbb" },
    NOTEPAD,
  ],
  csv: [
    { n: "스프레드시트", d: "기본 앱 · 표 편집기", c: GREEN },
    NOTEPAD,
  ],
  xlsx: [{ n: "스프레드시트", d: "기본 앱 · 표 편집기", c: GREEN }],
  png: [
    { n: "사진 뷰어", d: "기본 앱 · 이미지 보기", c: AMBER },
    { n: "그림판", d: "이미지 편집", c: "#8a857c" },
  ],
  jpg: [{ n: "사진 뷰어", d: "기본 앱 · 이미지 보기", c: AMBER }],
  pdf: [
    { n: "PDF 뷰어", d: "기본 앱 · 문서 보기", c: "#c04a4a" },
    { n: "웹 브라우저", d: "PDF 열기 지원", c: BLUE },
  ],
  har: [
    { n: "웹 브라우저", d: "기본 앱 · 네트워크 로그 분석", c: BLUE },
    NOTEPAD,
  ],
  html: [
    { n: "웹 브라우저", d: "기본 앱 · 스크립트까지 실행", c: BLUE },
    VSCODE,
    NOTEPAD,
  ],
  htm: [
    { n: "웹 브라우저", d: "기본 앱 · 스크립트까지 실행", c: BLUE },
    VSCODE,
    NOTEPAD,
  ],
  txt: [{ ...NOTEPAD, d: "기본 앱 · Windows 기본 텍스트 편집기" }, VSCODE],
  log: [{ ...NOTEPAD, d: "기본 앱 · Windows 기본 텍스트 편집기" }, VSCODE],
};

export function appsFor(ext: string): AppChoice[] {
  return APPS[ext] ?? [{ ...NOTEPAD, d: "기본 앱 · Windows 기본 텍스트 편집기" }];
}

export function extOf(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? (parts.pop() as string).toLowerCase() : "";
}

export function extStyle(ext: string): { fg: string; bg: string } {
  if (ext === "md") return { fg: "#5a44b4", bg: "#f2eefc" };
  // 내장 뷰어가 있는 나머지 한 종류 — 마크다운과 구분되는 색을 준다.
  if (ext === "html" || ext === "htm") return { fg: "#8f5d17", bg: "#fbf3e6" };
  if (["json", "ts", "tsx", "js", "sql", "ps1", "rs", "py"].includes(ext))
    return { fg: "#2f5cbb", bg: "#eef3fd" };
  if (["csv", "xlsx", "tsv"].includes(ext)) return { fg: "#256b47", bg: "#e9f4ee" };
  return { fg: "#8a857c", bg: "#f0ede7" };
}

/** Toast accents used across the design's `toast(...)` calls. */
export const TOAST = {
  info: "#6a9ff0",
  ok: "#5fbf8d",
  warn: "#e0a955",
  danger: "#e0705a",
  violet: "#a78bfa",
  muted: "#a8a29a",
} as const;
