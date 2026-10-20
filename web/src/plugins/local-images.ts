import { localImagePath } from "../paths.ts";
import type { PreviewPlugin } from "../preview.ts";

/**
 * 桌面版：把文件中以相對路徑引用的圖片（例如 `assets/截圖.png`）換成 WebView 能載入的本機網址。
 * 匯出 HTML 時保留原本的相對路徑，和 .md 放在同一個資料夾就能正常顯示。
 */
export function localImagesPlugin(docDir: () => string | null, toUrl: (path: string) => string): PreviewPlugin {
  return {
    name: "local-images",
    apply(root) {
      const dir = docDir();
      if (!dir) return;
      for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) {
        const path = localImagePath(img.getAttribute("src")!, dir);
        if (path) img.src = toUrl(path);
      }
    },
  };
}
