# Markdown 編輯器

左邊寫 Markdown、右邊即時預覽的網頁編輯器。解析核心用 Rust 撰寫並編譯成 WebAssembly，介面則用 TypeScript，可以自由接上 JS 生態系的套件。

## 功能

- **即時預覽**：支援 GitHub Flavored Markdown（表格、刪除線、待辦清單、自動連結、註腳、`> [!NOTE]` 提示區塊）
- **中文友善**：`這是**粗體**文字` 這種中文緊接星號的寫法也能正確辨識；字數統計以中文字與英文單字分開計算
- **大綱**：依標題自動產生，點擊即可跳到編輯器與預覽的對應位置
- **捲動同步**：捲動編輯器時，預覽會對齊同一段內容
- **程式碼語法上色**：編輯器內的程式碼區塊與預覽都會上色
- **檔案**：開啟／儲存 `.md`（Chrome、Edge 可直接寫回原檔）、拖曳開檔、匯出獨立 HTML、複製 HTML
- **自動儲存草稿**到瀏覽器，重新整理也不會遺失
- 深色／淺色主題、編輯／分割／預覽三種檢視模式、手機版面
- 快速鍵：`Ctrl+B` 粗體、`Ctrl+I` 斜體、`Ctrl+E` 行內程式碼、`Ctrl+S` 儲存、`Ctrl+F` 搜尋

## 架構

```
crates/
  md-core/   Rust 核心：解析 Markdown（comrak）、產生 HTML、擷取大綱、字數統計
  md-wasm/   md-core 的 WebAssembly 綁定（wasm-bindgen），回傳一般的 JS 物件
  md-cli/    命令列工具 mdtool，跟網頁共用同一個核心
web/         前端：Vite + TypeScript + CodeMirror 6
```

Rust 負責「Markdown → HTML」這段需要正確與效能的部分；前端拿到 HTML 後，再交給**預覽外掛**做後續處理。
想加入數學公式（KaTeX）、流程圖（Mermaid）等功能時，只要實作 `PreviewPlugin` 介面，不必改動 Rust：

```ts
// web/src/preview.ts
export interface PreviewPlugin {
  name: string;
  apply(root: HTMLElement): void | Promise<void>;
}
```

可參考 `web/src/plugins/highlight.ts`，然後在 `web/src/main.ts` 的 `new Preview(...)` 加進去即可。

安全性：核心一律不輸出原始 HTML，並會過濾 `javascript:` 等危險連結，因此預覽可以直接把結果放進 DOM。

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
cargo run -p md-cli -- html 筆記.md -o 筆記.html   # 轉成完整的 HTML 頁面
cargo run -p md-cli -- html --fragment 筆記.md     # 只輸出 HTML 片段
cargo run -p md-cli -- toc 筆記.md                 # 列出標題大綱
cargo run -p md-cli -- stats 筆記.md               # 字數統計
```

省略檔名時會從標準輸入讀取，例如 `cat 筆記.md | mdtool html`。

## 授權

MIT
