# Markdown 編輯器

左邊編輯、右邊即時預覽的網頁編輯器，支援 **Markdown、純文字（.txt）與 JSON**。解析核心用 Rust 撰寫並編譯成 WebAssembly，介面則用 TypeScript，可以自由接上 JS 生態系的套件。

## 功能

**三種文件類型**（依副檔名自動判斷，也可以從檔名旁的選單切換）

| 類型 | 編輯器 | 預覽 |
| --- | --- | --- |
| Markdown | 語法上色、格式工具列 | GitHub Flavored Markdown（表格、待辦清單、註腳、`> [!NOTE]` 提示區塊） |
| 純文字 | 純文字編輯 | 適合閱讀的排版，保留原本的換行 |
| JSON | 語法上色、錯誤處畫紅色底線 | 可摺疊的樹狀檢視；語法錯誤時以中文說明原因與行、欄位置，可一鍵跳過去，並保留上一次正確的畫面 |

**編輯體驗**

- **指令面板**（`Ctrl/⌘+Shift+P`）：輸入關鍵字就能找到所有功能，並顯示對應的快速鍵
- **格式工具列**：標題、粗體、斜體、刪除線、程式碼、連結、清單、待辦、引言、程式碼區塊、表格、分隔線；JSON 則提供「格式化」
- **中文友善**：`這是**粗體**文字` 這種寫法也能正確辨識；字數統計會把中文字和英文單字分開算；注音輸入選字時不會誤觸快速鍵
- **括號自動配對**：`(`、`[`、`"` 與全形「」『』（）《》【】都會自動補上右半邊；先選取文字再打「會把文字包起來。用注音、倉頡打的全形括號也適用
- **表格編輯**：在表格中按 `Tab`／`Shift+Tab` 移到下一格或上一格，最後一格按 `Tab` 會新增一列，`Enter` 新增一列，在空白列按 `Enter` 離開表格。每次移動都會依中文字寬自動對齊；`Shift+Alt+F` 對齊文件中所有表格；指令面板中可插入或刪除欄、列
- **數學公式與流程圖**：`$E=mc^2$`、`$$…$$` 用 KaTeX 顯示，` ```mermaid ` 區塊顯示成流程圖；只有文件裡真的有時才會載入。匯出 HTML 時公式轉成 MathML、流程圖轉成 SVG，不需要網路也能正確顯示
- **設定**（`Ctrl/⌘+,`）：編輯區字級、行號、括號配對、表格自動對齊、預覽欄寬、公式與流程圖開關
- **大綱**：點擊即可跳到對應位置，並標示目前閱讀到的段落
- **捲動同步**：捲動編輯器時預覽會跟著對齊；中間分隔線可以拖曳（或用方向鍵）調整寬度，雙擊恢復一半一半
- **存檔狀態清楚**：檔名旁的藍點表示有變更尚未存檔；草稿會自動保存在瀏覽器
- **安全存檔**：存檔時先寫到暫存檔再取代原檔，不會因為斷電留下殘缺的檔案；如果檔案在開啟後被其他程式（例如 NAS 同步軟體）改過，會先詢問，可以**逐段比較差異**再決定採用哪個版本
- **檔案**：開啟／儲存／另存新檔（Chrome、Edge 可直接寫回原檔）、拖曳開檔、匯出獨立 HTML、複製 HTML
- 新增文件後可以從通知按「復原」找回原本的內容，不需要先回答確認對話框
- 狀態列顯示游標位置、選取字數、總字數與預估閱讀時間

**介面**

- 主題可選「跟隨系統／淺色／深色」，載入時不會閃白
- 手機版：編輯與預覽用分頁切換，大綱改成側邊抽屜，觸控按鈕放大
- 無障礙：所有按鈕都有文字標籤與鍵盤操作、焦點外框清楚、支援「減少動態效果」與 Windows 高對比模式

### 快速鍵

| 功能 | Windows／Linux | macOS |
| --- | --- | --- |
| 指令面板 | `Ctrl+Shift+P` | `⌘⇧P` |
| 開啟／儲存／另存新檔 | `Ctrl+O`／`Ctrl+S`／`Ctrl+Shift+S` | `⌘O`／`⌘S`／`⌘⇧S` |
| 粗體／斜體／刪除線 | `Ctrl+B`／`Ctrl+I`／`Ctrl+Shift+X` | `⌘B`／`⌘I`／`⌘⇧X` |
| 行內程式碼／連結 | `Ctrl+E`／`Ctrl+K` | `⌘E`／`⌘K` |
| 標題 1～3 | `Ctrl+Alt+1`～`3` | `⌘⌥1`～`3` |
| 編號清單／項目清單／待辦 | `Ctrl+Shift+7`／`8`／`9` | `⌘⇧7`／`8`／`9` |
| 格式化 JSON／對齊所有表格 | `Shift+Alt+F` | `⇧⌥F` |
| 表格：下一格／上一格 | `Tab`／`Shift+Tab` | `Tab`／`⇧Tab` |
| 設定 | `Ctrl+,` | `⌘,` |
| 顯示／隱藏大綱 | `Ctrl+Shift+O` | `⌘⇧O` |
| 搜尋與取代 | `Ctrl+F` | `⌘F` |

## 桌面版（Windows 免安裝）

**[下載最新版 md-editor.exe](https://github.com/omni624562/markdown/releases/download/latest/md-editor.exe)**（不需登入 GitHub），下載後直接執行，不需要安裝。也可以到 [Releases 頁面](https://github.com/omni624562/markdown/releases/latest)查看更新內容。

- 每次合併到 `main`，CI 都會自動更新這個「最新版」。
- 推送 `v` 開頭的標籤（例如 `v0.2.0`）時，會另外建立該版本的 Release。
- PR 的測試版放在 Actions 的 Artifacts（需登入 GitHub）。

- 介面和網頁版相同，開檔、存檔改用 Windows 原生對話框，`Ctrl+S` 會直接寫回原檔
- 可以把 `.md`／`.txt`／`.json` 檔拖到 `md-editor.exe` 上開啟，或在「開啟檔案」中設定成預設程式
- 原本是 CRLF 換行或有 BOM 的檔案，存檔時會維持原樣；不是 UTF-8 的舊檔案會以 Big5 讀取（存檔時改存 UTF-8，開啟時會提示）
- 需要 Microsoft Edge WebView2 執行階段：Windows 10／11 已內建；若是精簡版系統，可到微軟官網下載安裝
- 草稿與設定存在 `%LOCALAPPDATA%\io.github.omni624562.markdown`

自己編譯（需要 Windows 與上面「開發」段落的工具）：

```sh
cd web && npm install && npm run wasm && npm run build
cd ../desktop && cargo build --release   # 產生 desktop/target/release/md-editor.exe
```

開發時可先在 `web/` 執行 `npm run dev`，再於 `desktop/` 執行 `cargo run --no-default-features`，桌面視窗會直接連到開發伺服器、即時更新。

## 架構

```
crates/
  md-core/   Rust 核心：Markdown（comrak）、純文字、JSON（serde_json）轉 HTML，擷取大綱、字數統計
  md-wasm/   md-core 的 WebAssembly 綁定（wasm-bindgen），回傳一般的 JS 物件
  md-cli/    命令列工具 mdtool，跟網頁共用同一個核心
