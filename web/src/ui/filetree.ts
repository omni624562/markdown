/**
 * 工作區的檔案樹：延遲載入子資料夾、鍵盤操作（WAI-ARIA tree 模式）、右鍵選單、原地改名。
 */
import { displayPath, type Entry } from "../desktop.ts";
import { t } from "../i18n.ts";
import { dirname, isInside } from "../paths.ts";
import { icon } from "./icons.ts";

export type TreeAction = "new-file" | "new-folder" | "upload" | "download" | "rename" | "trash" | "reveal" | "copy-path";

export interface FileTreeHandlers {
  list(dir: string): Promise<Entry[]>;
  open(path: string): void;
  action(action: TreeAction, entry: Entry): void;
  /** 展開或收合了資料夾（記住每個專案展開到哪裡）。 */
  expandedChanged?(): void;
  /** 是不是遠端資料夾（SSH、WebDAV）：可以上傳、下載，不能在檔案總管中顯示。 */
  remote?(): boolean;
  /** 從電腦拖曳檔案到資料夾（只有遠端資料夾會用到）。 */
  dropFiles?(dir: string, files: File[]): void;
}

const MENU: { action: TreeAction; label: string; dirOnly?: boolean; fileOnly?: boolean; remote?: boolean; key?: string }[] = [
  { action: "new-file", label: t("新增檔案"), dirOnly: true },
  { action: "new-folder", label: t("新增資料夾"), dirOnly: true },
  { action: "upload", label: t("從電腦上傳檔案…"), dirOnly: true, remote: true },
  { action: "download", label: t("下載到電腦…"), fileOnly: true, remote: true },
  { action: "rename", label: t("重新命名"), key: "F2" },
  { action: "trash", label: t("移到資源回收筒"), key: "Delete" },
  { action: "reveal", label: t("在檔案總管中顯示") },
  { action: "copy-path", label: t("複製路徑") },
];

export class FileTree {
  #el: HTMLElement;
  #handlers: FileTreeHandlers;
  #root: Entry | null = null;
  #expanded = new Set<string>();
  #active: string | null = null;
  #menu: HTMLElement;
  /** Git 狀態：檔案路徑 → 標記（M、U、A、D、R、!），以及含有變更的資料夾。 */
  #status = new Map<string, string>();
  #changedDirs = new Set<string>();

