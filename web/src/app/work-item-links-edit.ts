/**
 * 工作項目的關聯：「相關工作項目」段落的標題列有「加入關聯」，選種類（上層、子項目、相關、前置、後續項目）
 * 再找工作項目；每個關聯後面有移除鈕（只拿掉關聯，工作項目本身不動）。改完重新讀取內容。
 */
import { type AdoLinkChange, type AdoWorkItem, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { relationLabels, workItemIdOf } from "../issue-doc.ts";
import { choose } from "../ui/choice.ts";
import { icon } from "../ui/icons.ts";
import { type MenuEntry, setupMenu } from "../ui/menu.ts";
import { Picker } from "../ui/picker.ts";
import { app } from "./context.ts";
import type { WorkItemEditHooks } from "./work-item-edit.ts";

type LinkKind = AdoLinkChange["kind"];

/** 選單上的順序：上層最常用。 */
const KINDS: LinkKind[] = ["parent", "child", "related", "predecessor", "successor"];

/** 找工作項目的搜尋框裡的提示（說明這次要選的是什麼）。 */
function pickHint(kind: LinkKind): string {
  switch (kind) {
    case "parent":
      return t("上層項目：輸入標題關鍵字或編號");
    case "child":
      return t("子項目：輸入標題關鍵字或編號");
    case "related":
      return t("相關的工作項目：輸入標題關鍵字或編號");
    case "predecessor":
      return t("前置項目（要先完成的）：輸入標題關鍵字或編號");
    case "successor":
      return t("後續項目（這個完成之後才做的）：輸入標題關鍵字或編號");
  }
}

/** 加入之後的提示。 */
function addedText(kind: LinkKind, w: AdoWorkItem): string {
  const name = `${w.kind} ${w.id}`;
  switch (kind) {
    case "parent":
      return t("已把上層設成 {name}", { name });
    case "child":
      return t("已把 {name} 加成子項目", { name });
    default:
      return t("已加入和 {name} 的關聯", { name });
  }
}

/** 每種關聯一個找工作項目的清單（搜尋框的提示不同）；選到之後交給 `onPick`。 */
const pickers = new Map<LinkKind, Picker<AdoWorkItem>>();
let onPick: ((w: AdoWorkItem) => void) | null = null;
/** 不列出來的：自己，與已經是這種關聯的。 */
let exclude = new Set<number>();
let seq = 0;

/** 找工作項目：沒打字時列出指派給我的，打字時不限人、狀態（和插入工作項目連結一樣）。 */
function openPicker(kind: LinkKind, skip: Set<number>, pick: (w: AdoWorkItem) => void): void {
  onPick = pick;
  exclude = skip;
  let picker = pickers.get(kind);
  if (!picker) {
    picker = new Picker<AdoWorkItem>({
      label: t("加入關聯"),
      placeholder: pickHint(kind),
      empty: t("找不到符合的工作項目"),
      async query(q) {
        if (!desktop) return [];
        const mine = ++seq;
        await new Promise((r) => setTimeout(r, 250));
        if (mine !== seq) return [];
        const text = q.trim().replace(/^#/, "");
        const base = app.DEFAULT_WORK_ITEM_FILTER;
        const filter = text ? { ...base, person: "", state: "all" as const } : base;
        return (await desktop.adoWorkItems(text, filter)).filter((w) => !exclude.has(w.id)).slice(0, 50);
      },
      render: (w) => ({ title: w.title, detail: [`${w.kind} ${w.id}`, w.state].join("・"), icon: "square-kanban" }),
      pick: (w) => onPick?.(w),
    });
    pickers.set(kind, picker);
  }
  picker.open();
}

/** 段落裡每一組的標題（「上層」「子項目」…）對應的種類；其他種類（例如 Tested By）不能在這裡移除。 */
function kindOfGroup(title: string): LinkKind | null {
  const labels = relationLabels();
  return KINDS.find((k) => labels[k] === title.trim()) ?? null;
}

/** 在「相關工作項目」段落加上「加入關聯」與每個關聯的移除鈕。 */
export function editableRelations(body: HTMLElement, h: WorkItemEditHooks): void {
  const sec = body.querySelector<HTMLDetailsElement>('.ado-sec[data-kind="relations"]');
  const head = sec?.querySelector<HTMLElement>(":scope > .ado-sec-head");
  const box = sec?.querySelector<HTMLElement>(":scope > .ado-sec-body");
  if (!sec || !head || !box || head.querySelector(".ado-sec-edit")) return;
  if (!box.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "ado-sec-empty";
    empty.textContent = t("還沒有相關的工作項目，按「加入關聯」設定上層、子項目或相關項目。");
    box.append(empty);
  }
  const add = document.createElement("button");
  add.type = "button";
  add.id = "wi-add-link";
  add.className = "ado-sec-edit";
  add.append(icon("plus"), t("加入關聯"));
  head.append(add);
  // 重畫時舊的選單還在：先拿掉。
  document.getElementById("wi-add-link-popover")?.remove();
  const entries: MenuEntry[] = [];
  const menu = setupMenu(add, null, entries);
  // 按鈕在 <summary> 裡：不要順便收合段落（所以自己開關選單）。
  add.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const d = h.detail();
    const parent = d?.relations.find((r) => r.link === "parent");
    const labels = relationLabels();
    entries.splice(
      0,
      entries.length,
      ...KINDS.map((kind) => ({
        label: kind === "parent" && parent ? t("換上層…") : t("{kind}…", { kind: labels[kind] }),
        icon: kind === "parent" ? "arrow-up" : kind === "child" ? "arrow-down" : "link",
        run: () => {
          const current = h.detail();
          if (!current) return;
          // 自己與已經是這種關聯的不列出來。
          const skip = new Set([h.id, ...current.relations.filter((r) => r.link === kind).map((r) => r.id)]);
          openPicker(kind, skip, (w) => {
            const change = kind === "parent" ? { parent: w.id } : { linksAdd: [{ kind, id: w.id }] };
            void h.apply(change, addedText(kind, w));
          });
        },
      })),
    );
    if (menu.matches(":popover-open")) menu.hidePopover();
    else menu.showPopover();
  });
  removeButtons(box, h);
}

/** 每個關聯後面的移除鈕（問過再拿掉）。 */
function removeButtons(box: HTMLElement, h: WorkItemEditHooks): void {
  let kind: LinkKind | null = null;
  for (const el of box.children) {
    if (el.tagName === "H3") kind = kindOfGroup(el.textContent ?? "");
    if (el.tagName !== "UL" || !kind) continue;
    const linkKind = kind;
    for (const li of el.querySelectorAll<HTMLLIElement>(":scope > li")) {
      const a = li.querySelector<HTMLAnchorElement>("a[href]");
      const id = a ? workItemIdOf(a.getAttribute("href") ?? "") : null;
      if (id === null || li.querySelector(".ado-link-remove")) continue;
      const name = a?.textContent?.trim() ?? String(id);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ado-link-remove";
      button.title = t("移除關聯");
      button.setAttribute("aria-label", t("移除和「{name}」的關聯", { name }));
      button.append(icon("x"));
      button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void (async () => {
          const answer = await choose(t("移除關聯"), t("要移除和「{name}」的關聯嗎？工作項目本身不會刪除。", { name }), [
            { id: "remove", label: t("移除"), danger: true },
            { id: "cancel", label: t("取消"), primary: true },
          ]);
          if (answer === "remove") await h.apply({ linksRemove: [{ kind: linkKind, id }] }, t("已移除和 {id} 的關聯", { id }));
        })();
      });
      li.append(button);
    }
  }
}
