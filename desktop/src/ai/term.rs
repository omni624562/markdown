//! 內嵌終端機：用虛擬終端（Windows 上是 ConPTY）執行殼層或 Claude Code、Codex，
//! 輸出以事件傳給前端的 xterm.js。
//!
//! 前端只能選擇「殼層／claude／codex」三種程式，參數由這裡決定，不能執行任意命令。
//! AI 透過 MCP 要求執行的指令（`run_command`）一律先經過使用者在編輯器中同意。
//!
//! 每個終端機的輸出會保留最後一段（去掉控制碼），讓 AI 可以讀取執行結果。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::mcp::Mcp;
use super::tools::{program_for, Tool};
use crate::workspace::Workspace;

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Program {
    Shell,
    Claude,
    Codex,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// 每個終端機最多保留的輸出（位元組）。
const LOG_LIMIT: usize = 256 * 1024;

/// 終端機的輸出紀錄（程式結束後保留到使用者關閉分頁）。
#[derive(Clone, Default)]
pub struct Log {
    pub label: String,
    pub text: String,
    /// `Some` 表示程式已結束（內層是結束代碼）。
    pub exit: Option<Option<u32>>,
}

impl Log {
    fn push(&mut self, data: &str) {
        self.text.push_str(data);
        if self.text.len() > LOG_LIMIT {
            let mut cut = self.text.len() - LOG_LIMIT / 2;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text.drain(..cut);
        }
    }
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
    logs: Mutex<HashMap<u32, Log>>,
}

impl Terminals {
    /// 關閉 app 時結束所有子程序。
    pub fn kill_all(&self) {
        for (_, mut s) in self.sessions.lock().unwrap().drain() {
            let _ = s.killer.kill();
        }
    }

    /// 一個終端機的輸出紀錄。
    pub fn log(&self, id: u32) -> Option<Log> {
        self.logs.lock().unwrap().get(&id).cloned()
    }

    /// 所有終端機（編號、名稱、是否已結束），依編號排序。
    pub fn list(&self) -> Vec<(u32, Log)> {
        let mut all: Vec<(u32, Log)> = self
            .logs
            .lock()
            .unwrap()
            .iter()
            .map(|(id, l)| {
                (
                    *id,
                    Log {
                        text: String::new(),
                        ..l.clone()
                    },
                )
            })
            .collect();
        all.sort_by_key(|(id, _)| *id);
        all
    }

    /// 在虛擬終端中啟動程式，輸出以事件傳給前端，並記錄在紀錄中。
    pub fn spawn(
        &self,
        app: &AppHandle,
        mut cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        label: String,
    ) -> Result<u32, String> {
        let workspace = app.state::<Workspace>();
        let cwd = workspace
            .root()
            .or_else(|| app.path().home_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("無法建立終端機：{e}"))?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("無法啟動程式：{e}"))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();

        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                master: pair.master,
                writer,
                killer,
            },
        );
        self.logs.lock().unwrap().insert(
            id,
            Log {
                label,
                ..Default::default()
            },
        );

        let out_app = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let data = take_utf8(&mut pending);
                        if !data.is_empty() {
                            if let Some(log) = out_app
                                .state::<Terminals>()
                                .logs
                                .lock()
                                .unwrap()
                                .get_mut(&id)
                            {
                                log.push(&data);
                            }
                            let _ = out_app.emit("term-output", Output { id, data });
                        }
                    }
                }
            }
        });

        // 等子程序結束。Windows 的 ConPTY 在子程序結束後不會自動讓讀取結束，
        // 所以由這裡移除工作階段（釋放虛擬終端），讀取的執行緒才會停下來。
        let exit_app = app.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            let terms = exit_app.state::<Terminals>();
            terms.sessions.lock().unwrap().remove(&id);
            if let Some(log) = terms.logs.lock().unwrap().get_mut(&id) {
                log.exit = Some(code);
            }
            let _ = exit_app.emit("term-exit", Exit { id, code });
        });
        Ok(id)
    }

    /// 執行 AI 要求、使用者同意過的指令：開一個新的終端機分頁讓使用者看到過程。
    pub fn run_command(&self, app: &AppHandle, command: &str) -> Result<u32, String> {
        let label = format!("AI：{}", shorten(command, 24));
        let id = self.spawn(app, command_line(command), 120, 30, label.clone())?;
        let _ = app.emit("term-attached", Attached { id, label });
        Ok(id)
    }
}

#[derive(Serialize, Clone)]
struct Attached {
    id: u32,
    label: String,
}

fn shorten(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.chars().count() > max || s.trim().contains('\n') {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else {
        line.to_string()
    }
}

/// 用預設的殼層執行一行指令（Windows 是 PowerShell）。
fn command_line(command: &str) -> CommandBuilder {
    if cfg!(windows) {
        let mut cmd = match which::which("pwsh") {
            Ok(p) => CommandBuilder::new(p),
            Err(_) => CommandBuilder::new("powershell.exe"),
        };
        cmd.args(["-NoLogo", "-NoProfile", "-Command", command]);
        cmd
    } else {
        let mut cmd =
            CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        cmd.args(["-c", command]);
        cmd
    }
}

/// 去掉終端機的控制碼（顏色、游標移動、視窗標題等），給 AI 讀取用。
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // CSI：ESC [ 參數 … 結尾字元（0x40–0x7E）
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC：ESC ] … BEL 或 ESC \\
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\r' => {
                // \r\n 當成換行；單獨的 \r 是覆寫同一行（例如進度列），只留最後的內容。
                if chars.peek() != Some(&'\n') {
                    out.truncate(out.rfind('\n').map_or(0, |i| i + 1));
                }
            }
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

