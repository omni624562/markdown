//! Claude API 助理（預設關閉，只在私人電腦使用）。
//!
//! - API 金鑰存在 Windows 認證管理員，只在這裡讀取、放進要求的標頭，不會交給網頁。
//! - 送出前原生端自己再檢查一次（不只靠網頁那一端）：設定開啟了「Claude API 助理」、
//!   目前的資料夾是允許 AI 的專案、不是 Azure DevOps 的儲存庫、這個月的費用還沒到上限。
//! - 費用依回傳的 token 數估計，記在設定資料夾的 `assistant-usage.json`（每個月重新計算）。
//! - 回覆以 `assistant-run` 事件串流回傳；修改文件一律由前端的建議卡片讓使用者決定。

use std::collections::{BTreeMap, HashMap};
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
    /// 長提示的價格：提示（輸入＋快取）超過這麼多 token 時，輸入、輸出改用這組單價。
    long_prompt: Option<LongPrompt>,
    /// 拒絕回答時改用其他模型重試（伺服器端處理）。
    fallback: bool,
    /// 上網查資料的工具版本（Haiku 只能用基本版）。
    web_search: &'static str,
}

struct LongPrompt {
    over: u64,
    input: f64,
    output: f64,
}

/// 上網查資料：每次搜尋 US$0.01，一次回答最多查幾次。
const SEARCH_USD: f64 = 0.01;
const MAX_SEARCHES: u64 = 5;

