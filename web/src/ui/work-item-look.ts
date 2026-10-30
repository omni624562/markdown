/**
 * 工作項目檢視比照 TFS 網頁的樣子：欄位改成精簡的格狀排列、狀態前面加顏色、
 * 段落標題下面加分隔線、留言加上頭像。內容還是同一份 Markdown（複製成文件不受影響），
 * 這裡只在畫好的內容上加 class 與屬性、不搬動節點（預覽只更新有改動的段落，
 * 沒改的節點會留著，所以每次都先清掉上次加的 class 再重新標）。樣式只套用在
 * `.issue-pane[data-source="ado"]` 裡。
 */
import { stateTone } from "../issue-doc.ts";
import { t } from "../i18n.ts";
import { shortcutHue, shortcutInitial } from "../wiki-shortcuts.ts";

/** `comments` 是留言段落的標題（例如「留言（2）」）。 */
export function decorateWorkItem(body: HTMLElement, comments: string): void {
  for (const el of body.querySelectorAll(".ado-fields, .ado-comment-head, .ado-comment-body")) {
    el.classList.remove("ado-fields", "ado-comment-head", "ado-comment-body");
  }
  const table = body.querySelector<HTMLTableElement>(":scope > h1 + table");
  if (table) {
    table.classList.add("ado-fields");
    for (const row of table.tBodies[0]?.rows ?? []) {
      const [label, value] = row.cells;
      if (!label || !value || label.textContent !== t("狀態") || value.querySelector(".ado-state-dot")) continue;
      const dot = document.createElement("span");
      dot.className = `ado-state-dot ${stateTone(value.textContent ?? "")}`;
      dot.setAttribute("aria-hidden", "true");
      value.prepend(dot);
    }
  }
  // 留言：標題（「名字・時間」）加頭像，內容往右縮排、和標題連成一張卡片。
  let inComments = false;
  for (const el of body.children) {
    if (el.tagName === "H2") {
      inComments = el.textContent === comments;
      continue;
    }
    if (!inComments) continue;
    if (el.tagName === "H3") {
      const [name, ...when] = (el.textContent ?? "").split("・");
      el.classList.add("ado-comment-head");
      (el as HTMLElement).dataset.initial = shortcutInitial(name);
      (el as HTMLElement).style.setProperty("--hue", String(shortcutHue(name)));
      // 時間用淡一點的字（和 TFS 網頁一樣，名字比較顯眼）。
      if (when.length && !el.querySelector(".ado-comment-time")) {
        const time = document.createElement("span");
        time.className = "ado-comment-time";
        time.textContent = when.join("・");
        el.replaceChildren(name, time);
      }
    } else el.classList.add("ado-comment-body");
  }
}
