import type { PreviewPlugin } from "../preview.ts";
import { icon } from "../ui/icons.ts";

/** 程式碼區塊標示的語言（`language-js` → `js`）；沒有標語言時回傳空字串。 */
export function languageOf(className: string): string {
  return /(?:^|\s)language-(\S+)/.exec(className)?.[1] ?? "";
}

/**
 * 預覽中的程式碼區塊：左上角顯示語言，滑過時右上角出現「複製」。
 * 外面包一層 <div>（按鈕才不會跟著程式碼左右捲動），捲動同步用的 data-sourcepos 移到這一層。
 * 只在預覽中加，匯出的 HTML、PDF 沒有這些按鈕。
 */
export function codeToolsPlugin(opts: {
  copy(text: string): Promise<boolean>;
  /** 會被其他外掛換成別的東西的區塊（例如流程圖），不加按鈕。 */
  skip(lang: string): boolean;
}): PreviewPlugin {
  return {
    name: "code-tools",
    apply(root) {
      for (const pre of root.querySelectorAll<HTMLElement>("pre")) {
        if (pre.parentElement?.classList.contains("code-block")) continue;
        const code = pre.querySelector(":scope > code");
        const lang = languageOf(code?.className ?? "");
        if (opts.skip(lang)) continue;
        const block = document.createElement("div");
        block.className = "code-block";
        if (pre.dataset.sourcepos) {
          block.dataset.sourcepos = pre.dataset.sourcepos;
          pre.removeAttribute("data-sourcepos");
        }
        const tools = document.createElement("div");
        tools.className = "code-tools";
        if (lang) {
          const label = document.createElement("span");
          label.className = "code-lang";
          label.textContent = lang;
          tools.append(label);
        }
        const button = document.createElement("button");
        button.type = "button";
        button.className = "code-copy";
        button.title = "複製程式碼";
        button.setAttribute("aria-label", "複製程式碼");
        button.append(icon("copy"));
        button.addEventListener("click", async () => {
          const ok = await opts.copy((pre.querySelector("code") ?? pre).textContent ?? "");
          if (!ok) return;
          button.classList.add("copied");
          button.replaceChildren(icon("check"), "已複製");
          setTimeout(() => {
            button.classList.remove("copied");
            button.replaceChildren(icon("copy"));
          }, 1500);
        });
        tools.append(button);
        pre.replaceWith(block);
        block.append(tools, pre);
      }
    },
  };
}
