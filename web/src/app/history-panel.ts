/**
 * 右側欄的「歷史」分頁：目前這份檔案存檔時留下的版本（本機版本紀錄）與 Git 的提交，排在同一條時間線上，
 * 新的在上面；點一下就和現在的內容比較（照「比較的方式」設定上下對照或左右並排，見 compare-old.ts）。
 * 檔案樹每一列的「⋯」選單（右鍵也一樣）也有「歷史」，打開那份檔案並切到這一頁。
 */
import { type FileCommit, type FileVersion, desktop } from "../desktop.ts";
import { versionTitle } from "../history-label.ts";
import { t } from "../i18n.ts";
import { icon } from "../ui/icons.ts";
import { app } from "./context.ts";
import { compareWithCommit, compareWithVersion } from "./file-history.ts";
import { reportError } from "./git-actions.ts";
import { storeName } from "./offline-drive.ts";
import { gitPanel } from "./work-item-updates.ts";

type Item = { at: number; kind: "save"; version: FileVersion } | { at: number; kind: "commit"; commit: FileCommit };

let box: HTMLElement | null = null;
/** 最後一次讀取的檔案與順序（換檔案、存檔後重讀；舊的回應不蓋掉新的）。 */
let loading = 0;

/** 「歷史」分頁的內容（第一次用到才建立）。 */
export function historyBox(): HTMLElement {
  if (box) return box;
  box = document.createElement("div");
  box.className = "right-history";
  box.setAttribute("role", "tabpanel");
  box.setAttribute("aria-label", t("歷史"));
  return box;
}

/** 這一頁看得到時重新讀取目前檔案的歷史（換文件、存檔後呼叫；看不到時不讀）。 */
export async function refreshHistory(): Promise<void> {
  if (!box || box.hidden || !box.isConnected) return;
  const el = box;
  const path = app.cur.fileHandle?.path ?? null;
  const seq = ++loading;
  if (!desktop || !path) {
    el.replaceChildren(note(t("存檔過的檔案才有歷史。")));
    return;
  }
  const repo = !!gitPanel?.status?.repo;
  // 先顯示讀取中（保留上一次的清單，換檔案時才清空），兩種歷史一起讀。
  if (el.dataset.path !== path) el.replaceChildren(note(t("讀取中…")));
  el.dataset.path = path;
  const [versions, commits] = await Promise.all([
    desktop.historyList(path).catch(() => [] as FileVersion[]),
    repo ? desktop.gitFileHistory(path).catch(() => [] as FileCommit[]) : Promise.resolve([] as FileCommit[]),
  ]);
  if (seq !== loading || app.cur.fileHandle?.path !== path) return;
  const items: Item[] = [
    ...(versions ?? []).map((version) => ({ at: version.id, kind: "save" as const, version })),
    ...(commits ?? []).map((commit) => ({ at: commit.time * 1000, kind: "commit" as const, commit })),
  ].sort((a, b) => b.at - a.at);
  if (!items.length) {
    el.replaceChildren(note(repo ? t("這個檔案還沒有存檔的版本或提交。存檔時會自動保存版本。") : t("這個檔案還沒有版本紀錄。存檔時會自動保存。")));
    return;
  }
  const list = document.createElement("ul");
  list.className = "history-list";
  for (const item of items) list.append(row(path, item));
  el.replaceChildren(Object.assign(document.createElement("p"), { className: "history-hint", textContent: t("點一下和現在的內容比較") }), list);
}

function note(text: string): HTMLElement {
  return Object.assign(document.createElement("p"), { className: "side-empty", textContent: text });
}

function row(path: string, item: Item): HTMLElement {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = `history-item history-${item.kind}`;
  const title = document.createElement("span");
  title.className = "history-title";
  const detail = document.createElement("small");
  if (item.kind === "save") {
    const v = item.version;
    title.textContent = versionTitle(v.id);
    detail.textContent = v.kind === "disk" ? t("存檔前{store}上的內容", { store: storeName(path) }) : t("存檔");
    b.title = t("和 {version} 的版本比較", { version: versionTitle(v.id) });
    b.append(icon("history"));
    b.addEventListener("click", () => void compareWithVersion({ ...v, path }).catch(reportError));
  } else {
    const c = item.commit;
    title.textContent = versionTitle(item.at);
    detail.textContent = t("提交：{summary} · {author}", { summary: c.summary || t("（沒有說明）"), author: c.author });
    b.title = t("和提交 {commit}（{summary}）比較", { commit: c.short, summary: c.summary });
    b.append(icon("git-commit-horizontal"));
    b.addEventListener("click", () => void compareWithCommit({ ...c, path }).catch(reportError));
  }
  const text = document.createElement("span");
  text.className = "history-text";
  text.append(title, detail);
  b.append(text);
  li.append(b);
  return li;
}

/**
 * 檔案樹的「歷史…」：打開那份檔案，右側欄切到「歷史」。
 * 右側欄放不下（視窗窄、大綱不放在右邊）時改用「版本紀錄」清單。
 */
export async function showHistoryOf(path: string): Promise<void> {
  const { openPath, setRightOutline } = await import("./workspace-ui.ts");
  const { availableRightTabs, selectRightTab } = await import("./right-tabs.ts");
  const { historyPicker } = await import("./file-history.ts");
  const existing = app.tabForPath(path);
  if (existing) app.activate(existing);
  else await openPath(path);
  if (app.cur.fileHandle?.path !== path) return;
  if (!availableRightTabs().includes("history")) {
    historyPicker.open();
    return;
  }
  if (!app.rightOutlineShown) setRightOutline(true);
  selectRightTab("history");
}
