/**
 * 專案（開過的資料夾）：切換器、專案總覽、專案設定（名稱、顏色、群組、釘選）。桌面版才有。
 */
import { type DavConnection, type Desktop, displayPath, type Project, type ProjectChange } from "../desktop.ts";
import { timeAgo } from "../history-label.ts";
import { PROJECT_COLORS, projectGroups, projectSections, samePath } from "../projects.ts";
import { choose } from "./choice.ts";
import { icon } from "./icons.ts";
import { Picker } from "./picker.ts";
import { toast } from "./toast.ts";

export interface ProjectHooks {
  /** 目前開啟的資料夾路徑。 */
  current(): string | null;
  /** 開啟（切換到）專案。 */
  open(path: string): Promise<void>;
  /** 開啟其他資料夾（選擇資料夾的對話框）。 */
  openFolder(): void;
  remotes(): Promise<DavConnection[]>;
  openRemote(c: DavConnection): void;
  /** 專案的名稱、顏色等改了（更新側邊欄與狀態列）。 */
  changed(): void;
  /** 專案裡有沒有還沒存檔的分頁。 */
  unsaved(path: string): boolean;
}

type SwitchItem =
  | { kind: "project"; project: Project; section: string }
  | { kind: "remote"; remote: DavConnection }
  | { kind: "action"; id: "open-folder" | "overview" | "edit"; title: string; icon: string };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function dot(color: string | null): HTMLElement {
  const el = document.createElement("span");
  el.className = "project-dot";
  if (color) el.dataset.color = color;
  return el;
}

