import type { Translation } from "../en.ts";

/** index.html 的靜態文字（啟動時由 translateDom() 翻譯；「檔案」「大綱」「搜尋」等共用的詞在 common）。 */
export const html: Record<string, Translation> = {
  "跳到編輯區": "Skip to Editor",
  "更多功能": "More Actions",
  "側邊欄": "Sidebar",
  "待辦總覽": "Tasks",
  "Issues（GitHub）": "Issues (GitHub)",
  "側邊欄內容": "Sidebar Content",
  "專案的檔案": "Project Files",
  "原始碼控制": "Source Control",
  "格式工具列": "Formatting Toolbar",
  "檢視模式": "View Mode",
  "文件類型": "Document Type",
  "文件類型（依副檔名自動判斷，也可以在這裡切換）": "Document type (detected from the file extension; you can also change it here)",
  "放開以開啟檔案": "Drop to Open Files",
  "支援 Markdown、文字檔、YAML、CSV、HTML、程式碼檔；圖片會插入到文件中": "Markdown, text, YAML, CSV, HTML and code files are supported. Images are inserted into the document.",
  "重新讀取檔案清單（不會和 Git 同步）": "Reload the file list from disk (doesn't sync with Git)",
  "重新讀取檔案清單": "Reload File List",
  "工作項目（Azure DevOps）": "Work Items (Azure DevOps)",
  "Wiki（Azure DevOps）": "Wiki (Azure DevOps)",
  "右側欄": "Right Sidebar",
  "編碼": "Encoding",
  "檔案的編碼：按一下可以用其他編碼重新讀取，或換存檔時用的編碼": "File encoding: click to reopen with another encoding or change the encoding used when saving",
  "換行": "Line Endings",
  "換行的格式：Windows 是 CRLF，macOS、Linux 是 LF": "Line endings: CRLF on Windows, LF on macOS and Linux",
};
