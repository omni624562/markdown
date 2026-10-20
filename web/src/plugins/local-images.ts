import { localImagePath } from "../paths.ts";
import type { PreviewPlugin } from "../preview.ts";

const REMOTE = "webdav://";
const CACHE_LIMIT = 200;

/**
 * 桌面版：把文件中以相對路徑引用的圖片（例如 `assets/截圖.png`）換成 WebView 能載入的網址。
 * 本機檔案用 Tauri 的 asset 協定；WebDAV 遠端的圖片由原生端下載後換成 data: 網址（會快取）。
 * 匯出 HTML 時保留原本的相對路徑，和 .md 放在同一個資料夾就能正常顯示。
 */
export function localImagesPlugin(
  docDir: () => string | null,
  toUrl: (path: string) => string,
  loadRemote?: (path: string) => Promise<string>,
): PreviewPlugin {
  const cache = new Map<string, Promise<string>>();
  return {
    name: "local-images",
    apply(root) {
      const dir = docDir();
      if (!dir) return;
      const remote = dir.startsWith(REMOTE);
      for (const img of root.querySelectorAll<HTMLImageElement>("img[src]")) {
        const path = localImagePath(img.getAttribute("src")!, dir);
        if (!path) continue;
        if (!remote) {
          img.src = toUrl(path);
          continue;
        }
        if (!loadRemote) continue;
        // 下載完成前先不要讓瀏覽器去抓相對網址（一定失敗）。
        img.removeAttribute("src");
        img.dataset.loading = "1";
        if (!cache.has(path)) {
          if (cache.size >= CACHE_LIMIT) cache.clear();
          cache.set(path, loadRemote(path));
        }
        cache
          .get(path)!
          .then((url) => {
            img.src = url;
            delete img.dataset.loading;
          })
          .catch(() => {
            cache.delete(path);
            img.alt = `${img.alt || "圖片"}（無法從遠端載入）`;
            delete img.dataset.loading;
          });
      }
    },
  };
}
