/**
 * 在分頁裡檢視專案裡的圖片（PNG、JPEG、GIF、WebP、SVG…）：和工作項目、Wiki 頁面一樣是唯讀內容的分頁，
 * 用原生端的 `mdimg:` 協定讀圖，點圖放大，工具列可以把圖片以 Markdown 語法插進目前的文件。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { imageMarkdown } from "../image-markdown.ts";
import { basename, dirname, relativePath } from "../paths.ts";
import { openLightbox } from "../ui/lightbox.ts";
import { toast } from "../ui/toast.ts";
import { app } from "./context.ts";
import { insertAtCursor } from "./image-paste.ts";
import { openItem } from "./item-tabs.ts";

/** 標頭上的位置：圖片在專案裡的哪個資料夾（專案根目錄顯示專案名稱）。 */
function whereLabel(path: string): string {
  const root = app.workspaceRoot;
  const dir = dirname(path);
  if (!root) return dir;
  const rel = relativePath(root.path, dir);
  return !rel || rel === "." || rel === "" ? root.name : `${root.name}/${rel}`;
}

/** 在分頁裡顯示圖片（已經開著就切過去）。 */
export function showImage(path: string): Promise<void> {
  const d = desktop;
  if (!d) return Promise.resolve();
  const name = basename(path);
  const src = d.fileUrl(path);
  return openItem({
    key: `image:${path}`,
    origin: { kind: "image", icon: "image", text: t("圖片") },
    label: whereLabel(path),
    title: name,
    // 本機檔案沒有網址：工具列不顯示「在瀏覽器開啟」。
    webUrl: "",
    fileName: `${name}.md`,
    // 內容就是這張圖；標題由標頭顯示，這裡不再放一次。
    load: () => Promise.resolve(imageMarkdown(path, null).replace(/\]\(.*\)$/, `](${src})`)),
    insertLink: () => {
      insertAtCursor(imageMarkdown(path, app.cur.fileHandle?.path));
      toast(t("已插入圖片「{name}」", { name }));
    },
    decorate: (body) => {
      body.classList.add("image-view");
      const img = body.querySelector("img");
      if (!img) return;
      img.title = t("點一下放大");
      img.addEventListener("click", () => openLightbox(img.currentSrc || img.src, name));
      const caption = document.createElement("p");
      caption.className = "image-view-caption";
      const describe = () => {
        caption.textContent = img.naturalWidth ? t("{width} × {height} 像素", { width: img.naturalWidth, height: img.naturalHeight }) : "";
      };
      img.addEventListener("load", describe);
      img.addEventListener("error", () => {
        caption.textContent = t("讀不到這張圖片（可能已經被移走，或不在專案資料夾裡）");
      });
      describe();
      body.append(caption);
    },
  });
}
