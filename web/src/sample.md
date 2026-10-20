# 歡迎使用 Markdown 編輯器

左邊寫 Markdown，右邊**即時預覽**。解析由 Rust（[comrak](https://github.com/kivikakk/comrak)）編譯成 WebAssembly 執行，程式碼語法上色則交給 JS 生態系的 highlight.js。

## 快速鍵

| 功能 | Windows／Linux | macOS |
| --- | --- | --- |
| 粗體 | `Ctrl+B` | `⌘B` |
| 斜體 | `Ctrl+I` | `⌘I` |
| 行內程式碼 | `Ctrl+E` | `⌘E` |
| 儲存 | `Ctrl+S` | `⌘S` |
| 搜尋／取代 | `Ctrl+F` | `⌘F` |

## 支援的語法

- [x] 表格、刪除線（~~像這樣~~）、自動連結：https://example.com
- [x] 待辦清單
- [x] 註腳[^1]
- [x] GitHub 風格的提示區塊
- [ ] 數學公式（可以用預覽外掛接上 KaTeX）

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

## 其他功能

1. 左側**大綱**可以點擊跳到對應段落
2. 捲動編輯器時，預覽會跟著同步
3. 內容會自動存成草稿，重新整理也不會不見
4. 可以拖曳 `.md` 檔進來開啟，或匯出成獨立的 HTML 檔

[^1]: 註腳會出現在文件最下方。
