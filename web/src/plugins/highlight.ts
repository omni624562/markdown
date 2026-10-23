import type { HLJSApi } from "highlight.js";
import type { PreviewPlugin, Scope } from "../preview.ts";

const CACHE_LIMIT = 500;

let hljs: HLJSApi | null = null;
let loading: Promise<HLJSApi> | null = null;

/** highlight.js 不小（約 160 KB），文件中第一次出現程式碼區塊時才載入。 */
function load(): Promise<HLJSApi> {
  loading ??= import("highlight.js/lib/common").then((m) => (hljs = m.default));
  return loading;
}

/**
 * 用 highlight.js 為程式碼區塊上色。
 * 每次按鍵都會重新渲染，所以把結果依「語言 + 內容」快取起來，只處理有變動的區塊。
 */
export function highlightPlugin(): PreviewPlugin {
  const cache = new Map<string, string>();

  const paint = (api: HLJSApi, scope: Scope) => {
    for (const code of scope.querySelectorAll<HTMLElement>("pre > code[class^='language-']:not(.hljs)")) {
      const lang = code.className.slice("language-".length);
      if (!api.getLanguage(lang)) continue;

      const key = `${lang}\u0000${code.textContent}`;
      let html = cache.get(key);
      if (html === undefined) {
        html = api.highlight(code.textContent ?? "", { language: lang, ignoreIllegals: true }).value;
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(key, html);
      }
      code.innerHTML = html;
      code.classList.add("hljs");
    }
  };

  return {
    name: "highlight",
    apply(_root, scope) {
      if (!scope.querySelector("pre > code[class^='language-']")) return;
      if (hljs) return paint(hljs, scope);
      return load().then((api) => paint(api, scope));
    },
  };
}
