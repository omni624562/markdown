//! 內嵌終端機：用虛擬終端（Windows 上是 ConPTY）執行殼層或 Claude Code、Codex，
//! 輸出以事件傳給前端的 xterm.js。
//!
//! 前端只能選擇「殼層／claude／codex」三種程式，參數由這裡決定，不能執行任意命令。

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

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

impl Terminals {
    /// 關閉 app 時結束所有子程序。
    pub fn kill_all(&self) {
        for (_, mut s) in self.sessions.lock().unwrap().drain() {
            let _ = s.killer.kill();
        }
    }
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
    workspace: State<'_, Workspace>,
) -> Result<u32, String> {
    let mut cmd = match program {
        Program::Shell => default_shell(),
        Program::Claude => tool_command(&app, Tool::Claude)?,
        Program::Codex => tool_command(&app, Tool::Codex)?,
    };
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

    let id = terms.next.fetch_add(1, Ordering::Relaxed) + 1;
    terms.sessions.lock().unwrap().insert(
        id,
        Session {
            master: pair.master,
            writer,
            killer,
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
                        let _ = out_app.emit("term-output", Output { id, data });
                    }
                }
            }
        }
    });

    // 等子程序結束。Windows 的 ConPTY 在子程序結束後不會自動讓讀取結束，
    // 所以由這裡移除工作階段（釋放虛擬終端），讀取的執行緒才會停下來。
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        app.state::<Terminals>()
            .sessions
            .lock()
            .unwrap()
            .remove(&id);
        let _ = app.emit("term-exit", Exit { id, code });
    });
    Ok(id)
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
    fn invalid_bytes_do_not_stall_output() {
        let mut buf = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut buf), "a\u{fffd}b");
        assert!(buf.is_empty());
    }
}
