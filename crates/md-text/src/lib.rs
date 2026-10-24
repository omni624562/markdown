//! Markdown 文件的文字分析（待辦、標籤、連結；用語、錯字與標點檢查），桌面版後端（資料夾索引）與網頁版（WebAssembly）共用同一份程式。
//!
//! 只依賴 `serde`（不用正規表示式套件），編譯成 WebAssembly 時檔案才小。

mod doc_info;
mod proofread;
mod scan;

pub use doc_info::{parse_doc, DocInfo, LinkRef, Task};
pub use proofread::{proofread, punct_key, terms, Term, TermMatch};
