/**
 * 標題列中間的搜尋框（「搜尋檔案、工作項目，或問助理　Ctrl+P」）：按一下和按 Ctrl+P 一樣打開快速開啟。
 * 快速開啟裡除了檔案、工作項目（`#`）、Wiki 頁面，這裡再加上兩種：
 * - `>` 開頭找指令（和指令面板同一份清單、同一份「最近使用」）。
 * - `?` 開頭問助理；一般搜尋時最後一項也是「問助理：…」（設定裡開了 Claude API 助理時）。
 * 框裡的字依目前能找的東西而定（沒連上 Azure DevOps 時不寫「工作項目」，助理沒開時不寫「問助理」）。
 */
import { formatKeys } from "../commands.ts";
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { paletteItems, recentCommandIds, rememberCommand } from "../ui/palette.ts";
import { askAssistant, assistantEnabled } from "./assistant.ts";
import { commands } from "./commands.ts";
import { app } from "./context.ts";
import { reportError } from "./git-actions.ts";
import { type QuickItem, addQuickMode, quickOpen } from "./quick-open.ts";

/** 「問助理：…」那一項。 */
function askItem(text: string, section?: string): QuickItem {
  return {
    title: t("問助理：「{q}」", { q: text.trim() }),
    detail: t("送到右側欄的助理"),
    remote: { icon: "sparkles", open: () => askAssistant(text) },
    section,
  };
}

/** 框裡的字：依目前能找的東西。 */
export function titleSearchLabel(o: { desktop: boolean; ado: boolean; assistant: boolean }): string {
  if (!o.desktop) return t("搜尋分頁或指令");
  if (o.ado && o.assistant) return t("搜尋檔案、工作項目，或問助理");
  if (o.ado) return t("搜尋檔案、工作項目與 Wiki");
  if (o.assistant) return t("搜尋檔案，或問助理");
  return t("搜尋檔案或指令");
}

export function renderTitleSearch(): void {
  const box = document.querySelector<HTMLButtonElement>("#title-search");
  if (!box) return;
  const label = titleSearchLabel({ desktop: !!desktop, ado: !!app.ado?.account, assistant: assistantEnabled() });
  box.querySelector(".title-search-text")!.textContent = label;
  box.title = label;
}

export function initTitleSearch(): void {
  const box = document.querySelector<HTMLButtonElement>("#title-search");
  if (!box) return;
  const quick = commands.get("quick-open");
  const keys = quick?.keys ? formatKeys(quick.keys) : "";
  box.querySelector(".title-search-keys")!.textContent = keys;
  if (keys) box.setAttribute("aria-keyshortcuts", keys.replace("Ctrl", "Control").replace("⌘", "Meta+"));
  box.addEventListener("click", () => quickOpen.open());

  addQuickMode({
    // 注音輸入法開著時打出來的是全形的符號，也算。
    prefixes: [">", "＞", "》"], // i18n-ignore
    tip: t("指令"),
    empty: t("找不到符合的指令"),
    available: () => true,
    query: (text) =>
      paletteItems(commands.available(), text, recentCommandIds())
        .slice(0, 200)
        .map(({ c, section }) => {
          const k = c.keys ?? c.shownKeys;
          return {
            title: c.title,
            detail: [c.note?.(), section ? undefined : c.group].filter(Boolean).join(" · "),
            keys: k ? formatKeys(k) : undefined,
            section,
            remote: {
              icon: c.icon ?? "command",
              open: () => {
                rememberCommand(c.id);
                commands.run(c.id).catch(reportError);
              },
            },
          };
        }),
  });
  addQuickMode({
    prefixes: ["?", "？"], // i18n-ignore
    tip: t("問助理"),
    empty: t("輸入要問助理的問題"),
    available: assistantEnabled,
    query: (text) => (text.trim() ? [askItem(text)] : []),
    fallback: (text) => [askItem(text, t("助理"))],
  });

  renderTitleSearch();
  app.settings.subscribe((_s, changed) => {
    if (changed.includes("claudeApiEnabled")) renderTitleSearch();
  });
}
