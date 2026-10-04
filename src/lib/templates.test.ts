import { describe, expect, it } from "vitest";
import type { TaskMeta } from "./api";
import { taskAtFolder, templatePrefill } from "./templates";

describe("templatePrefill — 템플릿을 바꿀 때의 카테고리 칸", () => {
  it("빈 칸이면 새 기본값, 새 템플릿에 기본값이 없으면 빈 칸 그대로", () => {
    expect(templatePrefill("", null, "운영/보고")).toBe("운영/보고");
    expect(templatePrefill("  ", "운영", "운영/보고")).toBe("운영/보고");
    expect(templatePrefill("", "운영", null)).toBe("");
  });

  it("앞 템플릿의 기본값 그대로면 갈아 끼운다 — 철자 · 구분자만 다르면 같은 값이다", () => {
    expect(templatePrefill("운영/보고", "운영/보고", "개인")).toBe("개인");
    expect(templatePrefill(" 운영 › 보고 ", "운영/보고", null)).toBe("");
    expect(templatePrefill("Proj/Sub", "proj/sub", "운영")).toBe("운영");
  });

  it("손으로 고친 값은 그대로 둔다 — 대화상자를 연 곳이 채운 값도", () => {
    expect(templatePrefill("운영/회의", "운영/보고", "개인")).toBe("운영/회의");
    // 카테고리 묶음 머리에서 연 새 업무 창 — 앞 템플릿이 없었다.
    expect(templatePrefill("프로젝트", null, "운영/보고")).toBe("프로젝트");
  });

  it("잘못된 값은 빈 칸으로 보지 않는다 — 정규화하면 null 이라도 고친 값이다", () => {
    expect(templatePrefill("a/b/c/d", null, "운영")).toBe("a/b/c/d");
    expect(templatePrefill("미분류", "운영", "개인")).toBe("미분류");
  });
});

describe("taskAtFolder — 고른 폴더가 업무 폴더인가", () => {
  const t = (folder: string, category: string | null) => ({ folder, category }) as TaskMeta;
  const tasks = [t("C:/Vault/Tasks/[2026-09] 결제 점검", "운영"), t("C:/Vault/Tasks/[2026-09] 문서", null)];

  it("대소문자 · 역슬래시 · 끝의 `/` 는 가리지 않는다", () => {
    expect(taskAtFolder(tasks, "c:/vault/tasks/[2026-09] 결제 점검/")?.category).toBe("운영");
    expect(taskAtFolder(tasks, "C:\\Vault\\Tasks\\[2026-09] 문서")).toBe(tasks[1]);
  });

  it("업무 폴더가 아니거나 비었으면 null — 업무 안의 하위 폴더도 업무가 아니다", () => {
    expect(taskAtFolder(tasks, "C:/Vault/Tasks/[2026-09] 결제 점검/설계")).toBeNull();
    expect(taskAtFolder(tasks, "D:/다른 곳")).toBeNull();
    expect(taskAtFolder(tasks, "")).toBeNull();
  });
});