function button(label: string, iconName: string, onClick: () => void, cls = "btn icon-only"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(iconName));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export class ProjectUi {
  #d: Desktop;
  #h: ProjectHooks;
  #list: Project[] = [];
  #switcher: Picker<SwitchItem>;
  #overview: HTMLDialogElement | null = null;
  #query = "";

  constructor(d: Desktop, hooks: ProjectHooks) {
    this.#d = d;
    this.#h = hooks;
    this.#switcher = new Picker<SwitchItem>({
      label: "切換專案",
      placeholder: "搜尋專案（名稱、群組或路徑）…",
      empty: "找不到符合的專案",
      query: (text) => this.#switchItems(text),
      render: (item) => {
        if (item.kind === "project") {
          const p = item.project;
          const here = this.#isCurrent(p);
          const dirty = !here && this.#h.unsaved(p.path) ? "● 有沒存檔的分頁　" : "";
          return {
            title: p.label,
            detail: here ? "目前的專案" : dirty + displayPath(p.path),
            color: p.color,
            section: item.section,
          };
        }
        if (item.kind === "remote") {
          return { title: item.remote.name, detail: item.remote.url, icon: "cloud", section: "WebDAV" };
        }
        return { title: item.title, icon: item.icon, section: "動作" };
      },
      pick: (item) => {
        if (item.kind === "project") void this.#open(item.project);
        else if (item.kind === "remote") this.#h.openRemote(item.remote);
        else if (item.id === "open-folder") this.#h.openFolder();
        else if (item.id === "overview") void this.openOverview();
        else {
          const p = this.current;
          if (p) void this.edit(p);
        }
      },
    });
  }

  /** 重新讀取專案清單。 */
  async refresh(): Promise<Project[]> {
    this.#list = await this.#d.projects().catch(() => this.#list);
    return this.#list;
  }

  /** 目前開啟的專案（還沒讀過清單時是 undefined）。 */
  get current(): Project | undefined {
    const path = this.#h.current();
    return path ? this.#list.find((p) => samePath(p.path, path)) : undefined;
  }

  #isCurrent(p: Project): boolean {
    const path = this.#h.current();
    return !!path && samePath(p.path, path);
  }

  async openSwitcher(): Promise<void> {
    await this.refresh();
    this.#switcher.open();
  }

  async #switchItems(text: string): Promise<SwitchItem[]> {
    const items: SwitchItem[] = [];
    for (const s of projectSections(this.#list, text)) {
      for (const project of s.items) items.push({ kind: "project", project, section: s.title });
    }
    const q = text.trim().toLowerCase();
    const remotes = await this.#h.remotes().catch(() => []);
    for (const remote of remotes) {
      if (!q || `${remote.name} ${remote.url}`.toLowerCase().includes(q)) items.push({ kind: "remote", remote });
    }
    const actions: SwitchItem[] = [
      { kind: "action", id: "open-folder", title: "開啟資料夾…", icon: "folder-open" },
      { kind: "action", id: "overview", title: "專案總覽", icon: "layout-grid" },
    ];
    if (this.current) actions.push({ kind: "action", id: "edit", title: "目前專案的設定…", icon: "pencil" });
    for (const a of actions) if (a.kind === "action" && (!q || a.title.toLowerCase().includes(q))) items.push(a);
    return items;
  }

  async #open(p: Project): Promise<void> {
    if (this.#isCurrent(p)) return;
    this.#overview?.close();
    await this.#h.open(p.path);
    await this.refresh();
    this.#renderOverview();
  }

  // ---- 專案總覽 ------------------------------------------------------------

  async openOverview(): Promise<void> {
    await this.refresh();
    if (!this.#overview) this.#overview = this.#buildOverview();
    this.#renderOverview();
    if (!this.#overview.open) this.#overview.showModal();
    this.#overview.querySelector<HTMLInputElement>(".po-search")!.focus();
  }

  #buildOverview(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "choice project-overview";
    dialog.setAttribute("aria-labelledby", "po-title");
    dialog.innerHTML = `
      <div class="po-head">
        <h2 id="po-title">專案總覽</h2>
        <input type="search" class="po-search" placeholder="搜尋專案（名稱、群組或路徑）…" aria-label="搜尋專案" spellcheck="false" />
      </div>
      <div class="po-body"></div>`;
    const head = dialog.querySelector(".po-head")!;
    const open = button("開啟資料夾…", "folder-open", () => {
      dialog.close();
      this.#h.openFolder();
    }, "btn");
    open.append("開啟資料夾…");
    head.append(open, button("關閉", "x", () => dialog.close()));
    const search = dialog.querySelector<HTMLInputElement>(".po-search")!;
    search.addEventListener("input", () => {
      this.#query = search.value;
      this.#renderOverview();
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    document.body.append(dialog);
    return dialog;
  }

  #renderOverview(): void {
    const dialog = this.#overview;
    if (!dialog) return;
    const body = dialog.querySelector(".po-body")!;
    const sections = projectSections(this.#list, this.#query);
    if (!sections.length) {
      const p = document.createElement("p");
      p.className = "po-empty";
      p.textContent = this.#list.length ? "找不到符合的專案" : "還沒有專案。開啟一個資料夾，它就會出現在這裡。";
      body.replaceChildren(p);
      return;
    }
    body.replaceChildren(
      ...sections.map((s) => {
        const section = document.createElement("section");
        section.className = "po-section";
        const h = document.createElement("h3");
        h.textContent = `${s.title}（${s.items.length}）`;
        const grid = document.createElement("ul");
        grid.className = "po-grid";
        grid.append(...s.items.map((p) => this.#card(p)));
        section.append(h, grid);
        return section;
      }),
    );
  }

  #card(p: Project): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "po-card";
    if (p.color) li.dataset.color = p.color;
    const here = this.#isCurrent(p);
    const main = document.createElement("button");
    main.type = "button";
    main.className = "po-open";
    main.title = here ? "目前的專案" : `開啟「${p.label}」`;
    const name = document.createElement("span");
    name.className = "po-name";
    name.append(dot(p.color), Object.assign(document.createElement("span"), { textContent: p.label }));
    if (here) name.append(Object.assign(document.createElement("span"), { className: "po-badge", textContent: "目前" }));
    const path = Object.assign(document.createElement("span"), { className: "po-path", textContent: displayPath(p.path) });
    const meta: string[] = [];
    if (p.pinned && p.group) meta.push(p.group);
    meta.push(p.lastOpened ? `${timeAgo(p.lastOpened)}開啟` : "很久以前開啟");
    if (!here && this.#h.unsaved(p.path)) meta.push("● 有沒存檔的分頁");
    const info = Object.assign(document.createElement("span"), { className: "po-meta", textContent: meta.join(" · ") });
    main.append(name, path, info);
    main.addEventListener("click", () => void this.#open(p).catch((e) => toast(message(e), { tone: "error", duration: 10000 })));
    const actions = document.createElement("div");
    actions.className = "po-actions";
    actions.append(
      button(p.pinned ? "取消釘選" : "釘選", p.pinned ? "pin-off" : "pin", () => void this.#save(p, { ...this.#changeOf(p), pinned: !p.pinned })),
      button("專案設定…", "pencil", () => void this.edit(p)),
      button("在檔案總管中顯示", "folder-open", () => void this.#d.projectReveal(p.path).catch((e) => toast(message(e), { tone: "error" }))),
      button("從清單移除", "x", () => void this.#forget(p)),
    );
    li.append(main, actions);
    return li;
  }

  #changeOf(p: Project): ProjectChange {
    return { name: p.name, color: p.color, group: p.group, pinned: p.pinned };
  }

  async #save(p: Project, change: ProjectChange): Promise<boolean> {
    try {
      await this.#d.projectUpdate(p.path, change);
    } catch (e) {
      toast(message(e), { tone: "error" });
      return false;
    }
    await this.refresh();
    this.#renderOverview();
    this.#h.changed();
    return true;
  }

  async #forget(p: Project): Promise<void> {
    const ok = await choose(
      "從清單移除",
      `「${p.label}」會從專案清單移除（名稱、顏色、群組的設定也會一起清掉）。資料夾和裡面的檔案都不會動，之後再開啟這個資料夾就會重新加入。`,
      [
        { id: "cancel", label: "取消" },
        { id: "go", label: "移除", danger: true },
      ],
    );
    if (ok !== "go") return;
    await this.#d.projectForget(p.path).catch((e) => toast(message(e), { tone: "error" }));
    await this.refresh();
    this.#renderOverview();
    this.#h.changed();
  }

  // ---- 專案設定 ------------------------------------------------------------

  /** 編輯專案的名稱、顏色、群組與釘選。 */
  async edit(p: Project): Promise<void> {
    await this.refresh();
    const dialog = document.createElement("dialog");
    dialog.className = "choice project-edit";
    dialog.setAttribute("aria-labelledby", "pe-title");
    const colors = [{ id: "", label: "不設定" }, ...PROJECT_COLORS]
      .map(
        (c) =>
          `<label class="pe-color" title="${c.label}"><input type="radio" name="color" value="${c.id}" aria-label="${c.label}" /><span class="project-dot"${c.id ? ` data-color="${c.id}"` : ""}></span></label>`,
      )
      .join("");
    dialog.innerHTML = `
      <form method="dialog">
        <h2 id="pe-title">專案設定</h2>
        <p class="pe-path"></p>
        <label>名稱<input name="name" maxlength="80" spellcheck="false" /></label>
        <label>群組<input name="group" maxlength="40" list="pe-groups" spellcheck="false" placeholder="例如：公司 TFS、個人（留白就是不分組）" /></label>
        <datalist id="pe-groups"></datalist>
        <fieldset class="pe-colors"><legend>顏色</legend>${colors}</fieldset>
        <label class="pe-check"><input type="checkbox" name="pinned" /> 釘選在清單最上面</label>
        <p class="dav-error" role="alert" hidden></p>
        <div class="choice-actions">
          <button type="button" class="btn pe-relocate">重新指定位置…</button>
          <span class="pe-spacer"></span>
          <button type="button" class="btn" value="cancel">取消</button>
          <button type="submit" class="btn btn-primary">儲存</button>
        </div>
      </form>`;
    const q = <T extends HTMLElement>(sel: string) => dialog.querySelector<T>(sel)!;
    q(".pe-path").textContent = displayPath(p.path);
    const name = q<HTMLInputElement>("input[name=name]");
    name.value = p.name ?? "";
    name.placeholder = p.name ? "" : p.label;
    const group = q<HTMLInputElement>("input[name=group]");
    group.value = p.group ?? "";
    q("#pe-groups").append(...projectGroups(this.#list).map((g) => Object.assign(document.createElement("option"), { value: g })));
    const radio = dialog.querySelector<HTMLInputElement>(`input[name=color][value="${p.color ?? ""}"]`);
    if (radio) radio.checked = true;
    q<HTMLInputElement>("input[name=pinned]").checked = p.pinned;
    const error = q(".dav-error");

    q("[value=cancel]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => dialog.remove());
    q(".pe-relocate").addEventListener("click", () => {
      void (async () => {
        try {
          const moved = await this.#d.projectRelocate(p.path);
          if (!moved) return;
          dialog.close();
          await this.refresh();
          this.#renderOverview();
          this.#h.changed();
          toast(`已把「${moved.label}」改到 ${displayPath(moved.path)}`, { tone: "success" });
        } catch (e) {
          error.hidden = false;
          error.textContent = message(e);
        }
      })();
    });
    q("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const color = dialog.querySelector<HTMLInputElement>("input[name=color]:checked")?.value || null;
      void (async () => {
        try {
          await this.#d.projectUpdate(p.path, {
            name: name.value.trim() || null,
            group: group.value.trim() || null,
            color,
            pinned: q<HTMLInputElement>("input[name=pinned]").checked,
          });
        } catch (e) {
          error.hidden = false;
          error.textContent = message(e);
          return;
        }
        dialog.close();
        await this.refresh();
        this.#renderOverview();
        this.#h.changed();
      })();
    });
    document.body.append(dialog);
    dialog.showModal();
    name.focus();
  }
}
