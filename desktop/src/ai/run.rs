//! 選取段落快捷動作：在背景執行 `claude -p` 或 `codex exec`，串流回傳結果。
//!
//! 不給 AI 任何工具（不能讀寫檔案、不能執行命令），只處理傳進去的文字；
//! 文字從標準輸入傳入，不放在命令列上。結果由前端以差異檢視讓使用者決定是否套用。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;

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

fn command(app: &AppHandle, tool: Tool) -> Result<tokio::process::Command, String> {
    let (prog, pre) = program_for(&tool.locate()?);
    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(pre);
    match tool {
        Tool::Claude => {
            cmd.args([
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--tools",
                "",
            ]);
        }
        Tool::Codex => {
            cmd.args([
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "-",
            ]);
        }
    }
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
    let mut child = command(&app, tool)?
        .spawn()
        .map_err(|e| tr!("無法執行 {tool}：{e}", tool = tool.label(), e = e))?;
    let mut stdin = child.stdin.take().ok_or_else(|| tr!("無法傳送內容"))?;
    let stdout = child.stdout.take().ok_or_else(|| tr!("無法讀取輸出"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| tr!("無法讀取輸出"))?;
    let (cancel, mut cancelled) = oneshot::channel();
    runs.0.lock().unwrap().insert(id, cancel);

    tauri::async_runtime::spawn(async move {
        let emit = |e: RunEvent| {
            let _ = app.emit("ai-run", e);
        };
        let write = async move {
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await
        };
        if let Err(e) = write.await {
            emit(RunEvent::Error {
                id,
                message: tr!("無法傳送內容給 {tool}：{e}", tool = tool.label(), e = e),
            });
        }
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
            let mut err = String::new();
            let _ = stderr.read_to_string(&mut err).await;
            let detail = err.trim();
            emit(RunEvent::Error {
                id,
                message: if detail.is_empty() {
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
        app.state::<Runs>().0.lock().unwrap().remove(&id);
    });
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(id: u64, runs: State<'_, Runs>) {
    if let Some(tx) = runs.0.lock().unwrap().remove(&id) {
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
    }
}
