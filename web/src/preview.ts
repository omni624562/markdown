import { type DocKind, type RenderResult, render, renderDocument } from "../pkg/md_wasm.js";
import { diffRange, lineDelta, shiftSourcepos, stripSourcepos } from "./preview-diff.ts";

/** 可以查詢元素的範圍：整個 DOM 節點，或這次新加入的段落（`Scope`）。 */
export interface Queryable {
  querySelectorAll<E extends Element = Element>(selector: string): Iterable<E>;
}

/**
 * 這次更新新放進預覽的頂層元素。外掛只處理這些（沒改動的段落保留上次處理好的結果）；
 * 查詢時也會比對元素本身。
 */
export class Scope {
  readonly elements: readonly Element[];

  constructor(elements: readonly Element[]) {
    this.elements = elements;
  }

  querySelectorAll<E extends Element = Element>(selector: string): E[] {
    const out: E[] = [];
    for (const el of this.elements) {
      if (el.matches(selector)) out.push(el as E);
      out.push(...el.querySelectorAll<E>(selector));
    }
    return out;
  }

  querySelector<E extends Element = Element>(selector: string): E | null {
    for (const el of this.elements) {
      if (el.matches(selector)) return el as E;
      const found = el.querySelector<E>(selector);
      if (found) return found;
    }
    return null;
  }
}

/**
 * 預覽外掛：在 Rust 產生 HTML 之後，對 DOM 做額外處理。
 * 程式碼語法上色、數學公式（KaTeX）、圖表（Mermaid）等 JS 生態系的套件都從這裡接進來。
 */
export interface PreviewPlugin {
  name: string;
  /** `root` 是整個預覽；`scope` 是這次新加入的段落（只需要處理這些）。 */
  apply(root: HTMLElement, scope: Scope): void | Promise<void>;
  /** 放進畫面之前處理（這時圖片還沒開始載入），例如換掉圖片網址。 */
  prepare?(content: DocumentFragment): void;
  /** 匯出 HTML 時對文件內容做的處理（例如把公式換成 MathML、流程圖換成 SVG）。 */
  exportTransform?(root: HTMLElement): void | Promise<void>;
}

/** 頂層節點的比對鍵：內容（不含行號）相同就視為同一段。 */
function nodeKey(node: Node): string {
  if (node instanceof Element) return stripSourcepos(node.outerHTML);
  return `${node.nodeName}\u0000${node.textContent ?? ""}`;
}

export class Preview {
  #root: HTMLElement;
  #plugins: PreviewPlugin[];
  #last: RenderResult | null = null;
  #stale = false;
  /** 畫面上每個頂層節點的比對鍵與行號（和 `#root.childNodes` 一一對應）；null 代表下次整個重建。 */
  #keys: string[] | null = null;
  #pos: (string | null)[] = [];

  constructor(root: HTMLElement, plugins: PreviewPlugin[] = []) {
    this.#root = root;
    this.#plugins = plugins;
  }

  get result(): RenderResult | null {
    return this.#last;
  }

  /** 上次只更新了大綱與統計，畫面上的預覽還是舊的。 */
  get stale(): boolean {
    return this.#stale;
  }

