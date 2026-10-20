import type { PreviewPlugin } from "../preview.ts";

type Mermaid = typeof import("mermaid").default;

let mermaidPromise: Promise<Mermaid> | null = null;
let initializedTheme = "";

function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 第一次遇到流程圖時才下載 Mermaid（檔案很大）。 */
async function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidPromise;
  const theme = isDark() ? "dark" : "default";
  if (initializedTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "inherit" });
    initializedTheme = theme;
  }
  return mermaid;
}

let seq = 0;

/** 把 ```mermaid 程式碼區塊換成圖。保留 data-sourcepos，捲動同步才不會失準。 */
export function mermaidPlugin(enabled: () => boolean): PreviewPlugin {
  const cache = new Map<string, string>();

  const svgFor = async (code: string): Promise<string> => {
    const mermaid = await loadMermaid();
    const key = `${initializedTheme}\u0000${code}`;
    let svg = cache.get(key);
    if (svg === undefined) {
      ({ svg } = await mermaid.render(`mermaid-${++seq}`, code));
      if (cache.size >= 100) cache.clear();
      cache.set(key, svg);
    }
    return svg;
  };

  const replace = async (root: ParentNode, keepAttrs: boolean) => {
    const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
    for (const code of blocks) {
      const pre = code.parentElement!;
      const figure = document.createElement("figure");
      figure.className = "mermaid-diagram";
      if (keepAttrs && pre.dataset.sourcepos) figure.dataset.sourcepos = pre.dataset.sourcepos;
      try {
        figure.innerHTML = await svgFor(code.textContent ?? "");
      } catch (e) {
        figure.classList.add("mermaid-error");
        figure.textContent = `流程圖語法錯誤：${e instanceof Error ? e.message : String(e)}`;
      }
      // 等待期間預覽可能已經重新渲染，原本的區塊不在頁面上就不處理。
      if (!keepAttrs || pre.isConnected) pre.replaceWith(figure);
    }
  };

  return {
    name: "mermaid",
    async apply(root) {
      if (!enabled() || !root.querySelector("code.language-mermaid")) return;
      await replace(root, true);
    },
    async exportTransform(root) {
      if (!enabled() || !root.querySelector("code.language-mermaid")) return;
      await replace(root, false);
    },
  };
}
