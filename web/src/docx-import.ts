/**
 * 匯入 Word（.docx）：用 mammoth 轉成 HTML，再用和智慧貼上相同的轉換器變成 Markdown。
 * 保留標題、清單、表格、粗體、斜體、底線、螢光、刪除線、連結與圖片。
 */
import mammoth from "mammoth";
import { htmlToMarkdown } from "./html-paste.ts";
import { t } from "./i18n.ts";
import { zipUncompressedSize } from "./zip-size.ts";

/** 解壓縮後超過這個大小就不匯入（正常的 Word 檔，連圖片也很少超過幾百 MB）。 */
const MAX_UNCOMPRESSED = 500 * 1024 * 1024;

/** 圖片：回傳要寫進 Markdown 的網址（例如存好的 `assets/…png`，或 data: 網址）。 */
export type SaveImage = (data: Uint8Array, contentType: string) => Promise<string>;

/** Word 的樣式名稱（英文版與中文版）對應到 HTML。中文樣式名稱是 Word 的資料，不翻譯。 */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='標題'] => h1:fresh", // i18n-ignore
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='副標題'] => h2:fresh", // i18n-ignore
  ...[1, 2, 3, 4, 5, 6].map((n) => `p[style-name='標題 ${n}'] => h${n}:fresh`), // i18n-ignore
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='引文'] => blockquote:fresh", // i18n-ignore
  "p[style-name='Intense Quote'] => blockquote:fresh",
  "u => u",
  "highlight => mark",
  "strike => del",
];

export interface ImportResult {
  markdown: string;
  /** 沒辦法完整轉換的地方（例如不認得的樣式）。 */
  warnings: string[];
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function docxToMarkdown(data: ArrayBuffer, saveImage: SaveImage): Promise<ImportResult> {
  const size = zipUncompressedSize(data);
  if (size === null) throw new Error(t("這不是有效的 Word（.docx）檔案"));
  if (size > MAX_UNCOMPRESSED) throw new Error(t("這個 Word 檔解壓縮後太大，可能是損毀或惡意的檔案，已取消匯入"));
  const result = await mammoth.convertToHtml(
    { arrayBuffer: data },
    {
      styleMap: STYLE_MAP,
      convertImage: mammoth.images.imgElement(async (image) => {
        const src = await saveImage(base64ToBytes(await image.read("base64")), image.contentType);
        return { src };
      }),
    },
  );
  const markdown = htmlToMarkdown(result.value, { keepImages: true });
  const warnings = result.messages
    .filter((m) => m.type === "warning")
    .map((m) => m.message)
    // 樣式沒有對應時 mammoth 會改成一般段落，這種不用特別提醒。
    .filter((m) => !/Unrecognised (paragraph|run) style/i.test(m));
  return { markdown: `${markdown}\n`, warnings };
}

/** 圖片類型對應的副檔名（存檔用）。 */
export function imageExtension(contentType: string): string | null {
  const ext: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  return ext[contentType.toLowerCase()] ?? null;
}
