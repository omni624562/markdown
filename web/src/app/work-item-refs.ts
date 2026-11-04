/**
 * 工作項目、Wiki 內容裡的「#編號」（例如「Story #1895964 / Task #1895969」）換成工作項目連結。
 * 先在背景問伺服器有沒有這個工作項目，有才換：「#100 號」這類寫法、沒有權限看的項目都維持原本的文字。
 * 換好的連結和其他工作項目連結一樣：滑鼠停一下顯示摘要卡片，點一下在 oMarker 開啟。
 */
import { setBounded } from "../bounded.ts";
import { type AdoWorkItem, desktop } from "../desktop.ts";
import { findWorkItemRefs } from "../work-item-refs.ts";
import { watchLinkCards } from "./ado-links.ts";
import { app } from "./context.ts";

/** 查過的編號：工作項目，或 null（伺服器上沒有、沒有權限看）。 */
const known = new Map<number, { item: AdoWorkItem | null; at: number }>();
const KNOWN_MAX = 2000;
/** 查不到的編號過一陣子再查（可能是剛建立的工作項目）。 */
const MISSING_TTL = 5 * 60_000;
/** 一次最多問幾個（伺服器的上限）。 */
const BATCH = 200;
/** 正在問伺服器的編號（同一個編號不重複問）。 */
const pending = new Set<number>();
/** 已經掛上摘要卡片的內容區（每次重畫都是同一個元素，只掛一次）。 */
const watched = new WeakSet<HTMLElement>();

/**
 * 這些地方的「#編號」不換：程式碼、本來就是連結、標題、工作項目的標頭、段落標題列（收合時的內容摘要，
 * 點了是展開段落）、標籤與檔案方塊、編輯中的欄位。
 */
const SKIP = "a, pre, code, kbd, samp, h1, h2, h3, h4, h5, h6, summary, .ado-hero, .wi-chip, .ado-tags, .ado-file, [contenteditable], textarea, input, button, select";

function lookup(id: number): AdoWorkItem | null | undefined {
  const hit = known.get(id);
  if (!hit || (!hit.item && Date.now() - hit.at > MISSING_TTL)) return undefined;
  return hit.item;
}

function refLink(item: AdoWorkItem, text: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "wi-ref";
  a.href = item.webUrl;
  a.dataset.wiRef = String(item.id);
  a.textContent = text;
  return a;
}

/** 換掉已經查過、確定有的「#編號」；回傳還沒查過的編號。 */
function wrap(body: HTMLElement): number[] {
  const unknown = new Set<number>();
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.textContent?.includes("#") && !n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.data;
    const parts: (string | Node)[] = [];
    let at = 0;
    for (const ref of findWorkItemRefs(text)) {
      const item = lookup(ref.id);
      if (item === undefined) unknown.add(ref.id);
      if (!item) continue;
      parts.push(text.slice(at, ref.index), refLink(item, text.slice(ref.index, ref.index + ref.length)));
      at = ref.index + ref.length;
    }
    if (!parts.length) continue;
    parts.push(text.slice(at));
    node.replaceWith(...parts.filter((p) => p !== ""));
  }
  return [...unknown];
}

/** 問伺服器這些編號有沒有工作項目（分批）；讀不到時這次就不換，下次顯示再問。 */
async function check(ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      const items = await desktop!.adoWorkItemsByIds(batch);
      const at = Date.now();
      for (const id of batch) setBounded(known, id, { item: items.find((w) => w.id === id) ?? null, at }, KNOWN_MAX);
    } catch {
      // 連不到伺服器：維持原本的文字。
    } finally {
      for (const id of batch) pending.delete(id);
    }
  }
}

/** 工作項目、Wiki 內容顯示之後呼叫（`decorate`）：內容裡的「#編號」換成工作項目連結。 */
export function linkWorkItemRefs(body: HTMLElement): void {
  if (!desktop || !app.ado?.account) return;
  if (!watched.has(body)) {
    watched.add(body);
    watchLinkCards(body, (a) => (a.classList.contains("wi-ref") ? { kind: "workitem", id: Number(a.dataset.wiRef) } : null));
  }
  const ask = wrap(body).filter((id) => !pending.has(id));
  if (!ask.length) return;
  for (const id of ask) pending.add(id);
  void check(ask).then(() => {
    // 這段時間內容可能重畫過（同一個元素）：照目前的內容再換一次。
    if (body.isConnected) wrap(body);
  });
}