const MODELS: [Model; 3] = [
    Model {
        id: "claude-haiku-5-5",
        input: 0.10,
        output: 0.50,
        cache_read: 0.01,
        // 提示超過 10 萬 token 時是 US$0.50／US$2.50。
        long_prompt: Some(LongPrompt {
            over: 100_000,
            input: 0.50,
            output: 2.50,
        }),
        fallback: false,
        web_search: "web_search_20250305",
    },
    Model {
        id: "claude-sonnet-5-5",
        input: 2.0,
        output: 10.0,
        cache_read: 0.10,
        long_prompt: None,
        fallback: true,
        web_search: "web_search_20260209",
    },
    Model {
        id: "claude-opus-5-5",
        input: 4.0,
        output: 20.0,
        cache_read: 0.20,
        long_prompt: None,
        fallback: true,
        web_search: "web_search_20260209",
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

/// 存在 `assistant-usage.json` 的用量。`month`／`usd` 是這個月的總額（上限用它判斷）；
/// `days` 是每天的費用（選期間看用量時用），`months` 是已經過完的月份的總額。
/// 舊版只有 `month`／`usd`：升級之前的那幾天沒有每日紀錄，只算在這個月的總額裡。
#[derive(Serialize, Deserialize, Default, Debug, PartialEq, Clone)]
struct Stored {
    month: String,
    usd: f64,
    #[serde(default)]
    days: BTreeMap<String, f64>,
    #[serde(default)]
    months: BTreeMap<String, f64>,
}

/// 每日紀錄留幾天、每月總額留幾個月（舊的刪掉，檔案不會一直變大）。
const KEEP_DAYS: usize = 400;
const KEEP_MONTHS: usize = 36;

impl Stored {
    /// 記上一筆費用。`month`、`day` 是這台電腦現在的月份與日期。換月時把上個月的總額收進 `months`，這個月從 0 開始。
    fn add(&mut self, month: &str, day: &str, usd: f64) {
        if self.month != month {
            if !self.month.is_empty() && self.usd > 0.0 {
                self.months
                    .insert(std::mem::take(&mut self.month), self.usd);
            }
            self.month = month.to_string();
            self.usd = 0.0;
        }
        self.usd += usd;
        *self.days.entry(day.to_string()).or_insert(0.0) += usd;
        while self.days.len() > KEEP_DAYS {
            self.days.pop_first();
        }
        while self.months.len() > KEEP_MONTHS {
            self.months.pop_first();
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    month: String,
    usd: f64,
    limit: f64,
}

/// 選期間看用量：每天的費用、過去每個月的總額，和這個月的總額。日期、月份都是這台電腦的時區。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistory {
    today: String,
    month: String,
    /// 這個月的總額（包含還沒有每日紀錄的部分）。
    usd: f64,
    limit: f64,
    days: Vec<DayUsage>,
    months: Vec<MonthUsage>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct DayUsage {
    date: String,
    usd: f64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct MonthUsage {
    month: String,
    usd: f64,
}

fn this_month() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn usage_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("assistant-usage.json"))
}

/// 這個月已經用掉的費用（換月份時從 0 開始）。
fn used(stored: Option<&Stored>, month: &str) -> f64 {
    stored.filter(|s| s.month == month).map_or(0.0, |s| s.usd)
}

fn read_stored(app: &AppHandle) -> Option<Stored> {
    usage_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn read_used(app: &AppHandle) -> f64 {
    used(read_stored(app).as_ref(), &this_month())
}

/// 加上這次的費用；回傳這個月的總額。
fn add_used(app: &AppHandle, usd: f64) -> f64 {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock();
    let mut stored = read_stored(app).unwrap_or_default();
    stored.add(&this_month(), &today(), usd);
    if let Some(path) = usage_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string(&stored) {
            let _ = crate::files::write_atomic(&path, json.as_bytes());
        }
    }
    stored.usd
}

/// 給畫面的用量紀錄。已經換月但還沒有新的用量時，檔案裡的 `month` 還是上個月：算進過去的月份，這個月是 0。
fn history(stored: Stored, month: String, today: String, limit: f64) -> UsageHistory {
    let mut months = stored.months.clone();
    let usd = used(Some(&stored), &month);
    if stored.month != month && !stored.month.is_empty() && stored.usd > 0.0 {
        months.insert(stored.month.clone(), stored.usd);
    }
    UsageHistory {
        today,
        month,
        usd,
        limit,
        days: stored
            .days
            .into_iter()
            .map(|(date, usd)| DayUsage { date, usd })
            .collect(),
        months: months
            .into_iter()
            .map(|(month, usd)| MonthUsage { month, usd })
            .collect(),
    }
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

#[tauri::command]
pub fn assistant_usage_history(app: AppHandle) -> UsageHistory {
    let settings = crate::settings::read_value(&app).unwrap_or_default();
    history(
        read_stored(&app).unwrap_or_default(),
        this_month(),
        today(),
        limit(&settings),
    )
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
        return Err(tr!("這個專案還沒允許使用 AI（設定 → Claude API 助理）"));
    }
    Ok(())
}

// ---- 送出 ----

/// 附在問題裡的圖片（Base64）。
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatImage {
    media_type: String,
    data: String,
}

/// 一次最多附幾張圖片、每張多大（Base64 之後；原始檔大約 5 MB）。
const MAX_IMAGES: usize = 4;
const MAX_IMAGE_BASE64: usize = 7_000_000;
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/// PDF 也走附件（`images`）這個欄位，送出時是 `document` 區塊。單一 PDF 與整個要求的附件大小上限
/// （Base64 之後；Claude API 一個要求最多 32 MB）。
const PDF_TYPE: &str = "application/pdf";
const MAX_PDF_BASE64: usize = 28_000_000;
const MAX_ATTACHED_BASE64: usize = 30_000_000;

#[derive(Deserialize, Debug)]
pub struct ChatMessage {
    role: String,
    content: String,
    /// 只有使用者的訊息能附圖片或 PDF。
    #[serde(default)]
    images: Vec<ChatImage>,
}

/// 附件（圖片、PDF）的格式、大小、數量都在範圍內，而且只附在使用者的訊息。
fn valid_images(messages: &[ChatMessage]) -> bool {
    let each = messages.iter().all(|m| {
        m.images.is_empty()
            || (m.role == "user"
                && m.images.len() <= MAX_IMAGES
                && m.images.iter().all(|i| {
                    let max = if i.media_type == PDF_TYPE {
                        MAX_PDF_BASE64
                    } else if IMAGE_TYPES.contains(&i.media_type.as_str()) {
                        MAX_IMAGE_BASE64
                    } else {
                        return false;
                    };
                    !i.data.is_empty()
                        && i.data.len() <= max
                        && i.data.bytes().all(|b| {
                            b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='
                        })
                }))
    });
    let total: usize = messages
        .iter()
        .flat_map(|m| &m.images)
        .map(|i| i.data.len())
        .sum();
    each && total <= MAX_ATTACHED_BASE64
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    model: String,
    system: String,
    messages: Vec<ChatMessage>,
    /// 這一題允許上網查資料（設定也要開著才會生效）。
    #[serde(default)]
    web_search: bool,
}

/// 對話要從使用者開始、輪流、以使用者結束，內容不能空白。
fn valid_messages(messages: &[ChatMessage]) -> bool {
    !messages.is_empty()
        && messages.len() % 2 == 1
        && messages.iter().enumerate().all(|(i, m)| {
            m.role == if i % 2 == 0 { "user" } else { "assistant" } && !m.content.trim().is_empty()
        })
}

fn request_body(m: &Model, req: &SendRequest, web: bool) -> serde_json::Value {
    let messages: Vec<_> = req
        .messages
        .iter()
        .map(|msg| {
            if msg.images.is_empty() {
                return serde_json::json!({ "role": msg.role, "content": msg.content });
            }
            // 圖片、PDF 放在文字前面；PDF 是 `document` 區塊。
            let mut blocks: Vec<_> = msg
                .images
                .iter()
                .map(|i| {
                    let kind = if i.media_type == PDF_TYPE {
                        "document"
                    } else {
                        "image"
                    };
                    serde_json::json!({
                        "type": kind,
                        "source": { "type": "base64", "media_type": i.media_type, "data": i.data },
                    })
                })
                .collect();
            blocks.push(serde_json::json!({ "type": "text", "text": msg.content }));
            serde_json::json!({ "role": msg.role, "content": blocks })
        })
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
    if web {
        body["tools"] = serde_json::json!([
            { "type": m.web_search, "name": "web_search", "max_uses": MAX_SEARCHES }
        ]);
    }
    body
}

#[derive(Default, Debug, PartialEq)]
struct Tokens {
    input: u64,
    cache_write: u64,
    cache_read: u64,
    output: u64,
    /// 上網搜尋的次數。
    searches: u64,
}

/// 估計的費用（美元）。寫入快取的部分是一般輸入的 1.25 倍。
fn cost(m: &Model, t: &Tokens) -> f64 {
    let per = |n: u64, price: f64| n as f64 * price / 1_000_000.0;
    let prompt = t.input + t.cache_write + t.cache_read;
    let (input, output) = match &m.long_prompt {
        Some(l) if prompt > l.over => (l.input, l.output),
        _ => (m.input, m.output),
    };
    per(t.input, input)
        + per(t.cache_write, input * 1.25)
        + per(t.cache_read, m.cache_read)
        + per(t.output, output)
        + t.searches as f64 * SEARCH_USD
}

/// 串流裡的一個事件（`data:` 那一行的 JSON）。
#[derive(Debug, PartialEq)]
enum Sse {
    Start {
        model: Option<String>,
        tokens: Tokens,
    },
    Text(String),
    /// 回答引用的網頁。
    Source {
        url: String,
        title: String,
    },
    Delta {
        output: u64,
        searches: u64,
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
                    searches: 0,
                },
            }
        }
        Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
            Sse::Text(v["delta"]["text"].as_str().unwrap_or_default().to_string())
        }
        Some("content_block_delta") if v["delta"]["type"] == "citations_delta" => {
            let c = &v["delta"]["citation"];
            match c["url"].as_str() {
                Some(url) if url.starts_with("https://") || url.starts_with("http://") => {
                    Sse::Source {
                        url: url.to_string(),
                        title: c["title"].as_str().unwrap_or(url).to_string(),
                    }
                }
                _ => Sse::Other,
            }
        }
        Some("message_delta") => Sse::Delta {
            output: n(&v["usage"]["output_tokens"]),
            searches: n(&v["usage"]["server_tool_use"]["web_search_requests"]),
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
    Source {
        id: u64,
        url: String,
        title: String,
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
    if !valid_images(&request.messages) {
        return Err(tr!(
            "圖片只能是 PNG、JPEG、GIF 或 WebP，每張不超過 5 MB，一次最多 4 張"
        ));
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
    // 上網查資料要設定裡開著、這一題也勾了才會送出搜尋工具。
    let web = request.web_search && settings["claudeWebSearch"] == true;
    let body = request_body(m, &request, web).to_string();
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
            // 連線中斷之前已經送出的提示、已經產生的回答照樣計費：記進用量，不然會少算。
            add_used(app, cost(served, &tokens));
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
            Sse::Source { url, title } => {
                let _ = app.emit("assistant-run", RunEvent::Source { id, url, title });
            }
            Sse::Delta {
                output,
                searches,
                stop: s,
            } => {
                tokens.output = tokens.output.max(output);
                tokens.searches = tokens.searches.max(searches);
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
        stop: stop.filter(|s| s == "max_tokens" || s == "refusal" || s == "pause_turn"),
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
        let s = Stored {
            month: "2026-11".into(),
            usd: 0.42,
            ..Default::default()
        };
        assert_eq!(used(Some(&s), "2026-11"), 0.42);
        assert_eq!(used(Some(&s), "2026-12"), 0.0);
        assert_eq!(used(None, "2026-11"), 0.0);
    }

    #[test]
    fn usage_is_recorded_per_day_and_rolls_over_by_month() {
        // 舊版的檔案只有這個月的總額。
        let mut s: Stored = serde_json::from_str(r#"{"month":"2026-11","usd":1.5}"#).unwrap();
        s.add("2026-11", "2026-11-29", 0.25);
        s.add("2026-11", "2026-11-29", 0.25);
        s.add("2026-11", "2026-11-30", 1.0);
        assert_eq!(s.usd, 3.0);
        assert_eq!(s.days["2026-11-29"], 0.5);
        assert_eq!(s.days["2026-11-30"], 1.0);
        // 換月：上個月的總額收起來，這個月從 0 開始；每日紀錄留著。
        s.add("2026-12", "2026-12-01", 0.1);
        assert_eq!((s.month.as_str(), s.usd), ("2026-12", 0.1));
        assert_eq!(s.months["2026-11"], 3.0);
        assert_eq!(s.days.len(), 3);

        let h = history(s.clone(), "2026-12".into(), "2026-12-01".into(), 10.0);
        assert_eq!(h.usd, 0.1);
        assert_eq!(h.months.len(), 1);
        assert_eq!(h.days.last().unwrap().date, "2026-12-01");
        // 已經換月、還沒有新的用量：檔案裡還是上個月，算進過去的月份。
        let h = history(s, "2027-01".into(), "2027-01-02".into(), 10.0);
        assert_eq!(h.usd, 0.0);
        assert_eq!(
            h.months
                .iter()
                .map(|m| m.month.as_str())
                .collect::<Vec<_>>(),
            ["2026-11", "2026-12"]
        );
    }

    #[test]
    fn old_days_and_months_are_dropped() {
        let mut s = Stored::default();
        for i in 0..(KEEP_DAYS + 20) {
            s.add("2026-11", &format!("day-{i:05}"), 0.01);
        }
        assert_eq!(s.days.len(), KEEP_DAYS);
        assert!(s.days.contains_key(&format!("day-{:05}", KEEP_DAYS + 19)));
        assert!(!s.days.contains_key("day-00000"));
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
            images: vec![],
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
                images: vec![],
            }],
            web_search: false,
        };
        let body = request_body(model(&req.model).unwrap(), &req, false);
        assert_eq!(body["model"], "claude-sonnet-5-5");
        assert_eq!(body["stream"], true);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["messages"][0]["content"], "摘要");
        assert!(body.get("thinking").is_none() && body.get("temperature").is_none());
        let haiku = request_body(model("claude-haiku-5-5").unwrap(), &req, false);
        assert!(haiku.get("fallbacks").is_none());
        // 沒開上網查資料時不送工具；開了依模型用對應的版本，最多查 5 次。
        assert!(body.get("tools").is_none());
        let web = request_body(model(&req.model).unwrap(), &req, true);
        assert_eq!(web["tools"][0]["type"], "web_search_20260209");
        assert_eq!(web["tools"][0]["max_uses"], 5);
        let haiku = request_body(model("claude-haiku-5-5").unwrap(), &req, true);
        assert_eq!(haiku["tools"][0]["type"], "web_search_20250305");
    }

    #[test]
    fn sends_images_before_the_text() {
        let img = |t: &str, data: &str| ChatImage {
            media_type: t.into(),
            data: data.into(),
        };
        let msg = |role: &str, images: Vec<ChatImage>| ChatMessage {
            role: role.into(),
            content: "這張圖在講什麼？".into(),
            images,
        };
        let req = SendRequest {
            model: "claude-haiku-5-5".into(),
            system: String::new(),
            messages: vec![msg("user", vec![img("image/png", "iVBORw0KGgo=")])],
            web_search: false,
        };
        let body = request_body(model(&req.model).unwrap(), &req, false);
        let content = &body["messages"][0]["content"];
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[0]["source"]["data"], "iVBORw0KGgo=");
        assert_eq!(content[1]["text"], "這張圖在講什麼？");

        assert!(valid_images(&req.messages));
        // 不支援的格式、不是 Base64、助理的訊息附圖、太多張都不行。
        assert!(!valid_images(&[msg(
            "user",
            vec![img("image/svg+xml", "PHN2Zz4=")]
        )]));
        assert!(!valid_images(&[msg(
            "user",
            vec![img("image/png", "<script>")]
        )]));
        assert!(!valid_images(&[msg(
            "assistant",
            vec![img("image/png", "AAAA")]
        )]));
        assert!(!valid_images(&[msg(
            "user",
            (0..5).map(|_| img("image/png", "AAAA")).collect()
        )]));
    }

    #[test]
    fn sends_pdfs_as_document_blocks() {
        let att = |t: &str, data: &str| ChatImage {
            media_type: t.into(),
            data: data.into(),
        };
        let msg = |role: &str, images: Vec<ChatImage>| ChatMessage {
            role: role.into(),
            content: "這份合約的重點？".into(),
            images,
        };
        let req = SendRequest {
            model: "claude-sonnet-5-5".into(),
            system: String::new(),
            messages: vec![msg(
                "user",
                vec![
                    att("application/pdf", "JVBERi0xLjQ="),
                    att("image/png", "iVBORw0KGgo="),
                ],
            )],
            web_search: false,
        };
        let body = request_body(model("claude-sonnet-5-5").unwrap(), &req, false);
        let content = &body["messages"][0]["content"];
        assert_eq!(content[0]["type"], "document");
        assert_eq!(content[0]["source"]["media_type"], "application/pdf");
        assert_eq!(content[0]["source"]["data"], "JVBERi0xLjQ=");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[2]["type"], "text");
        assert!(valid_images(&req.messages));
        // PDF 可以比圖片大，但有自己的上限；只能附在使用者的訊息。
        let big = "A".repeat(MAX_IMAGE_BASE64 + 4);
        assert!(valid_images(&[msg(
            "user",
            vec![att("application/pdf", &big)]
        )]));
        assert!(!valid_images(&[msg("user", vec![att("image/png", &big)])]));
        let too_big = "A".repeat(MAX_PDF_BASE64 + 4);
        assert!(!valid_images(&[msg(
            "user",
            vec![att("application/pdf", &too_big)]
        )]));
        assert!(!valid_images(&[msg(
            "assistant",
            vec![att("application/pdf", "JVBERi0xLjQ=")]
        )]));
        // 所有附件加起來也有上限（一個要求最多 32 MB）。
        let half = "A".repeat(MAX_ATTACHED_BASE64 / 2 + 4);
        assert!(!valid_images(&[
            msg("user", vec![att("application/pdf", &half)]),
            msg("user", vec![att("application/pdf", &half)]),
        ]));
    }

    #[test]
    fn estimates_cost() {
        let sonnet = model("claude-sonnet-5-5").unwrap();
        let t = Tokens {
            input: 1_000_000,
            cache_write: 0,
            cache_read: 1_000_000,
            output: 100_000,
            searches: 0,
        };
        assert!((cost(sonnet, &t) - (2.0 + 0.1 + 1.0)).abs() < 1e-9);
        // 每次搜尋 US$0.01。
        let t = Tokens {
            searches: 3,
            ..Default::default()
        };
        assert!((cost(sonnet, &t) - 0.03).abs() < 1e-9);
        let t = Tokens {
            cache_write: 1_000_000,
            ..Default::default()
        };
        assert!((cost(sonnet, &t) - 2.5).abs() < 1e-9);
    }

    #[test]
    fn haiku_long_prompts_cost_more() {
        let haiku = model("claude-haiku-5-5").unwrap();
        // 10 萬 token 以內：US$0.10／US$0.50。
        let short = Tokens {
            input: 100_000,
            output: 1_000_000,
            ..Default::default()
        };
        assert!((cost(haiku, &short) - (0.01 + 0.50)).abs() < 1e-9);
        // 超過 10 萬（輸入加上快取一起算）：US$0.50／US$2.50。
        let long = Tokens {
            input: 60_000,
            cache_read: 50_000,
            output: 1_000_000,
            ..Default::default()
        };
        assert!((cost(haiku, &long) - (0.03 + 0.0005 + 2.50)).abs() < 1e-9);
        // 其他模型沒有長提示的價格。
        let sonnet = model("claude-sonnet-5-5").unwrap();
        let big = Tokens {
            input: 500_000,
            ..Default::default()
        };
        assert!((cost(sonnet, &big) - 1.0).abs() < 1e-9);
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
                    output: 1,
                    searches: 0
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
                searches: 0,
                stop: Some("end_turn".into())
            }
        );
        assert_eq!(
            parse_sse(
                r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9,"server_tool_use":{"web_search_requests":2}}}"#
            ),
            Sse::Delta {
                output: 9,
                searches: 2,
                stop: Some("end_turn".into())
            }
        );
        // 引用的網頁變成來源；不是 http(s) 的網址不收。
        assert_eq!(
            parse_sse(
                r#"{"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com/nas","title":"NAS 備份","cited_text":"…"}}}"#
            ),
            Sse::Source {
                url: "https://example.com/nas".into(),
                title: "NAS 備份".into()
            }
        );
        assert_eq!(
            parse_sse(
                r#"{"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"url":"javascript:alert(1)"}}}"#
            ),
            Sse::Other
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
