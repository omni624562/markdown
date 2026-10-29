//! AI 工具、終端機、MCP。

pub static EN: &[(&str, &str)] = &[
    ("Claude Code 回報錯誤（{reason}）", "Claude Code reported an error ({reason})"),
    ("未知", "unknown"),
    ("無法執行 {tool}：{e}", "Couldn't run {tool}: {e}"),
    ("無法傳送內容", "Couldn't send the content."),
    ("無法傳送內容給 {tool}：{e}", "Couldn't send the content to {tool}: {e}"),
    ("{tool} 沒有回傳結果（結束代碼 {status}）", "{tool} returned no result (exit code {status})"),
    ("無法建立終端機：{e}", "Couldn't create the terminal: {e}"),
    ("無法啟動程式：{e}", "Couldn't start the program: {e}"),
    ("AI：{command}", "AI: {command}"),
    ("終端機", "Terminal"),
    ("找不到 {label}。請先安裝並登入，確認在命令提示字元輸入 {exe} 可以執行。", "Couldn't find {label}. Install it and sign in first, and make sure typing {exe} in the Command Prompt runs it."),
    ("無法啟動 MCP 伺服器：{e}", "Couldn't start the MCP server: {e}"),
    ("請先開啟「讓 AI 讀取目前的文件」", "Turn on \"Let AI Read the Current Document\" first."),
    ("不支援這個工具", "This tool isn't supported."),
    ("無法複製到剪貼簿：{e}", "Couldn't copy to the clipboard: {e}"),
];
