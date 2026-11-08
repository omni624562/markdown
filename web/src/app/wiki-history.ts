/**
 * Wiki 頁面的修改記錄：誰、什麼時候改了什麼，和目前的內容比較。
 */
import { type AdoWiki, type AdoWikiChange, desktop } from "../desktop.ts";
import { versionTitle } from "../history-label.ts";
import { t } from "../i18n.ts";
import { Picker } from "../ui/picker.ts";
import { toast } from "../ui/toast.ts";
import { myChanges } from "../wiki-coedit.ts";
import { inPageScope, pageName, revisionNote } from "../wiki-text.ts";
import { chatgptButton } from "./chatgpt.ts";
import { app } from "./context.ts";
import { editWikiPage } from "./ado-files.ts";
import { reportError } from "./git-actions.ts";
import { showWikiPage } from "./wiki-edit.ts";


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
  wikiHistoryLoad.catch(reportError);
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
  const gpt = chatgptButton(() => text, (label, run) => button(label, run));
  actions.append(
    button(t("複製這一版的內容"), () => {
      void navigator.clipboard.writeText(text).then(() => toast(t("已複製"), { tone: "success", duration: 1500 }));
    }),
    ...(gpt ? [gpt] : []),
    button(t("和目前的內容比較"), () => {
      dialog.close();
      void compareWikiRevision(target, text, who, when).catch(reportError);
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
  else if (target.wiki) await editWikiPage(target.wiki, target.path);
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

/** 最近修改要看的 Wiki、範圍（樹狀目錄篩選後的頁面，null 是整個 Wiki）與讀到的清單。 */
let recentOf: AdoWiki | null = null;
let recentScope: string[] | null = null;
let recentLoad: Promise<AdoWikiChange[]> | null = null;
// 在 init 時建立。
let recentPicker: Picker<AdoWikiChange>;

/**
 * 打開這個 Wiki 的最近修改：誰、什麼時候改了哪一頁；選一筆開那一頁。
 * `scope`：Wiki 面板樹狀目錄目前的範圍（篩選了最上層頁面或「只看這裡」），只列範圍裡的頁面，
 * 不然樹狀目錄裡藏起來的資料夾也會出現，看起來像別的 Wiki 的內容。
 */
export function openWikiRecent(wiki: AdoWiki, scope: string[] | null = null): void {
  recentOf = wiki;
  recentScope = scope;
  recentLoad = desktop!.adoWikiRecent(wiki);
  recentLoad.catch(reportError);
  recentPicker.open();
}

function changeLabel(change: AdoWikiChange["change"]): string {
  switch (change) {
    case "add":
      return t("新增");
    case "delete":
      return t("刪除");
    case "rename":
      return t("改名或搬移");
    default:
      return t("修改");
  }
}

/** 上層頁面的位置（「產品 › 安裝」）；最上層的頁面是空字串。 */
function parentTrail(path: string): string {
  return path.split("/").filter(Boolean).slice(0, -1).join(" › ");
}

export function initWikiHistory(): void {
  recentPicker = new Picker<AdoWikiChange>({
    label: t("Wiki 最近修改"),
    placeholder: t("輸入頁面名稱、人名或修改說明"),
    stacked: true,
    empty: () => (recentScope ? t("樹狀目錄目前的範圍裡最近沒有修改（篩選了最上層頁面或「只看這裡」）。") : t("最近沒有修改。")),
    async query(q) {
      if (!recentLoad) return [];
      const scope = recentScope;
      const list = (await recentLoad).filter((c) => inPageScope(c.path, scope));
      const needle = q.trim().toLowerCase();
      return needle ? list.filter((c) => `${c.path} ${c.author} ${c.comment}`.toLowerCase().includes(needle)) : list;
    },
    render: (c) => ({
      title: pageName(c.path),
      detail: [
        changeLabel(c.change),
        c.author || t("（不明）"),
        c.date ? versionTitle(Date.parse(c.date)) : "",
        parentTrail(c.path),
        c.comment ? revisionNote(c.comment, c.path) : "",
      ]
        .filter(Boolean)
        .join("・"),
      icon: c.change === "add" ? "file-plus" : c.change === "delete" ? "trash" : c.change === "rename" ? "pencil" : "file-text",
    }),
    pick: (c) => {
      if (!recentOf) return;
      if (c.change === "delete") {
        toast(t("「{name}」已經刪除了。", { name: pageName(c.path) }));
        return;
      }
      showWikiPage(recentOf, c.path);
    },
  });

  wikiHistoryPicker = new Picker<WikiRevisionItem>({
    label: t("修改紀錄"),
    placeholder: t("選擇一次修改，看那次改了什麼"),
    // 第一行是誰、什麼時候，第二行是修改說明（很長時截掉）。
    stacked: true,
    empty: t("這一頁還沒有修改紀錄。"),
    async query(q) {
      if (!wikiHistoryLoad) return [];
      const { revisions } = await wikiHistoryLoad;
      const needle = q.trim().toLowerCase();
      return needle ? revisions.filter((r) => `${r.author} ${r.comment}`.toLowerCase().includes(needle)) : revisions;
    },
    render: (r) => ({
      title: r.date ? t("{who} · {time}", { who: r.author || t("（不明）"), time: versionTitle(Date.parse(r.date)) }) : r.author,
      detail: (r.comment && revisionNote(r.comment, wikiHistoryOf?.path ?? "")) || r.id.slice(0, 8),
      icon: "history",
    }),
    pick: (r) => void showWikiRevision(r).catch(reportError),
  });
}
