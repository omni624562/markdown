import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  plugins: [csp],
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
