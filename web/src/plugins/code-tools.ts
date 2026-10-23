import type { PreviewPlugin } from "../preview.ts";
import { t } from "../i18n.ts";
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
  /** 大文件可能有上千個程式碼區塊：整個預覽共用一個點擊處理，不要每個按鈕各掛一個。 */
  const bound = new WeakSet<HTMLElement>();
  const onClick = async (e: MouseEvent) => {
    const button = (e.target as Element).closest<HTMLButtonElement>(".code-copy");
    const pre = button?.closest(".code-block")?.querySelector("pre");
    if (!button || !pre) return;
    const ok = await opts.copy((pre.querySelector("code") ?? pre).textContent ?? "");
    if (!ok) return;
    button.classList.add("copied");
    button.replaceChildren(icon("check"), t("已複製"));
    setTimeout(() => {
      button.classList.remove("copied");
      button.replaceChildren(icon("copy"));
    }, 1500);
  };
  return {
    name: "code-tools",
    apply(root, scope) {
      if (!bound.has(root)) {
        root.addEventListener("click", onClick);
        bound.add(root);
      }
      for (const pre of scope.querySelectorAll<HTMLElement>("pre")) {
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
        button.title = t("複製程式碼");
        button.setAttribute("aria-label", t("複製程式碼"));
        button.append(icon("copy"));
        tools.append(button);
        pre.replaceWith(block);
        block.append(tools, pre);
      }
    },
  };
}
