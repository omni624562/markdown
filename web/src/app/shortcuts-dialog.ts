/**
 * 快速鍵（F1）：依功能分組列出所有快速鍵；按一下快速鍵就能錄製新的按法、拿掉，或還原成預設。
 * 自訂的快速鍵存在設定的 `keybindings`，改了之後指令中心會立刻套用。
 */
import { type Command, formatKeys, fuzzyScore, isMac, keysFromEvent, keysProblem, normalizeKeys, withBinding } from "../commands.ts";
import { t } from "../i18n.ts";
import { choose } from "../ui/choice.ts";
import { icon } from "../ui/icons.ts";
import { sortByGroup } from "../ui/palette.ts";
import { app } from "./context.ts";
import { commands } from "./commands.ts";

/** 錄製中的按法有問題（沒有修飾鍵、基本按鍵），或跟別的指令撞到。 */
type Note =
  | { kind: "problem"; text: string }
  | { kind: "conflict"; keys: string; others: Command[] };

function kbd(text: string): HTMLElement {
  return Object.assign(document.createElement("kbd"), { textContent: text });
}

function button(label: string, className = "btn", iconName?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  if (iconName) b.append(icon(iconName));
  b.append(Object.assign(document.createElement("span"), { textContent: label }));
  return b;
}

const noModifiers = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

