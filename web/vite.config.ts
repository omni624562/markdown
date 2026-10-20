import { defineConfig } from "vite";

export default defineConfig({
  // 相對路徑，方便部署到 GitHub Pages 等子目錄。
  base: "./",
  server: {
    fs: {
      // 允許讀取 crates/ 底下共用的 document.css。
      allow: [".."],
    },
  },
});
