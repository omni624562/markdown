import { type DocKind, type RenderResult, render } from "../pkg/md_wasm.js";

/**
 * 預覽外掛：在 Rust 產生 HTML 之後，對 DOM 做額外處理。
 * 程式碼語法上色、數學公式（KaTeX）、圖表（Mermaid）等 JS 生態系的套件都從這裡接進來。
 */
export interface PreviewPlugin {
  name: string;
  apply(root: HTMLElement): void | Promise<void>;
}

export class Preview {
  #root: HTMLElement;
  #plugins: PreviewPlugin[];
  #last: RenderResult | null = null;

  constructor(root: HTMLElement, plugins: PreviewPlugin[] = []) {
    this.#root = root;
    this.#plugins = plugins;
  }

  get result(): RenderResult | null {
    return this.#last;
  }

  /**
   * 重新渲染預覽。Rust 端已移除原始 HTML 與危險連結，可以直接放進 DOM。
   * 文件有語法錯誤時保留上一次成功的畫面，避免輸入到一半整個預覽消失。
   */
  update(text: string, kind: DocKind): RenderResult {
    const result = render(text, { kind, sourcepos: true });
    this.#last = result;
    if (result.error) return result;

    this.#root.innerHTML = result.html;
    for (const plugin of this.#plugins) {
      try {
        const ret = plugin.apply(this.#root);
        if (ret instanceof Promise) ret.catch((e) => console.error(`[${plugin.name}]`, e));
      } catch (e) {
        console.error(`[${plugin.name}]`, e);
      }
    }
    return result;
  }

  /** 換文件時清空，避免錯誤狀態下殘留上一份文件的畫面。 */
  clear(): void {
    this.#root.replaceChildren();
    this.#last = null;
  }
}
