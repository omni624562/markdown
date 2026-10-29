//! AI 協作（預設關閉，由設定開啟）。
//!
//! 原則：只執行使用者自己安裝、自己登入的官方命令列工具（Claude Code、Codex），
//! 編輯器不碰任何帳號或金鑰；AI 提出的修改一律交給前端的差異檢視，由使用者決定是否套用。

pub mod mcp;
pub mod run;
pub mod term;
pub mod tools;
pub mod view;
