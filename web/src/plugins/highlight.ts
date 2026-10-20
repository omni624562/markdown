import hljs from "highlight.js/lib/common";
import type { PreviewPlugin } from "../preview.ts";

const CACHE_LIMIT = 500;

/**
 * 用 highlight.js 為程式碼區塊上色。
 * 每次按鍵都會重新渲染，所以把結果依「語言 + 內容」快取起來，只處理有變動的區塊。
 */
export function highlightPlugin(): PreviewPlugin {
  const cache = new Map<string, string>();

  return {
    name: "highlight",
    apply(root) {
      for (const code of root.querySelectorAll<HTMLElement>("pre > code[class^='language-']")) {
        const lang = code.className.slice("language-".length);
        if (!hljs.getLanguage(lang)) continue;

        const key = `${lang}\u0000${code.textContent}`;
        let html = cache.get(key);
        if (html === undefined) {
          html = hljs.highlight(code.textContent ?? "", { language: lang, ignoreIllegals: true }).value;
          if (cache.size >= CACHE_LIMIT) cache.clear();
          cache.set(key, html);
        }
        code.innerHTML = html;
        code.classList.add("hljs");
      }
    },
  };
}
