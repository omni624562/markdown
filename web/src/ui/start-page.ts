/**
 * 起始頁：空白文件時顯示在編輯區（或預覽區）中間。左欄「開始」「連線」，右欄最近開啟的資料夾與檔案，
 * 下方一排小提示。直接打字就開始寫，起始頁跟著消失（呼叫端在文件有內容時藏起來）。
 */
import { t } from "../i18n.ts";
import { recentLabel } from "../start-page.ts";
import { icon } from "./icons.ts";

export interface StartAction {
  icon: string;
  label: string;
  /** 快速鍵（`formatKeys` 之後的文字），顯示在右邊。 */
  keys?: string;
  primary?: boolean;
  run(): void;
}

export interface StartPageOptions {
  /** 標題下的一句話：怎麼開始寫。 */
  hint: string;
  /** 「開始」：新增、開啟檔案、開啟資料夾、從範本新增… */
  actions: StartAction[];
  /** 「連線」：還沒連線的 Azure DevOps、GitHub（沒有就不顯示這一段）。 */
  connect: StartAction[];
  /** 下方的小提示：快速鍵與說明，點了就執行。 */
  tips: { keys?: string; label: string; run?(): void }[];
  /** 「3 分鐘認識 oMarker」。 */
  tour?(): void;
}

export interface StartRecent {
  folders: string[];
  files: string[];
  /** 完整路徑的顯示方式（滑鼠提示）。 */
  display(path: string): string;
  openFolder(path: string): void;
  openFile(path: string): void;
}

const button = (className: string, ...children: (Node | string)[]): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.append(...children);
  return b;
};

const kbd = (keys: string): HTMLElement => Object.assign(document.createElement("kbd"), { textContent: keys });

const heading = (text: string): HTMLElement => Object.assign(document.createElement("h3"), { textContent: text });

function actionButton(a: StartAction): HTMLButtonElement {
  const label = Object.assign(document.createElement("span"), { textContent: a.label });
  const b = button(a.primary ? "start-action primary" : "start-action", icon(a.icon), label, ...(a.keys ? [kbd(a.keys)] : []));
  b.addEventListener("click", () => a.run());
  return b;
}

/** 建立起始頁（最近開啟的清單之後用 `fillStartRecent` 補上，桌面版要先讀）。 */
export function buildStartPage(o: StartPageOptions): HTMLElement {
  const page = document.createElement("div");
  page.className = "start-page";

  const head = document.createElement("header");
  head.className = "start-head";
  const logo = document.createElement("img");
  logo.src = "favicon.svg";
  logo.alt = "";
  const title = document.createElement("div");
  const h = Object.assign(document.createElement("h2"), { textContent: "oMarker" });
  const p = Object.assign(document.createElement("p"), { textContent: o.hint });
  title.append(h, p);
  head.append(logo, title);

  const start = document.createElement("section");
  start.className = "start-main";
  start.append(heading(t("開始")), ...o.actions.map(actionButton));
  if (o.connect.length) start.append(heading(t("連線")), ...o.connect.map(actionButton));

  const recent = document.createElement("section");
  recent.className = "start-recent";
  recent.hidden = true;

  const cols = document.createElement("div");
  cols.className = "start-cols";
  cols.append(start, recent);

  const tips = document.createElement("footer");
  tips.className = "start-tips";
  for (const tip of o.tips) {
    const children = [...(tip.keys ? [kbd(tip.keys)] : []), tip.label];
    const run = tip.run;
    if (run) {
      const b = button("start-tip", ...children);
      b.addEventListener("click", () => run());
      tips.append(b);
    } else {
      const span = Object.assign(document.createElement("span"), { className: "start-tip" });
      span.append(...children);
      tips.append(span);
    }
  }
  if (o.tour) {
    const tour = button("start-tour", icon("book-open-text"), t("3 分鐘認識 oMarker"));
    tour.addEventListener("click", () => o.tour!());
    tips.append(tour);
  }

  page.append(head, cols, tips);
  return page;
}

/** 補上右欄「最近開啟的資料夾」「最近開啟的檔案」：名稱加上所在位置的最後兩層，完整路徑在滑鼠提示裡。 */
export function fillStartRecent(page: HTMLElement, r: StartRecent): void {
  const box = page.querySelector<HTMLElement>(".start-recent");
  if (!box) return;
  const row = (kind: "folder" | "file", path: string) => {
    const { name, where } = recentLabel(path);
    const b = button(
      "start-recent-item",
      icon(kind === "folder" ? "folder" : "file-text"),
      Object.assign(document.createElement("span"), { className: "start-recent-name", textContent: name }),
      Object.assign(document.createElement("span"), { className: "start-recent-where", textContent: where }),
    );
    b.title = r.display(path);
    b.addEventListener("click", () => (kind === "folder" ? r.openFolder(path) : r.openFile(path)));
    return b;
  };
  const parts: HTMLElement[] = [];
  if (r.folders.length) parts.push(heading(t("最近開啟的資料夾")), ...r.folders.map((p) => row("folder", p)));
  if (r.files.length) parts.push(heading(t("最近開啟的檔案")), ...r.files.map((p) => row("file", p)));
  box.replaceChildren(...parts);
  box.hidden = !parts.length;
  page.classList.toggle("has-recent", !!parts.length);
}
