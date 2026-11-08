# oMarker

中文友善的 Markdown 編輯器，也是 Azure DevOps 團隊的工作台。

寫文件時直接在編輯區看到排版，中文的用語、錯字、標點都幫你顧好；需要時，同一個視窗裡就能看工作項目、改 Wiki、提交 Git，也能請 AI 幫忙。

## 下載

**[下載 Windows 版 omarker.exe](https://github.com/omni624562/markdown/releases/download/latest/omarker.exe)**：免安裝，下載後直接執行，之後會自動更新。

## 能做什麼

- **寫作**：即時預覽（像 Obsidian 一樣在編輯區看到排版）、表格、公式、流程圖、範本、簡報模式。中文友善：兩國用語與錯字檢查、簡體轉繁體、中英文間自動補空格，注音、倉頡組字不受影響
- **整理筆記**：`[[文件連結]]` 與反向連結、`#標籤`、跨檔案的待辦總覽、每日筆記
- **專案與檔案**：資料夾就是專案，各自記住開過的分頁；版本紀錄、安全存檔，也能直接編輯 NAS（WebDAV）與 Linux 主機（SSH）上的檔案
- **團隊協作**（桌面版）：Git（GitHub、Azure DevOps）、Azure DevOps 的工作項目與 Wiki，都在同一個視窗裡看和改
- **AI 協作**（桌面版，預設關閉）：在終端機用 Claude Code、Codex，AI 改文件時逐段標示差異由你決定；私人電腦可以開啟 Claude API 助理，在右側問問題、摘要、改寫、翻譯
- **COMET 專案**（桌面版）：不用終端機就能建立、設定 COMET 專案；COMET 產生的檔案預設唯讀，不會被不小心改到
- **匯出與分享**：Word、PDF、HTML，以及複製成格式文字貼到 Word、Outlook、Teams；匯出檔預設放在原稿旁邊

## 說明文件

- [功能與快速鍵](docs/features.md)：寫作、整理筆記、檔案與存檔、匯出、介面與設定
- [桌面版](docs/desktop.md)：專案、Git、Azure DevOps、遠端資料夾、AI 協作、Claude API 助理、COMET
- [更新紀錄](CHANGELOG.md)
- [開發與架構](docs/development.md)

## 授權

MIT。英文拼字字典與拼字引擎的授權見 [開發與架構](docs/development.md#第三方授權)。
