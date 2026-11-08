/**
 * 「檢查連結」：找出連到不存在的文件、圖片或檔案的連結，列成清單，點一下跳到那一行。
 * 開啟資料夾時檢查資料夾裡的所有文件；沒有開資料夾時檢查已開啟的文件；
 * 正在看或編輯 Azure DevOps Wiki 頁面時，檢查這一頁連到的其他 Wiki 頁面。
 */
import { parseDoc } from "../../pkg/md_wasm.js";
import { desktop, isRemote } from "../desktop.ts";
import type { DocInfo } from "../doc-index.ts";
import { t } from "../i18n.ts";
import { type LinkKind, type LinkProblem, planLinkCheck, wikiLinkProblems, wikiPageLinkCount } from "../link-check.ts";
import { flattenPages, pageName } from "../wiki-text.ts";
import { wikiPanel } from "./work-items-panel.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import type { IndexedDoc } from "../workspace-index.ts";
import { indexedDocs, indexScope, openIndexed } from "./workspace-ui.ts";
import { app } from "./context.ts";
import { issueView } from "./wiki-edit.ts";
import { markdownFiles } from "./wiki-links.ts";

/** 後端一次最多查幾個路徑（和 `paths_exist` 的上限相同，超過會被拒絕）。 */
const BATCH = 500;

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
  const files = folder && app.fileListCache ? markdownFiles(app.fileListCache) : null;
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

/** 正在看（或在分頁裡編輯）的 Wiki 頁面：路徑、內容與跳到某個連結的方法；不是 Wiki 頁面時是 null。 */
function shownWikiPage(): { path: string; text: string; jump(p: LinkProblem): void } | null {
  const view = issueView;
  if (view.isOpen) {
    if (!view.shownKey?.startsWith("wiki:") || !app.wikiPage) return null;
    return {
      path: app.wikiPage.path,
      text: view.markdown,
      jump: (p) => {
        // 內文裡的連結還是原本的寫法（編碼過）：解碼後比對。
        const same = (a: HTMLAnchorElement) => {
          try {
            return decodeURIComponent((a.getAttribute("href") ?? "").split(/[?#]/)[0]) === p.target;
          } catch {
            return false;
          }
        };
        const a = [...view.body.querySelectorAll<HTMLAnchorElement>("a[href]")].find(same);
        if (a) view.reveal(a);
      },
    };
  }
  const wiki = app.active.wiki;
  if (!wiki) return null;
  return { path: wiki.path, text: app.editor.text, jump: (p) => app.editor.reveal(p.line) };
}

/** 檢查 Wiki 頁面裡連到其他頁面的連結（附件、圖片不檢查）。 */
function checkWikiLinks(page: { path: string; text: string; jump(p: LinkProblem): void }): void {
  const pages = flattenPages(wikiPanel?.pages ?? []);
  if (!pages.length) {
    toast(t("還沒讀到 Wiki 的頁面清單，開啟左側的 Wiki 面板後再試一次。"), { tone: "error" });
    return;
  }
  const info = parseDoc(page.text, new Date().getFullYear()) as DocInfo;
  const problems = wikiLinkProblems(info.links, page.path, pages);
  const checked = wikiPageLinkCount(info.links);
  if (!problems.length) {
    toast(
      checked
        ? t("沒有斷掉的頁面連結（檢查了 {n} 個連結）", { n: checked })
        : t("這一頁沒有連到其他 Wiki 頁面"),
      { tone: "success" },
    );
    return;
  }
  const name = pageName(page.path);
  const label = t("斷掉的連結（{n}）", { n: problems.length });
  new Picker<LinkProblem>({
    label,
    placeholder: t("{label}：輸入文字篩選，Enter 跳到那一行", { label }),
    empty: t("沒有符合的連結"),
    query: (q) => {
      const needle = q.trim().toLowerCase();
      return needle ? problems.filter((p) => p.target.toLowerCase().includes(needle)) : problems;
    },
    render: (p) => ({
      title: t("找不到 Wiki 頁面：{target}", { target: p.target }),
      detail: t("{file}：第 {line} 行", { file: name, line: p.line }),
      icon: ICONS.page,
    }),
    pick: (p) => page.jump(p),
  }).open();
}

export async function checkLinks(): Promise<void> {
  if (!desktop) return;
  // 正在看 Wiki 頁面：檢查這一頁連到的其他頁面。
  const wiki = shownWikiPage();
  if (wiki) return checkWikiLinks(wiki);
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
