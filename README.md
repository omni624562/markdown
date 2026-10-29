# oMarker

左邊編輯、右邊預覽，也可以直接在編輯區看到排版結果的網頁編輯器，支援 **Markdown、純文字（.txt）與 JSON**，也能開啟 YAML、CSV、HTML 與各種程式碼檔。解析核心用 Rust 撰寫並編譯成 WebAssembly，介面則用 TypeScript，可以自由接上 JS 生態系的套件。

## 功能

- **即時預覽**：和 Obsidian 一樣直接在編輯區看到排版，游標所在的那一行換回原始碼；也可以切換成原始碼、左右分割或純預覽
- **中文友善**：兩國用語與錯字檢查、中文標點、簡體轉繁體（台灣用語）、以詞為單位移動游標、中英文間自動補空格，注音、倉頡組字不受影響
- **寫作工具**：指令面板、斜線指令、選取時浮出的格式按鈕、表格編輯（依中文字寬對齊）、目錄、文件範本、`[[文件]]` 互連、標籤、待辦總覽
- **公式與流程圖**：KaTeX、Mermaid，只有文件裡真的有時才載入
- **匯入匯出**：Word（.docx）匯入與匯出、PDF、獨立 HTML、複製為格式文字（貼到 Word、Outlook 保留格式）、簡報模式
- **安全**：預覽不執行文件裡的任何程式碼，可以封鎖遠端圖片

完整的功能說明與快速鍵見 **[docs/features.md](docs/features.md)**。

## 桌面版（Windows 免安裝）

