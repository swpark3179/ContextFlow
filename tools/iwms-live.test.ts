/**
 * i-WMS 정제 실데이터 점검 — `IWMS_LIVE_DIR` 이 있을 때만 돈다(평소 `pnpm test` 에서는 건너뛴다).
 *
 * `src/` 밖에 두는 이유: `node:fs` 를 쓰는데 이 저장소의 `tsc` 는 `src/` 만, 브라우저 타입으로 검사한다.
 *
 * 폴더에 필요한 것:
 *   - `day-YYYYMMDD.json`     Rust `live_read` 가 `IWMS_DUMP` 에 남기는 그날 현황(화면이 받는 모양)
 *   - `entries-YYYYMMDD.json` `[{ entry: DayEntry, task: { folder, indexPath, category, tags } | null }]`
 *   - (선택) `prices.json`     `{ "<entryId>": "O" | "N" }` — 없으면 모두 대가포함
 *
 * 1) 이 테스트가 `system.txt` · `prompt.txt` 를 쓴다.
 * 2) Rust `live_refine_run`(IWMS_PROMPT_DIR=같은 폴더)이 실제 연결로 묻고 `response.txt` 를 쓴다.
 * 3) 다시 돌리면 `response.txt` 를 해석해 `drafts.json` 을 쓰고 요약을 찍는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { duplicateOf } from "../src/lib/iwms/duplicates";
import { collectMaterial } from "../src/lib/iwms/material";
import { parseRefine } from "../src/lib/iwms/parse";
import { buildIwmsPrompt, buildIwmsSystemPrompt, codeTable } from "../src/lib/iwms/prompts";
import { pricesOf, refit, remainingOf } from "../src/lib/iwms/refine";
import type { IwmsDay, IwmsSettings, Price } from "../src/lib/iwms/types";
import type { TaskMeta } from "../src/lib/api";
import type { DayEntry } from "../src/lib/daylog";

const dir = process.env.IWMS_LIVE_DIR;
const ymd = (process.env.IWMS_DATE ?? "2026-10-02").replace(/-/g, "");

const DEFAULTS: IwmsSettings = {
  baseUrl: "http://i-wms.sds.samsung.net",
  fillToStandard: true,
  minuteStep: 10,
  styleGuide: "- 1~3줄로 쓰고 명사형으로 끝낸다(예: …수행, …확인, …조치, …배포).",
  categories: [],
};

describe.skipIf(!dir)("i-WMS 정제 실데이터", () => {
  it("프롬프트를 만들고, 답이 있으면 해석한다", async () => {
    const d = dir!;
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(d, name), "utf8"));
    const day: IwmsDay = read(`day-${ymd}.json`);
    const rows: { entry: DayEntry; task: Partial<TaskMeta> | null }[] = read(`entries-${ymd}.json`);
    const prices: Record<string, Price> = fs.existsSync(path.join(d, "prices.json")) ? read("prices.json") : {};
    const settingsPath = path.join(os.homedir(), ".contextflow", "iwms.json");
    const settings: IwmsSettings = fs.existsSync(settingsPath)
      ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) }
      : DEFAULTS;

    const targets = rows.map((r) => ({ entry: r.entry, price: prices[String(r.entry.id)] ?? ("O" as Price), pushed: [] }));
    for (const t of targets) {
      const dup = duplicateOf(t.entry.title, day);
      if (dup) console.log(`이미 있음? ${t.entry.title} ≈ "${dup.row.note.split("\n")[0]}" (${dup.score.toFixed(2)})`);
    }
    const tasks = rows.filter((r) => r.task).map((r) => r.task as TaskMeta);
    const items = await collectMaterial(targets, tasks, settings.categories, day.workDate, async (p) =>
      fs.readFileSync(p, "utf8"),
    );
    const table = codeTable(day, pricesOf(items), settings.categories);
    const prompt = buildIwmsPrompt({
      day,
      items,
      table,
      designated: settings.categories,
      styleGuide: settings.styleGuide,
      remaining: remainingOf(day),
      fill: settings.fillToStandard,
      step: settings.minuteStep,
      examples: [],
      inject: "",
    });
    fs.writeFileSync(path.join(d, "system.txt"), buildIwmsSystemPrompt());
    fs.writeFileSync(path.join(d, "prompt.txt"), prompt);
    console.log(`프롬프트 ${prompt.length}자 · 업무 ${items.length} · 후보 ${table.byCode.size} · 남은 ${remainingOf(day)}분`);

    const resPath = path.join(d, "response.txt");
    if (!fs.existsSync(resPath)) return;
    const parsed = parseRefine(fs.readFileSync(resPath, "utf8"), items, table);
    expect(parsed.parsed).toBe(true);
    const drafts = refit(parsed.drafts, remainingOf(day), settings);
    fs.writeFileSync(path.join(d, "drafts.json"), JSON.stringify(drafts, null, 1));
    for (const x of drafts) {
      console.log(
        `${x.entryId} ${x.title}\n   → ${x.category ? `${x.category.ciName} › ${x.category.task}` : "(없음)"} · ${x.minutes}분 · 확신 ${x.confidence}\n   "${x.note}"${x.issues.length ? `\n   ! ${x.issues.join(" / ")}` : ""}`,
      );
    }
    expect(drafts.reduce((n, x) => n + x.minutes, 0)).toBe(settings.fillToStandard ? remainingOf(day) : expect.any(Number));
  });
});
