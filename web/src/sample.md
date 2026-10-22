# 歡迎使用 Laiwrite

左邊寫 Markdown，右邊**即時預覽**。解析由 Rust（[comrak](https://github.com/kivikakk/comrak)）編譯成 WebAssembly 執行，程式碼語法上色則交給 JS 生態系的 highlight.js。

## 快速鍵

| 功能 | Windows／Linux | macOS |
| --- | --- | --- |
| **指令面板**（找得到所有功能） | `Ctrl+Shift+P` | `⌘⇧P` |
| 粗體／斜體 | `Ctrl+B`／`Ctrl+I` | `⌘B`／`⌘I` |
| 行內程式碼 | `Ctrl+E` | `⌘E` |
| 插入連結 | `Ctrl+K` | `⌘K` |
| 標題 1～3 | `Ctrl+Alt+1`～`3` | `⌘⌥1`～`3` |
| 開啟／儲存 | `Ctrl+O`／`Ctrl+S` | `⌘O`／`⌘S` |
| 搜尋與取代 | `Ctrl+F` | `⌘F` |

## 支援的語法

- [x] 表格、刪除線（~~像這樣~~）、自動連結：https://example.com
- [x] 待辦清單
- [x] 註腳[^1]
- [x] GitHub 風格的提示區塊
- [x] 數學公式：$E = mc^2$
- [x] 流程圖（Mermaid）

> [!TIP]
> 中文緊接著**粗體**也能正確辨識，不需要在星號前後補空白。

```rust
fn main() {
    let html = md_core::render("# 你好", &Default::default()).html;
    println!("{html}");
}
```

```ts
const result = render(markdown, { sourcepos: true });
preview.innerHTML = result.html;
```

```mermaid
graph LR
  寫作 --> 預覽 --> 匯出
```

## 其他功能

1. 在表格中按 `Tab` 跳到下一格，表格會依中文字寬自動對齊
2. 也能開啟 `.txt` 與 `.json`：JSON 會顯示可摺疊的樹狀檢視，並即時標出語法錯誤
3. 左側**大綱**可以點擊跳到對應段落，並標示目前閱讀的位置
4. 捲動編輯器時，預覽會跟著同步；中間的分隔線可以拖曳調整寬度
5. 內容會自動存成草稿，重新整理也不會不見
6. 可以直接把檔案拖曳進來，或匯出成獨立的 HTML 檔

[^1]: 註腳會出現在文件最下方。
