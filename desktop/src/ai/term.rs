//! 內嵌終端機：用虛擬終端（Windows 上是 ConPTY）執行殼層或 Claude Code、Codex，
//! 輸出以事件傳給前端的 xterm.js。
//!
//! 前端只能選擇「殼層／claude／codex」三種程式，參數由這裡決定。殼層可以執行任何指令，
//! 所以第一次開啟前要在系統的對話框同意（網頁萬一被注入程式碼，也不能自己偷偷開殼層）；
//! claude、codex 要先開啟「啟用 AI 協作」（同樣在系統的對話框確認）。
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
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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
    /// 送給程式的輸入。由專門的執行緒依序寫入：程式沒在讀輸入時（虛擬終端的緩衝區滿了），
    /// 寫入會停住，不能讓前端的指令（以及握著的 `sessions` 鎖）跟著卡住。
    input: std::sync::mpsc::Sender<Vec<u8>>,
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
        drop_invalid_env(&mut cmd);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(10),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| tr!("無法建立終端機：{e}", e = e))?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| tr!("無法啟動程式：{e}", e = e))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let (input, keys) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            // 終端機關閉（`Session` 被移除）時通道斷開，迴圈結束。
            for data in keys {
                if writer
                    .write_all(&data)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });

        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions.lock().unwrap().insert(
            id,
            Session {
                master: pair.master,
                input,
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

        // 讀取與送出分成兩個執行緒：大量輸出時（例如建置記錄），送出前把已經讀到的合併成一次，
        // 不用每讀一次就送一個事件給前端。打字時的少量輸出仍然立刻送出。
        let (tx, rx) = std::sync::mpsc::channel::<Chunk>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let data = take_utf8(&mut pending);
                        let full = n == buf.len();
                        if !data.is_empty() && tx.send(Chunk { data, full }).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let out_app = app.clone();
        std::thread::spawn(move || {
            while let Some(data) = next_batch(&rx) {
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
        let label = tr!("AI：{command}", command = shorten(command, 24));
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

/// Windows 內建的 PowerShell（完整路徑，免得執行到放在本程式旁邊的同名程式）。
fn windows_powershell() -> PathBuf {
    crate::io::system_root().join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}

/// 用預設的殼層執行一行指令（Windows 是 PowerShell）。
/// 環境變數的名稱與值是否能放進 Windows 建立程式時的環境區塊。
/// 名稱是空的（例如登錄檔「使用者環境變數」裡被設了值的「(預設值)」）、名稱中間有 `=`，
/// 或含有 NUL 字元時，CreateProcessW 會回報「參數不正確」（os error 87），連終端機都開不了。
/// 開頭的 `=` 是 Windows 自己用的隱藏變數（例如 `=C:`），要保留。
fn valid_env(key: &str, value: &str) -> bool {
    let name = key.strip_prefix('=').unwrap_or(key);
    !name.is_empty() && !name.contains('=') && !key.contains('\0') && !value.contains('\0')
}

/// 拿掉不合法的環境變數。portable-pty 會把登錄檔中的使用者與系統環境變數原封不動加進來，
/// 一筆不合法就會讓所有程式（PowerShell、Claude Code、Codex）都啟動失敗。
fn drop_invalid_env(cmd: &mut CommandBuilder) {
    let bad: Vec<String> = cmd
        .iter_full_env_as_str()
        .filter(|(k, v)| !valid_env(k, v))
        .map(|(k, _)| k.to_string())
        .collect();
    for key in bad {
        cmd.env_remove(key);
    }
}

fn command_line(command: &str) -> CommandBuilder {
    if cfg!(windows) {
        let mut cmd = match which::which("pwsh") {
            Ok(p) => CommandBuilder::new(p),
            Err(_) => CommandBuilder::new(windows_powershell()),
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

/// 讀到的一段輸出。`full` 表示讀取的緩衝區滿了（後面很可能還有）。
struct Chunk {
    data: String,
    full: bool,
}

/// 大量輸出時最多等多久把後續的輸出合併成一次送出。
const BATCH_WAIT: std::time::Duration = std::time::Duration::from_millis(8);
/// 一次最多送出多少（位元組）。
const BATCH_LIMIT: usize = 256 * 1024;

/// 等下一段輸出，並合併已經在排隊的輸出。只有在確實是大量輸出時（排隊中還有，或緩衝區讀滿）
/// 才再多等最多 [`BATCH_WAIT`]；打字的回應不會被延遲。讀取結束時回傳 `None`。
fn next_batch(rx: &std::sync::mpsc::Receiver<Chunk>) -> Option<String> {
    use std::sync::mpsc::RecvTimeoutError;
    let first = rx.recv().ok()?;
    let mut data = first.data;
    let mut burst = first.full;
    let deadline = std::time::Instant::now() + BATCH_WAIT;
    while data.len() < BATCH_LIMIT {
        let next = match rx.try_recv() {
            Ok(c) => Ok(c),
            Err(_) if burst => {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    break;
                }
                rx.recv_timeout(left)
            }
            Err(_) => break,
        };
        match next {
            Ok(c) => {
                data.push_str(&c.data);
                burst = true;
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        }
    }
    Some(data)
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
        match which::which("pwsh") {
            Ok(p) => {
                let mut cmd = CommandBuilder::new(p);
                // PowerShell 7 預設把資料夾名稱畫成整塊藍底，在編輯器裡太刺眼；
                // 還是預設值時改成藍色粗體字（使用者自己設定過就不動）。
                cmd.args([
                    "-NoLogo",
                    "-NoExit",
                    "-Command",
                    "if ($PSStyle.FileInfo.Directory -eq \"`e[44;1m\") { $PSStyle.FileInfo.Directory = \"`e[34;1m\" }",
                ]);
                cmd
            }
            Err(_) => {
                let mut cmd = CommandBuilder::new(windows_powershell());
                cmd.arg("-NoLogo");
                cmd
            }
        }
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

/// 記錄「使用者已經同意使用終端機」的檔案。放在設定資料夾，和前端寫的 settings.json 分開，
/// 前端沒有指令可以建立它。
fn shell_consent_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("terminal-allowed"))
        .map_err(|e| e.to_string())
}

/// 開殼層前檢查使用者是否同意過；還沒有時用系統的對話框詢問（網頁無法代按），同意後記下來，
/// 之後不再詢問。
async fn require_shell_consent(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    // 一次只問一次，同時開好幾個終端機時對話框不會重複跳出。
    static ASKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = ASKING.lock().await;
    let path = shell_consent_path(app)?;
    if path.is_file() {
        return Ok(());
    }
    let answer = rfd::AsyncMessageDialog::new()
        .set_parent(window)
        .set_level(rfd::MessageLevel::Warning)
        .set_title(tr!("開啟終端機"))
        .set_description(tr!(
            "終端機可以用你的帳號執行任何指令。只有在你自己要開啟終端機時才選「是」；同意後，之後開啟終端機不會再詢問。要開啟嗎？"
        ))
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await;
    if answer != rfd::MessageDialogResult::Yes {
        return Err(tr!("沒有開啟終端機"));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| tr!("無法建立設定資料夾：{e}", e = e))?;
    }
    std::fs::write(&path, b"1").map_err(|e| tr!("無法儲存設定：{e}", e = e))
}

/// 開啟一個終端機，回傳編號。工作目錄是目前開啟的資料夾（沒有的話是使用者家目錄）。
/// 搜尋程式與啟動子程序可能要一點時間，在背景執行緒進行，不會卡住視窗。
#[tauri::command]
pub async fn term_open(
    app: AppHandle,
    window: WebviewWindow,
    program: Program,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    if matches!(program, Program::Shell) {
        require_shell_consent(&app, &window).await?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (cmd, label) = match program {
            // 開著 SSH 遠端資料夾時，終端機也連到同一台主機。
            Program::Shell => match app
                .state::<crate::dav::Dav>()
                .ssh_target()
                .and_then(|(user, t)| Some((crate::ssh::terminal_command(&user, &t)?, t.host)))
            {
                Some((cmd, host)) => (cmd, tr!("SSH：{host}", host = host)),
                None => (default_shell(), tr!("終端機")),
            },
            Program::Claude => {
                crate::settings::require_ai(&app)?;
                (tool_command(&app, Tool::Claude)?, "Claude Code".into())
            }
            Program::Codex => {
                crate::settings::require_ai(&app)?;
                (tool_command(&app, Tool::Codex)?, "Codex".into())
            }
        };
        app.state::<Terminals>().spawn(&app, cmd, cols, rows, label)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn term_write(id: u32, data: String, terms: State<'_, Terminals>) -> Result<(), String> {
    let sessions = terms.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or_else(|| tr!("終端機已經結束"))?;
    s.input
        .send(data.into_bytes())
        .map_err(|_| tr!("終端機已經結束"))
}

#[tauri::command]
pub fn term_resize(
    id: u32,
    cols: u16,
    rows: u16,
    terms: State<'_, Terminals>,
) -> Result<(), String> {
    let sessions = terms.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or_else(|| tr!("終端機已經結束"))?;
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
    fn rejects_env_vars_that_break_create_process() {
        assert!(valid_env("PATH", "C:\\Windows"));
        assert!(
            valid_env("=C:", "C:\\Users\\nan"),
            "Windows 的隱藏變數要保留"
        );
        assert!(valid_env("EMPTY_VALUE", ""));
        assert!(!valid_env("", "殘留的預設值"));
        assert!(!valid_env("=", "x"));
        assert!(!valid_env("A=B", "x"));
        assert!(!valid_env("A", "x\0y"));

        let mut cmd = CommandBuilder::new("claude");
        cmd.env("", "殘留的預設值");
        cmd.env("MCP_TOOL_TIMEOUT", "600000");
        drop_invalid_env(&mut cmd);
        assert_eq!(cmd.get_env(""), None);
        assert_eq!(
            cmd.get_env("MCP_TOOL_TIMEOUT"),
            Some(std::ffi::OsStr::new("600000"))
        );
    }

    /// 真的開一個虛擬終端執行程式。Windows 上同時確認：環境區塊裡有空名稱的變數時，
    /// CreateProcessW 確實會失敗（使用者遇到的 os error 87），拿掉後就能啟動。
    #[test]
    fn spawns_after_dropping_invalid_env() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = if cfg!(windows) {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/d", "/c", "echo ok"]);
            c
        } else {
            let mut c = CommandBuilder::new("/bin/sh");
            c.args(["-c", "echo ok"]);
            c
        };
        cmd.env("", "殘留的預設值");
        if cfg!(windows) {
            let err = pair.slave.spawn_command(cmd.clone()).err();
            assert!(
                err.as_ref()
                    .is_some_and(|e| e.to_string().contains("os error 87")),
                "預期空名稱的環境變數會讓 CreateProcessW 失敗，實際：{err:?}"
            );
        }
        drop_invalid_env(&mut cmd);
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .expect("拿掉不合法的環境變數後要能啟動");
        // Windows 的虛擬終端一開始會詢問游標位置（ESC [6n），要回答之後程式才會執行；
        // 輸出也要有人讀走。介面上由 xterm.js 回答，這裡自己回答。
        // 讀取的執行緒不等它（終端關閉前不會讀到結尾）。
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                panic!("程式啟動後 30 秒內沒有結束");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert!(status.success());
    }

    #[test]
    fn batches_only_bursts() {
        let (tx, rx) = std::sync::mpsc::channel();
        let chunk = |s: &str, full| Chunk {
            data: s.into(),
            full,
        };
        // 打字：一次一小段，立刻送出，不合併。
        tx.send(chunk("a", false)).unwrap();
        assert_eq!(next_batch(&rx).as_deref(), Some("a"));
        // 已經在排隊的輸出合併成一次。
        tx.send(chunk("b", false)).unwrap();
        tx.send(chunk("c", false)).unwrap();
        assert_eq!(next_batch(&rx).as_deref(), Some("bc"));
        // 緩衝區讀滿：稍等後續的輸出。
        tx.send(chunk("d", true)).unwrap();
        let tx2 = tx.clone();
        let later = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1));
            tx2.send(chunk("e", false)).unwrap();
        });
        later.join().unwrap();
        assert_eq!(next_batch(&rx).as_deref(), Some("de"));
        drop(tx);
        assert_eq!(next_batch(&rx), None);
    }

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
