import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
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
