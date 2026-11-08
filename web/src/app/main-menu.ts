/**
 * 主選單（☰）：第一層放最常用的（新增、開啟、存檔）與分好類的子選單，少用的工具收進「文件工具」。
 * 項目是指令的 id（`commands`），「-」是分隔線。從 main.ts 拆出來。
 */
import { t } from "../i18n.ts";
import { setupMenu } from "../ui/menu.ts";
import { app } from "./context.ts";
import { commands } from "./commands.ts";

export function initMainMenu(): void {
  setupMenu(app.$<HTMLButtonElement>("#main-menu"), commands, [
    "new",
    "new-from-template",
    "daily-note",
    "open",
    "open-recent",
    "save",
    "save-as",
    "-",
    {
      label: t("專案"),
      icon: "folder-kanban",
      items: [
        "new-project",
        "switch-project",
        "project-overview",
        "open-in-codex",
        "open-in-claude",
        "comet-setup-project",
        "comet-resetup-project",
        "-",
        "open-folder",
        { label: t("下載儲存庫"), icon: "download", items: ["github-open", "ado-open"] },
        { label: t("連線到遠端資料夾"), icon: "cloud", items: ["connect-webdav", "connect-ssh"] },
        "-",
        "delete-project",
      ],
    },
    {
      label: t("Git"),
      icon: "git-branch",
      items: ["show-git", "git-history", "git-commit", "git-sync", "git-branch-switch", "git-create-pr", "ado-publish", "-", "git-file-history", "git-open-web", "git-copy-link"],
    },
    "-",
    {
      label: t("匯入與匯出"),
      icon: "download",
      items: ["export-pdf", "export-docx", "export-html", "print", "-", "copy-rich", "-", "import-docx"],
    },
    { label: t("文件工具"), icon: "wand-sparkles", items: ["doc-stats", "history", "save-as-template", "-", "fix-terms", "check-links", "s2t", "-", "slideshow"] },
    "-",
    { label: t("AI 與終端機"), icon: "sparkles", items: ["toggle-terminal", "start-claude", "start-codex", "-", "ai-settings"] },
    { label: t("外觀"), icon: "sun", items: ["theme-system", "theme-light", "theme-dark", "-", "choose-palette"] },
    {
      label: t("說明"),
      icon: "circle-help",
      items: ["show-shortcuts", "show-welcome", "show-changelog", "-", "check-update", "report-issue", "copy-error-log", "-", "about"],
    },
    "pin-manage", "palette",
    "settings",
  ]);
}
