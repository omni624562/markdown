/**
 * 「檢查連結」：找出連到不存在的文件、圖片或檔案的連結，列成清單，點一下跳到那一行。
 * 開啟資料夾時檢查資料夾裡的所有文件；沒有開資料夾時檢查已開啟的文件。
 */
import { desktop, isRemote } from "../desktop.ts";
import { t } from "../i18n.ts";
import { type LinkKind, type LinkProblem, planLinkCheck } from "../link-check.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import type { IndexedDoc } from "../workspace-index.ts";
import { indexedDocs, indexScope, openIndexed } from "./workspace-ui.ts";
import { app } from "./context.ts";

/** 後端一次最多查幾個路徑（和 `paths_exist` 的上限相同）。 */
const BATCH = 5_000;

interface Found {
  doc: IndexedDoc;
  problem: LinkProblem;
}

const ICONS: Record<LinkKind, string> = { page: "unlink", image: "image-off", file: "file-x" };

function problemText(p: LinkProblem): string {
  if (p.kind === "image") return t("找不到圖片：{target}", { target: p.target });
  if (p.kind === "page") return t("找不到文件：{target}", { target: p.target });
  return t("找不到檔案：{target}", { target: p.target });
}

/** 檢查這些文件的連結：回傳斷掉的連結（依檔名、行號排好）與檢查了幾個連結。 */
async function findBroken(docs: IndexedDoc[]): Promise<{ found: Found[]; checked: number }> {
  const folder = indexScope() === "folder";
  if (folder) app.fileListCache ??= await desktop!.listFiles(app.workspaceRoot!.path).catch(() => []);
  const files = folder && app.fileListCache ? app.markdownFiles(app.fileListCache) : null;
  const found: Found[] = [];
  const ask: { path: string; found: Found }[] = [];
  let checked = 0;
  for (const doc of docs) {
    // 還沒存檔的分頁沒有位置可以對照；遠端資料夾的檔案無法在本機檢查。
    if (!doc.path || isRemote(doc.path)) continue;
    const plan = planLinkCheck(doc.info.links, doc.path, files);
    checked += plan.checked;
    for (const problem of plan.broken) found.push({ doc, problem });
    for (const p of plan.paths) ask.push({ path: p.path, found: { doc, problem: p.problem } });
  }
  // 同一個路徑只問一次。
  const unique = [...new Set(ask.map((a) => a.path))];
  const exists = new Map<string, boolean | null>();
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const result = await desktop!.pathsExist(chunk);
    chunk.forEach((p, j) => exists.set(p, result[j] ?? null));
  }
  for (const a of ask) if (exists.get(a.path) === false) found.push(a.found);
  found.sort((a, b) => a.doc.rel.localeCompare(b.doc.rel) || a.problem.line - b.problem.line);
  return { found, checked };
}

export async function checkLinks(): Promise<void> {
  if (!desktop) return;
  const folder = indexScope() === "folder";
  const { found, checked } = await findBroken(await indexedDocs());
  if (!found.length) {
    toast(
      checked
        ? t("沒有斷掉的連結（檢查了 {n} 個連結）", { n: checked })
        : folder
          ? t("資料夾裡的文件沒有連到其他文件或圖片")
          : t("已開啟的文件沒有連到其他文件或圖片"),
      { tone: "success" },
    );
    return;
  }
  const label = t("斷掉的連結（{n}）", { n: found.length });
  new Picker<Found>({
    label,
    placeholder: t("{label}：輸入文字篩選，Enter 跳到那一行", { label }),
    empty: t("沒有符合的連結"),
    query: (q) => {
      const needle = q.trim().toLowerCase();
      return needle ? found.filter((f) => `${f.doc.rel} ${f.problem.target}`.toLowerCase().includes(needle)) : found;
    },
    render: (f) => ({
      title: problemText(f.problem),
      detail: t("{file}：第 {line} 行", { file: f.doc.rel, line: f.problem.line }),
      icon: ICONS[f.problem.kind],
    }),
    pick: (f) => openIndexed(f.doc, f.problem.line),
  }).open();
}
