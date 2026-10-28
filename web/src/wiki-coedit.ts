/**
 * Wiki 共同編輯：判斷別人有沒有剛改過頁面，以及「載入最新版」前把自己的修改拆成一段一段，
 * 方便貼回最新版（不碰畫面，方便測試）。
 */
/** Wiki 頁面目前的版本與最後修改的人（`ado_wiki_page_info`）。 */
export interface WikiPageInfo {
  etag: string | null;
  author: string | null;
  date: string | null;
}

/** 多久以內有人改過，就提醒「對方可能還在編輯」。 */
export const RECENT_EDIT_MS = 15 * 60_000;

/** 最後修改的人不是自己、而且在 `within` 以內：回傳那個人與時間；否則 null。 */
export function recentEditor(
  info: Pick<WikiPageInfo, "author" | "date">,
  me: string | null,
  now = Date.now(),
  within = RECENT_EDIT_MS,
): { author: string; at: number } | null {
  if (!info.author || !info.date) return null;
  const at = Date.parse(info.date);
  if (!Number.isFinite(at) || now - at > within) return null;
  if (me && sameName(info.author, me)) return null;
  return { author: info.author, at };
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 一段自己的修改：原本的內容（新增時是空的）與改成的內容（刪除時是空的）。 */
export interface MyChange {
  before: string;
  after: string;
}

/** 逐行比對時，中間不同的部分最多比對多少（行數相乘）；超過就整段當成一段修改。 */
const MAX_CELLS = 4_000_000;

/** 從開始編輯時的內容（`base`）到自己目前的內容（`mine`），逐段列出改了什麼（整行為單位）。 */
export function myChanges(base: string, mine: string): MyChange[] {
  if (base === mine) return [];
  const a = base.split("\n");
  const b = mine.split("\n");
  // 頭尾相同的行先略過。
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const out: MyChange[] = [];
  // 前後的空行不算（段落之間的空行），只留內容。
  const text = (lines: string[]) => lines.join("\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
  const push = (before: string[], after: string[]) => {
    const change = { before: text(before), after: text(after) };
    if (change.before.trim() || change.after.trim()) out.push(change);
  };
  if (x.length * y.length > MAX_CELLS) {
    push(x, y);
    return out;
  }
  // 最長共同子序列（從後面算回來，前面就能依序走）。
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let before: string[] = [];
  let after: string[] = [];
  const flush = () => {
    if (before.length || after.length) push(before, after);
    before = [];
    after = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      after.push(y[j++]);
    } else {
      before.push(x[i++]);
    }
  }
  flush();
  return out;
}
