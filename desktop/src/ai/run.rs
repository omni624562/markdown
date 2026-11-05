//! 選取段落快捷動作：在背景執行 `claude -p` 或 `codex exec`，串流回傳結果。
//!
//! 選取的文字可能來自 Wiki、工作項目等別人寫的內容（可能夾帶要 AI 做別的事的指示），
//! 所以 AI 只能處理傳進去的文字，不能執行命令、不能讀寫檔案：
//! - Claude Code：`--tools ""` 不給任何內建工具，`--strict-mcp-config` 不載入 MCP 伺服器。
//! - Codex：`--disable shell_tool` 拿掉執行命令的工具（沒有它就不能列目錄、讀檔案），
//!   `--sandbox read-only` 擋住寫入。`--disable` 遇到不認得的功能名稱會直接失敗，
//!   不會在沒有保護的情況下執行；另外先檢查版本（見 [`CODEX_MIN_VERSION`]）。
//!   還有兩處做不到和 Claude Code 一樣：讀取圖片檔的 `view_image` 要 0.147.0 起才能關掉
//!   （舊版的 AI 仍可能讀取猜得到路徑的圖片）；使用者自己在 Codex 設定檔加的 MCP 伺服器
//!   仍然會載入（`--ignore-user-config` 會連模型等設定一起忽略，所以不用）。
//!
//! 兩者都在一個空的資料夾執行，文字從標準輸入傳入，不放在命令列上。
//! 結果由前端以差異檢視讓使用者決定是否套用。

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

use super::tools::{program_for, Tool};

#[derive(Default)]
pub struct Runs(Mutex<HashMap<u64, oneshot::Sender<()>>>);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunEvent {
    /// 串流中的部分文字。
    Delta {
        id: u64,
        text: String,
    },
    /// 完成。`text` 是完整結果。
    #[serde(rename_all = "camelCase")]
    Done {
        id: u64,
        text: String,
        cost_usd: Option<f64>,
        tokens: Option<u64>,
    },
    Error {
        id: u64,
        message: String,
    },
}

/// 從 CLI 的一行 JSON 輸出解析出的內容。
#[derive(Debug, PartialEq)]
enum Parsed {
    Delta(String),
    /// 中途的完整訊息（Codex 一次給整段）。
    Message(String),
    Done {
        text: Option<String>,
        cost_usd: Option<f64>,
        tokens: Option<u64>,
    },
    Error(String),
}

/// `claude -p --output-format stream-json --include-partial-messages` 的一行。
fn parse_claude(line: &str) -> Option<Parsed> {
    let v: Value = serde_json::from_str(line).ok()?;
    match v["type"].as_str()? {
        "stream_event" => {
            let ev = &v["event"];
            (ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta")
                .then(|| Parsed::Delta(ev["delta"]["text"].as_str().unwrap_or("").to_string()))
        }
        "result" => {
            let text = v["result"].as_str().unwrap_or("").to_string();
            if v["is_error"].as_bool().unwrap_or(false) || v["subtype"] != "success" {
                Some(Parsed::Error(if text.is_empty() {
                    tr!(
                        "Claude Code 回報錯誤（{reason}）",
                        reason = v["subtype"].as_str().unwrap_or(&tr!("未知"))
                    )
                } else {
                    text
                }))
            } else {
                let usage = &v["usage"];
                let tokens = usage["input_tokens"]
                    .as_u64()
                    .zip(usage["output_tokens"].as_u64());
                Some(Parsed::Done {
                    text: Some(text),
                    cost_usd: v["total_cost_usd"].as_f64(),
                    tokens: tokens.map(|(a, b)| a + b),
                })
            }
        }
        _ => None,
    }
}

/// `codex exec --json` 的一行。
fn parse_codex(line: &str) -> Option<Parsed> {
    let v: Value = serde_json::from_str(line).ok()?;
    match v["type"].as_str()? {
        "item.completed" if v["item"]["type"] == "agent_message" => Some(Parsed::Message(
            v["item"]["text"].as_str().unwrap_or("").to_string(),
        )),
        "turn.completed" => {
            let u = &v["usage"];
            let tokens = u["input_tokens"].as_u64().zip(u["output_tokens"].as_u64());
            Some(Parsed::Done {
                text: None,
                cost_usd: None,
                tokens: tokens.map(|(a, b)| a + b),
            })
        }
        "turn.failed" => Some(Parsed::Error(
            v["error"]["message"]
                .as_str()
                .unwrap_or(&tr!("Codex 執行失敗"))
                .to_string(),
        )),
        "error" => Some(Parsed::Error(
            v["message"]
                .as_str()
                .unwrap_or(&tr!("Codex 執行失敗"))
                .to_string(),
        )),
        _ => None,
    }
}

/// 快捷動作傳給各工具的參數（提示從標準輸入傳入）。
fn args(tool: Tool) -> &'static [&'static str] {
    match tool {
        Tool::Claude => &[
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--tools",
            "",
        ],
        Tool::Codex => &[
            // 拿掉執行命令的工具（shell、exec_command 等）。Codex 0.51.0 起，
            // 不認得的功能名稱會讓整個命令失敗，不會默默忽略。
            "--disable",
            "shell_tool",
            // 讀取圖片檔的工具（0.147.0 起才有這個開關；舊版不認得只會忽略）。
            "-c",
            "features.view_image=false",
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-",
        ],
    }
}

