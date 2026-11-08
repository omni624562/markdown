/**
 * Wiki 頁面改名、搬移：對話框問新的名稱與放在哪一頁底下（從 Wiki 樹拖曳到別的頁面時先帶好），
 * 搬移後更新其他頁面裡連到它（和它的子頁面）的連結，左側圖示列的捷徑、開著的分頁也跟著換到新位置。
 * 只限專案 Wiki（程式碼 Wiki 的頁面是儲存庫裡的檔案，要用 Git 搬）。
 */
import { type AdoWiki, desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { toast } from "../ui/toast.ts";
import { isWikiShortcut } from "../wiki-shortcuts.ts";
import { movedPaths, relinkText } from "../wiki-relink.ts";
import { childPagePath, flattenPages, pageLinkResolver, pageName, wikiTitleProblem } from "../wiki-text.ts";
import { siblingsOf } from "../wiki-order.ts";
import { wikiPageTree, wikiPagesCache } from "./ado-links.ts";
import { closeItemsWhere } from "./item-tabs.ts";
import { forgetListCopies } from "./offline-copies.ts";
import { barShortcuts, setBarShortcuts, wikiPanel } from "./work-items-panel.ts";
import { app } from "./context.ts";
import { issueView, showWikiPage } from "./wiki-edit.ts";

/** 搬到哪裡：上層頁面（null 是最上層）與在那一層排第幾個（沒給就放最後）。 */
export interface WikiMoveTarget {
  parent: string | null;
  index?: number;
}

/** 更新連結時一次存幾頁。 */
const SAVE_BATCH = 4;

/** 上層頁面的路徑（最上層是 null）。 */
function parentPath(path: string): string | null {
  return path.slice(0, path.lastIndexOf("/")) || null;
}

/** 選單上的位置：「產品 › 安裝」。 */
function trail(path: string): string {
  return path.split("/").filter(Boolean).join(" › ");
}

/** 名稱有問題時的說明；沒問題回傳 null。 */
function nameProblem(name: string, newPath: string, path: string, existing: Set<string>): string | null {
  const problem = wikiTitleProblem(name);
  if (problem === "empty") return t("請輸入頁面標題。");
  if (problem === "chars") return t("頁面標題不能有 /、\\、#。");
  if (problem === "dot") return t("頁面標題不能以「.」開頭或結尾。");
  if (problem === "long") return t("頁面標題太長了。");
  if (newPath.toLowerCase() !== path.toLowerCase() && existing.has(newPath.toLowerCase())) return t("已經有同名的頁面了，請換一個名稱");
  return null;
}

/** 搬移前讀好的資料：頁面樹與每一頁的內文（算哪些頁面的連結要改）。 */
interface Prepared {
  pages: string[];
  sources: Promise<{ path: string; text: string }[]>;
}

/** 搬到 `newPath` 後，內文裡有連結要改的頁面（搬移前的路徑）。 */
async function pagesToRelink(prep: Prepared, path: string, newPath: string): Promise<string[]> {
  const moved = movedPaths(prep.pages, path, newPath);
  const before = pageLinkResolver(prep.pages);
  const after = pageLinkResolver(prep.pages.map((p) => moved.get(p) ?? p));
  return (await prep.sources).filter((s) => relinkText(s.text, s.path, moved, before, after) !== null).map((s) => s.path);
}

/**
 * 問新的名稱、放在哪裡、要不要更新連結；按「搬移」回傳結果，取消回傳 null。
 * `to` 是從 Wiki 樹拖曳時帶好的位置。
 */
function askMove(path: string, prep: Prepared, to: WikiMoveTarget | undefined): Promise<{ newPath: string; parent: string | null; relink: boolean } | null> {
  const existing = new Set(prep.pages.map((p) => p.toLowerCase()));
  const inside = (p: string) => p === path || p.startsWith(`${path}/`);
  const dialog = document.createElement("dialog");
  dialog.className = "choice wi-create wiki-move";
  const form = document.createElement("form");
  form.method = "dialog";
  const h = document.createElement("h2");
  h.textContent = t("改名或搬移「{name}」", { name: pageName(path) });
  const field = (label: string, control: HTMLElement) => {
    const l = document.createElement("label");
    l.className = "pdf-field";
    l.append(Object.assign(document.createElement("span"), { textContent: label }), control);
    return l;
  };
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 235;
  name.value = pageName(path);
  const parent = document.createElement("select");
  parent.append(new Option(t("（最上層）"), ""));
  // 自己和底下的子頁面不能當新的上層。
  for (const p of prep.pages) if (!inside(p)) parent.append(new Option(trail(p), p));
  parent.value = (to ? to.parent : parentPath(path)) ?? "";
  const children = prep.pages.filter((p) => p.startsWith(`${path}/`)).length;
  const note = document.createElement("p");
  note.className = "wiki-new-hint";
  note.textContent = children ? t("底下的 {n} 個子頁面會一起搬過去。", { n: children }) : "";
  note.hidden = !children;
  const relink = document.createElement("input");
  relink.type = "checkbox";
  relink.checked = true;
  const relinkLabel = document.createElement("label");
  relinkLabel.className = "wiki-move-relink";
  const relinkText = document.createElement("span");
  relinkText.textContent = t("一併更新其他頁面裡的連結（正在檢查…）");
  relinkLabel.append(relink, relinkText);
  const error = document.createElement("p");
  error.className = "wi-create-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  const cancel = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: t("取消") });
  const ok = Object.assign(document.createElement("button"), { type: "submit", className: "btn btn-primary", textContent: t("搬移") });
  actions.append(cancel, ok);
  form.append(h, field(t("名稱"), name), field(t("放在"), parent), note, relinkLabel, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
  name.select();

  const target = () => childPagePath(parent.value || null, name.value);
  // 有幾頁的連結要改：改名稱或位置後停一下再算。
  let seq = 0;
  let timer = 0;
  const count = () => {
    clearTimeout(timer);
    const s = ++seq;
    timer = window.setTimeout(() => {
      const newPath = target();
      if (wikiTitleProblem(name.value) || newPath === path) {
        relinkText.textContent = t("一併更新其他頁面裡的連結");
        return;
      }
      pagesToRelink(prep, path, newPath)
        .then((list) => {
          if (s !== seq) return;
          relinkText.textContent = list.length
            ? t("一併更新其他頁面裡的連結（{n} 頁要改）", { n: list.length })
            : t("一併更新其他頁面裡的連結（沒有頁面連到這裡）");
        })
        .catch(() => {
          if (s === seq) relinkText.textContent = t("一併更新其他頁面裡的連結（讀不到頁面的內容，沒辦法更新）");
        });
    }, 200);
  };
  name.addEventListener("input", count);
  parent.addEventListener("change", count);
  count();

  return new Promise((resolve) => {
    let result: { newPath: string; parent: string | null; relink: boolean } | null = null;
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      clearTimeout(timer);
      dialog.remove();
      resolve(result);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const newPath = target();
      const message = nameProblem(name.value.trim(), newPath, path, existing);
      if (message) {
        error.hidden = false;
        error.textContent = message;
        name.focus();
        return;
      }
      result = { newPath: childPagePath(parent.value || null, name.value.trim()), parent: parent.value || null, relink: relink.checked };
      dialog.close();
    });
  });
}