#[derive(Serialize, Clone)]
struct Output {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: u32,
    code: Option<u32>,
}

/// 把讀到的位元組轉成字串；結尾不完整的 UTF-8 字元留到下一次。
fn take_utf8(buf: &mut Vec<u8>) -> String {
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let s = s.to_owned();
            buf.clear();
            s
        }
        Err(e) if e.error_len().is_none() => {
            // 結尾的字元還沒讀完整。
            let rest = buf.split_off(e.valid_up_to());
            String::from_utf8(std::mem::replace(buf, rest)).unwrap_or_default()
        }
        Err(_) => {
            let s = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            s
        }
    }
}

fn default_shell() -> CommandBuilder {
    if cfg!(windows) {
        let mut cmd = match which::which("pwsh") {
            Ok(p) => CommandBuilder::new(p),
            Err(_) => CommandBuilder::new("powershell.exe"),
        };
        cmd.arg("-NoLogo");
        cmd
    } else {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()))
    }
}

fn tool_command(app: &AppHandle, tool: Tool) -> Result<CommandBuilder, String> {
    let (prog, pre) = program_for(&tool.locate()?);
    let mut cmd = CommandBuilder::new(prog);
    cmd.args(pre);
    // 編輯器的 MCP 伺服器開著時，順便讓 AI 能讀取目前的文件、提出修改。
    if let Some(conn) = app.state::<Mcp>().connection() {
        match tool {
            Tool::Claude => {
                cmd.arg("--mcp-config");
                cmd.arg(&conn.config_path);
                // 提出修改後要等使用者在編輯器中決定，工具呼叫可能需要比較久。
                cmd.env("MCP_TOOL_TIMEOUT", "600000");
            }
            Tool::Codex => {
                cmd.args([
                    "-c".to_string(),
                    format!("mcp_servers.md-editor.url=\"{}\"", conn.url),
                    "-c".to_string(),
                    format!(
                        "mcp_servers.md-editor.bearer_token_env_var=\"{}\"",
                        super::mcp::TOKEN_ENV
                    ),
                    "-c".to_string(),
                    "mcp_servers.md-editor.tool_timeout_sec=600".to_string(),
                ]);
                cmd.env(super::mcp::TOKEN_ENV, &conn.token);
            }
        }
    }
    Ok(cmd)
}

/// 開啟一個終端機，回傳編號。工作目錄是目前開啟的資料夾（沒有的話是使用者家目錄）。
#[tauri::command]
pub fn term_open(
    app: AppHandle,
    program: Program,
    cols: u16,
    rows: u16,
    terms: State<'_, Terminals>,
) -> Result<u32, String> {
    let (cmd, label) = match program {
        Program::Shell => (default_shell(), "終端機"),
        Program::Claude => (tool_command(&app, Tool::Claude)?, "Claude Code"),
        Program::Codex => (tool_command(&app, Tool::Codex)?, "Codex"),
    };
    terms.spawn(&app, cmd, cols, rows, label.into())
}

#[tauri::command]
pub fn term_write(id: u32, data: String, terms: State<'_, Terminals>) -> Result<(), String> {
    let mut sessions = terms.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("終端機已經結束")?;
    s.writer
        .write_all(data.as_bytes())
        .and_then(|_| s.writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(
    id: u32,
    cols: u16,
    rows: u16,
    terms: State<'_, Terminals>,
) -> Result<(), String> {
    let sessions = terms.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("終端機已經結束")?;
    s.master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_close(id: u32, terms: State<'_, Terminals>) {
    if let Some(mut s) = terms.sessions.lock().unwrap().remove(&id) {
        let _ = s.killer.kill();
    }
    terms.logs.lock().unwrap().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_incomplete_utf8_for_next_read() {
        let bytes = "中文".as_bytes();
        let mut buf = bytes[..4].to_vec(); // 「中」完整，「文」只有第一個位元組
        assert_eq!(take_utf8(&mut buf), "中");
        assert_eq!(buf.len(), 1);
        buf.extend_from_slice(&bytes[4..]);
        assert_eq!(take_utf8(&mut buf), "文");
        assert!(buf.is_empty());
    }

    #[test]
    fn strips_terminal_control_codes() {
        let raw = "\u{1b}]0;標題\u{7}\u{1b}[1;32m成功\u{1b}[0m\r\n下載 10%\r下載 100%\r\n";
        assert_eq!(strip_ansi(raw), "成功\n下載 100%\n");
        assert_eq!(strip_ansi("a\u{1b}]8;;http://x\u{1b}\\b"), "ab");
    }

    #[test]
    fn log_keeps_the_latest_output() {
        let mut log = Log::default();
        log.push(&"中".repeat(LOG_LIMIT));
        assert!(log.text.len() <= LOG_LIMIT);
        log.push("結尾");
        assert!(log.text.ends_with("結尾"));
    }

    #[test]
    fn shortens_labels() {
        assert_eq!(shorten("git status", 24), "git status");
        assert_eq!(shorten("echo 一\necho 二", 24), "echo 一…");
    }

    #[test]
    fn invalid_bytes_do_not_stall_output() {
        let mut buf = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut buf), "a\u{fffd}b");
        assert!(buf.is_empty());
    }
}
