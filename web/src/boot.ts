/**
 * 程式進入點：先載入介面語言的字典，再載入主程式（主程式和各模組在載入時就會呼叫 `t()`）。
 */
import { loadLocale } from "./i18n.ts";

void loadLocale().then(() => import("./main.ts"));
