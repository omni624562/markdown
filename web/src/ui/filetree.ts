/**
 * 工作區的檔案樹：延遲載入子資料夾、鍵盤操作（WAI-ARIA tree 模式）、右鍵選單、原地改名。
 */
import type { Entry } from "../desktop.ts";
import { dirname, isInside } from "../paths.ts";
import { icon } from "./icons.ts";

export type TreeAction = "new-file" | "new-folder" | "rename" | "trash" | "reveal" | "copy-path";

export interface FileTreeHandlers {
  list(dir: string): Promise<Entry[]>;
  open(path: string): void;
  action(action: TreeAction, entry: Entry): void;
}

const MENU: { action: TreeAction; label: string; dirOnly?: boolean; key?: string }[] = [
  { action: "new-file", label: "新增檔案", dirOnly: true },
  { action: "new-folder", label: "新增資料夾", dirOnly: true },
  { action: "rename", label: "重新命名", key: "F2" },
  { action: "trash", label: "移到資源回收筒", key: "Delete" },
  { action: "reveal", label: "在檔案總管中顯示" },
  { action: "copy-path", label: "複製路徑" },
];

export class FileTree {
  #el: HTMLElement;
  #handlers: FileTreeHandlers;
  #root: Entry | null = null;
  #expanded = new Set<string>();
  #active: string | null = null;
  #menu: HTMLElement;

  constructor(el: HTMLElement, handlers: FileTreeHandlers) {
    this.#el = el;
    this.#handlers = handlers;
    el.role = "tree";
    el.addEventListener("keydown", (e) => this.#onKey(e));

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

  get root(): Entry | null {
    return this.#root;
  }

  /** 換一個工作區（null 代表沒有開啟資料夾）。 */
  async setRoot(path: string | null, name = ""): Promise<void> {
    this.#expanded.clear();
    this.#root = path ? { path, name, isDir: true } : null;
    if (path) this.#expanded.add(path);
    await this.#renderAll();
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
      input.setAttribute("aria-label", kind === "rename" ? "新名稱" : kind === "folder" ? "資料夾名稱" : "檔案名稱");
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
      err.textContent = `無法讀取資料夾：${e instanceof Error ? e.message : e}`;
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
      empty.textContent = "這個資料夾裡沒有 Markdown、純文字或 JSON 檔案。";
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
    row.title = entry.path;
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
  }

  #entryOf(row: HTMLElement): Entry {
    return { path: row.dataset.path!, name: row.querySelector("span")!.textContent!, isDir: row.dataset.dir === "1" };
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
      ...MENU.filter((m) => !m.dirOnly || entry.isDir).map((m) => {
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
