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
- **大綱**：點擊即可跳到對應位置，並標示目前閱讀到的段落
- **捲動同步**：捲動編輯器時預覽會跟著對齊；中間分隔線可以拖曳（或用方向鍵）調整寬度，雙擊恢復一半一半
- **存檔狀態清楚**：檔名旁的藍點表示有變更尚未存檔；草稿會自動保存在瀏覽器
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
| 格式化 JSON | `Shift+Alt+F` | `⇧⌥F` |
| 顯示／隱藏大綱 | `Ctrl+Shift+O` | `⌘⇧O` |
| 搜尋與取代 | `Ctrl+F` | `⌘F` |

## 架構

```
crates/
  md-core/   Rust 核心：Markdown（comrak）、純文字、JSON（serde_json）轉 HTML，擷取大綱、字數統計
  md-wasm/   md-core 的 WebAssembly 綁定（wasm-bindgen），回傳一般的 JS 物件
  md-cli/    命令列工具 mdtool，跟網頁共用同一個核心
web/
  src/main.ts        組裝各個模組
  src/commands.ts    指令中心：工具列、選單、指令面板、快速鍵共用同一份指令清單
  src/editor.ts      CodeMirror 6 編輯器（依文件類型切換語法）
  src/format.ts      Markdown 格式指令
  src/preview.ts     預覽與外掛介面
  src/ui/            指令面板、下拉選單、通知、分隔線、圖示（lucide）
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
```

文件類型依副檔名判斷，也可以用 `--format md|txt|json` 指定。省略檔名時會從標準輸入讀取，例如 `cat 筆記.md | mdtool html`。

## 授權

MIT
