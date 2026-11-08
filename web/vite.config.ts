import { readFileSync } from "node:fs";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * 網頁版的內容安全政策（CSP）：和桌面版（desktop/tauri.conf.json）相同，不允許行內與外來的腳本，
 * 文件裡就算夾帶了程式碼也不會執行。只在建置時加上，開發伺服器的即時更新（WebSocket）才不會被擋。
 * 桌面版會同時套用這裡與 Tauri 的設定（兩者都要符合），所以不能比桌面版需要的更嚴。
 * `connect-src` 多允許 https:，網頁版匯出 Word 時要下載文件中的遠端圖片。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http: mdimg: http://mdimg.localhost",
  "font-src 'self' data:",
  "connect-src 'self' https: data: blob: ipc: http://ipc.localhost mdimg: http://mdimg.localhost",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

const csp: Plugin = {
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
};

/**
 * 預載主程式與 wasm：進入點（boot.ts）很小，先載入語言字典才 `import()` 主程式，主程式執行到一半才去抓 wasm，
 * 三段串聯要等三次來回。這裡在 index.html 補上主程式 chunk（與它靜態引用的 chunk）的 modulepreload
 * 和 wasm 的 preload，瀏覽器一開始就同時下載。wasm 的 preload 用和 wasm-bindgen 的 fetch 相同的模式（cors、同站 cookie），
 * 之後的 fetch 才會拿到預載的那一份而不是再下載一次。
 */
const preloadMain: Plugin = {
  name: "preload-main-and-wasm",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler(_html, ctx) {
      const bundle = ctx.bundle;
      if (!bundle || !ctx.filename.endsWith("/index.html")) return [];
      const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
      const main = chunks.find((c) => c.facadeModuleId?.endsWith("/src/main.ts"));
      if (!main) return [];
      // 主程式和它靜態 import 的 chunk（遞迴），去掉 Vite 已經替進入點預載的。
      const entry = chunks.find((c) => c.isEntry && c.facadeModuleId?.endsWith("/index.html"));
      const already = new Set([entry?.fileName, ...(entry?.imports ?? [])]);
      const wanted: string[] = [];
      const visit = (name: string) => {
        if (already.has(name) || wanted.includes(name)) return;
        wanted.push(name);
        const chunk = bundle[name];
        if (chunk?.type === "chunk") chunk.imports.forEach(visit);
      };
      visit(main.fileName);
      const tags: HtmlTagDescriptor[] = wanted.map((name) => ({ tag: "link", attrs: { rel: "modulepreload", crossorigin: true, href: `./${name}` } }));
      const wasm = Object.values(bundle).find((a) => a.type === "asset" && a.fileName.endsWith(".wasm"));
      if (wasm) {
        tags.push({ tag: "link", attrs: { rel: "preload", as: "fetch", type: "application/wasm", crossorigin: true, href: `./${wasm.fileName}` } });
      }
      return tags;
    },
  },
};

export default defineConfig({
  plugins: [csp, preloadMain],
  // 相對路徑，方便部署到 GitHub Pages 等子目錄。
  base: "./",
  // 「關於」頁顯示的版本號（網頁版沒有更新機制，直接用 package.json 的版本）。
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    // 桌面版的終端機在獨立的 webview 顯示（terminal.html），和主畫面分開。
    rollupOptions: { input: { main: "index.html", terminal: "terminal.html" } },
  },
  server: {
    fs: {
      // 允許讀取 crates/ 底下共用的 document.css。
      allow: [".."],
    },
  },
});