export function showShortcuts(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "choice shortcuts-dialog";
  dialog.setAttribute("aria-label", t("快速鍵"));
  const h = document.createElement("h2");
  h.textContent = t("快速鍵");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "shortcuts-search";
  search.placeholder = t("搜尋指令或快速鍵");
  search.setAttribute("aria-label", t("搜尋指令或快速鍵"));
  search.autofocus = true;
  const hint = document.createElement("p");
  hint.className = "shortcuts-hint";
  hint.textContent = t("按一下快速鍵，就能換成你習慣的按法；搜尋可以找到還沒有快速鍵的指令。");
  const body = document.createElement("div");
  body.className = "shortcuts-body";
  const resetAll = button(t("全部還原成預設"), "btn", "rotate-ccw");
  const close = button(t("關閉"), "btn btn-primary");
  const actions = document.createElement("div");
  actions.className = "choice-actions shortcuts-actions";
  actions.append(resetAll, close);
  dialog.append(h, search, hint, body, actions);

  /** 正在錄製哪個指令的快速鍵。 */
  let editing: string | null = null;
  let note: Note | null = null;

  const customized = () => app.settings.value.keybindings;

  /** 列出的指令：沒有搜尋時是有快速鍵（或自訂過）的；搜尋時是所有符合的指令。同一個 id 只列一次。 */
  function listed(): Command[] {
    const q = search.value.trim();
    const seen = new Set<string>();
    return sortByGroup(
      commands.all().filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        const keys = c.keys ?? c.shownKeys;
        if (!q) return !!keys || Object.hasOwn(customized(), c.id);
        return fuzzyScore(q, `${c.title} ${c.group} ${keys ? formatKeys(keys) : ""}`) > 0;
      }),
    );
  }

  function save(id: string, keys: string | null, unbind: readonly Command[] = []): void {
    const next = withBinding(customized(), id, keys, (x) => commands.defaultKeys(x), unbind.map((c) => c.id));
    editing = null;
    note = null;
    app.settings.update({ keybindings: next });
    render(id);
  }

  /**
   * 改成 `keys`：跟別的指令撞到時先問要不要改用在這裡。內建就共用同一組快速鍵的
   * （例如「格式化 JSON」和「對齊所有表格」，各自只在不同的文件裡能用）不算撞到。
   */
  function setKeys(id: string, keys: string): void {
    const builtIn = (x: string) => {
      const def = commands.defaultKeys(x);
      return !!def && normalizeKeys(def) === normalizeKeys(keys);
    };
    const others = commands.usedBy(keys, id).filter((o) => !(builtIn(id) && builtIn(o.id)));
    if (!others.length) return save(id, keys);
    editing = id;
    note = { kind: "conflict", keys, others };
    render(id);
  }

  function stop(focusId?: string): void {
    editing = null;
    note = null;
    render(focusId);
  }

  function noteRow(table: HTMLTableElement, c: Command): void {
    const row = table.insertRow();
    row.className = "shortcut-note";
    const td = row.insertCell();
    td.colSpan = 2;
    const cell = document.createElement("div");
    td.append(cell);
    if (!note) {
      cell.textContent = t("按下新的組合鍵。Esc 取消，Backspace 拿掉這個快速鍵。");
      return;
    }
    if (note.kind === "problem") {
      cell.classList.add("shortcut-problem");
      cell.textContent = note.text;
      return;
    }
    const { keys, others } = note;
    cell.classList.add("shortcut-conflict");
    const text = document.createElement("span");
    text.textContent = t("{keys} 已經是「{title}」的快速鍵。", {
      keys: formatKeys(keys),
      title: others.map((o) => o.title).join(t("、")),
    });
    const take = button(t("改用在這裡"), "btn btn-primary");
    take.addEventListener("click", () => save(c.id, keys, others));
    const cancel = button(t("取消"));
    cancel.addEventListener("click", () => stop(c.id));
    cell.append(text, take, cancel);
    queueMicrotask(() => take.focus());
  }

  function keyCell(row: HTMLTableRowElement, c: Command): void {
    const cell = row.insertCell();
    cell.className = "shortcut-keys";
    const keys = c.keys ?? c.shownKeys;
    const custom = Object.hasOwn(customized(), c.id);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "shortcut-key";
    edit.dataset.id = c.id;
    edit.setAttribute("aria-label", t("變更「{title}」的快速鍵", { title: c.title }));
    if (editing === c.id) {
      edit.classList.add("recording");
      edit.textContent = t("請按下快速鍵…");
    } else if (keys) {
      edit.append(kbd(formatKeys(keys)));
      edit.title = t("按一下換成別的按法");
    } else {
      edit.classList.add("empty");
      edit.textContent = t("設定快速鍵");
    }
    edit.addEventListener("click", () => {
      editing = editing === c.id ? null : c.id;
      note = null;
      render(c.id);
    });
    const wrap = document.createElement("span");
    wrap.className = "shortcut-keys-wrap";
    wrap.append(edit);
    cell.append(wrap);
    if (custom) {
      row.classList.add("custom");
      const def = commands.defaultKeys(c.id);
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "btn icon-only shortcut-reset";
      reset.title = def ? t("還原成預設（{keys}）", { keys: formatKeys(def) }) : t("還原成預設（沒有快速鍵）");
      reset.setAttribute("aria-label", reset.title);
      reset.append(icon("rotate-ccw"));
      wrap.append(reset);
      reset.addEventListener("click", () => (def ? setKeys(c.id, def) : save(c.id, null)));
    }
  }

  function render(focusId?: string): void {
    const top = body.scrollTop;
    body.replaceChildren();
    const groups = new Map<string, Command[]>();
    for (const c of listed()) {
      const list = groups.get(c.group ?? "") ?? [];
      list.push(c);
      groups.set(c.group ?? "", list);
    }
    for (const [group, items] of groups) {
      const g = document.createElement("h3");
      g.textContent = group;
      const table = document.createElement("table");
      for (const c of items) {
        const row = table.insertRow();
        row.insertCell().textContent = c.title;
        keyCell(row, c);
        if (editing === c.id) noteRow(table, c);
      }
      body.append(g, table);
    }
    if (!groups.size) {
      const empty = document.createElement("p");
      empty.className = "shortcuts-empty";
      empty.textContent = t("找不到符合的指令。");
      body.append(empty);
    }
    body.scrollTop = top;
    resetAll.hidden = !Object.keys(customized()).length;
    if (focusId && !(note?.kind === "conflict")) {
      body.querySelector<HTMLElement>(`.shortcut-key[data-id="${CSS.escape(focusId)}"]`)?.focus();
    }
  }

  // 錄製：在捕獲階段攔下所有按鍵（包括 Esc，不讓對話框關掉）。
  dialog.addEventListener(
    "keydown",
    (e) => {
      if (!editing || e.isComposing) return;
      const id = editing;
      if (note?.kind === "conflict") {
        if (e.key === "Escape") {
          e.preventDefault();
          stop(id);
        }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && noModifiers(e)) return stop(id);
      if ((e.key === "Backspace" || e.key === "Delete") && noModifiers(e)) return save(id, null);
      const keys = keysFromEvent(e);
      if (!keys) return;
      const problem = keysProblem(keys);
      if (problem) {
        note = {
          kind: "problem",
          text:
            problem === "reserved"
              ? t("{keys} 是複製、貼上、復原等基本按鍵，不能改用。", { keys: formatKeys(keys) })
              : t("{keys} 會跟打字衝突：要搭配 {mods}，或使用 F1～F12 功能鍵。", {
                  keys: formatKeys(keys),
                  mods: isMac ? t("⌘、⌃ 或 ⌥") : t("Ctrl 或 Alt"),
                }),
        };
        return render(id);
      }
      setKeys(id, keys);
    },
    { capture: true },
  );
  search.addEventListener("input", () => {
    editing = null;
    note = null;
    render();
  });
  resetAll.addEventListener("click", async () => {
    const n = Object.keys(customized()).length;
    const pick = await choose(t("全部還原成預設？"), t("自訂過的 {n} 個快速鍵都會改回預設的按法。", { n }), [
      { id: "reset", label: t("全部還原"), danger: true },
      { id: "cancel", label: t("取消"), primary: true },
    ]);
    if (pick !== "reset") return;
    editing = null;
    note = null;
    app.settings.update({ keybindings: {} });
    render();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  render();
  document.body.append(dialog);
  dialog.showModal();
}
