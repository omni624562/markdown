/**
 * 新增 Wiki 頁面的對話框：輸入標題、選範本（空白頁面、這個 Wiki 的「範本」頁面底下的子頁面、文件範本）。
 * 記住每個 Wiki 上次選的範本。
 */
import { desktop, type AdoWiki } from "../desktop.ts";
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";
import { BUILTIN_TEMPLATES } from "../templates.ts";
import { childPagePath, pageName, wikiTitleProblem } from "../wiki-text.ts";
import { newPageBody, wikiTemplateFolder, wikiTemplatePages } from "../wiki-templates.ts";
import { app } from "./context.ts";

/** 範本選單的值：空字串是空白頁面，`wiki:路徑`、`custom:名稱`、`builtin:名稱`。 */
type TemplateChoice = string;

/** 標題有問題時的說明；沒問題回傳 null。 */
function titleMessage(title: string, parent: string | null, existing: Set<string>): string | null {
  const problem = wikiTitleProblem(title);
  if (problem === "empty") return t("請輸入頁面標題。");
  if (problem === "chars") return t("頁面標題不能有 /、\\、#。");
  if (problem === "dot") return t("頁面標題不能以「.」開頭或結尾。");
  if (problem === "long") return t("頁面標題太長了。");
  if (existing.has(childPagePath(parent, title).toLowerCase())) return t("已經有同名的頁面了，請換一個名稱");
  return null;
}

/**
 * 問新頁面的標題與範本；按「建立」後讀好範本的內容，回傳路徑與內容。取消時回傳 null。
 * `pages` 是這個 Wiki 所有頁面的路徑（檢查同名、找共用範本）。
 */
export function askNewWikiPage(wiki: AdoWiki, parent: string | null, pages: string[]): Promise<{ path: string; title: string; body: string } | null> {
  const existing = new Set(pages.map((p) => p.toLowerCase()));
  const folder = wikiTemplateFolder(pages);
  const shared = folder ? wikiTemplatePages(pages, folder) : [];
  const custom = app.settings.value.templates;
  // 內建的「空白文件」和「空白頁面」重複，不列。
  const builtin = BUILTIN_TEMPLATES.filter((tpl) => tpl.body.trim());

  const dialog = document.createElement("dialog");
  dialog.className = "choice wi-create wiki-new-page";
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h2");
  h.textContent = parent ? t("新增子頁面") : t("新增頁面");
  const where = document.createElement("p");
  where.textContent = parent ? t("新頁面會放在「{name}」底下。", { name: pageName(parent) }) : t("新頁面會放在 Wiki 的最上層。");
  const field = (label: string, control: HTMLElement) => {
    const l = document.createElement("label");
    l.className = "pdf-field";
    l.append(Object.assign(document.createElement("span"), { textContent: label }), control);
    return l;
  };
  const title = document.createElement("input");
  title.type = "text";
  title.maxLength = 235;
  const template = document.createElement("select");
  template.append(new Option(t("空白頁面"), ""));
  const group = (label: string, options: [string, string][]) => {
    if (!options.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const [value, text] of options) g.append(new Option(text, value));
    template.append(g);
  };
  group(
    folder ? t("這個 Wiki 的範本（{name}）", { name: pageName(folder) }) : t("這個 Wiki 的範本"),
    shared.map((p) => [`wiki:${p}`, pageName(p)]),
  );
  group(
    t("自訂範本"),
    custom.map((tpl) => [`custom:${tpl.name}`, tpl.name]),
  );
  group(
    t("內建範本"),
    builtin.map((tpl) => [`builtin:${tpl.name}`, tpl.name]),
  );
  const remembered = storage.load(`wiki-template:${wiki.id}`) ?? "";
  if ([...template.options].some((o) => o.value === remembered)) template.value = remembered;
  const hint = document.createElement("p");
  hint.className = "wiki-new-hint";
  hint.textContent = folder
    ? t("「{name}」底下的子頁面會列在這裡，大家共用。", { name: pageName(folder) })
    : t("在 Wiki 最上層建立「範本」頁面，把範本放在它底下，就會列在這裡，大家共用。");
  const error = document.createElement("p");
  error.className = "wi-create-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: t("取消") });
  const ok = Object.assign(document.createElement("button"), { type: "submit", className: "btn btn-primary", textContent: t("建立") });
  actions.append(cancel, ok);
  form.append(h, where, field(t("標題"), title), field(t("範本"), template), hint, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
  title.focus();

  /** 選的範本內容（Wiki 裡的範本要讀）；空白頁面是 null。 */
  const templateBody = async (choice: TemplateChoice): Promise<string | null> => {
    if (choice.startsWith("wiki:")) return (await desktop!.adoWikiPage(wiki, choice.slice(5))).content;
    if (choice.startsWith("custom:")) return custom.find((tpl) => tpl.name === choice.slice(7))?.body ?? null;
    if (choice.startsWith("builtin:")) return builtin.find((tpl) => tpl.name === choice.slice(8))?.body ?? null;
    return null;
  };

  return new Promise((resolve) => {
    let result: { path: string; title: string; body: string } | null = null;
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = title.value.trim();
      const message = titleMessage(name, parent, existing);
      if (message) {
        error.hidden = false;
        error.textContent = message;
        title.focus();
        return;
      }
      error.hidden = true;
      ok.disabled = true;
      ok.textContent = t("建立中…");
      const choice = template.value;
      void templateBody(choice)
        .then((body) => {
          storage.save(`wiki-template:${wiki.id}`, choice);
          result = { path: childPagePath(parent, name), title: name, body: newPageBody(name, body) };
          dialog.close();
        })
        .catch((err) => {
          ok.disabled = false;
          ok.textContent = t("建立");
          error.hidden = false;
          error.textContent = t("讀不到範本：{error}", { error: err instanceof Error ? err.message : String(err) });
        });
    });
  });
}
