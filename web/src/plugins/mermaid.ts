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
  const theme = mermaidTheme();
  if (initializedTheme !== theme) {
    // Mermaid 12 預設用 ELK 排版（要另外下載約 1.4 MB）；改用輕量的 dagre，
    // 圖裡寫了 `layout: elk` 時才會載入 ELK。
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme, fontFamily: "inherit", layout: "dagre" });
    initializedTheme = theme;
  }
  return mermaid;
}

let seq = 0;
const cache = new Map<string, string>();

/** 目前流程圖的配色（跟著深淺色主題）；主題改變時要重畫。 */
export function mermaidTheme(): "dark" | "default" {
  return isDark() ? "dark" : "default";
}

/** 把 Mermaid 原始碼畫成 SVG（同樣的原始碼與主題只畫一次）。語法錯誤時丟出例外。 */
export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const key = `${initializedTheme}\u0000${code}`;
  let svg = cache.get(key);
  if (svg === undefined) {
    const id = `mermaid-${++seq}`;
    try {
      ({ svg } = await mermaid.render(id, code));
    } finally {
      // 語法錯誤時 Mermaid 會把繪圖用的暫存元素留在 body 裡。
      document.getElementById(`d${id}`)?.remove();
    }
    if (cache.size >= 100) cache.clear();
    cache.set(key, svg);
  }
  return svg;
}

/** 把 ```mermaid 程式碼區塊換成圖。保留 data-sourcepos，捲動同步才不會失準。 */
export function mermaidPlugin(enabled: () => boolean): PreviewPlugin {
  const replace = async (root: ParentNode, keepAttrs: boolean) => {
    const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
    for (const code of blocks) {
      const pre = code.parentElement!;
      const figure = document.createElement("figure");
      figure.className = "mermaid-diagram";
      if (keepAttrs && pre.dataset.sourcepos) figure.dataset.sourcepos = pre.dataset.sourcepos;
      try {
        figure.innerHTML = await renderMermaid(code.textContent ?? "");
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
