/**
 * 工作項目的附件：網址、大小的顯示，以及點一下要怎麼開（不碰畫面，方便測試）。
 * - 文字檔：在 oMarker 開成唯讀分頁。
 * - 圖片：在 oMarker 裡放大檢視。
 * - 其他檔案：下載後用 Windows 預設的程式開啟；會自己執行的檔案只能另存新檔。
 */
import { isReadableFileName } from "./repo-links.ts";
import { underServer } from "./server-url.ts";

export type AttachmentKind = "text" | "image" | "runnable" | "other";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** 和原生端 `RUNNABLE` 一樣：下載後會自己執行（或安裝、捷徑）的檔案。 */
const RUNNABLE =
  /\.(exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|wsf|wsh|msi|msp|mst|scr|pif|lnk|url|hta|cpl|jar|reg|dll|sys|inf|scf|appx|appxbundle|msix|msixbundle|application|appref-ms|gadget|iso|img|vhd|vhdx|chm|settingcontent-ms|sh|command|app)[. ]*$/i;

export function attachmentKind(name: string): AttachmentKind {
  if (IMAGE.test(name)) return "image";
  // 文字檔優先：.js、.ps1 這類程式碼在 oMarker 裡當文字看，不會執行。
  if (isReadableFileName(name)) return "text";
  if (RUNNABLE.test(name)) return "runnable";
  return "other";
}

/** 附件網址加上 `fileName`（TFS 網頁下載時用這個檔名；oMarker 也靠它知道檔案類型）。 */
export function withFileName(url: string, name: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("fileName", name);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * `href` 是連線中那台伺服器（`base` 是集合的網址）上的工作項目附件嗎；是的話回傳網址與檔名。
 * 留言裡貼的網址常和連線設定的寫法不同（http／https、有沒有埠號、只寫電腦名稱），
 * 主機名稱對得上、路徑在同一個集合底下就算；回傳的網址改用連線設定的伺服器，權杖只會送到那裡。
 */
export function attachmentLink(href: string, base: string): { url: string; name: string } | null {
  const at = underServer(href, base);
  if (!at) return null;
  // 集合底下可以有專案（名稱或 id）；連線設定的是伺服器（沒有集合）時再多一層集合。
  const m = /^(?:\/[^/]+){0,2}\/_apis\/wit\/attachments\/([^/]+)$/i.exec(at.rest);
  if (!m) return null;
  const name = at.params.get("fileName")?.trim() || decodeURIComponent(m[1]);
  return { url: `${at.root}${at.rest}${at.search}`, name };
}

/** 「512 B」「12 KB」「3.4 MB」。 */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 圖示上的副檔名（最多 4 個字，大寫）。 */
export function extLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[^a-z0-9]/gi, "") : "";
  return (ext || "FILE").slice(0, 4).toUpperCase();
}

/** 貼上的圖片沒有檔名（或都叫 image.png）：加上時間，附件不會同名。 */
export function pastedName(file: { name: string; type: string }, now = new Date()): string {
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : `.${file.type.split("/")[1] || "png"}`;
  const stem = !file.name || /^image\.\w+$/i.test(file.name) ? "image" : file.name.slice(0, file.name.lastIndexOf(".")) || "image";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${stem}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${ext}`;
}
