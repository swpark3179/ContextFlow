import { describe, expect, it } from "vitest";
import type { TaskMeta } from "../api";
import { collectMaterial, overviewOf, runLogOf, samePath } from "./material";

const NOTE = [
  "---",
  "id: task-2026-1002-131948",
  "title: S-PCS-Plus Standalone 서버 기동",
  "---",
  "## 개요",
  "",
  "프론트엔드에 build-standalone 가 추가된 것 같다.",
  "",
  "## 실행 이력 (Run Log)",
  "- 2026-10-02 16:49 · 배포 스크립트 수정",
  "- 2026-10-01 09:00 · 전날 작업",
  "- 2026-10-02 13:19 · 업무 생성",
  "",
  "## 다른 절",
  "- 2026-10-02 10:00 · 이건 Run Log 가 아니다",
].join("\n");

describe("재료", () => {
  it("개요는 골격 머리말과 Run Log 를 뺀다", () => {
    expect(overviewOf(NOTE)).toBe("프론트엔드에 build-standalone 가 추가된 것 같다.");
    expect(overviewOf("---\na: 1\n---\n" + "가".repeat(700), 600)).toHaveLength(601);
    expect(overviewOf("설정 확인\n```yml\nkey: secret\n```\n적용 완료\n```sql\nSELECT 1")).toBe(
      "설정 확인\n(코드 생략)\n적용 완료\n(코드 생략)",
    );
  });

  it("그날의 Run Log 줄만", () => {
    expect(runLogOf(NOTE, "2026-10-02")).toEqual(["2026-10-02 16:49 · 배포 스크립트 수정", "2026-10-02 13:19 · 업무 생성"]);
    expect(runLogOf("## 개요\n본문", "2026-10-02")).toEqual([]);
  });

  it("경로는 구분자 · 대소문자를 가리지 않는다", () => {
    expect(samePath("F:/ContextFlow\\Tasks\\[2026-10] a", "f:/contextflow/Tasks/[2026-10] a/")).toBe(true);
    expect(samePath("F:/a/b", "F:/a/bc")).toBe(false);
  });

  it("업무 폴더에서 카테고리 · 태그 · 개요를 끌어오고, 못 읽으면 제목만으로 간다", async () => {
    const task = {
      folder: "F:/ContextFlow/Tasks/[2026-10] a",
      indexPath: "F:/ContextFlow/Tasks/[2026-10] a/index.md",
      category: "프로젝트/S-PCS-Plus",
      tags: ["배포"],
    } as TaskMeta;
    const entry = (id: number, folder: string | null) => ({ id, day: "2026-10-02", folder, title: `t${id}`, body: "", at: "" });
    const out = await collectMaterial(
      [
        { entry: entry(1, "F:/ContextFlow\\Tasks\\[2026-10] a"), price: "O", pushed: [] },
        { entry: entry(2, "F:/gone"), price: "N", pushed: [] },
        { entry: entry(3, null), price: "N", pushed: [] },
      ],
      [task],
      [{ ciKey: "A", ciName: "공통", wbsid: "w", path: "", task: "", priceType: "O", hint: "", mapFrom: ["프로젝트"], samples: [] }],
      "2026-10-02",
      async (path) => {
        if (path === task.indexPath) return NOTE;
        throw new Error("없음");
      },
    );
    expect(out[0]).toMatchObject({ taskCategory: "프로젝트/S-PCS-Plus", tags: ["배포"], runLog: [expect.any(String), expect.any(String)] });
    expect(out[0].fixed?.wbsid).toBe("w");
    expect(out[1]).toMatchObject({ taskCategory: null, overview: "", runLog: [], fixed: null });
    expect(out[2].title).toBe("t3");
  });
});