**[下載最新版 omarker.exe](https://github.com/omni624562/markdown/releases/download/latest/omarker.exe)**（不需登入 GitHub），下載後直接執行，不需要安裝，之後會自動更新。

桌面版另外有：開啟資料夾與多專案、資料夾全文搜尋與取代、版本記錄、內建 Git（GitHub、Azure DevOps／TFS 同步）、Azure DevOps 工作項目與 Wiki、WebDAV 與 SSH 遠端資料夾、內嵌終端機，以及搭配 Claude Code／Codex 的 AI 協作（預設關閉）。說明見 **[docs/desktop.md](docs/desktop.md)**。

## 版本與更新紀錄

版本號採用語意化版本（`主版號.次版號.修訂號`）：新功能改次版號、修正改修訂號、不相容的改變改主版號。規則與升版方式見 [VERSIONING.md](VERSIONING.md)，每一版改了什麼見 [CHANGELOG.md](CHANGELOG.md)。

## 架構

```
crates/
  md-core/    Rust 核心：Markdown（comrak）、純文字、JSON（serde_json）轉 HTML，大綱、字數統計、中英文間距、表格對齊
  md-text/    文字分析：兩國用語與錯字校對、文件中的待辦、標籤與連結、改名後更新連結（網頁版與桌面版共用）
  md-docx/    Markdown 轉 Word（.docx）
  md-wasm/    md-core 與 md-text 的 WebAssembly 綁定（wasm-bindgen）
  md-cli/     命令列工具 mdtool，跟網頁共用同一個核心

desktop/src/  桌面版（Tauri 2）：沿用網頁介面，補上原生端的功能
  檔案與資料夾  files.rs（讀寫、編碼、安全存檔與衝突偵測）、workspace.rs（資料夾工作區、全文搜尋）、
                watch.rs（外部修改監看、網路磁碟輪詢）、io.rs（背景讀寫與逾時）、trust.rs（最近開啟與允許的路徑）、
                projects.rs（多專案）、history.rs（版本記錄）、doc_index.rs（資料夾文件索引）、
                images.rs（貼上圖片）、image_protocol.rs（預覽的本機圖片 mdimg:）、pdf.rs（直接匯出 PDF）、fonts.rs
  Git           git.rs（狀態、提交、拉取、推送；libgit2）、git_flow.rs（分支、合併衝突）、
                git_log.rs（提交歷史與線圖）、git_files.rs（單一檔案的歷史、網頁網址）
  遠端與帳號    github.rs（GitHub 登入、儲存庫、Issues）、ado.rs（Azure DevOps：儲存庫、工作項目、Wiki）、
                dav.rs（WebDAV 遠端資料夾與共用的 RemoteFs）、ssh.rs（SSH／SFTP 遠端資料夾）、
                offline.rs（工作項目與 Wiki 的離線副本）、secrets.rs（Windows 認證管理員）、notify.rs（系統通知）
  AI 協作       ai/term.rs（內嵌終端機）、ai/mcp.rs（編輯器 MCP 伺服器）、ai/run.rs（選取段落快捷動作）、ai/tools.rs
  其他          main.rs（建立視窗、註冊指令）、settings.rs、update.rs 與 winhttp.rs（自動更新）、
                navigation.rs（導覽限制）、i18n.rs 與 locales/（後端訊息的英文翻譯）

web/src/      網頁介面（桌面版也用同一份）
  主程式        main.ts（組裝各個模組）、boot.ts（先載入語言）、commands.ts（指令中心：工具列、選單、指令面板、
                快速鍵共用同一份清單）、settings.ts、session.ts（分頁與草稿）、storage.ts、desktop.ts（呼叫原生端）
  編輯器        editor.ts（CodeMirror 6）、live-preview.ts（即時預覽）、table-widget.ts 與 table-model.ts
                （即時預覽中的表格）、table.ts、format.ts、inline-tools.ts、brackets.ts、auto-symbols.ts、words.ts、
                writing-modes.ts、sections.ts（大綱拖曳重排）、slash-complete.ts、date-complete.ts、link-complete.ts
  預覽          preview.ts（預覽與外掛介面）、preview-diff.ts（增量更新）、plugins/（語法上色、KaTeX、Mermaid、
                表格、[[連結]] 與標籤、本機圖片）、scroll-sync.ts、remote-images.ts（封鎖遠端圖片）
  中文          terms.ts 與 proofread.ts（兩國用語、錯字）、s2t.ts（簡體轉繁體）、collator.ts（中文排序）
  文件互連      links.ts（[[文件]]、反向連結）、doc-index.ts 與 workspace-index.ts（待辦、標籤）、toc.ts、templates.ts
  匯入匯出      docx-export.ts、docx-import.ts、docx-image.ts、zip-size.ts、html-paste.ts（智慧貼上）、
                rich-copy.ts（複製為格式文字）、pdf-print.ts、image-compress.ts、svg-image.ts
  Git 與遠端    git-ui.ts、git-graph.ts、github-ui.ts、ado-ui.ts、workitem-*.ts（工作項目）、wiki-*.ts（Wiki）、
                issue-doc.ts、repo-links.ts、remote-links.ts、offline.ts、auth-errors.ts
  AI 與更新     ai.ts（AI 協作：MCP 狀態同步、提議、執行指令的同意流程、快捷動作）、ci-workflow.ts、updater.ts、
                release-notes.ts
  ui/           分頁列、檔案樹、搜尋、待辦總覽、標籤、Issues、Wiki、簡報、圖片放大、匯出 PDF 選項、終端機（xterm.js）、
                指令面板與快速開啟、選單、通知、差異檢視、Git 歷史、設定、WebDAV 與 SSH 連線、專案、圖示（lucide）
  locales/      英文介面的翻譯（用語對照見 locales/README.md）
```

Rust 負責「文件 → HTML」這段需要正確與效能的部分；前端拿到 HTML 後，再交給**預覽外掛**做後續處理。
想加入數學公式（KaTeX）、流程圖（Mermaid）等功能時，只要實作 `PreviewPlugin` 介面，不必改動 Rust：

```ts
// web/src/preview.ts
export interface PreviewPlugin {
  name: string;
  apply(root: HTMLElement, scope: Scope): void | Promise<void>;
}
```

可參考 `web/src/plugins/highlight.ts`，然後在 `web/src/main.ts` 的 `new Preview(...)` 加進去即可。
要新增功能時，在 `main.ts` 用 `commands.register(...)` 註冊一個指令，它就會自動出現在指令面板，並套用快速鍵。

安全性：核心一律不輸出原始 HTML（只有成對、不帶屬性的 `<u>`、`<mark>`、`<sup>`、`<sub>`、`<ins>` 與 `<br>` 會換成對應的格式），並會過濾 `javascript:` 等危險連結（`[[ ]]` 連結也一樣）；純文字與 JSON 的內容也都會跳脫，因此預覽可以直接把結果放進 DOM。

## 開發

需要：Rust（stable）、[wasm-pack](https://rustwasm.github.io/wasm-pack/)、Node.js 22 以上。

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

cd web
npm install
npm run wasm   # 編譯 Rust 成 WebAssembly，輸出到 web/pkg（修改 Rust 程式後要重跑）
npm run dev    # 開發伺服器，預設 http://localhost:5173
```

其他指令：

| 指令 | 用途 |
| --- | --- |
| `cargo test --workspace` | 執行 Rust 測試 |
| `npm test`（在 `web/`） | 執行前端單元測試（Node 內建測試框架） |
| `npm run typecheck` | TypeScript 型別檢查 |
| `npm run build` | 建置正式版到 `web/dist`，可以直接部署到任何靜態網站主機 |

## 命令列工具

```sh
cargo run -p md-cli -- html 筆記.md -o 筆記.html   # 轉成完整的 HTML 頁面（.txt、.json 也可以）
cargo run -p md-cli -- html --fragment 筆記.md     # 只輸出 HTML 片段
cargo run -p md-cli -- toc 筆記.md                 # 列出標題大綱
cargo run -p md-cli -- stats 筆記.txt              # 字數統計
cargo run -p md-cli -- fmt 資料.json               # 把 JSON 重新排版（加 -w 直接覆寫檔案）
cargo run -p md-cli -- fmt 筆記.md                 # 依中文字寬對齊文件中所有表格
cargo run -p md-cli -- fmt --spacing -w 筆記.md    # 另外在中文與英文、數字之間補空格，並直接覆寫檔案
```

文件類型依副檔名判斷，也可以用 `--format md|txt|json` 指定。省略檔名時會從標準輸入讀取，例如 `cat 筆記.md | mdtool html`。

## 授權

MIT
