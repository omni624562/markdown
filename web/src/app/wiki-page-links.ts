/**
 * Wiki 頁面內文裡的相對連結（`子頁面`、`../其他頁面`、`設定.json`）：一律在 oMarker 裡開，不交給瀏覽器。
 * - 指到頁面：開那一頁。用這一頁所屬 Wiki 的頁面樹找，不受左側面板目前選哪個 Wiki 影響。
 * - 指到 Wiki 儲存庫裡的文字檔（例如 .json、.yaml）：開成唯讀分頁。
 * - 都找不到：提示，不開瀏覽器（相對路徑交給瀏覽器只會開到一個不存在的網址）。
 */
import type { AdoWiki } from "../desktop.ts";
import { t } from "../i18n.ts";
import { isMarkdownName, isReadableFileName } from "../repo-links.ts";
import { toast } from "../ui/toast.ts";
import { flattenPages, imageRepoPath, resolvePageLink } from "../wiki-text.ts";
import { wikiPageTree } from "./ado-links.ts";
import { showRepoFile } from "./ado-files.ts";
import { reportError } from "./git-actions.ts";
import { wikiPanel } from "./work-items-panel.ts";
import { showWikiPage } from "./wiki-edit.ts";

/** 網址、mailto: 等（交給呼叫的人：Azure DevOps 的網址在 oMarker 開，其他用瀏覽器）。 */
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

function decoded(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** 開啟 `wiki` 的 `path` 這一頁，左側面板顯示的是同一個 Wiki 時一起選取。 */
function openPage(wiki: AdoWiki, path: string): void {
  if (wikiPanel?.wiki?.id === wiki.id) wikiPanel.select(path);
  showWikiPage(wiki, path);
}

/**
 * 處理 `current` 這一頁內文裡的連結 `href`；回傳 false 表示不是相對連結（網址、錨點），交給呼叫的人。
 * 頁面樹還沒讀到時先讀（第一次會慢一點），找不到再重新讀一次（可能是剛新增的頁面）。
 */
export function followWikiLink(wiki: AdoWiki, current: string, href: string): boolean {
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || EXTERNAL.test(raw)) return false;
  // 左側面板顯示的就是這個 Wiki：直接用它的頁面樹（最新的）。
  if (wikiPanel?.wiki?.id === wiki.id) {
    const target = resolvePageLink(raw, current, flattenPages(wikiPanel.pages));
    if (target) {
      openPage(wiki, target);
      return true;
    }
  }
  void (async () => {
    for (const fresh of [false, true]) {
      const target = resolvePageLink(raw, current, flattenPages(await wikiPageTree(wiki, fresh)));
      if (target) return openPage(wiki, target);
    }
    // 不是頁面：Wiki 儲存庫裡可以閱讀的文字檔（和圖片一樣，相對於這一頁所在的資料夾）。
    const path = imageRepoPath(raw, current, wiki.mappedPath);
    const name = path?.slice(path.lastIndexOf("/") + 1) ?? "";
    if (path && isReadableFileName(name) && !isMarkdownName(name)) {
      return showRepoFile({
        kind: "git",
        project: wiki.project,
        // 專案 Wiki 的儲存庫和 Wiki 同名；程式碼 Wiki 用儲存庫的 id。
        repo: wiki.code ? wiki.repositoryId : wiki.name,
        path,
        version: wiki.version,
        versionType: wiki.version ? "branch" : null,
        name,
      });
    }
    toast(t("找不到連結的頁面：{name}", { name: decoded(raw.split(/[?#]/)[0]) }), { tone: "error" });
  })().catch(reportError);
  return true;
}
