# 介面翻譯（英文）

介面以繁體中文寫成，英文介面用「中文原文 → 英文」的對照表翻譯。

## 寫法

- 前端：`t("中文原文")`（`web/src/i18n.ts`）。參數寫成 `{名稱}`：`t("已開啟「{name}」", { name })`，**不要**在 `t()` 裡用 `${}`。
- 後端：`tr!("中文原文")`、`tr!("無法開啟「{name}」：{e}", name = path.display(), e = err)`（`desktop/src/i18n.rs`），回傳 `String`。
- 英文需要單複數時，翻譯寫成陣列：`"{n} 個結果": ["{n} result", "{n} results"]`，依參數 `n`（或 `count`）是不是 1 選一個（只有前端支援）。
- 文件內容、詞庫、比對中文用的正規表示式、送給 AI 的說明等**不是介面**的中文，在同一行或上一行加上註解 `i18n-ignore`；整個檔案都不是介面時，在檔案開頭加 `// i18n-ignore-file`。
- 對照表依區域分檔（`web/src/locales/en/*.ts`、`desktop/src/locales/*.rs`），同一句中文只能出現在一個檔。很多地方共用的詞放在 `common`。
- 測試會檢查：中文字串都經過 `t()`／`tr!`（或標了 `i18n-ignore`）、每一句都有英文、參數一致、沒有重複。

## 英文的風格

- 介面標籤、按鈕、選單項目、指令名稱用 **Title Case**（Open Folder…、Save As…、Switch Project…），和 VS Code、Windows 一致；說明、通知、錯誤訊息用一般句子（Sentence case），句尾加句點。
- 中文的「」『』換成英文雙引號 "…"；全形標點（，。：；！？（））換成半形；「…」保留成 "…"（U+2026）。
- 快速鍵照原樣（Ctrl+S、Alt+Enter）。
- 用語盡量簡短，和 VS Code、GitHub Desktop、Obsidian 的說法一致。
- 「台灣用語」相關功能（兩國用語檢查、簡體轉繁體、中文標點）照實翻譯功能名稱，例如 Mainland China terms、Simplified → Traditional Chinese。

## 用語對照

| 中文 | English |
| --- | --- |
| 專案／專案總覽 | Project／Projects Overview |
| 資料夾／檔案／分頁 | Folder／File／Tab |
| 開啟資料夾 | Open Folder… |
| 存檔／另存新檔 | Save／Save As… |
| 未存檔的變更 | unsaved changes |
| 草稿 | draft |
| 原始碼／即時預覽／分割／預覽 | Source／Live Preview／Split／Preview |
| 大綱／側邊欄／狀態列 | Outline／Sidebar／Status Bar |
| 指令面板 | Command Palette |
| 設定（外觀、編輯、進階） | Settings (Appearance, Editing, Advanced) |
| 快速開啟 | Quick Open |
| 原始碼控制 | Source Control |
| 提交／推送／拉取／同步 | Commit／Push／Pull／Sync |
| 儲存庫／分支／遠端／本機 | Repository／Branch／Remote／Local |
| 合併／衝突／逐段處理 | Merge／Conflict／Resolve Chunk by Chunk |
| 採用遠端／保留本機 | Accept Remote／Keep Local |
| 完成合併／放棄合併 | Finish Merge／Abort Merge |
| 建立 Pull Request | Create Pull Request |
| 工作項目 | Work Items |
| 個人存取權杖 | personal access token |
| 集合（ADO） | collection |
| 版本記錄 | Version History |
| 自動存檔 | Auto Save |
| 終端機 | Terminal |
| 快捷動作（AI） | Quick Actions |
| 範本 | Template |
| 待辦總覽 | Tasks |
| 標籤 | Tags |
| 反向連結 | Backlinks |
| 文件互連 | linked documents |
| 兩國用語 | Mainland China terms |
| 錯字 | typos |
| 中文標點 | Chinese punctuation |
| 簡體轉繁體（台灣用語） | Simplified → Traditional Chinese (Taiwan) |
| 整理文件（中英文間加空格） | Tidy Spacing |
| 檔案總管 | File Explorer |
| 資源回收筒 | Recycle Bin |
| 釘選／群組 | Pin／Group |
| 尋找與取代 | Find and Replace |
| 正規表示式 | regular expression |
| 匯出／匯入 | Export／Import |
| 範例文件 | sample document |
| 網路磁碟 | network drive |
| 符號 | Symbols |
| 斜線指令 | slash commands |
| 簡報模式 | Presentation Mode |
| 專注模式／打字機模式 | Focus Mode／Typewriter Mode |
| 檢查更新 | Check for Updates |
