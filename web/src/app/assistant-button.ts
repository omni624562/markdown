/**
 * 標題列右上角、右側欄開關（◨）左邊的「助理」按鈕：開了 Claude API 助理才出現，點一下打開或收起助理。
 * 平板只用觸控時不必先開右側欄再切分頁；桌面版也不必記 Ctrl+Shift+L。
 */
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { assistantEnabled, assistantOpen, toggleAssistant } from "./assistant.ts";
import { app } from "./context.ts";

export function initAssistantButton(): void {
  const actions = document.querySelector<HTMLElement>(".top-actions");
  const right = document.querySelector<HTMLElement>("[data-command='toggle-outline-right']");
  if (!actions || !right) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn icon-only top-assistant";
  button.id = "top-assistant";
  button.append(icon("sparkles"));
  const label = t("助理（Claude API）");
  button.title = t("{label}（{keys}）", { label, keys: "Ctrl+Shift+L" });
  button.setAttribute("aria-label", label);
  button.addEventListener("click", () => {
    toggleAssistant();
    sync();
  });
  right.before(button);
  const sync = () => {
    button.hidden = !assistantEnabled();
    button.setAttribute("aria-pressed", String(assistantOpen()));
  };
  // 右側欄開關、切換分頁（從指令面板、快捷鍵、右側欄的分頁）時跟著更新按下的樣子。
  const watch = new MutationObserver(sync);
  watch.observe(app.$("aside#outline-right"), { attributes: true, attributeFilter: ["hidden", "class"], subtree: true });
  app.settings.subscribe((_s, changed) => {
    if (changed.includes("claudeApiEnabled")) sync();
  });
  sync();
}
