/**
 * 留言框裡打 @ 跳出同事清單：先列專案預設團隊的成員，打了字再用伺服器的身分搜尋補上團隊以外的人
 * （和網頁版一樣）。選了之後插入「@名字」，送出時換成 Azure DevOps 的 @，對方會收到通知。
 */
import { type AdoTeamMember, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { type Mention, insertMention, mentionQuery } from "../mentions.ts";
import { shortcutHue, shortcutInitial } from "../wiki-shortcuts.ts";

/** 清單最多列幾個人。 */
const MAX = 8;

/** 每個專案的預設團隊成員（只讀一次；讀不到時下次再試）。 */
const teams = new Map<string, Promise<AdoTeamMember[]>>();

function projectMembers(project: string): Promise<AdoTeamMember[]> {
  let members = teams.get(project);
  if (!members) {
    members = desktop!.adoProjectMembers(project).catch(() => {
      teams.delete(project);
      return [];
    });
    teams.set(project, members);
  }
  return members;
}

const matches = (m: AdoTeamMember, query: string) => {
  const q = query.toLowerCase();
  return !q || m.name.toLowerCase().includes(q) || m.unique.toLowerCase().includes(q);
};

let lists = 0;

export interface MentionPicker {
  /** 這次選過的人（送出時把「@名字」換成 @）。 */
  mentions(): Mention[];
}

/**
 * 在留言框加上 @ 的清單。要在留言框自己的按鍵處理之前呼叫：清單開著時 Enter、Tab 是選人，Esc 是關清單。
 * `initial` 是原本就有的 @（編輯留言時）。
 */
export function mentionPicker(textarea: HTMLTextAreaElement, project: () => string, initial: Mention[] = []): MentionPicker {
  const chosen = new Map(initial.map((m) => [m.id, m]));
  const list = document.createElement("ul");
  list.className = "mention-list";
  list.id = `mention-list-${++lists}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("要 @ 的人"));
  list.hidden = true;
  textarea.setAttribute("aria-autocomplete", "list");
  let items: AdoTeamMember[] = [];
  let active = 0;
  let seq = 0;
  let at: { start: number; query: string } | null = null;

  const close = () => {
    seq++;
    at = null;
    items = [];
    list.hidden = true;
    textarea.removeAttribute("aria-activedescendant");
    textarea.removeAttribute("aria-expanded");
  };
  const highlight = () => {
    for (const [i, li] of [...list.children].entries()) li.setAttribute("aria-selected", String(i === active));
    const li = list.children[active] as HTMLElement | undefined;
    if (li?.id) textarea.setAttribute("aria-activedescendant", li.id);
    li?.scrollIntoView({ block: "nearest" });
  };
  const pick = (i: number) => {
    const m = items[i];
    if (!m || !at) return;
    const r = insertMention(textarea.value, at.start, textarea.selectionStart, m.name);
    textarea.value = r.text;
    textarea.setSelectionRange(r.caret, r.caret);
    chosen.set(m.id, { name: m.name, id: m.id });
    close();
    textarea.focus();
  };
  /** 畫出清單；`searching` 為 true 時還在找，沒有結果先不說找不到。 */
  const show = (people: AdoTeamMember[], searching: boolean) => {
    items = people.slice(0, MAX);
    active = 0;
    if (!list.isConnected) textarea.after(list);
    list.replaceChildren(
      ...items.map((m, i) => {
        const li = document.createElement("li");
        li.id = `${list.id}-${i}`;
        li.setAttribute("role", "option");
        const avatar = document.createElement("span");
        avatar.className = "mention-avatar";
        avatar.textContent = shortcutInitial(m.name);
        avatar.style.setProperty("--hue", String(shortcutHue(m.name)));
        avatar.setAttribute("aria-hidden", "true");
        const name = Object.assign(document.createElement("span"), { className: "mention-name", textContent: m.name });
        const who = Object.assign(document.createElement("span"), { className: "mention-unique", textContent: m.unique });
        li.append(avatar, name, who);
        // 按下去時焦點不要離開留言框。
        li.addEventListener("mousedown", (e) => e.preventDefault());
        li.addEventListener("click", () => pick(i));
        li.addEventListener("mouseenter", () => {
          active = i;
          highlight();
        });
        return li;
      }),
    );
    if (!items.length) {
      if (searching || !at?.query) {
        list.hidden = true;
        return;
      }
      const none = Object.assign(document.createElement("li"), { className: "mention-none", textContent: t("找不到「{name}」", { name: at.query }) });
      list.append(none);
    }
    list.hidden = false;
    textarea.setAttribute("aria-expanded", "true");
    textarea.setAttribute("aria-controls", list.id);
    highlight();
  };
  const update = async () => {
    const q = textarea.selectionStart === textarea.selectionEnd ? mentionQuery(textarea.value, textarea.selectionStart) : null;
    if (!q || !desktop) return close();
    at = q;
    const mine = ++seq;
    const name = project();
    const team = (name ? await projectMembers(name) : []).filter((m) => m.id && matches(m, q.query));
    if (mine !== seq) return;
    show(team, !!q.query);
    if (!q.query) return;
    // 打了字：等一下再用伺服器的身分搜尋（打字很快時只找最後一次）。
    await new Promise((r) => setTimeout(r, 250));
    if (mine !== seq) return;
    const found = await desktop.adoSearchPeople(q.query).catch(() => [] as AdoTeamMember[]);
    if (mine !== seq) return;
    const ids = new Set(team.map((m) => m.id.toLowerCase()));
    show([...team, ...found.filter((m) => m.id && !ids.has(m.id.toLowerCase()))], false);
  };

  textarea.addEventListener("input", () => void update());
  textarea.addEventListener("keydown", (e) => {
    if (list.hidden || e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      highlight();
    } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey) || e.key === "Tab") {
      if (!items.length) return close();
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  });
  textarea.addEventListener("blur", () => setTimeout(() => document.activeElement !== textarea && close(), 150));
  return { mentions: () => [...chosen.values()] };
}
