/**
 * 英文介面的翻譯：鍵是繁體中文原文（和 `t()` 的參數一字不差），值是英文。
 * 依檔案分開，避免同時修改時互相衝突；同一句中文只能出現在一個檔案。
 * common：很多地方共用的詞；main：main.ts；ui：ui/ 資料夾；sync：Git、GitHub、ADO、AI、更新等；
 * editing：編輯器、預覽、符號、範本等；html：index.html 的靜態文字。
 */
import { common } from "./en/common.ts";
import { editing } from "./en/editing.ts";
import { html } from "./en/html.ts";
import { main } from "./en/main.ts";
import { sync } from "./en/sync.ts";
import { ui } from "./en/ui.ts";

/** 單數、複數兩種寫法時用陣列：`["{n} file", "{n} files"]`。 */
export type Translation = string | readonly [string, string];

export const en: Readonly<Record<string, Translation>> = Object.freeze({ ...common, ...html, ...main, ...ui, ...sync, ...editing });
export const enParts: Readonly<Record<string, Readonly<Record<string, Translation>>>> = { common, html, main, ui, sync, editing };