/// 快捷動作要求的最低 Codex 版本：`shell_tool` 這個功能開關從 0.59.0 開始才有。
/// 更舊的版本會因為不認得 `--disable` 或 `shell_tool` 而失敗，但 0.50.0 會默默忽略，
/// 所以先問版本，太舊時直接說明要更新。
const CODEX_MIN_VERSION: (u64, u64, u64) = (0, 59, 0);

/// 從 `codex --version` 的輸出（例如 `codex-cli 0.59.0`）找出第一個「數字.數字.數字」。
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    s.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|word| {
            let mut parts = word.split('.');
            let major = parts.next()?.parse().ok()?;
            let minor = parts.next()?.parse().ok()?;
            let patch = parts.next()?.parse().ok()?;
            Some((major, minor, patch))
        })
}

fn version_text((major, minor, patch): (u64, u64, u64)) -> String {
    format!("{major}.{minor}.{patch}")
}

/// 確認 Codex 夠新，能關掉執行命令的工具。確認過的路徑記起來，之後不再重問。
async fn check_codex_version(exe: &Path) -> Result<(), String> {
    static CHECKED: Mutex<Option<PathBuf>> = Mutex::new(None);
    if CHECKED.lock().as_deref() == Some(exe) {
        return Ok(());
    }
    let (prog, pre) = program_for(exe);
    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(pre)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return Err(tr!(
                "無法執行 {tool}：{e}",
                tool = Tool::Codex.label(),
                e = e
            ))
        }
        Err(_) => return Err(codex_version_unknown()),
    };
    match parse_version(&String::from_utf8_lossy(&output.stdout)) {
        Some(found) if found >= CODEX_MIN_VERSION => {
            *CHECKED.lock() = Some(exe.to_path_buf());
            Ok(())
        }
        Some(found) => Err(tr!(
            "AI 快速動作需要 Codex {min} 以上的版本（目前是 {version}），舊版無法禁止 AI 執行命令。請先更新 Codex，或改用 Claude Code。",
            min = version_text(CODEX_MIN_VERSION),
            version = version_text(found)
        )),
        None => Err(codex_version_unknown()),
    }
}

fn codex_version_unknown() -> String {
    tr!(
        "無法確認 Codex 的版本。AI 快速動作需要 Codex {min} 以上的版本，請先更新 Codex，或改用 Claude Code。",
        min = version_text(CODEX_MIN_VERSION)
    )
}

fn command(app: &AppHandle, tool: Tool, exe: &Path) -> Result<tokio::process::Command, String> {
    let (prog, pre) = program_for(exe);
    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(pre).args(args(tool));
    // 在一個中性的資料夾執行，不會讀到任何專案的設定或檔案。
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("ai-run");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    cmd.current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不要閃出命令提示字元視窗
    Ok(cmd)
}

