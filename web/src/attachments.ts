/**
 * 工作項目的附件：網址、大小的顯示，以及點一下要怎麼開（不碰畫面，方便測試）。
 * - 文字檔：在 oMarker 開成唯讀分頁。
 * - 圖片：在 oMarker 裡放大檢視。
 * - 其他檔案：下載後用 Windows 預設的程式開啟；會自己執行的檔案只能另存新檔。
 */
import { isReadableFileName } from "./repo-links.ts";

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
 * 兩個主機名稱是不是同一台伺服器：不分大小寫；一邊只寫電腦名稱（`pialm01`）、
 * 另一邊寫完整名稱（`pialm01.corp.local`）也算。兩邊都是完整名稱時要完全一樣。
 */
function sameHost(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (x.includes(".") === y.includes(".")) return false;
  const [short, full] = x.includes(".") ? [y, x] : [x, y];
  return full.startsWith(`${short}.`);
}

/**
 * `href` 是連線中那台伺服器（`base` 是集合的網址）上的工作項目附件嗎；是的話回傳網址與檔名。
 * 留言裡貼的網址常和連線設定的寫法不同（http／https、有沒有埠號、只寫電腦名稱），
 * 主機名稱對得上、路徑在同一個集合底下就算；回傳的網址改用連線設定的伺服器，權杖只會送到那裡。
 */
export function attachmentLink(href: string, base: string): { url: string; name: string } | null {
  const root = base.trim().replace(/\/+$/, "");
  let link: URL;
  let server: URL;
  try {
    link = new URL(href.trim());
    server = new URL(root);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(link.protocol) || !sameHost(link.hostname, server.hostname)) return null;
  const collection = server.pathname.replace(/\/+$/, "");
  if (link.pathname.slice(0, collection.length + 1).toLowerCase() !== `${collection.toLowerCase()}/`) return null;
  const rest = link.pathname.slice(collection.length);
  // 集合底下可以有專案（名稱或 id）；連線設定的是伺服器（沒有集合）時再多一層集合。
  const m = /^(?:\/[^/]+){0,2}\/_apis\/wit\/attachments\/([^/]+)$/i.exec(rest);
  if (!m) return null;
  const name = link.searchParams.get("fileName")?.trim() || decodeURIComponent(m[1]);
  return { url: `${root}${rest}${link.search}`, name };
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
