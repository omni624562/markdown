//! Claude API 助理（預設關閉，只在私人電腦使用）。
//!
//! - API 金鑰存在 Windows 認證管理員，只在這裡讀取、放進要求的標頭，不會交給網頁。
//! - 送出前原生端自己再檢查一次（不只靠網頁那一端）：設定開啟了「Claude API 助理」、
//!   目前的資料夾是允許 AI 的專案、不是 Azure DevOps 的儲存庫、這個月的費用還沒到上限。
//! - 費用依回傳的 token 數估計，記在設定資料夾的 `assistant-usage.json`（每個月重新計算）。
//! - 回覆以 `assistant-run` 事件串流回傳；修改文件一律由前端的建議卡片讓使用者決定。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const KEY_SERVICE: &str = "oMarker Claude API";
const KEY_ID: &str = "api-key";
/// 沒有設定時的每月上限（美元）。
const DEFAULT_LIMIT: f64 = 10.0;
/// 一次最多送出的字數（避免不小心把超大的檔案整個送出）。
const MAX_INPUT_CHARS: usize = 400_000;

/// 可以選的模型與價格（每百萬 token 的美元）。
struct Model {
    id: &'static str,
    input: f64,
    output: f64,
    cache_read: f64,
    /// 拒絕回答時改用其他模型重試（伺服器端處理）。
    fallback: bool,
}

const MODELS: [Model; 3] = [
    Model {
        id: "claude-haiku-5-5",
        input: 0.10,
        output: 0.50,
        cache_read: 0.01,
        fallback: false,
    },
    Model {
        id: "claude-sonnet-5-5",
        input: 2.0,
        output: 10.0,
        cache_read: 0.20,
        fallback: true,
    },
    Model {
        id: "claude-opus-5-5",
        input: 4.0,
        output: 20.0,
        cache_read: 0.20,
        fallback: true,
    },
];

fn model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

// ---- API 金鑰 ----

/// 不能存進認證管理員的平台：只記在這次開啟期間。
static MEMORY_KEY: Mutex<Option<String>> = Mutex::new(None);

fn key() -> Option<String> {
    crate::secrets::get(KEY_SERVICE, KEY_ID).or_else(|| MEMORY_KEY.lock().clone())
}

