/**
 * 最近開啟（桌面版）：起始頁右欄的「專案」與「最近開啟的檔案」，以及「最近開啟的檔案…」。
 * 開過的資料夾都是專案：起始頁和檔案面板（沒開資料夾時）列的是同一份專案清單，用自訂的名稱與顏色，
 * 最近開啟的排前面（原生端的清單就是這個順序）；全部的專案在切換專案與專案總覽。
 */
import { desktop, displayPath } from "../desktop.ts";
import { t } from "../i18n.ts";
import { basename, dirname } from "../paths.ts";
import { Picker } from "../ui/picker.ts";
import { fillStartRecent } from "../ui/start-page.ts";
import { app } from "./context.ts";
import { reportError } from "./git-actions.ts";
import { openPath, openRecentFolder } from "./workspace-ui.ts";
import { commands } from "./commands.ts";

/** 起始頁列出幾個專案、幾個檔案；「最近開啟的檔案…」列出幾個檔案。 */
const LIMITS = { startProjects: 4, startFiles: 5, files: 10 } as const;

export const recentFilesPicker = new Picker<string>({
  label: t("最近開啟的檔案"),
  placeholder: t("輸入檔名"),
  empty: t("還沒有最近開啟的檔案。"),
  async query(q) {
    if (!desktop) return [];
    const files = (await desktop.recent()).files.slice(0, LIMITS.files);
    const needle = q.trim().toLowerCase();
    return needle ? files.filter((path) => path.toLowerCase().includes(needle)) : files;
  },
  render: (path) => ({ title: basename(path) || path, detail: displayPath(dirname(path)), icon: "file-text" }),
  pick: (path) => void openPath(path).catch(reportError),
});

/** 補上起始頁右欄（要先向原生端讀清單）；讀好時起始頁已經換掉（`stale`）就不補。 */
export async function renderStartRecent(page: HTMLElement, stale: () => boolean): Promise<void> {
  if (!desktop) return;
  const [projects, files] = await Promise.all([
    app.projectUi?.refresh() ?? [],
    desktop.recent().then((r) => r.files, () => [] as string[]),
  ]);
  if (stale()) return;
  fillStartRecent(page, {
    projects: projects.slice(0, LIMITS.startProjects),
    files: files.slice(0, LIMITS.startFiles),
    display: displayPath,
    openProject: (path) => void openRecentFolder(path),
    openFile: (path) => void openPath(path).catch(reportError),
    allProjects: () => void commands.run("project-overview").catch(reportError),
  });
}
