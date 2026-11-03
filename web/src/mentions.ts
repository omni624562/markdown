/**
 * 留言裡的 @（不碰畫面，方便測試）：打字時找出游標前面正在打的 `@名字`；送出時把選過的人
 * 換成 Azure DevOps 的 @ 寫法（`<a data-vss-mention="version:2.0,編號">@名字</a>`），對方才會收到通知。
 */

/** 可以 @ 的人：顯示名稱與伺服器上的身分編號。 */
export interface Mention {
  name: string;
  id: string;
}

/** `@` 前面是這些字元時是信箱（`ming@corp`），不是 @ 人；中文緊接著 @ 可以。 */
const EMAIL_CHAR = /[A-Za-z0-9._%+-]/;

/** 游標前面正在打的 `@…`：`@` 的位置與後面打的字。 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[^A-Za-z0-9._%+-])@([^\s@]{0,40})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

/** 選了人之後的文字：`@…` 換成 `@名字 `，回傳新的文字與游標位置。 */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  const after = text.slice(caret).replace(/^ /, "");
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeHtml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/** 身分編號只接受 GUID 的字元（放進屬性裡，不能有引號）。 */
const ID = /^[0-9a-z-]{1,64}$/i;

/** 一個人的 @（Azure DevOps 的寫法）。 */
export function mentionHtml(m: Mention): string {
  return `<a href="#" data-vss-mention="version:2.0,${m.id}">@${escapeHtml(m.name)}</a>`;
}

/**
 * 轉好的 HTML 裡，文字中的 `@名字`（選過的人）換成 @ 的連結；連結、程式碼裡的不換。
 * 名字長的先比對（「王小明」不會被「王小」搶走）；信箱（`@` 前面是英數字）不換。
 */
export function applyMentions(html: string, people: readonly Mention[]): string {
  const list = people.filter((p) => p.name && ID.test(p.id)).sort((a, b) => b.name.length - a.name.length);
  if (!list.length) return html;
  const names = list.map((p) => ({ text: `@${escapeHtml(p.name)}`, person: p }));
  let skip = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        const tag = /^<(\/?)(a|code|pre)\b/i.exec(part);
        if (tag) skip += tag[1] ? -1 : 1;
        skip = Math.max(0, skip);
        return part;
      }
      if (skip || !part.includes("@")) return part;
      let out = "";
      let i = 0;
      while (i < part.length) {
        const at = part.indexOf("@", i);
        if (at < 0) break;
        const prev = at > 0 ? part[at - 1] : "";
        const hit = EMAIL_CHAR.test(prev) ? undefined : names.find((n) => part.startsWith(n.text, at));
        if (!hit) {
          out += part.slice(i, at + 1);
          i = at + 1;
          continue;
        }
        out += part.slice(i, at) + mentionHtml(hit.person);
        i = at + hit.text.length;
      }
      return out + part.slice(i);
    })
    .join("");
}

/** HTML 裡已經有的 @（編輯留言時保留：改完存回去還是 @）。 */
export function mentionsIn(html: string): Mention[] {
  const out: Mention[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const id = /data-vss-mention\s*=\s*["']version:[\d.]+,([^"']+)["']/i.exec(m[1])?.[1]?.trim();
    const name = unescapeHtml(m[2].replace(/<[^>]*>/g, "")).replace(/^@/, "").trim();
    if (id && ID.test(id) && name && !out.some((x) => x.id === id)) out.push({ name, id });
  }
  return out;
}
