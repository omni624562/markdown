/**
 * 點預覽、即時預覽中的連結：錨點在文件內捲動、外部網址用瀏覽器開啟（連到 Azure DevOps 的在 oMarker 裡開啟）、
 * 相對路徑的文件開成分頁，圖片、PDF、Office 文件開成檢視分頁。
 */
import { desktop } from "../desktop.ts";
import { t } from "../i18n.ts";
import { isImageName, isViewerDoc } from "../kinds.ts";
import { dirname, resolvePath } from "../paths.ts";
import { toast } from "../ui/toast.ts";
import { openRepoFileLink } from "./ado-files.ts";
import { openRemoteLink } from "./ado-links.ts";
import { app } from "./context.ts";
import { openPath } from "./workspace-ui.ts";

function decodeHref(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** 點預覽中的連結：錨點在文件內捲動、外部網址用瀏覽器開啟、相對路徑的文件開成分頁。 */
export async function followLink(href: string): Promise<void> {
  if (href.startsWith("#")) {
    app.scrollToAnchor(decodeHref(href.slice(1)));
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    // 連到 Azure DevOps 儲存庫裡的 Markdown 等文字檔：在 oMarker 裡閱讀，不下載。
    if (openRepoFileLink(href)) return;
    // 連到工作項目、Wiki 頁面的連結在 oMarker 裡開啟（讀不到就照舊用瀏覽器）。
    if (await openRemoteLink(href)) return;
    if (desktop) await desktop.openExternal(href);
    else window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  // 其他協定（file: 等）一律不處理。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return;
  const hashAt = href.indexOf("#");
  const rel = decodeHref(hashAt >= 0 ? href.slice(0, hashAt) : href);
  const anchor = hashAt >= 0 ? decodeHref(href.slice(hashAt + 1)) : "";
  const base = app.cur.fileHandle?.path;
  if (!desktop || !base) {
    toast(desktop ? t("存檔之後才能開啟相對路徑的連結。") : t("網頁版無法開啟相對路徑的檔案，請改用桌面版。"));
    return;
  }
  const target = resolvePath(dirname(base), rel);
  if (isImageName(target) || isViewerDoc(target)) return openPath(target);
  if (!/\.(md|markdown|txt|json)$/i.test(target)) {
    toast(t("只能在編輯器中開啟 Markdown、純文字與 JSON 檔。"));
    return;
  }
  await openPath(target);
  if (anchor) {
    app.renderNow();
    app.scrollToAnchor(anchor);
  }
}