/** 搬移後更新連結：重新讀每一頁（拿到最新的內容與版本）、改好存回去。回傳改了幾頁、哪幾頁沒改成。 */
async function relinkPages(wiki: AdoWiki, prep: Prepared, list: string[], path: string, newPath: string): Promise<{ done: number; failed: string[] }> {
  const moved = movedPaths(prep.pages, path, newPath);
  const before = pageLinkResolver(prep.pages);
  const after = pageLinkResolver(prep.pages.map((p) => moved.get(p) ?? p));
  let done = 0;
  const failed: string[] = [];
  const one = async (old: string) => {
    const now = moved.get(old) ?? old;
    try {
      const page = await desktop!.adoWikiPage(wiki, now);
      const text = relinkText(page.content, old, moved, before, after);
      if (text === null) return;
      if (!page.etag) throw new Error("no etag");
      const res = await desktop!.adoWikiSave({ projectId: wiki.projectId, wikiId: wiki.id, path: now }, text, page.etag);
      if (res.status !== "saved") throw new Error("conflict");
      done++;
    } catch {
      failed.push(now);
    }
  };
  for (let i = 0; i < list.length; i += SAVE_BATCH) await Promise.all(list.slice(i, i + SAVE_BATCH).map(one));
  return { done, failed };
}

