/**
 * Wiki 頁面的修改記錄：誰、什麼時候改了什麼，和目前的內容比較。
 */
import { type AdoWiki, desktop } from "../desktop.ts";
import { versionTitle } from "../history-label.ts";
import { t } from "../i18n.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import { myChanges } from "../wiki-coedit.ts";
import { app } from "./context.ts";


interface WikiRevisionItem {
  id: string;
  author: string;
  date: string;
  comment: string;
  /** 前一版（比這一版舊的那一次）；第一版是 null。 */
  previous: string | null;
}

type WikiHistoryTarget = { projectId: string; wikiId: string; repositoryId?: string; path: string };

/** 修改記錄要看的頁面（Wiki 頁面檢視或 Wiki 編輯分頁）。 */
let wikiHistoryOf: (WikiHistoryTarget & { wiki: AdoWiki | null }) | null = null;
let wikiHistoryLoad: Promise<{ gitPath: string; revisions: WikiRevisionItem[] }> | null = null;

// 在 init 時建立。
let wikiHistoryPicker: Picker<WikiRevisionItem>;

/** 打開修改記錄（Wiki 頁面檢視或編輯分頁）。 */
export function openWikiHistory(target: WikiHistoryTarget, wiki: AdoWiki | null): void {
  wikiHistoryOf = { projectId: target.projectId, wikiId: target.wikiId, repositoryId: target.repositoryId, path: target.path, wiki };
  wikiHistoryLoad = desktop!.adoWikiHistory(target).then(({ gitPath, revisions }) => ({
    gitPath,
    revisions: revisions.map((r, i) => ({ ...r, previous: revisions[i + 1]?.id ?? null })),
  }));
  wikiHistoryLoad.catch(app.reportError);
  wikiHistoryPicker.open();
}

/** 讀某一版的內容（`null` 是還沒有這一頁之前，內容是空的）。 */
async function wikiRevisionText(id: string | null): Promise<string> {
  if (!id || !wikiHistoryOf || !wikiHistoryLoad) return "";
  const { gitPath } = await wikiHistoryLoad;
  const text = await desktop!.adoRepoText({
    project: wikiHistoryOf.projectId,
    repo: wikiHistoryOf.repositoryId ?? wikiHistoryOf.wikiId,
    path: gitPath,
    version: id,
    versionType: "commit",
  });
  return text.replace(/\r\n?/g, "\n");
}

/** 一次修改的內容：列出那次改了哪幾段；可以和目前的內容比較（逐段還原）或複製那一版。 */
async function showWikiRevision(r: WikiRevisionItem): Promise<void> {
  const target = wikiHistoryOf;
  if (!target) return;
  const [text, before] = await Promise.all([wikiRevisionText(r.id), wikiRevisionText(r.previous)]);
  const changes = myChanges(before, text);
  const who = r.author || t("（不明）");
  const when = r.date ? versionTitle(Date.parse(r.date)) : "";
  const dialog = document.createElement("dialog");
  dialog.className = "choice wiki-revision";
  const h = document.createElement("h2");
  h.textContent = r.previous ? t("{who}的修改", { who }) : t("{who}建立了這一頁", { who });
  const p = document.createElement("p");
  p.textContent = [when, r.comment].filter(Boolean).join(" · ");
  const list = document.createElement("ol");
  list.className = "wiki-mine-list";
  for (const change of changes) {
    const item = document.createElement("li");
    if (change.before) {
      item.append(
        Object.assign(document.createElement("div"), { className: "wiki-mine-label", textContent: change.after ? t("原本") : t("刪除了") }),
        Object.assign(document.createElement("pre"), { className: "wiki-mine-before", textContent: change.before }),
      );
    }
    if (change.after) {
      item.append(
        Object.assign(document.createElement("div"), { className: "wiki-mine-label", textContent: change.before ? t("改成") : t("新增了") }),
        Object.assign(document.createElement("pre"), { className: "wiki-mine-after", textContent: change.after }),
      );
    }
    list.append(item);
  }
  if (!changes.length) list.append(Object.assign(document.createElement("li"), { textContent: t("這次修改沒有改到內容（例如只是改名或搬移）。") }));
  const actions = document.createElement("div");
  actions.className = "choice-actions";
  const button = (label: string, run: () => void, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn${primary ? " btn-primary" : ""}`;
    b.textContent = label;
    b.addEventListener("click", run);
    return b;
  };
  actions.append(
    button(t("複製這一版的內容"), () => {
      void navigator.clipboard.writeText(text).then(() => toast(t("已複製"), { tone: "success", duration: 1500 }));
    }),
    button(t("和目前的內容比較"), () => {
      dialog.close();
      void compareWikiRevision(target, text, who, when).catch(app.reportError);
    }),
    button(t("關閉"), () => dialog.close(), true),
  );
  dialog.append(h, p, list, actions);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** 在編輯分頁裡和某一版逐段比較（「採用這一版」把那一段換回去，處理完按 Ctrl+S 存回）。 */
async function compareWikiRevision(target: WikiHistoryTarget & { wiki: AdoWiki | null }, text: string, who: string, when: string): Promise<void> {
  const open = app.docs.find((d) => d.wiki?.wikiId === target.wikiId && d.wiki.path === target.path);
  if (open) app.activate(open);
  else if (target.wiki) await app.editWikiPage(target.wiki, target.path);
  else return;
  if (!app.active.wiki || app.active.wiki.path !== target.path) return;
  if (app.review.active) app.review.finish();
  const started = app.review.start(text, {
    title: t("與 {who} {time} 的版本比較", { who, time: when }),
    hint: t("「採用這一版」會把那一段換回那時的內容，可以用 Ctrl+Z 復原；處理完按 Ctrl+S 存回 Wiki"),
    acceptLabel: t("採用這一版"),
    rejectLabel: t("保留目前"),
  });
  if (!started) toast(t("這一版和目前的內容相同。"));
}

export function initWikiHistory(): void {
  wikiHistoryPicker = new Picker<WikiRevisionItem>({
    label: t("修改記錄"),
    placeholder: t("選擇一次修改，看那次改了什麼"),
    empty: t("這一頁還沒有修改記錄。"),
    async query(q) {
      if (!wikiHistoryLoad) return [];
      const { revisions } = await wikiHistoryLoad;
      const needle = q.trim().toLowerCase();
      return needle ? revisions.filter((r) => `${r.author} ${r.comment}`.toLowerCase().includes(needle)) : revisions;
    },
    render: (r) => ({
      title: r.date ? t("{who} · {time}", { who: r.author || t("（不明）"), time: versionTitle(Date.parse(r.date)) }) : r.author,
      detail: r.comment || r.id.slice(0, 8),
      icon: "history",
    }),
    pick: (r) => void showWikiRevision(r).catch(app.reportError),
  });
}
