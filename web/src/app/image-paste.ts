/**
 * 貼上、拖曳圖片：存到文件旁的資料夾（桌面版）或內嵌成 data URL，Wiki 編輯時上傳成附件。
 */
import { desktop, type AdoWiki } from "../desktop.ts";
import { stem } from "../files.ts";
import { t } from "../i18n.ts";
import { compressImage, formatBytes } from "../image-compress.ts";
import { markdownUrl } from "../paths.ts";
import type { PreviewPlugin } from "../preview.ts";
import type { WikiTarget } from "../session.ts";
import { toast } from "../ui/toast.ts";
import { imageRepoPath } from "../wiki-text.ts";
import { app } from "./context.ts";


const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};
/** 網頁版內嵌圖片（data: 網址）的大小上限，太大會讓文件難以編輯。 */
const EMBED_LIMIT = 2 * 1024 * 1024;

export function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type in IMAGE_EXT);
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 圖片的替代文字：用檔名，但截圖工具產生的「image.png」之類的名稱沒有意義就留白。 */
function altText(name: string): string {
  const s = stem(name);
  return /^(image|img|clipboard|screenshot|untitled)[-_ ]?\d*$/i.test(s) ? "" : s.replace(/[[\]]/g, "");
}

export function insertAtCursor(text: string): void {
  const { from, to } = app.editor.view.state.selection.main;
  app.editor.view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  app.editor.view.focus();
}

/**
 * 插入圖片。桌面版把圖片存到文件旁邊的 assets 資料夾並插入相對路徑；
 * 網頁版無法寫入檔案，詢問後改用內嵌的 data: 網址。
 */
export async function insertImages(original: File[]): Promise<void> {
  if (app.kind !== "markdown") {
    toast(t("只有 Markdown 文件可以插入圖片。"));
    return;
  }
  let files = original;
  if (app.settings.value.imageCompress) {
    const out = await Promise.all(original.map(compressImage));
    files = out.map((c) => c.file);
    const changed = out.filter((c) => c.changed);
    if (changed.length) {
      const before = changed.reduce((n, c) => n + c.before, 0);
      const after = changed.reduce((n, c) => n + c.file.size, 0);
      toast(t("已自動縮小圖片（{before} → {after}）。不想壓縮可以在設定的「編輯」關閉。", { before: formatBytes(before), after: formatBytes(after) }), {
        duration: 6000,
      });
    }
  }
  if (!desktop) {
    if (files.reduce((n, f) => n + f.size, 0) > EMBED_LIMIT) {
      toast(t("圖片超過 2 MB，網頁版無法內嵌。桌面版會把圖片另存成檔案，沒有這個限制。"), { tone: "error", duration: 8000 });
      return;
    }
    toast(t("網頁版無法把圖片另存成檔案。要直接內嵌在文件裡嗎？（文件會變大）"), {
      duration: 10000,
      action: {
        label: t("內嵌圖片"),
        run: () =>
          void Promise.all(files.map(readDataUrl))
            .then((urls) => insertAtCursor(urls.map((url, i) => `![${altText(files[i].name)}](${url})`).join("\n")))
            .catch(app.reportError),
      },
    });
    return;
  }
  if (app.active.wiki) {
    await insertWikiImages(files);
    return;
  }
  const docPath = app.fileHandle?.path;
  if (!docPath) {
    toast(t("請先存檔：圖片會存到文件所在資料夾的 assets 資料夾裡。"), {
      duration: 8000,
      action: {
        label: t("儲存"),
        run: () =>
          void app.save(false)
            .then(() => (app.fileHandle?.path ? insertImages(files) : undefined))
            .catch(app.reportError),
      },
    });
    return;
  }
  const doc = app.active;
  const links: string[] = [];
  for (const file of files) {
    const data = (await readDataUrl(file)).split(",")[1];
    const rel = await desktop.saveImage(docPath, data, IMAGE_EXT[file.type]);
    links.push(`![${altText(file.name)}](${markdownUrl(rel)})`);
  }
  if (app.active !== doc) return; // 存圖片時使用者切換了分頁
  insertAtCursor(links.join("\n"));
  toast(files.length > 1 ? t("已把 {n} 張圖片存到 assets 資料夾", { n: files.length }) : t("已把圖片存到 assets 資料夾"), {
    tone: "success",
  });
}