/**
 * 改名或搬移 Wiki 頁面（子頁面一起搬）。`to` 是從 Wiki 樹拖曳到別的位置時帶好的上層與順序，
 * 對話框裡還可以改；沒給就是從選單開的（預設原本的位置）。
 */
export async function moveWikiPage(wiki: AdoWiki, path: string, to?: WikiMoveTarget): Promise<void> {
  if (wiki.code) return;
  const inside = (p: string) => p === path || p.startsWith(`${path}/`);
  // 正在編輯的頁面搬走之後就存不回去了：先請使用者存好、關掉。
  const editing = app.docs.filter((d) => d.wiki?.wikiId === wiki.id && inside(d.wiki.path));
  if (editing.length) {
    toast(t("「{name}」或它的子頁面正在編輯，請先存回並關閉編輯的分頁，再改名或搬移。", { name: pageName(path) }), { tone: "error" });
    return;
  }
  const tree = wikiPanel?.wiki?.id === wiki.id ? wikiPanel.pages : await wikiPageTree(wiki, true);
  const prep: Prepared = {
    pages: flattenPages(tree),
    sources: desktop!.adoWikiSources(wiki).then((s) => s.pages),
  };
  prep.sources.catch(() => {});
  const answer = await askMove(path, prep, to);
  if (!answer) return;
  const { newPath } = answer;
  // 順序：從樹上拖曳時用拖到的位置；改名時留在原本的位置；搬到別的上層時放最後。
  const siblings = siblingsOf(tree, path);
  const here = siblings?.findIndex((p) => p.path === path) ?? -1;
  const sameParent = answer.parent === parentPath(path);
  const index =
    to && answer.parent === to.parent && to.index !== undefined
      ? to.index
      : sameParent
        ? Math.max(here, 0)
        : flattenPages(tree).filter((p) => parentPath(p) === answer.parent).length;
  // 名稱和位置都沒變：不用搬。
  if (newPath === path && index === here) return;
  const relinks = answer.relink && newPath !== path ? await pagesToRelink(prep, path, newPath).catch(() => [] as string[]) : [];
  await desktop!.adoWikiMove(wiki, path, newPath, index);
  const moved = movedPaths(prep.pages, path, newPath);
  // 左側圖示列的捷徑換到新位置；開著的分頁關掉，開著的那一頁在新位置重新開。
  if (barShortcuts.some((s) => isWikiShortcut(s) && s.wiki === wiki.id && moved.has(s.path))) {
    setBarShortcuts(barShortcuts.map((s) => (isWikiShortcut(s) && s.wiki === wiki.id && moved.has(s.path) ? { ...s, path: moved.get(s.path)! } : s)));
  }
  const showing = issueView.isOpen && app.wikiPage?.wiki.id === wiki.id ? moved.get(app.wikiPage.path) : undefined;
  closeItemsWhere((key) => {
    const [kind, id, ...rest] = key.split(":");
    return kind === "wiki" && id === wiki.id && moved.has(rest.join(":"));
  });
  const { done, failed } = relinks.length ? await relinkPages(wiki, prep, relinks, path, newPath) : { done: 0, failed: [] };
  forgetListCopies("wiki");
  wikiPagesCache.delete(wiki.id);
  if (wikiPanel?.wiki?.id === wiki.id) {
    await wikiPanel.refresh(true);
    wikiPanel.select(newPath);
  }
  if (showing) showWikiPage(wiki, showing);
  const what =
    parentPath(newPath) === parentPath(path)
      ? t("已改名為「{name}」", { name: pageName(newPath) })
      : t("已把「{name}」搬到「{where}」", { name: pageName(newPath), where: parentPath(newPath) ? trail(parentPath(newPath)!) : t("最上層") });
  const parts = [what];
  if (done) parts.push(t("更新了 {n} 頁的連結", { n: done }));
  toast(parts.join(t("，")), { tone: "success" });
  if (failed.length) {
    toast(
      t("有 {n} 頁的連結沒有更新（{names}），請自己改一下", { n: failed.length, names: failed.slice(0, 3).map((p) => pageName(p)).join(t("、")) }),
      { tone: "error", duration: 12000 },
    );
  }
}