  /**
   * 重新渲染預覽。Rust 端已移除原始 HTML 與危險連結，可以直接放進 DOM。
   * 文件有語法錯誤時保留上一次成功的畫面，避免輸入到一半整個預覽消失。
   */
  update(text: string, kind: DocKind, skipHtml = false): RenderResult {
    if (skipHtml) {
      // 預覽沒有顯示：只算大綱、統計與錯誤，不產生 HTML 也不動畫面（大文件每次按鍵可以省下幾十毫秒）。
      const result = render(text, { kind, skipHtml: true });
      this.#last = result;
      this.#stale = true;
      return result;
    }
    const result = render(text, { kind, sourcepos: true });
    this.#last = result;
    this.#stale = false;
    if (result.error) return result;

    // 先在 <template> 裡解析（不會載入圖片），讓外掛有機會在發出任何連線前換掉網址。
    const tpl = document.createElement("template");
    tpl.innerHTML = result.html;
    for (const plugin of this.#plugins) {
      try {
        plugin.prepare?.(tpl.content);
      } catch (e) {
        console.error(`[${plugin.name}]`, e);
      }
    }
    const added = this.#patch([...tpl.content.childNodes]);
    const scope = new Scope(added.filter((n): n is Element => n instanceof Element));
    for (const plugin of this.#plugins) {
      try {
        const ret = plugin.apply(this.#root, scope);
        if (ret instanceof Promise) ret.catch((e) => console.error(`[${plugin.name}]`, e));
      } catch (e) {
        console.error(`[${plugin.name}]`, e);
      }
    }
    // 外掛應該一對一替換節點；數量對不上就不再比對，下次整個重建。
    if (this.#keys && this.#root.childNodes.length !== this.#keys.length) this.#keys = null;
    return result;
  }

  /**
   * 把新的頂層節點放進預覽：前後內容沒變的段落保留原本的節點（只更新行號），
   * 只換掉中間有改動的部分。回傳實際放進去的新節點。
   */
  #patch(fresh: Node[]): Node[] {
    const keys = fresh.map(nodeKey);
    const pos = fresh.map((n) => (n instanceof Element ? n.getAttribute("data-sourcepos") : null));
    const old = [...this.#root.childNodes];
    const oldKeys = this.#keys;
    const oldPos = this.#pos;
    this.#keys = keys;
    this.#pos = pos;
    if (!oldKeys || oldKeys.length !== old.length) {
      this.#root.replaceChildren(...fresh);
      return fresh;
    }
    const { prefix, suffix } = diffRange(oldKeys, keys);
    const added: Node[] = [];
    // 保留的節點：內容一樣但行號可能移動了（前面增減了行），平移行號；欄位也變了就換成新的。
    const keep = (oldIndex: number, newIndex: number) => {
      const node = old[oldIndex];
      const delta = lineDelta(oldPos[oldIndex], pos[newIndex]);
      if (delta === 0) return;
      if (delta === null || !(node instanceof Element)) {
        node.replaceWith(fresh[newIndex]);
        added.push(fresh[newIndex]);
        return;
      }
      const targets = node.hasAttribute("data-sourcepos") ? [node] : [];
      targets.push(...node.querySelectorAll("[data-sourcepos]"));
      for (const el of targets) el.setAttribute("data-sourcepos", shiftSourcepos(el.getAttribute("data-sourcepos")!, delta));
    };
    for (let i = 0; i < prefix; i++) keep(i, i);
    for (let i = 0; i < suffix; i++) keep(old.length - suffix + i, fresh.length - suffix + i);
    const middle = fresh.slice(prefix, fresh.length - suffix);
    const anchor = suffix ? (this.#root.childNodes[this.#root.childNodes.length - suffix] ?? null) : null;
    for (const node of old.slice(prefix, old.length - suffix)) node.remove();
    for (const node of middle) this.#root.insertBefore(node, anchor);
    return [...added, ...middle];
  }

  /** 產生可單獨開啟的完整 HTML，並讓外掛把公式、流程圖等轉成不需外部資源的形式。 */
  async exportDocument(text: string, kind: DocKind, title: string): Promise<string> {
    const html = renderDocument(text, { kind, title });
    if (!this.#plugins.some((p) => p.exportTransform)) return html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.querySelector<HTMLElement>("article.markdown-body");
    if (!body) return html;
    for (const plugin of this.#plugins) {
      try {
        await plugin.exportTransform?.(body);
      } catch (e) {
        console.error(`[${plugin.name}] 匯出失敗`, e); // i18n-ignore（開發者訊息）
      }
    }
    return `<!doctype html>\n${doc.documentElement.outerHTML}\n`;
  }

  /** 下次更新時整個重建（例如換了主題，流程圖要重畫；沒改動的段落也要重新處理）。 */
  invalidate(): void {
    this.#keys = null;
  }

  /** 換文件時清空，避免錯誤狀態下殘留上一份文件的畫面。 */
  clear(): void {
    this.#root.replaceChildren();
    this.#last = null;
    this.#stale = true;
    this.#keys = null;
  }
}
