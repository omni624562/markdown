/**
 * 預覽中的文件互連與標籤：`[[文件]]` 找不到對應檔案時淡化顯示，`#標籤` 顯示成標籤，
 * 圖片說明文字結尾的 `|400` 當成寬度（和 Obsidian 的寫法相同，例如 `![截圖|400](a.png)`）。
 */
import { TAG } from "../doc-index.ts";
import type { PreviewPlugin } from "../preview.ts";

/** 這些元素裡的文字不找標籤。 */
const SKIP = "code, pre, a, script, style, svg, math, .katex, .tag, .mermaid";

export function wikiTarget(a: HTMLAnchorElement): string {
  const href = a.getAttribute("href") ?? "";
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** 把文字中的 `#標籤` 包成 `<span class="tag">`。 */
export function markTags(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue?.includes("#") && !n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.nodeValue!;
    const parts: (string | HTMLElement)[] = [];
    let last = 0;
    for (const m of text.matchAll(TAG)) {
      const tag = m[1].replace(/[/-]+$/, "");
      if (!tag || /^\d+$/.test(tag)) continue;
      parts.push(text.slice(last, m.index));
      const span = document.createElement("span");
      span.className = "tag";
      span.dataset.tag = tag;
      span.textContent = `#${tag}`;
      parts.push(span);
      last = m.index + 1 + tag.length;
    }
    if (!last) continue;
    parts.push(text.slice(last));
    node.replaceWith(...parts.filter((p) => p !== ""));
  }
}

/** `![說明|400](…)`：寬度 400 像素（`|400x300` 同時指定高度），說明文字去掉尺寸。 */
export function sizeImages(root: HTMLElement): void {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[alt*='|']")) {
    const m = /^(.*?)\s*\|\s*(\d{1,4})(?:\s*x\s*(\d{1,4}))?$/.exec(img.alt);
    if (!m) continue;
    img.alt = m[1];
    img.setAttribute("width", m[2]);
    if (m[3]) img.setAttribute("height", m[3]);
  }
}

export interface DocLinksOptions {
  /** `[[文件]]` 找不找得到對應的檔案；不知道時回傳 null。 */
  wikiExists(target: string): boolean | null;
}

export function docLinksPlugin(opts: DocLinksOptions): PreviewPlugin {
  return {
    name: "doc-links",
    apply(root) {
      for (const a of root.querySelectorAll<HTMLAnchorElement>("a[data-wikilink]")) {
        a.classList.add("wikilink");
        const target = wikiTarget(a).split("#")[0];
        if (target && opts.wikiExists(target) === false) {
          a.classList.add("missing");
          a.title = `還沒有「${target}」這份文件，點一下建立`;
        }
      }
      markTags(root);
      sizeImages(root);
    },
    exportTransform(root) {
      markTags(root);
      sizeImages(root);
    },
  };
}
