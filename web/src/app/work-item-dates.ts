/**
 * 工作項目的開始、完成、目標日期：標題下的日期小標籤點一下，打開小視窗選日期，選了就存回 Azure DevOps；
 * 也可以清除。小視窗一律留在視窗內（ui/menu-place.ts）。
 *
 * 只處理工作項目上已經有值的日期（流程範本有這個欄位）：沒有值時看不出這個類型有沒有這個欄位，存了可能失敗。
 */
import type { AdoWorkItemChange } from "../desktop.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { placeMenu } from "../ui/menu-place.ts";
import type { WorkItemEditHooks } from "./work-item-edit.ts";

type DateField = "startDate" | "finishDate" | "targetDate";

const LABELS: Record<DateField, () => string> = {
  startDate: () => t("開始日期"),
  finishDate: () => t("完成日期"),
  targetDate: () => t("目標日期"),
};

/** `2026-12-04`（本地日期）→ 那天本地午夜的 ISO 時間（和 Azure DevOps 網頁版選日期時存的一樣）。 */
export function dateToIso(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 把日期小標籤換成按鈕，點一下選日期。重畫之後要再呼叫一次。 */
export function editableDates(hero: HTMLElement, h: WorkItemEditHooks): void {
  for (const chip of hero.querySelectorAll<HTMLElement>(".ado-fact[data-field][data-date]")) {
    const field = chip.dataset.field as DateField;
    if (!(field in LABELS)) continue;
    const label = LABELS[field]();
    const button = document.createElement("button");
    button.type = "button";
    button.id = `wi-edit-${field}`;
    button.className = `${chip.className} ado-fact-edit`;
    button.dataset.field = field;
    button.dataset.date = chip.dataset.date ?? "";
    button.title = t("{label}：按一下修改", { label });
    button.setAttribute("aria-label", t("修改{label}", { label }));
    button.setAttribute("aria-haspopup", "dialog");
    button.append(...chip.childNodes, icon("chevron-down"));
    chip.replaceWith(button);
    button.addEventListener("click", () => openPicker(button, field, label, h));
  }
}

function openPicker(button: HTMLElement, field: DateField, label: string, h: WorkItemEditHooks): void {
  document.querySelector(`#wi-date-popover`)?.remove();
  const box = document.createElement("div");
  box.id = "wi-date-popover";
  box.className = "menu wi-date-popover";
  box.popover = "auto";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", label);
  const title = document.createElement("div");
  title.className = "menu-head";
  title.textContent = label;
  const input = document.createElement("input");
  input.type = "date";
  input.className = "wi-date-input";
  input.value = button.dataset.date ?? "";
  input.setAttribute("aria-label", label);
  const actions = document.createElement("div");
  actions.className = "wi-date-actions";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn";
  clear.textContent = t("清除日期");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn btn-primary";
  save.textContent = t("儲存");
  actions.append(clear, save);
  box.append(title, input, actions);
  document.body.append(box);

  const apply = (value: string, done: string) => {
    box.hidePopover();
    const change: AdoWorkItemChange = { [field]: value };
    void h.apply(change, done);
  };
  save.addEventListener("click", () => {
    const day = input.value;
    if (!day || day === button.dataset.date) return box.hidePopover();
    const iso = dateToIso(day);
    if (iso) apply(iso, t("已把{label}改成 {date}", { label, date: day }));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save.click();
    }
  });
  clear.addEventListener("click", () => apply("", t("已清除{label}", { label })));
  box.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState === "closed") box.remove();
  });

  box.showPopover();
  const anchor = button.getBoundingClientRect();
  const { width, height } = box.getBoundingClientRect();
  const p = placeMenu(anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight });
  Object.assign(box.style, { left: `${p.left}px`, top: `${p.top}px`, right: "auto", bottom: "auto", maxHeight: `${p.maxHeight}px` });
  input.focus();
}