desktop/     桌面版（Tauri 2）：沿用網頁介面，補上原生開檔／存檔對話框
web/
  src/main.ts        組裝各個模組
  src/commands.ts    指令中心：工具列、選單、指令面板、快速鍵共用同一份指令清單
  src/editor.ts      CodeMirror 6 編輯器（依文件類型切換語法）
  src/format.ts      Markdown 格式指令
  src/table.ts       表格編輯（Tab 跳格、插入刪除欄列；對齊由 Rust 核心處理）
  src/brackets.ts    括號配對（含輸入法組字後的全形括號）
  src/settings.ts    設定的讀取、驗證與儲存
  src/preview.ts     預覽與外掛介面
  src/ui/            指令面板、下拉選單、通知、分隔線、差異檢視、設定、圖示（lucide）
```

Rust 負責「文件 → HTML」這段需要正確與效能的部分；前端拿到 HTML 後，再交給**預覽外掛**做後續處理。
想加入數學公式（KaTeX）、流程圖（Mermaid）等功能時，只要實作 `PreviewPlugin` 介面，不必改動 Rust：

```ts
// web/src/preview.ts
export interface PreviewPlugin {
  name: string;
  apply(root: HTMLElement): void | Promise<void>;
}
```

可參考 `web/src/plugins/highlight.ts`，然後在 `web/src/main.ts` 的 `new Preview(...)` 加進去即可。
要新增功能時，在 `main.ts` 用 `commands.register(...)` 註冊一個指令，它就會自動出現在指令面板，並套用快速鍵。

安全性：核心一律不輸出原始 HTML，並會過濾 `javascript:` 等危險連結；純文字與 JSON 的內容也都會跳脫，因此預覽可以直接把結果放進 DOM。

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
```

文件類型依副檔名判斷，也可以用 `--format md|txt|json` 指定。省略檔名時會從標準輸入讀取，例如 `cat 筆記.md | mdtool html`。

## 授權

MIT