/// 執行一次快捷動作。結果以 `ai-run` 事件回傳；呼叫本身在開始執行後就返回。
#[tauri::command]
pub async fn ai_run(
    app: AppHandle,
    id: u64,
    tool: Tool,
    prompt: String,
    runs: State<'_, Runs>,
) -> Result<(), String> {
    crate::settings::require_ai(&app)?;
    let exe = tool.locate()?;
    if tool == Tool::Codex {
        check_codex_version(&exe).await?;
    }
    let mut child = command(&app, tool, &exe)?
        .spawn()
        .map_err(|e| tr!("無法執行 {tool}：{e}", tool = tool.label(), e = e))?;
    let mut stdin = child.stdin.take().ok_or_else(|| tr!("無法傳送內容"))?;
    let stdout = child.stdout.take().ok_or_else(|| tr!("無法讀取輸出"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| tr!("無法讀取輸出"))?;
    let (cancel, mut cancelled) = oneshot::channel();
    runs.0.lock().insert(id, cancel);

    tauri::async_runtime::spawn(async move {
        let emit = |e: RunEvent| {
            let _ = app.emit("ai-run", e);
        };
        // 寫入提示、讀取錯誤輸出都和讀取結果同時進行：程式先輸出一大堆再讀輸入、
        // 或把錯誤輸出寫滿時才不會互相等待卡住；寫入期間按「取消」也立刻有效。
        let writer = tauri::async_runtime::spawn(async move {
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await
        });
        let errors = tauri::async_runtime::spawn(async move {
            // 只留最後一段（錯誤訊息只顯示最後幾行）。
            const KEEP: usize = 64 * 1024;
            let mut kept: Vec<u8> = Vec::new();
            let mut buf = [0u8; 8192];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                kept.extend_from_slice(&buf[..n]);
                if kept.len() > KEEP {
                    kept.drain(..kept.len() - KEEP);
                }
            }
            String::from_utf8_lossy(&kept).into_owned()
        });
        let parse = match tool {
            Tool::Claude => parse_claude,
            Tool::Codex => parse_codex,
        };
        let mut lines = BufReader::new(stdout).lines();
        let mut text = String::new();
        let mut finished = false;
        loop {
            tokio::select! {
                _ = &mut cancelled => {
                    let _ = child.kill().await;
                    finished = true;
                    break;
                }
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { break };
                    match parse(&line) {
                        Some(Parsed::Delta(t)) => {
                            text.push_str(&t);
                            emit(RunEvent::Delta { id, text: t });
                        }
                        Some(Parsed::Message(t)) => {
                            text = t.clone();
                            emit(RunEvent::Delta { id, text: t });
                        }
                        Some(Parsed::Done { text: full, cost_usd, tokens }) => {
                            emit(RunEvent::Done { id, text: full.unwrap_or_else(|| text.clone()), cost_usd, tokens });
                            finished = true;
                        }
                        Some(Parsed::Error(message)) => {
                            emit(RunEvent::Error { id, message });
                            finished = true;
                        }
                        None => {}
                    }
                }
            }
        }
        let status = child.wait().await;
        if !finished {
            let err = errors.await.unwrap_or_default();
            let detail = err.trim();
            let write_error = match writer.await {
                Ok(Err(e)) => Some(e),
                _ => None,
            };
            emit(RunEvent::Error {
                id,
                message: if let Some(e) = write_error.filter(|_| detail.is_empty()) {
                    tr!("無法傳送內容給 {tool}：{e}", tool = tool.label(), e = e)
                } else if detail.is_empty() {
                    tr!(
                        "{tool} 沒有回傳結果（結束代碼 {status}）",
                        tool = tool.label(),
                        status = status.ok().and_then(|s| s.code()).unwrap_or(-1)
                    )
                } else {
                    // 錯誤訊息可能很長，只留最後幾行。
                    detail
                        .lines()
                        .rev()
                        .take(6)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join("\n")
                },
            });
        }
        app.state::<Runs>().0.lock().remove(&id);
    });
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(id: u64, runs: State<'_, Runs>) {
    if let Some(tx) = runs.0.lock().remove(&id) {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_stream() {
        let delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"天我們"}}}"#;
        assert_eq!(parse_claude(delta), Some(Parsed::Delta("天我們".into())));
        let start = r#"{"type":"stream_event","event":{"type":"message_start"}}"#;
        assert_eq!(parse_claude(start), None);
        let done = r#"{"type":"result","subtype":"success","is_error":false,"result":"今天我們一起討論了許多編輯器功能。","total_cost_usd":0.00062169,"usage":{"input_tokens":10,"output_tokens":20}}"#;
        assert_eq!(
            parse_claude(done),
            Some(Parsed::Done {
                text: Some("今天我們一起討論了許多編輯器功能。".into()),
                cost_usd: Some(0.00062169),
                tokens: Some(30)
            })
        );
        let err =
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":""}"#;
        assert!(matches!(parse_claude(err), Some(Parsed::Error(_))));
        assert_eq!(parse_claude("不是 JSON"), None);
    }

    #[test]
    fn parses_codex_stream() {
        let msg = r#"{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"精簡後的文字"}}"#;
        assert_eq!(
            parse_codex(msg),
            Some(Parsed::Message("精簡後的文字".into()))
        );
        let reasoning = r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"想一下"}}"#;
        assert_eq!(parse_codex(reasoning), None);
        let done = r#"{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":20}}"#;
        assert_eq!(
            parse_codex(done),
            Some(Parsed::Done {
                text: None,
                cost_usd: None,
                tokens: Some(120)
            })
        );
        let failed = r#"{"type":"turn.failed","error":{"message":"未登入"}}"#;
        assert_eq!(parse_codex(failed), Some(Parsed::Error("未登入".into())));
        // 設定警告（例如舊版不認得 features.view_image）以 error 項目回報，不能當成失敗。
        let warning = r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"unknown configuration field `features.view_image`"}}"#;
        assert_eq!(parse_codex(warning), None);
    }

    #[test]
    fn codex_cannot_run_commands() {
        let a = args(Tool::Codex);
        let exec = a.iter().position(|&s| s == "exec").unwrap();
        // 功能開關放在 exec 之前（主程式的參數），每一版都會處理。
        let disable = a.windows(2).position(|w| w == ["--disable", "shell_tool"]);
        assert!(disable.is_some_and(|i| i < exec), "{a:?}");
        let image = a
            .windows(2)
            .position(|w| w == ["-c", "features.view_image=false"]);
        assert!(image.is_some_and(|i| i < exec), "{a:?}");
        assert!(
            a.windows(2).any(|w| w == ["--sandbox", "read-only"]),
            "{a:?}"
        );
        // 不能有放寬限制的參數。
        for loose in [
            "--full-auto",
            "--dangerously-bypass-approvals-and-sandbox",
            "--yolo",
            "--enable",
            "workspace-write",
            "danger-full-access",
        ] {
            assert!(!a.contains(&loose), "{loose}");
        }
        // 提示從標準輸入傳入，最後一個參數是「-」。
        assert_eq!(a.last(), Some(&"-"));
    }

    #[test]
    fn claude_has_no_tools() {
        let a = args(Tool::Claude);
        assert!(a.windows(2).any(|w| w == ["--tools", ""]), "{a:?}");
        assert!(a.contains(&"--strict-mcp-config"));
        assert!(a.contains(&"-p"));
    }

    #[test]
    fn parses_codex_version() {
        assert_eq!(parse_version("codex-cli 0.59.0\n"), Some((0, 59, 0)));
        assert_eq!(parse_version("codex-cli 0.166.1"), Some((0, 166, 1)));
        assert_eq!(parse_version("codex-cli 0.60.0-alpha.3"), Some((0, 60, 0)));
        assert_eq!(parse_version("codex 1.2.3 (abc)"), Some((1, 2, 3)));
        assert_eq!(parse_version("codex-cli"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("版本 12"), None);
    }

    #[test]
    fn requires_codex_with_shell_tool_switch() {
        let ok = |s: &str| parse_version(s).is_some_and(|v| v >= CODEX_MIN_VERSION);
        assert!(ok("codex-cli 0.59.0"));
        assert!(ok("codex-cli 0.166.0"));
        assert!(ok("codex-cli 1.0.0"));
        // 0.50.0 有 --disable 但會默默忽略不認得的名稱；0.58 以前沒有 shell_tool。
        assert!(!ok("codex-cli 0.50.0"));
        assert!(!ok("codex-cli 0.58.9"));
        assert!(!ok("codex-cli 0.0.0"));
        assert_eq!(version_text(CODEX_MIN_VERSION), "0.59.0");
    }
}
