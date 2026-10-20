import type { PreviewPlugin } from "../preview.ts";

type Katex = typeof import("katex").default;

let katexPromise: Promise<Katex> | null = null;

/** 第一次遇到公式時才下載 KaTeX 與它的樣式，沒有公式的文件完全不載入。 */
function loadKatex(): Promise<Katex> {
  katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => m.default);
  return katexPromise;
}

const CACHE_LIMIT = 500;

/**
 * 用 KaTeX 顯示 Rust 核心輸出的 `<span data-math-style="inline|display">` 公式。
 * 語法錯誤時只把那一個公式標成紅字，不影響其他段落。
 */
export function mathPlugin(enabled: () => boolean): PreviewPlugin {
  const cache = new Map<string, string>();

  const renderAll = (katex: Katex, root: ParentNode, output: "htmlAndMathml" | "mathml") => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-math-style]")) {
      const tex = el.textContent ?? "";
      const display = el.dataset.mathStyle === "display";
      const key = `${output}\u0000${display}\u0000${tex}`;
      let html = cache.get(key);
      if (html === undefined) {
        html = katex.renderToString(tex.trim(), {
          displayMode: display,
          throwOnError: false,
          output,
          // 公式裡不允許 \href 等可能帶入連結或 HTML 的指令。
          trust: false,
          strict: "ignore",
        });
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(key, html);
      }
      el.innerHTML = html;
      el.classList.add("math-rendered");
    }
  };

  return {
    name: "math",
    async apply(root) {
      if (!enabled() || !root.querySelector("[data-math-style]")) return;
      const katex = await loadKatex();
      // 下載期間預覽可能已經重新渲染過，元素仍在頁面上才處理。
      if (root.isConnected) renderAll(katex, root, "htmlAndMathml");
    },
    async exportTransform(root) {
      if (!enabled() || !root.querySelector("[data-math-style]")) return;
      // 匯出用 MathML：瀏覽器原生支援，不需要附帶 KaTeX 的字型與樣式。
      renderAll(await loadKatex(), root, "mathml");
    },
  };
}
