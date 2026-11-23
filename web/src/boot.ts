/**
 * 程式進入點：先載入介面語言的字典，再載入主程式（主程式和各模組在載入時就會呼叫 `t()`）。
 */
import { loadLocale } from "./i18n.ts";
import { installMobileFiles } from "./mobile-files.ts";

// Android 版：補上系統的檔案選擇器（網頁版的開檔、存檔流程照舊）。
installMobileFiles();
void loadLocale().then(() => import("./main.ts"));
