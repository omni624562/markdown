/**
 * 工作項目、Wiki 面板上方的篩選區可以收合，清單多一點空間：標題列多一顆收合按鈕；
 * 收合後篩選區換成一行摘要（工作項目：目前的條件；Wiki：目前的 Wiki），按一下摘要就展開。
 * 兩個面板各自記住。
 */
import { t } from "../i18n.ts";
import * as storage from "../storage.ts";
import { icon } from "../ui/icons.ts";

export type FilterPanel = "workitems" | "wiki";

interface Spec {
  /** 面板（`.side-panel`）與裡面的內容（`.side-body`）的 id。 */
  panel: string;
  host: string;
  /** 收合時藏起來的部分（內容底下的直接子元素）。 */
  blocks: string;
  /** 摘要列開頭的圖示。 */
  icon: string;
  collapse: string;
  expand: string;
  /** 摘要列要列出的幾項（用「·」隔開）。 */
  parts(host: HTMLElement): string[];
}

/** 沒有藏起來（自己和上層都沒有 `hidden`；收合時整塊不顯示，不能用版面判斷）。 */
const notHidden = (el: Element): boolean => !el.closest("[hidden]");

/** 搜尋框裡打的字（有打字才列出來，收合後也看得出清單是搜尋的結果）。 */
function query(host: HTMLElement, selector: string): string[] {
  const q = host.querySelector<HTMLInputElement>(selector)?.value.trim();
  return q ? [t("搜尋「{q}」", { q })] : [];
}

const SPECS: Record<FilterPanel, Spec> = {
  workitems: {
    panel: "panel-workitems",
    host: "workitems-host",
    blocks: ":scope > .workitems-filters",
    icon: "list-filter",
    collapse: t("收合篩選條件"),
    expand: t("展開篩選條件"),
    parts: (host) => {
      const bar = host.querySelector(":scope > .workitems-filters");
      if (!bar) return [];
      const person = bar.querySelector<HTMLInputElement>(".workitems-person");
      const name = person && notHidden(person) ? person.value.trim() : "";
      const parts = [...bar.querySelectorAll<HTMLElement>(".workitems-select")].filter(notHidden).map((b) => {
        const text = b.textContent?.trim() ?? "";
        // 「指派給…」「建立者是…」加上輸入的名字。
        return name && text.endsWith("…") ? `${text.slice(0, -1)} ${name}` : text;
      });
      return [...parts.filter(Boolean), ...query(host, ".workitems-search")];
    },
  },
  wiki: {
    panel: "panel-wiki",
    host: "wiki-host",
    blocks: ":scope > :is(.wiki-filters, .workitems-searchrow)",
    icon: "book-open-text",
    collapse: t("收合 Wiki 選單與搜尋"),
    expand: t("展開 Wiki 選單與搜尋"),
    parts: (host) => {
      const select = host.querySelector<HTMLSelectElement>(":scope > .wiki-filters select");
      const name = select?.selectedOptions[0]?.textContent?.trim() || "Wiki";
      return [name, ...query(host, ":scope > .workitems-searchrow .workitems-search")];
    },
  },
};

const storageKey = (which: FilterPanel) => `${which}-filters-collapsed`;

const controls = new Map<FilterPanel, { set(collapsed: boolean): void }>();

function setup(which: FilterPanel): void {
  const spec = SPECS[which];
  const panel = document.getElementById(spec.panel);
  const host = document.getElementById(spec.host);
  const actions = panel?.querySelector<HTMLElement>(":scope > .side-head .side-actions");
  // 沒有篩選區（網頁版沒有 Azure DevOps 面板）就不加按鈕。
  const blocks = host ? [...host.querySelectorAll(spec.blocks)] : [];
  if (!panel || !host || !actions || !blocks.length) return;
  let collapsed = storage.load(storageKey(which)) === "1";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn icon-only filters-toggle";
  toggle.setAttribute("aria-controls", spec.host);
  toggle.addEventListener("click", () => set(!collapsed));
  actions.prepend(toggle);

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "filters-summary";
  const text = document.createElement("span");
  text.className = "filters-summary-text";
  summary.append(icon(spec.icon), text, icon("chevron-down"));
  summary.addEventListener("click", () => {
    set(false);
    // 展開後游標放在篩選區的第一個選項（用鍵盤也接得下去）。
    host.querySelector<HTMLElement>(`${spec.blocks} :is(button, select, input):not([hidden])`)?.focus();
  });

  blocks[0].before(summary);
  const render = () => {
    if (!collapsed) return;
    const parts = spec.parts(host);
    const nodes: Node[] = [];
    parts.forEach((p, i) => {
      if (i) nodes.push(Object.assign(document.createElement("span"), { className: "filters-summary-sep", textContent: "·" }));
      nodes.push(document.createTextNode(p));
    });
    text.replaceChildren(...nodes);
    summary.title = `${parts.join(" · ")}\n${spec.expand}`;
    summary.setAttribute("aria-label", t("{action}：{filters}", { action: spec.expand, filters: parts.join(" · ") }));
  };
  const set = (next: boolean) => {
    collapsed = next;
    storage.save(storageKey(which), next ? "1" : "0");
    panel.classList.toggle("filters-collapsed", next);
    toggle.replaceChildren(icon(next ? "chevrons-up-down" : "chevrons-down-up"));
    toggle.title = next ? spec.expand : spec.collapse;
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!next));
    render();
  };
  // 條件換了（例如讀到 Wiki 清單、清除全部條件）時，摘要跟著換。只看篩選區本身（摘要在篩選區外面，改摘要不會再觸發）。
  const watch = new MutationObserver(render);
  for (const block of blocks) watch.observe(block, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });
  host.addEventListener("input", render);
  host.addEventListener("change", render);
  controls.set(which, { set });
  set(collapsed);
}

/** 標題列加上收合按鈕（工作項目、Wiki 面板建立之後呼叫）。 */
export function initFilterCollapse(): void {
  setup("workitems");
  setup("wiki");
}

/** 收合著時展開（例如要把游標放進搜尋框）。 */
export function showFilters(which: FilterPanel): void {
  controls.get(which)?.set(false);
}