/// 金鑰的格式（只檢查看起來像 Anthropic 的金鑰，不連線驗證）。
fn valid_key(key: &str) -> bool {
    key.starts_with("sk-ant-")
        && (20..=300).contains(&key.len())
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub fn assistant_key_status() -> bool {
    key().is_some()
}

#[tauri::command]
pub fn assistant_key_set(key: String) -> Result<(), String> {
    let key = key.trim();
    if !valid_key(key) {
        return Err(tr!("這不是 Claude API 的金鑰（應該以 sk-ant- 開頭）"));
    }
    if !crate::secrets::set(KEY_SERVICE, KEY_ID, key) {
        *MEMORY_KEY.lock() = Some(key.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn assistant_key_forget() {
    crate::secrets::forget(KEY_SERVICE, KEY_ID);
    *MEMORY_KEY.lock() = None;
}

// ---- 用量 ----

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
struct Stored {
    month: String,
    usd: f64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    month: String,
    usd: f64,
    limit: f64,
}

fn this_month() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

fn usage_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("assistant-usage.json"))
}

/// 這個月已經用掉的費用（換月份時從 0 開始）。
fn used(stored: Option<Stored>, month: &str) -> f64 {
    stored.filter(|s| s.month == month).map_or(0.0, |s| s.usd)
}

fn read_used(app: &AppHandle) -> f64 {
    let stored = usage_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    used(stored, &this_month())
}

/// 加上這次的費用；回傳這個月的總額。
fn add_used(app: &AppHandle, usd: f64) -> f64 {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock();
    let total = read_used(app) + usd;
    if let Some(path) = usage_path(app) {
        let stored = Stored {
            month: this_month(),
            usd: total,
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&stored) {
            let _ = crate::files::write_atomic(&path, json.as_bytes());
        }
    }
    total
}

/// 設定裡的每月上限（美元）。
fn limit(settings: &serde_json::Value) -> f64 {
    settings["claudeMonthlyLimit"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map_or(DEFAULT_LIMIT, |v| v.min(1000.0))
}

#[tauri::command]
pub fn assistant_usage(app: AppHandle) -> Usage {
    let settings = crate::settings::read_value(&app).unwrap_or_default();
    Usage {
        month: this_month(),
        usd: read_used(&app),
        limit: limit(&settings),
    }
}

// ---- 送出前的檢查 ----

/// 遠端 origin 是 Azure DevOps（含公司自己架的 TFS）的儲存庫。
fn is_ado_origin(origin: &str) -> bool {
    let o = origin.to_ascii_lowercase();
    o.contains("dev.azure.com") || o.contains(".visualstudio.com") || o.contains("/_git/")
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.trim_end_matches(['/', '\\']).replace('\\', "/");
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

/// 設定與目前的資料夾允許送出嗎？（不允許時回傳原因）
fn check(
    settings: &serde_json::Value,
    root: Option<&Path>,
    origin: Option<&str>,
) -> Result<(), String> {
    if settings["claudeApiEnabled"] != true {
        return Err(tr!("請先在設定開啟「Claude API 助理」"));
    }
    let Some(root) = root else {
        return Err(tr!("請先開啟允許 AI 的專案資料夾"));
    };
    if origin.is_some_and(is_ado_origin) {
        return Err(tr!("這是 Azure DevOps 的儲存庫，內容不會送給 AI"));
    }
    let root = crate::files::path_string(root);
    let allowed = settings["assistantProjects"]
        .as_array()
        .is_some_and(|list| {
            list.iter()
                .filter_map(|v| v.as_str())
                .any(|p| same_path(p, &root))
        });
    if !allowed {
        return Err(tr!(
            "這個專案還沒允許使用 AI（設定 → AI 協作 → Claude API 助理）"
        ));
    }
    Ok(())
}

// ---- 送出 ----

#[derive(Deserialize, Debug)]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    model: String,
    system: String,
    messages: Vec<ChatMessage>,
}

/// 對話要從使用者開始、輪流、以使用者結束，內容不能空白。
fn valid_messages(messages: &[ChatMessage]) -> bool {
    !messages.is_empty()
        && messages.len() % 2 == 1
        && messages.iter().enumerate().all(|(i, m)| {
            m.role == if i % 2 == 0 { "user" } else { "assistant" } && !m.content.trim().is_empty()
        })
}

fn request_body(m: &Model, req: &SendRequest) -> serde_json::Value {
    let messages: Vec<_> = req
        .messages
        .iter()
        .map(|msg| serde_json::json!({ "role": msg.role, "content": msg.content }))
        .collect();
    let mut body = serde_json::json!({
        "model": m.id,
        "max_tokens": 16000,
        "stream": true,
        // 同一份文件連續問好幾次時，前面相同的部分從快取讀取（比較便宜）。
        "cache_control": { "type": "ephemeral" },
        "output_config": { "effort": "low" },
        "system": req.system,
        "messages": messages,
    });
    if m.fallback {
        body["fallbacks"] = serde_json::json!("default");
    }
    body
}

#[derive(Default, Debug, PartialEq)]
struct Tokens {
    input: u64,
    cache_write: u64,
    cache_read: u64,
    output: u64,
}

/// 估計的費用（美元）。寫入快取的部分是一般輸入的 1.25 倍。
fn cost(m: &Model, t: &Tokens) -> f64 {
    let per = |n: u64, price: f64| n as f64 * price / 1_000_000.0;
    per(t.input, m.input)
        + per(t.cache_write, m.input * 1.25)
        + per(t.cache_read, m.cache_read)
        + per(t.output, m.output)
}

/// 串流裡的一個事件（`data:` 那一行的 JSON）。
#[derive(Debug, PartialEq)]
enum Sse {
    Start {
        model: Option<String>,
        tokens: Tokens,
    },
    Text(String),
    Delta {
        output: u64,
        stop: Option<String>,
    },
    Error(String),
    Other,
}

fn parse_sse(data: &str) -> Sse {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return Sse::Other;
    };
    let n = |v: &serde_json::Value| v.as_u64().unwrap_or(0);
    match v["type"].as_str() {
        Some("message_start") => {
            let u = &v["message"]["usage"];
            Sse::Start {
                model: v["message"]["model"].as_str().map(str::to_string),
                tokens: Tokens {
                    input: n(&u["input_tokens"]),
                    cache_write: n(&u["cache_creation_input_tokens"]),
                    cache_read: n(&u["cache_read_input_tokens"]),
                    output: n(&u["output_tokens"]),
                },
            }
        }
        Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
            Sse::Text(v["delta"]["text"].as_str().unwrap_or_default().to_string())
        }
        Some("message_delta") => Sse::Delta {
            output: n(&v["usage"]["output_tokens"]),
            stop: v["delta"]["stop_reason"].as_str().map(str::to_string),
        },
        Some("error") => Sse::Error(
            v["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        ),
        _ => Sse::Other,
    }
}

/// API 回應錯誤時給使用者看的訊息。
fn status_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_default();
    match status {
        401 => tr!("API 金鑰無效或已經撤銷，請在設定換一把"),
        403 => tr!("這把 API 金鑰沒有使用這個模型的權限"),
        429 => tr!("要求太頻繁或額度用完了，請稍後再試"),
        529 => tr!("Claude 現在太忙，請稍後再試"),
        _ if detail.is_empty() => tr!("Claude API 回應錯誤（{status}）", status = status),
        _ => tr!(
            "Claude API 回應錯誤（{status}）：{detail}",
            status = status,
            detail = detail
        ),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum RunEvent {
    Delta {
        id: u64,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        id: u64,
        usd: f64,
        month_usd: f64,
        /// 回答被截斷（`max_tokens`）或拒絕（`refusal`）時的原因。
        stop: Option<String>,
    },
    Error {
        id: u64,
        message: String,
    },
}

#[derive(Default)]
pub struct AssistantRuns(Mutex<HashMap<u64, Arc<AtomicBool>>>);

#[tauri::command]
pub fn assistant_send(
    app: AppHandle,
    id: u64,
    request: SendRequest,
    runs: State<'_, AssistantRuns>,
) -> Result<(), String> {
    let settings = crate::settings::read_value(&app).unwrap_or_default();
    let root = app
        .try_state::<crate::workspace::Workspace>()
        .and_then(|w| w.root());
    let origin = root.as_deref().and_then(crate::git::origin_at);
    check(&settings, root.as_deref(), origin.as_deref())?;
    let m = model(&request.model).ok_or_else(|| tr!("不支援這個模型"))?;
    if !valid_messages(&request.messages) {
        return Err(tr!("沒有要送出的內容"));
    }
    let chars = request.system.chars().count()
        + request
            .messages
            .iter()
            .map(|x| x.content.chars().count())
            .sum::<usize>();
    if chars > MAX_INPUT_CHARS {
        return Err(tr!(
            "內容太長（超過 {max} 字），請改送選取的段落",
            max = MAX_INPUT_CHARS
        ));
    }
    let key = key().ok_or_else(|| tr!("請先在設定輸入 Claude API 金鑰"))?;
    let (spent, cap) = (read_used(&app), limit(&settings));
    if spent >= cap {
        return Err(tr!(
            "這個月已經用了 US${spent}，到達上限 US${cap}；可以在設定調高上限",
            spent = format!("{spent:.2}"),
            cap = format!("{cap:.2}")
        ));
    }
    let body = request_body(m, &request).to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    runs.0.lock().insert(id, cancel.clone());
    std::thread::spawn(move || {
        let event = run(&app, id, m, &key, &body, &cancel);
        let _ = app.emit("assistant-run", event);
        app.state::<AssistantRuns>().0.lock().remove(&id);
    });
    Ok(())
}

/// 送出並讀取串流；文字一段一段以事件送出，最後回傳結束的事件。
fn run(
    app: &AppHandle,
    id: u64,
    m: &Model,
    key: &str,
    body: &str,
    cancel: &AtomicBool,
) -> RunEvent {
    let mut req = crate::update::agent()
        .post(API_URL)
        .config()
        .http_status_as_error(false)
        .build()
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");
    if m.fallback {
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let res = match req.send(body) {
        Ok(r) => r,
        Err(e) => {
            return RunEvent::Error {
                id,
                message: tr!("無法連線到 Claude API（{e}）", e = e),
            }
        }
    };
    let status = res.status().as_u16();
    if status != 200 {
        let text = res.into_body().read_to_string().unwrap_or_default();
        return RunEvent::Error {
            id,
            message: status_message(status, &text),
        };
    }
    let mut tokens = Tokens::default();
    let mut served = m;
    let mut stop = None;
    let reader = BufReader::new(res.into_body().into_reader());
    for line in reader.lines() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Ok(line) = line else {
            return RunEvent::Error {
                id,
                message: tr!("和 Claude API 的連線中斷了"),
            };
        };
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        match parse_sse(data.trim()) {
            Sse::Start {
                model: name,
                tokens: t,
            } => {
                // 拒絕回答而改用其他模型時，依實際的模型計價。
                served = name.as_deref().and_then(model).unwrap_or(m);
                tokens = t;
            }
            Sse::Text(text) if !text.is_empty() => {
                let _ = app.emit("assistant-run", RunEvent::Delta { id, text });
            }
            Sse::Delta { output, stop: s } => {
                tokens.output = tokens.output.max(output);
                if s.is_some() {
                    stop = s;
                }
            }
            Sse::Error(message) => {
                add_used(app, cost(served, &tokens));
                return RunEvent::Error {
                    id,
                    message: tr!("Claude API 回應錯誤：{detail}", detail = message),
                };
            }
            _ => {}
        }
    }
    let usd = cost(served, &tokens);
    let month_usd = add_used(app, usd);
    RunEvent::Done {
        id,
        usd,
        month_usd,
        stop: stop.filter(|s| s == "max_tokens" || s == "refusal"),
    }
}

#[tauri::command]
pub fn assistant_cancel(id: u64, runs: State<'_, AssistantRuns>) {
    if let Some(flag) = runs.0.lock().remove(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_key_format() {
        assert!(valid_key("sk-ant-api03-abcdefghijklmnop_QRS-tuv"));
        assert!(!valid_key("sk-proj-abcdefghijklmnopqrstuvwxyz"));
        assert!(!valid_key("sk-ant-短"));
        assert!(!valid_key("sk-ant-abc def ghi jkl mno pqr"));
    }

    #[test]
    fn usage_resets_every_month() {
        let s = || {
            Some(Stored {
                month: "2026-11".into(),
                usd: 0.42,
            })
        };
        assert_eq!(used(s(), "2026-11"), 0.42);
        assert_eq!(used(s(), "2026-12"), 0.0);
        assert_eq!(used(None, "2026-11"), 0.0);
    }

    #[test]
    fn reads_monthly_limit() {
        assert_eq!(limit(&serde_json::json!({})), DEFAULT_LIMIT);
        assert_eq!(limit(&serde_json::json!({ "claudeMonthlyLimit": 3 })), 3.0);
        assert_eq!(
            limit(&serde_json::json!({ "claudeMonthlyLimit": -1 })),
            DEFAULT_LIMIT
        );
        assert_eq!(
            limit(&serde_json::json!({ "claudeMonthlyLimit": 99999 })),
            1000.0
        );
    }

    #[test]
    fn only_allowed_projects_can_send() {
        let root = Path::new("/home/me/筆記");
        let on = serde_json::json!({ "claudeApiEnabled": true, "assistantProjects": ["/home/me/筆記/"] });
        assert!(check(&on, Some(root), None).is_ok());
        assert!(check(&on, Some(root), Some("https://github.com/me/notes.git")).is_ok());
        // 總開關關閉、沒開資料夾、不在清單裡、是 Azure DevOps 的儲存庫：都不送。
        let off = serde_json::json!({ "assistantProjects": ["/home/me/筆記"] });
        assert!(check(&off, Some(root), None).is_err());
        assert!(check(&on, None, None).is_err());
        assert!(check(&on, Some(Path::new("/home/me/產品")), None).is_err());
        for origin in [
            "https://dev.azure.com/contoso/產品/_git/web",
            "https://contoso.visualstudio.com/產品/_git/web",
            "http://tfs:8080/tfs/DefaultCollection/產品/_git/web",
        ] {
            assert!(check(&on, Some(root), Some(origin)).is_err(), "{origin}");
        }
    }

    #[test]
    fn messages_alternate_and_end_with_the_user() {
        let m = |role: &str, content: &str| ChatMessage {
            role: role.into(),
            content: content.into(),
        };
        assert!(valid_messages(&[m("user", "摘要")]));
        assert!(valid_messages(&[
            m("user", "問"),
            m("assistant", "答"),
            m("user", "再問")
        ]));
        assert!(!valid_messages(&[]));
        assert!(!valid_messages(&[m("assistant", "答")]));
        assert!(!valid_messages(&[m("user", "問"), m("assistant", "答")]));
        assert!(!valid_messages(&[m("user", "  ")]));
    }

    #[test]
    fn builds_the_request() {
        let req = SendRequest {
            model: "claude-sonnet-5-5".into(),
            system: "你是助理".into(),
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "摘要".into(),
            }],
        };
        let body = request_body(model(&req.model).unwrap(), &req);
        assert_eq!(body["model"], "claude-sonnet-5-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["messages"][0]["content"], "摘要");
        assert!(body.get("thinking").is_none() && body.get("temperature").is_none());
        let haiku = request_body(model("claude-haiku-5-5").unwrap(), &req);
        assert!(haiku.get("fallbacks").is_none());
    }

    #[test]
    fn estimates_cost() {
        let sonnet = model("claude-sonnet-5-5").unwrap();
        let t = Tokens {
            input: 1_000_000,
            cache_write: 0,
            cache_read: 1_000_000,
            output: 100_000,
        };
        assert!((cost(sonnet, &t) - (2.0 + 0.2 + 1.0)).abs() < 1e-9);
        let t = Tokens {
            cache_write: 1_000_000,
            ..Default::default()
        };
        assert!((cost(sonnet, &t) - 2.5).abs() < 1e-9);
    }

    #[test]
    fn parses_the_stream() {
        assert_eq!(
            parse_sse(
                r#"{"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":1}}}"#
            ),
            Sse::Start {
                model: Some("claude-sonnet-5-5".into()),
                tokens: Tokens {
                    input: 12,
                    cache_write: 0,
                    cache_read: 3,
                    output: 1
                },
            }
        );
        assert_eq!(
            parse_sse(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}"#
            ),
            Sse::Text("你好".into())
        );
        // 思考的內容不顯示。
        assert_eq!(
            parse_sse(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"…"}}"#
            ),
            Sse::Other
        );
        assert_eq!(
            parse_sse(
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}"#
            ),
            Sse::Delta {
                output: 40,
                stop: Some("end_turn".into())
            }
        );
        assert_eq!(
            parse_sse(
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
            ),
            Sse::Error("Overloaded".into())
        );
        assert_eq!(parse_sse("[DONE]"), Sse::Other);
    }

    #[test]
    fn explains_errors() {
        assert!(status_message(401, "").contains("金鑰"));
        assert!(status_message(400, r#"{"error":{"message":"bad"}}"#).contains("bad"));
    }
}
