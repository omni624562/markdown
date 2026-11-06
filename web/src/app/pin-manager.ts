/**
 * 「☰」→「釘選常用指令…」：所有能釘的指令（有圖示的）列成一張表，直接勾選要放在「檔案面板上方」
 * （最多 3 個，跟著專案）或「左側圖示列」。已經釘了的排在最上面；可以搜尋。滿了的那一欄，沒勾的變灰。
 * 釘上去的順序照勾選的先後；左側圖示列可以拖曳調整，檔案面板上方的可以在按鈕上按右鍵移除。
 */
import { type Command, fuzzyScore } from "../commands.ts";
import { t } from "../i18n.ts";
import { ACTIVITY_LIMIT, FILES_HEAD_LIMIT } from "../settings.ts";
import { icon } from "../ui/icons.ts";
import { sortByGroup } from "../ui/palette.ts";
import { app } from "./context.ts";

type Place = "filesHeadCommands" | "activityCommands";

const LIMIT: Record<Place, number> = { filesHeadCommands: FILES_HEAD_LIMIT, activityCommands: ACTIVITY_LIMIT };

/** 能釘的指令：有圖示的（和選單上的圖釘一樣），不含指令面板與這個對話框本身；同一個 id 只列一次。 */
function pinnable(): Command[] {
  const seen = new Set<string>();
  return sortByGroup(
    app.commands.all().filter((c) => {
      if (!c.icon || c.id === "palette" || c.id === "pin-manage" || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    }),
  );
}

export function openPinManager(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "choice pin-manager";
  dialog.setAttribute("aria-labelledby", "pin-manager-title");
  const h = document.createElement("h2");
  h.id = "pin-manager-title";
  h.textContent = t("釘選常用指令");
  const hint = document.createElement("p");
  hint.className = "pin-manager-hint";
  hint.textContent = t("勾選要放到檔案面板上方（專案名稱旁邊，跟著專案）或左側圖示列的指令。也可以在「☰」選單的項目上按右邊的圖釘。");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "shortcuts-search pin-manager-search";
  search.placeholder = t("搜尋指令");
  search.setAttribute("aria-label", t("搜尋指令"));
  const body = document.createElement("div");
  body.className = "pin-manager-body";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.textContent = t("完成");
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  actions.append(close);
  dialog.append(h, hint, search, body, actions);

  const toggle = (place: Place, id: string, on: boolean) => {
    const list = app.settings.value[place].filter((x) => x !== id);
    app.settings.update({ [place]: on ? [...list, id] : list });
    render(`${place}:${id}`);
  };

  const check = (place: Place, c: Command): HTMLTableCellElement => {
    const cell = document.createElement("td");
    cell.className = "pin-manager-check";
    const list = app.settings.value[place];
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.focus = `${place}:${c.id}`;
    box.checked = list.includes(c.id);
    const full = !box.checked && list.length >= LIMIT[place];
    box.disabled = full;
    const where = place === "filesHeadCommands" ? t("檔案面板上方") : t("左側圖示列");
    box.setAttribute("aria-label", t("把「{name}」釘到{where}", { name: c.title, where }));
    if (full) box.title = t("{where}最多放 {n} 個，先取消其他的才能勾", { where, n: LIMIT[place] });
    box.addEventListener("change", () => toggle(place, c.id, box.checked));
    cell.append(box);
    return cell;
  };

  const section = (title: string, items: Command[]): HTMLElement[] => {
    if (!items.length) return [];
    const g = document.createElement("h3");
    g.textContent = title;
    const table = document.createElement("table");
    for (const c of items) {
      const row = table.insertRow();
      row.dataset.command = c.id;
      const name = row.insertCell();
      name.className = "pin-manager-name";
      name.append(icon(c.icon ?? "command"), Object.assign(document.createElement("span"), { textContent: c.title }));
      row.append(check("filesHeadCommands", c), check("activityCommands", c));
    }
    return [g, table];
  };

  function render(focus?: string): void {
    const top = body.scrollTop;
    const v = app.settings.value;
    const q = search.value.trim();
    const all = pinnable().filter((c) => !q || fuzzyScore(q, `${c.title} ${c.group}`) > 0);
    const pinned = (c: Command) => v.filesHeadCommands.includes(c.id) || v.activityCommands.includes(c.id);
    // 表頭：兩個位置各釘了幾個（檔案面板上方有上限）。
    const head = document.createElement("table");
    head.className = "pin-manager-head";
    const hr = head.insertRow();
    hr.insertCell().textContent = t("指令");
    hr.insertCell().textContent = t("檔案面板上方（{n}/{max}）", { n: v.filesHeadCommands.length, max: FILES_HEAD_LIMIT });
    hr.insertCell().textContent = t("左側圖示列（{n}）", { n: v.activityCommands.length });
    const groups = new Map<string, Command[]>();
    for (const c of all) {
      if (!q && pinned(c)) continue;
      groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
    }
    const rows = [
      // 沒在搜尋時，已經釘的排在最上面（照原本的分組順序）。
      ...(q ? [] : section(t("已經釘的"), all.filter(pinned))),
      ...[...groups].flatMap(([group, items]) => section(group, items)),
    ];
    if (!rows.length) rows.push(Object.assign(document.createElement("p"), { className: "shortcuts-empty", textContent: t("找不到符合的指令") }));
    body.replaceChildren(head, ...rows);
    body.scrollTop = top;
    if (focus) body.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
  }

  search.addEventListener("input", () => render());
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  render();
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
}