/** Wiki 附件接受的圖片格式。 */
const WIKI_IMAGE_EXT = new Set(["png", "jpg", "gif", "webp", "bmp"]);

/** 編輯 Wiki 頁面時貼上、拖曳的圖片：上傳成 Wiki 的附件，插入 `/.attachments/…` 的連結（TFS 網頁版也看得到）。 */
async function insertWikiImages(files: File[]): Promise<void> {
  const doc = app.active;
  const target = doc.wiki!;
  const skipped = files.filter((f) => !WIKI_IMAGE_EXT.has(IMAGE_EXT[f.type]));
  if (skipped.length) toast(t("Wiki 只接受 PNG、JPG、GIF、WebP、BMP 圖片，已略過 {n} 張。", { n: skipped.length }), { tone: "error" });
  const ok = files.filter((f) => WIKI_IMAGE_EXT.has(IMAGE_EXT[f.type]));
  if (!ok.length) return;
  const progress = toast(t("正在上傳圖片到 Wiki…"), { duration: 60000 });
  const links: string[] = [];
  try {
    for (const file of ok) {
      const url = await readDataUrl(file);
      const ext = IMAGE_EXT[file.type];
      const path = await desktop!.adoWikiAttach(target, stem(file.name), ext, url.split(",")[1]);
      // 剛上傳的圖片直接用手上的內容顯示，不必再下載一次。
      wikiEditImages.set(wikiImageKey(target, path), Promise.resolve(url));
      links.push(`![${altText(file.name)}](${markdownUrl(path)})`);
    }
  } finally {
    progress.dismiss();
  }
  if (app.active !== doc) return; // 上傳時使用者切換了分頁
  insertAtCursor(links.join("\n"));
  toast(links.length > 1 ? t("已把 {n} 張圖片上傳到 Wiki，存回頁面後別人就看得到", { n: links.length }) : t("已把圖片上傳到 Wiki，存回頁面後別人就看得到"), {
    tone: "success",
  });
}

/** 編輯中的 Wiki 頁面裡的圖片（存在 Wiki 的 Git 儲存庫裡，要帶權杖才讀得到）。 */
const wikiEditImages = new Map<string, Promise<string>>();

function wikiImageKey(target: WikiTarget, path: string): string {
  return `wiki-img:${target.wikiId}:${path.startsWith("/") ? path : `/${path}`}`;
}

/** 編輯中 Wiki 頁面的圖片網址：相對路徑與 `/.attachments/…` 換成讀回來的 data: 網址；不是 Wiki 裡的圖片回傳 null。 */
export function wikiEditImage(target: WikiTarget, src: string): Promise<string> | null {
  if (!desktop) return null;
  const path = imageRepoPath(src, target.path, "/");
  if (!path) return null;
  const key = wikiImageKey(target, path);
  let url = wikiEditImages.get(key);
  if (!url) {
    const wiki = { projectId: target.projectId, repositoryId: target.repositoryId ?? target.wikiId, version: null } as AdoWiki;
    url = app.offlineImage(key, () => desktop!.adoWikiImage(wiki, path));
    url.catch(() => wikiEditImages.delete(key));
    if (wikiEditImages.size > 200) wikiEditImages.clear();
    wikiEditImages.set(key, url);
  }
  return url;
}

/** 預覽中編輯中 Wiki 頁面的圖片（和閱讀 Wiki 頁面時一樣，由原生端讀取）。 */
export function wikiEditImagesPlugin(): PreviewPlugin {
  return {
  name: "wiki-edit-images",
  prepare(content) {
    if (!app.active.wiki) return;
    for (const img of content.querySelectorAll<HTMLImageElement>("img[src]")) {
      const src = img.getAttribute("src")!;
      if (!imageRepoPath(src, app.active.wiki.path, "/")) continue;
      img.dataset.wikiEditSrc = src;
      img.removeAttribute("src");
    }
  },
  apply(_root, scope) {
    const target = app.active.wiki;
    if (!target) return;
    for (const img of scope.querySelectorAll<HTMLImageElement>("img[data-wiki-edit-src]")) {
      void wikiEditImage(target, img.dataset.wikiEditSrc!)
        ?.then((url) => (img.src = url))
        .catch((e) => (img.title = e instanceof Error ? e.message : String(e)));
    }
  },
  };
}
