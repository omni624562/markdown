/**
 * 頂端列中間的「● 專案 · 文件名稱」：一眼看出現在在哪個專案、看的是哪份文件。
 *
 * 文件名稱取自目前選取的分頁（文件、工作項目、Wiki 頁面都一樣）。位置盡量對齊視窗正中間；
 * 分頁多、正中間被擋住時往右靠，空間太小就整個隱藏，不會蓋到分頁。
 */
export interface TopbarProject {
  label: string;
  /** 專案顏色的名稱（例如 `green`），和專案圓點同一組顏色。 */
  color: string | null;
}

/** 窄於這個寬度就不顯示（只剩幾個字的「…」沒有幫助）。 */
const MIN_WIDTH = 90;
/** 和分頁、右邊按鈕之間至少留的空白。 */
const GAP = 16;

let box: HTMLElement | null = null;
let inner: HTMLElement;
let dot: HTMLElement;
let projectName: HTMLElement;
let sep: HTMLElement;
let docName: HTMLElement;
let tabBar: HTMLElement;
let project: TopbarProject | null = null;
let frame = 0;

/** 放在分頁列（`tabs`）的右邊，佔用剩下的空間。 */
export function initTopbarTitle(tabs: HTMLElement): void {
  tabBar = tabs;
  box = document.createElement("div");
  box.className = "topbar-title";
  // 和分頁、側邊欄的專案名稱重複，報讀軟體不必再唸一次。
  box.setAttribute("aria-hidden", "true");
  inner = document.createElement("span");
  inner.className = "topbar-title-inner";
  dot = document.createElement("span");
  dot.className = "project-dot";
  projectName = document.createElement("b");
  projectName.className = "topbar-project";
  sep = document.createElement("span");
  sep.className = "topbar-sep";
  sep.textContent = "·";
  docName = document.createElement("span");
  docName.className = "topbar-doc";
  inner.append(dot, projectName, sep, docName);
  box.append(inner);
  tabs.after(box);
  // 分頁換了、改名、新增或關閉時更新；寬度改變（視窗縮放、分頁變多）時重新置中。
  new MutationObserver(schedule).observe(tabs, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-selected", "class"],
  });
  new ResizeObserver(schedule).observe(box);
  addEventListener("resize", schedule);
  schedule();
}

/** 專案改了（開啟、切換、改名稱或顏色）；沒有開資料夾時是 null。 */
export function setTopbarProject(p: TopbarProject | null): void {
  project = p;
  schedule();
}

function schedule(): void {
  if (!box || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

function render(): void {
  if (!box) return;
  const blank = tabBar.classList.contains("blank");
  const selected = tabBar.querySelector<HTMLElement>(".tab[aria-selected='true'] .tab-name");
  const doc = blank ? "" : (selected?.textContent ?? "").trim();
  dot.hidden = !project;
  if (project?.color) dot.dataset.color = project.color;
  else delete dot.dataset.color;
  projectName.textContent = project?.label ?? "";
  projectName.hidden = !project;
  sep.hidden = !project || !doc;
  docName.textContent = doc;
  docName.hidden = !doc;
  const empty = !project && !doc;
  // 先放回原位、量出實際寬度，再決定位置。
  inner.style.transform = "";
  box.classList.toggle("empty", empty);
  const room = box.clientWidth - GAP * 2;
  if (empty || room < MIN_WIDTH) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  // 太長時截短（…），左右各留 GAP 的空白。
  inner.style.maxWidth = `${room}px`;
  const rect = box.getBoundingClientRect();
  const width = inner.getBoundingClientRect().width;
  // 想放的位置：視窗正中間；放不下就靠在可用範圍的邊上（兩邊各留一點空白）。
  const want = innerWidth / 2 - width / 2 - rect.left;
  const left = Math.max(GAP, Math.min(want, GAP + room - width));
  inner.style.transform = `translateX(${Math.round(left)}px)`;
}