  constructor(el: HTMLElement, handlers: FileTreeHandlers) {
    this.#el = el;
    this.#handlers = handlers;
    el.role = "tree";
    el.addEventListener("keydown", (e) => this.#onKey(e));
    this.#setupDrop();

    this.#menu = document.createElement("div");
    this.#menu.className = "menu";
    this.#menu.popover = "auto";
    this.#menu.role = "menu";
    this.#menu.addEventListener("keydown", (e) => {
      const items = [...this.#menu.querySelectorAll<HTMLElement>("button")];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
      else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
      else return;
      e.preventDefault();
    });
    document.body.append(this.#menu);
  }

  /** 遠端資料夾：從電腦拖曳檔案到資料夾（或檔案所在的資料夾）就上傳。 */
  #setupDrop(): void {
    const target = (e: DragEvent): HTMLElement | null => {
      if (!this.#root || !this.#handlers.remote?.() || !e.dataTransfer?.types.includes("Files")) return null;
      return (e.target as HTMLElement).closest<HTMLElement>(".tree-row") ?? this.#el;
    };
    const dirOf = (el: HTMLElement): string => {
      const path = el.dataset.path;
      if (!path) return this.#root!.path;
      return el.dataset.dir ? path : dirname(path);
    };
    const clear = () => this.#el.querySelectorAll(".tree-drop").forEach((n) => n.classList.remove("tree-drop"));
    this.#el.addEventListener("dragover", (e) => {
      const el = target(e);
      if (!el) return;
      e.preventDefault();
      // 不要讓整個視窗的「拖曳開檔」接手。
      e.stopPropagation();
      e.dataTransfer!.dropEffect = "copy";
      clear();
      const dir = dirOf(el);
      const row = dir === this.#root!.path ? this.#el : this.#el.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(dir)}"]`);
      row?.classList.add("tree-drop");
    });
    this.#el.addEventListener("dragleave", (e) => {
      if (!this.#el.contains(e.relatedTarget as Node)) clear();
    });
    this.#el.addEventListener("drop", (e) => {
      const el = target(e);
      clear();
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      // 視窗層的拖曳開檔也在數 dragenter／dragleave：讓它收起覆蓋層。
      window.dispatchEvent(new DragEvent("dragleave"));
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) this.#handlers.dropFiles?.(dirOf(el), files);
    });
  }

  get root(): Entry | null {
    return this.#root;
  }

  /** 換一個工作區（null 代表沒有開啟資料夾）；`expanded` 是要展開的資料夾（上次的狀態）。 */
  async setRoot(path: string | null, name = "", expanded: string[] = []): Promise<void> {
    this.#expanded.clear();
    this.#root = path ? { path, name, isDir: true } : null;
    if (path) {
      this.#expanded.add(path);
      for (const dir of expanded) if (isInside(dir, path)) this.#expanded.add(dir);
    }
    await this.#renderAll();
  }

  /** 目前展開的資料夾（不含根目錄）。 */
  get expanded(): string[] {
    return [...this.#expanded].filter((d) => d !== this.#root?.path);
  }

  /** 重新列出指定的資料夾（檔案監看通知有變動時呼叫）；不指定時全部重新整理。 */
  async refresh(dirs?: string[]): Promise<void> {
    if (!this.#root) return;
    if (!dirs) return this.#renderAll();
    for (const dir of dirs) {
      if (!this.#expanded.has(dir)) continue;
      const group = this.#el.querySelector<HTMLElement>(`[role=group][data-dir="${CSS.escape(dir)}"]`);
      if (group) await this.#fill(group, dir, Number(group.dataset.level));
      else if (dir === this.#root.path) await this.#renderAll();
    }
    this.#markActive();
  }

  /** 顯示 Git 狀態標記。`status` 的鍵是檔案路徑，值是一個字母（M、U、A、D、R、!）。 */
  setStatus(status: Map<string, string>): void {
    this.#status = status;
    this.#changedDirs = new Set();
    for (const path of status.keys()) {
      for (let dir = dirname(path); dir && dir !== dirname(dir); dir = dirname(dir)) {
        if (this.#changedDirs.has(dir)) break;
        this.#changedDirs.add(dir);
      }
    }
    for (const row of this.#el.querySelectorAll<HTMLElement>(".tree-row")) this.#decorate(row);
  }

  #decorate(row: HTMLElement): void {
    const path = row.dataset.path!;
    const mark = row.dataset.dir === "1" ? (this.#changedDirs.has(path) ? "•" : "") : (this.#status.get(path) ?? "");
    let badge = row.querySelector<HTMLElement>(".git-badge");
    if (!mark) {
      badge?.remove();
      row.removeAttribute("data-git");
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "git-badge";
      row.append(badge);
    }
    badge.textContent = mark;
    row.dataset.git = mark;
  }

  /** 標示目前開啟的檔案，並展開它所在的資料夾。 */
  async setActive(path: string | null): Promise<void> {
    this.#active = path;
    const root = this.#root?.path;
    if (path && root && path !== root && isInside(path, root)) {
      let collapsed = false;
      for (let dir = dirname(path); dir !== root && isInside(dir, root); dir = dirname(dir)) {
        if (!this.#expanded.has(dir)) {
          this.#expanded.add(dir);
          collapsed = true;
        }
      }
      if (collapsed) return this.#renderAll();
    }
    this.#markActive();
  }

  /** 在資料夾內顯示一個輸入框，讓使用者輸入新項目名稱。回傳輸入的名稱，取消時為 null。 */
  async promptName(dir: string, initial: string, kind: "file" | "folder" | "rename", target?: string): Promise<string | null> {
    if (dir !== this.#root?.path && !this.#expanded.has(dir)) {
      this.#expanded.add(dir);
      await this.refresh([dir]);
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.className = "tree-input";
      input.value = initial;
      input.setAttribute("aria-label", kind === "rename" ? t("新名稱") : kind === "folder" ? t("資料夾名稱") : t("檔案名稱"));
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        row.remove();
        if (targetRow) targetRow.hidden = false;
        resolve(value?.trim() ? value.trim() : null);
      };
      input.addEventListener("keydown", (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") finish(input.value);
        else if (e.key === "Escape") finish(null);
        else return;
        e.preventDefault();
        e.stopPropagation();
      });
      input.addEventListener("blur", () => finish(input.value));

      const row = document.createElement("div");
      row.className = "tree-row tree-editing";
      let targetRow: HTMLElement | null = null;
      if (kind === "rename" && target) {
        targetRow = this.#el.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(target)}"]`);
        row.style.setProperty("--level", targetRow?.style.getPropertyValue("--level") || "0");
        row.append(icon(targetRow?.dataset.dir === "1" ? "folder" : "file-text"), input);
        targetRow?.after(row);
        if (targetRow) targetRow.hidden = true;
      } else {
        const group =
          dir === this.#root?.path
            ? this.#el
            : this.#el.querySelector<HTMLElement>(`[role=group][data-dir="${CSS.escape(dir)}"]`);
        const level = group === this.#el ? 0 : Number(group?.dataset.level ?? 0);
        row.style.setProperty("--level", String(level));
        row.append(icon(kind === "folder" ? "folder" : "file-text"), input);
        (group ?? this.#el).prepend(row);
      }
      input.focus();
      // 預設只選取檔名，不含副檔名。
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, kind !== "folder" && dot > 0 ? dot : initial.length);
    });
  }

  async #renderAll(): Promise<void> {
    if (!this.#root) {
      this.#el.replaceChildren();
      return;
    }
    await this.#fill(this.#el, this.#root.path, 0);
    this.#markActive();
  }

  async #fill(container: HTMLElement, dir: string, level: number): Promise<void> {
    let entries: Entry[];
    try {
      entries = await this.#handlers.list(dir);
    } catch (e) {
      const err = document.createElement("p");
      err.className = "tree-empty";
      err.textContent = t("無法讀取資料夾：{error}", { error: e instanceof Error ? e.message : String(e) });
      container.replaceChildren(err);
      return;
    }
    const items: HTMLElement[] = [];
    for (const entry of entries) {
      const item = document.createElement("div");
      item.role = "none";
      const row = this.#row(entry, level);
      item.append(row);
      if (entry.isDir && this.#expanded.has(entry.path)) {
        const group = this.#group(entry.path, level + 1);
        item.append(group);
        await this.#fill(group, entry.path, level + 1);
      }
      items.push(item);
    }
    if (!entries.length && container === this.#el) {
      const empty = document.createElement("p");
      empty.className = "tree-empty";
      empty.textContent = t("這個資料夾裡沒有 Markdown、純文字或 JSON 檔案。");
      items.push(empty);
    }
    container.replaceChildren(...items);
  }

  #group(dir: string, level: number): HTMLElement {
    const g = document.createElement("div");
    g.role = "group";
    g.dataset.dir = dir;
    g.dataset.level = String(level);
    return g;
  }

  #row(entry: Entry, level: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.role = "treeitem";
    row.tabIndex = -1;
    row.dataset.path = entry.path;
    row.dataset.dir = entry.isDir ? "1" : "";
    row.title = entry.detail ? `${displayPath(entry.path)}\n${entry.detail}` : displayPath(entry.path);
    row.style.setProperty("--level", String(level));
    if (entry.isDir) {
      row.setAttribute("aria-expanded", String(this.#expanded.has(entry.path)));
      row.append(icon("chevron-right"), icon("folder"));
    } else {
      row.append(icon("file-text"));
    }
    const name = document.createElement("span");
    name.textContent = entry.name;
    row.append(name);
    this.#decorate(row);
    row.addEventListener("click", () => {
      this.#focus(row);
      if (entry.isDir) void this.#toggle(row, entry);
      else this.#handlers.open(entry.path);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.#focus(row);
      const show = () => this.#showMenu(entry, e.clientX, e.clientY);
      // Linux 等系統在按下右鍵時就觸發 contextmenu，放開時會被當成點在選單外而立刻關閉，所以等放開後再顯示。
      if (e.buttons & 2) window.addEventListener("pointerup", () => setTimeout(show), { once: true });
      else show();
    });
    return row;
  }

  async #toggle(row: HTMLElement, entry: Entry, expand?: boolean): Promise<void> {
    const open = expand ?? !this.#expanded.has(entry.path);
    const item = row.parentElement!;
    if (open) {
      this.#expanded.add(entry.path);
      const level = Number(row.style.getPropertyValue("--level")) + 1;
      const group = this.#group(entry.path, level);
      item.querySelector(":scope > [role=group]")?.remove();
      item.append(group);
      await this.#fill(group, entry.path, level);
      this.#markActive();
    } else {
      this.#expanded.delete(entry.path);
      item.querySelector(":scope > [role=group]")?.remove();
    }
    row.setAttribute("aria-expanded", String(open));
    this.#handlers.expandedChanged?.();
  }

  #entryOf(row: HTMLElement): Entry {
    return { path: row.dataset.path!, name: row.querySelector("span:not(.git-badge)")!.textContent!, isDir: row.dataset.dir === "1" };
  }

  #focus(row: HTMLElement): void {
    for (const r of this.#el.querySelectorAll<HTMLElement>(".tree-row[tabindex='0']")) r.tabIndex = -1;
    row.tabIndex = 0;
    row.focus();
  }

  #markActive(): void {
    let found = false;
    for (const row of this.#el.querySelectorAll<HTMLElement>(".tree-row")) {
      const on = row.dataset.path === this.#active;
      row.setAttribute("aria-selected", String(on));
      if (on) {
        found = true;
        row.scrollIntoView({ block: "nearest" });
      }
    }
    // 至少讓一列可以用 Tab 鍵聚焦。
    if (!this.#el.querySelector(".tree-row[tabindex='0']")) {
      const first = this.#el.querySelector<HTMLElement>(found ? ".tree-row[aria-selected=true]" : ".tree-row");
      if (first) first.tabIndex = 0;
    }
  }

  #onKey(e: KeyboardEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!row || e.isComposing || (e.target as HTMLElement).tagName === "INPUT") return;
    const rows = [...this.#el.querySelectorAll<HTMLElement>(".tree-row:not([hidden])")];
    const i = rows.indexOf(row);
    const entry = this.#entryOf(row);
    switch (e.key) {
      case "ArrowDown":
        if (rows[i + 1]) this.#focus(rows[i + 1]);
        break;
      case "ArrowUp":
        if (rows[i - 1]) this.#focus(rows[i - 1]);
        break;
      case "ArrowRight":
        if (entry.isDir && row.getAttribute("aria-expanded") !== "true") void this.#toggle(row, entry, true);
        else if (rows[i + 1]) this.#focus(rows[i + 1]);
        break;
      case "ArrowLeft":
        if (entry.isDir && row.getAttribute("aria-expanded") === "true") void this.#toggle(row, entry, false);
        else {
          const parent = row.parentElement?.parentElement?.closest("[role=none]")?.querySelector<HTMLElement>(":scope > .tree-row");
          if (parent) this.#focus(parent);
        }
        break;
      case "Enter":
        if (entry.isDir) void this.#toggle(row, entry);
        else this.#handlers.open(entry.path);
        break;
      case "F2":
        this.#handlers.action("rename", entry);
        break;
      case "Delete":
        this.#handlers.action("trash", entry);
        break;
      case "ContextMenu": {
        const r = row.getBoundingClientRect();
        this.#showMenu(entry, r.left + 24, r.bottom);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  #showMenu(entry: Entry, x: number, y: number): void {
    this.#menu.replaceChildren(
      ...MENU.filter((m) => {
        const remote = !!this.#handlers.remote?.();
        if ((m.dirOnly && !entry.isDir) || (m.fileOnly && entry.isDir)) return false;
        // 遠端資料夾才能上傳、下載；遠端的檔案不在這台電腦上，不能在檔案總管中顯示。
        return m.remote ? remote : !(remote && m.action === "reveal");
      }).map((m) => {
        const b = document.createElement("button");
        b.type = "button";
        b.role = "menuitem";
        b.append(Object.assign(document.createElement("span"), { textContent: m.label }));
        if (m.key) b.append(Object.assign(document.createElement("kbd"), { textContent: m.key }));
        b.addEventListener("click", () => {
          this.#menu.hidePopover();
          this.#handlers.action(m.action, entry);
        });
        return b;
      }),
    );
    this.#menu.style.left = `${Math.min(x, window.innerWidth - 240)}px`;
    this.#menu.style.top = `${Math.min(y, window.innerHeight - 260)}px`;
    this.#menu.style.right = "auto";
    this.#menu.showPopover();
    this.#menu.querySelector<HTMLElement>("button")?.focus();
  }
}
