//! 助理的批次處理：把同一個動作（摘要、審稿…）套用到資料夾裡的每一份文件。
//!
//! 走 Claude API 的 Message Batches：一次送出所有文件，Anthropic 在背景處理（通常幾分鐘到一小時，最久一天），
//! 費用是平常的一半。送出後把批次記在 `assistant-batches.json`；之後（下次打開程式也可以）問狀態，
//! 處理完就把每一份的結果存成原檔旁邊的新檔（`行程.摘要.md`），不動原檔，並把費用記進用量。
//!
//! 檢查和一般送出一樣：功能開著、專案允許、有金鑰、沒超過每月上限；檔案都要在目前開啟的資料夾裡。
//! 領結果時也要開著同一個資料夾（結果要寫回那裡）。

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{
    add_used, check, cost, key, limit, model, read_used, same_path, status_message, Model, Tokens,
    API_URL, MAX_INPUT_CHARS,
};

/// 一次最多幾份文件、全部加起來最多幾個字；清單最多留幾筆（舊的丟掉）。
const MAX_FILES: usize = 100;
const MAX_TOTAL_CHARS: usize = 2_000_000;
const KEEP: usize = 30;
/// 批次的費用是平常的一半。
const DISCOUNT: f64 = 0.5;

/// 記在 `assistant-batches.json` 的一個批次。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Batch {
    /// Claude API 給的批次代號。
    id: String,
    /// 送出的時間（這台電腦的時間，`2026-11-15 21:30`）。
    created: String,
    /// 送出時開著的資料夾（領結果時要開著同一個），和處理的是哪個資料夾。
    root: String,
    folder: String,
    /// 動作的名稱（顯示用），和結果檔名裡的那一段（`行程.<suffix>.md`）。
    action: String,
    suffix: String,
    model: String,
    /// 每一份文件的路徑；順序就是送出時的代號（`f0`、`f1`…）。
    files: Vec<String>,
    /// `processing`：還在處理；`done`：結果已經寫好；`canceled`：取消了（已經做完的部分照樣寫好）。
    state: String,
    #[serde(default)]
    canceling: bool,
    /// 處理中：已經完成幾份。
    #[serde(default)]
    finished: u32,
    /// 領完結果：寫了幾個檔案、幾份失敗、費用。
    #[serde(default)]
    written: u32,
    #[serde(default)]
    failed: u32,
    #[serde(default)]
    usd: f64,
}

/// 給畫面的批次。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BatchView {
    id: String,
    created: String,
    folder: String,
    action: String,
    total: usize,
    state: String,
    canceling: bool,
    finished: u32,
    written: u32,
    failed: u32,
    usd: f64,
    /// 處理完了，但要先打開送出時的資料夾才能把結果寫回去。
    needs_folder: Option<String>,
    /// 這次檢查才剛領完結果（畫面據此通知、重新整理檔案清單）。
    just_done: bool,
}

fn view(b: &Batch, needs_folder: bool, just_done: bool) -> BatchView {
    BatchView {
        id: b.id.clone(),
        created: b.created.clone(),
        folder: b.folder.clone(),
        action: b.action.clone(),
        total: b.files.len(),
        state: b.state.clone(),
        canceling: b.canceling,
        finished: b.finished,
        written: b.written,
        failed: b.failed,
        usd: b.usd,
        needs_folder: needs_folder.then(|| b.root.clone()),
        just_done,
    }
}

// ---- 清單 ----

static STORE: Mutex<()> = Mutex::new(());

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("assistant-batches.json"))
}

fn read_all(app: &AppHandle) -> Vec<Batch> {
    store_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_all(app: &AppHandle, list: &[Batch]) {
    let Some(path) = store_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(list) {
        let _ = crate::files::write_atomic(&path, json.as_bytes());
    }
}

/// 新的排前面；太多時丟掉最舊、已經結束的。
fn remember(list: &mut Vec<Batch>, batch: Batch) {
    list.retain(|b| b.id != batch.id);
    list.insert(0, batch);
    while list.len() > KEEP {
        match list.iter().rposition(|b| b.state != "processing") {
            Some(i) => {
                list.remove(i);
            }
            None => break,
        }
    }
}

fn update(app: &AppHandle, batch: &Batch) {
    let _guard = STORE.lock();
    let mut list = read_all(app);
    if let Some(slot) = list.iter_mut().find(|b| b.id == batch.id) {
        *slot = batch.clone();
        write_all(app, &list);
    }
}

fn find(app: &AppHandle, id: &str) -> Result<Batch, String> {
    read_all(app)
        .into_iter()
        .find(|b| b.id == id)
        .ok_or_else(|| tr!("找不到這個批次"))
}

// ---- Claude API ----

/// 呼叫批次的端點；`body` 有內容時是 POST。回傳回應的文字。
fn call(url: &str, key: &str, body: Option<String>) -> Result<String, String> {
    let connect = |e: ureq::Error| tr!("無法連線到 Claude API（{e}）", e = e);
    let res = match body {
        Some(body) => crate::update::agent()
            .post(url)
            .config()
            .http_status_as_error(false)
            .build()
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .send(body)
            .map_err(connect)?,
        None => crate::update::agent()
            .get(url)
            .config()
            .http_status_as_error(false)
            .build()
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .call()
            .map_err(connect)?,
    };
    let status = res.status().as_u16();
    let text = res.into_body().read_to_string().unwrap_or_default();
    if status == 200 {
        Ok(text)
    } else {
        Err(status_message(status, &text))
    }
}

/// 代號只會是 Claude API 給的（`msgbatch_…`）：拿去組網址之前確認沒有別的字元。
fn valid_batch_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ---- 送出 ----

#[derive(Deserialize)]
pub struct BatchItem {
    path: String,
    /// 這一份文件要送出的訊息（文件內容加上動作的指示）。
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    model: String,
    system: String,
    /// 處理的是哪個資料夾、動作的名稱、結果檔名裡的那一段。
    folder: String,
    action: String,
    suffix: String,
    items: Vec<BatchItem>,
}

/// 結果檔名裡的那一段：不能空白，也不能有檔名不能用的字元或句點（免得改到副檔名）。
fn valid_suffix(suffix: &str) -> bool {
    let s = suffix.trim();
    !s.is_empty()
        && s.chars().count() <= 40
        && !s.contains('.')
        && crate::workspace::validate_name(s).is_ok()
}

/// 要送給批次端點的要求：每一份文件一則，代號是 `f<順序>`。
fn create_body(m: &Model, req: &BatchRequest) -> serde_json::Value {
    let requests: Vec<_> = req
        .items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            serde_json::json!({
                "custom_id": format!("f{i}"),
                "params": {
                    "model": m.id,
                    "max_tokens": 16000,
                    "output_config": { "effort": "low" },
                    "system": req.system,
                    "messages": [{ "role": "user", "content": item.content }],
                },
            })
        })
        .collect();
    serde_json::json!({ "requests": requests })
}

/// 內容在範圍內嗎？（不在時回傳原因）
fn check_items(req: &BatchRequest) -> Result<(), String> {
    if req.items.is_empty() {
        return Err(tr!("這個資料夾裡沒有可以處理的文件"));
    }
    if req.items.len() > MAX_FILES {
        return Err(tr!(
            "一次最多處理 {max} 份文件，請選小一點的資料夾",
            max = MAX_FILES
        ));
    }
    if !valid_suffix(&req.suffix) {
        return Err(tr!("結果的檔名不能用這個名稱"));
    }
    let mut total = req.system.chars().count() * req.items.len();
    for item in &req.items {
        let n = item.content.chars().count();
        if item.content.trim().is_empty() || n > MAX_INPUT_CHARS {
            return Err(tr!(
                "「{name}」是空的或太長（超過 {max} 字）",
                name = crate::files::display_name(Path::new(&item.path)),
                max = MAX_INPUT_CHARS
            ));
        }
        total += n;
    }
    if total > MAX_TOTAL_CHARS {
        return Err(tr!(
            "內容加起來太長（超過 {max} 字），請選小一點的資料夾",
            max = MAX_TOTAL_CHARS
        ));
    }
    Ok(())
}

/// 把資料夾裡的文件送成一個批次。
#[tauri::command]
pub async fn assistant_batch_create(
    app: AppHandle,
    request: BatchRequest,
) -> Result<BatchView, String> {
    let settings = crate::settings::read_value(&app).unwrap_or_default();
    let root = app
        .try_state::<crate::workspace::Workspace>()
        .and_then(|w| w.root());
    let origin = root.as_deref().and_then(crate::git::origin_at);
    check(&settings, root.as_deref(), origin.as_deref())?;
    let root = root.ok_or_else(|| tr!("請先開啟允許 AI 的專案資料夾"))?;
    let m = model(&request.model).ok_or_else(|| tr!("不支援這個模型"))?;
    check_items(&request)?;
    for item in &request.items {
        crate::workspace::inside(&root, Path::new(&item.path))?;
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
    let body = create_body(m, &request).to_string();
    let text =
        crate::io::blocking(move || call(&format!("{API_URL}/batches"), &key, Some(body))).await?;
    let id = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v["id"].as_str().map(str::to_string))
        .filter(|id| valid_batch_id(id))
        .ok_or_else(|| tr!("Claude API 沒有回傳批次的代號"))?;
    let batch = Batch {
        id,
        created: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        root: crate::files::path_string(&root),
        folder: request.folder,
        action: request.action,
        suffix: request.suffix.trim().to_string(),
        model: m.id.to_string(),
        files: request.items.into_iter().map(|i| i.path).collect(),
        state: "processing".into(),
        canceling: false,
        finished: 0,
        written: 0,
        failed: 0,
        usd: 0.0,
    };
    let _guard = STORE.lock();
    let mut list = read_all(&app);
    remember(&mut list, batch.clone());
    write_all(&app, &list);
    Ok(view(&batch, false, false))
}

// ---- 清單、狀態、結果 ----

#[tauri::command]
pub fn assistant_batch_list(app: AppHandle) -> Vec<BatchView> {
    read_all(&app)
        .iter()
        .map(|b| view(b, false, false))
        .collect()
}

/// 結果裡的一行：哪一份文件、成功時的文字與用量。
#[derive(Debug, PartialEq)]
struct Line {
    index: usize,
    /// 成功時是回答的文字；失敗（錯誤、取消、過期）時是 `None`。
    text: Option<String>,
    tokens: Tokens,
}

fn parse_line(line: &str) -> Option<Line> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let index = v["custom_id"].as_str()?.strip_prefix('f')?.parse().ok()?;
    let message = &v["result"]["message"];
    let text = (v["result"]["type"] == "succeeded")
        .then(|| {
            message["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<String>()
                })
                .unwrap_or_default()
        })
        .filter(|t| !t.trim().is_empty());
    let n = |v: &serde_json::Value| v.as_u64().unwrap_or(0);
    let u = &message["usage"];
    Some(Line {
        index,
        text,
        tokens: Tokens {
            input: n(&u["input_tokens"]),
            cache_write: n(&u["cache_creation_input_tokens"]),
            cache_read: n(&u["cache_read_input_tokens"]),
            output: n(&u["output_tokens"]),
            searches: 0,
        },
    })
}

/// 結果的檔名：`行程.md` → `行程.<suffix>`（副檔名另外加）。
fn result_stem(source: &Path, suffix: &str) -> String {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("{stem}.{suffix}")
}

/// 把結果寫成原檔旁邊的新檔，回傳寫了幾個、幾份失敗、費用。
fn write_results(root: &Path, batch: &Batch, m: &Model, jsonl: &str) -> (u32, u32, f64) {
    let (mut written, mut usd) = (0u32, 0.0);
    for line in jsonl.lines().filter_map(parse_line) {
        usd += cost(m, &line.tokens) * DISCOUNT;
        let (Some(text), Some(source)) = (line.text, batch.files.get(line.index)) else {
            continue;
        };
        let source = Path::new(source);
        let Some(parent) = source.parent() else {
            continue;
        };
        let body = format!("{}\n", text.trim());
        let stem = result_stem(source, &batch.suffix);
        if crate::workspace::create_file_with(root, parent, &stem, "md", body.as_bytes()).is_ok() {
            written += 1;
        }
    }
    let failed = (batch.files.len() as u32).saturating_sub(written);
    (written, failed, usd)
}

/// 問這個批次現在的狀態；處理完了就領結果、寫成新檔、記上費用。
#[tauri::command]
pub async fn assistant_batch_check(app: AppHandle, id: String) -> Result<BatchView, String> {
    let mut batch = find(&app, &id)?;
    if batch.state != "processing" || !valid_batch_id(&batch.id) {
        return Ok(view(&batch, false, false));
    }
    let key = key().ok_or_else(|| tr!("請先在設定輸入 Claude API 金鑰"))?;
    let url = format!("{API_URL}/batches/{}", batch.id);
    let status = {
        let key = key.clone();
        crate::io::blocking(move || call(&url, &key, None)).await?
    };
    let status: serde_json::Value =
        serde_json::from_str(&status).map_err(|_| tr!("Claude API 的回應看不懂"))?;
    let n = |k: &str| status["request_counts"][k].as_u64().unwrap_or(0) as u32;
    batch.finished = n("succeeded") + n("errored") + n("canceled") + n("expired");
    if status["processing_status"] != "ended" {
        update(&app, &batch);
        return Ok(view(&batch, false, false));
    }
    // 結果要寫回送出時的資料夾：沒開著就先不領（之後打開再領）。
    let root = app
        .try_state::<crate::workspace::Workspace>()
        .and_then(|w| w.root())
        .filter(|r| same_path(&crate::files::path_string(r), &batch.root));
    let Some(root) = root else {
        update(&app, &batch);
        return Ok(view(&batch, true, false));
    };
    let m = model(&batch.model).ok_or_else(|| tr!("不支援這個模型"))?;
    let url = format!("{API_URL}/batches/{}/results", batch.id);
    let jsonl = crate::io::blocking(move || call(&url, &key, None)).await?;
    let (written, failed, usd) = {
        let (root, batch) = (root.clone(), batch.clone());
        crate::io::blocking(move || Ok(write_results(&root, &batch, m, &jsonl))).await?
    };
    batch.written = written;
    batch.failed = failed;
    batch.usd = usd;
    batch.state = if batch.canceling && n("canceled") > 0 {
        "canceled".into()
    } else {
        "done".into()
    };
    update(&app, &batch);
    add_used(&app, usd);
    Ok(view(&batch, false, true))
}

/// 取消還在處理的批次（已經做完的部分照樣收費，之後檢查時會寫好）。
#[tauri::command]
pub async fn assistant_batch_cancel(app: AppHandle, id: String) -> Result<BatchView, String> {
    let mut batch = find(&app, &id)?;
    if batch.state != "processing" || !valid_batch_id(&batch.id) {
        return Ok(view(&batch, false, false));
    }
    let key = key().ok_or_else(|| tr!("請先在設定輸入 Claude API 金鑰"))?;
    let url = format!("{API_URL}/batches/{}/cancel", batch.id);
    crate::io::blocking(move || call(&url, &key, Some("{}".into()))).await?;
    batch.canceling = true;
    update(&app, &batch);
    Ok(view(&batch, false, false))
}

/// 從清單拿掉一個批次（還在處理的要先取消）。
#[tauri::command]
pub fn assistant_batch_remove(app: AppHandle, id: String) {
    let _guard = STORE.lock();
    let mut list = read_all(&app);
    list.retain(|b| b.id != id || b.state == "processing");
    write_all(&app, &list);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(id: &str, state: &str) -> Batch {
        Batch {
            id: id.into(),
            created: "2026-11-15 21:30".into(),
            root: "C:/Users/me/Documents/旅遊".into(),
            folder: "行程".into(),
            action: "摘要".into(),
            suffix: "摘要".into(),
            model: "claude-haiku-5-5".into(),
            files: vec![
                "C:/Users/me/Documents/旅遊/行程/第一天.md".into(),
                "C:/Users/me/Documents/旅遊/行程/第二天.md".into(),
            ],
            state: state.into(),
            canceling: false,
            finished: 0,
            written: 0,
            failed: 0,
            usd: 0.0,
        }
    }

    fn request(items: Vec<(&str, &str)>) -> BatchRequest {
        BatchRequest {
            model: "claude-haiku-5-5".into(),
            system: "你是筆記助理".into(),
            folder: "行程".into(),
            action: "摘要".into(),
            suffix: "摘要".into(),
            items: items
                .into_iter()
                .map(|(path, content)| BatchItem {
                    path: path.into(),
                    content: content.into(),
                })
                .collect(),
        }
    }

    #[test]
    fn builds_one_request_per_document() {
        let req = request(vec![("a.md", "第一天的內容"), ("b.md", "第二天的內容")]);
        let body = create_body(model("claude-haiku-5-5").unwrap(), &req);
        let list = body["requests"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1]["custom_id"], "f1");
        assert_eq!(list[1]["params"]["model"], "claude-haiku-5-5");
        assert_eq!(list[1]["params"]["system"], "你是筆記助理");
        assert_eq!(
            list[1]["params"]["messages"],
            serde_json::json!([{ "role": "user", "content": "第二天的內容" }])
        );
        assert_eq!(list[1]["params"]["output_config"]["effort"], "low");
        assert!(list[1]["params"].get("stream").is_none());
    }

    #[test]
    fn checks_the_size_and_the_result_name() {
        assert!(check_items(&request(vec![("a.md", "內容")])).is_ok());
        assert!(check_items(&request(vec![])).is_err());
        assert!(check_items(&request(vec![("a.md", "  ")])).is_err());
        let many: Vec<_> = (0..=MAX_FILES).map(|_| ("a.md", "內容")).collect();
        assert!(check_items(&request(many)).is_err());
        let long = "字".repeat(MAX_INPUT_CHARS + 1);
        assert!(check_items(&request(vec![("a.md", &long)])).is_err());
        for bad in ["", " ", "a.b", "a/b", "a:b", ".."] {
            let mut req = request(vec![("a.md", "內容")]);
            req.suffix = bad.into();
            assert!(check_items(&req).is_err(), "{bad}");
        }
        assert!(valid_suffix("會議紀錄 草稿"));
    }

    #[test]
    fn only_api_batch_ids_go_into_urls() {
        assert!(valid_batch_id("msgbatch_01AbCdEf"));
        assert!(!valid_batch_id(""));
        assert!(!valid_batch_id("../x"));
        assert!(!valid_batch_id("a/b"));
        assert!(!valid_batch_id("a?b=1"));
    }

    #[test]
    fn reads_result_lines() {
        assert_eq!(
            parse_line(
                r#"{"custom_id":"f1","result":{"type":"succeeded","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"- 重點一\n"},{"type":"text","text":"- 重點二"}],"usage":{"input_tokens":1200,"cache_read_input_tokens":300,"output_tokens":80}}}}"#
            ),
            Some(Line {
                index: 1,
                text: Some("- 重點一\n- 重點二".into()),
                tokens: Tokens {
                    input: 1200,
                    cache_write: 0,
                    cache_read: 300,
                    output: 80,
                    searches: 0,
                },
            })
        );
        // 失敗、取消、過期的沒有文字；空白的回答也不寫。
        for line in [
            r#"{"custom_id":"f0","result":{"type":"errored","error":{"type":"invalid_request"}}}"#,
            r#"{"custom_id":"f0","result":{"type":"canceled"}}"#,
            r#"{"custom_id":"f0","result":{"type":"succeeded","message":{"content":[{"type":"text","text":" "}],"usage":{}}}}"#,
        ] {
            assert_eq!(parse_line(line).unwrap().text, None, "{line}");
        }
        assert_eq!(parse_line(r#"{"custom_id":"x1","result":{}}"#), None);
        assert_eq!(parse_line("not json"), None);
    }

    #[test]
    fn writes_results_next_to_the_originals_without_touching_them() {
        let dir = std::env::temp_dir().join(format!("md-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dunce::canonicalize(&dir).unwrap();
        let folder = root.join("行程");
        std::fs::create_dir(&folder).unwrap();
        let (a, b) = (folder.join("第一天.md"), folder.join("第二天.md"));
        std::fs::write(&a, "原本的第一天").unwrap();
        std::fs::write(&b, "原本的第二天").unwrap();
        // 已經有同名的結果：不覆寫，加上編號。
        std::fs::write(folder.join("第一天.摘要.md"), "舊的摘要").unwrap();
        let mut batch = batch("msgbatch_1", "processing");
        batch.files = vec![crate::files::path_string(&a), crate::files::path_string(&b)];
        let jsonl = [
            r#"{"custom_id":"f0","result":{"type":"succeeded","message":{"content":[{"type":"text","text":"\n第一天的摘要\n\n"}],"usage":{"input_tokens":1000000,"output_tokens":0}}}}"#,
            r#"{"custom_id":"f1","result":{"type":"errored","error":{"type":"api_error"}}}"#,
            r#"{"custom_id":"f9","result":{"type":"succeeded","message":{"content":[{"type":"text","text":"不在清單裡"}],"usage":{}}}}"#,
        ]
        .join("\n");
        let m = model("claude-sonnet-5-5").unwrap();
        let (written, failed, usd) = write_results(&root, &batch, m, &jsonl);
        assert_eq!((written, failed), (1, 1));
        // 一百萬個輸入 token 平常是 US$2，批次是一半。
        assert!((usd - 1.0).abs() < 1e-9, "{usd}");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "原本的第一天");
        assert_eq!(
            std::fs::read_to_string(folder.join("第一天.摘要.md")).unwrap(),
            "舊的摘要"
        );
        assert_eq!(
            std::fs::read_to_string(folder.join("第一天.摘要 2.md")).unwrap(),
            "第一天的摘要\n"
        );
        assert!(!folder.join("第二天.摘要.md").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_the_newest_batches_and_never_drops_running_ones() {
        let mut list = Vec::new();
        remember(&mut list, batch("running", "processing"));
        for i in 0..KEEP + 5 {
            remember(&mut list, batch(&format!("done{i}"), "done"));
        }
        assert_eq!(list.len(), KEEP);
        assert_eq!(list[0].id, format!("done{}", KEEP + 4));
        assert!(list.iter().any(|b| b.id == "running"), "還在處理的不丟");
        // 同一個代號只留一筆。
        remember(&mut list, batch("running", "done"));
        assert_eq!(list.iter().filter(|b| b.id == "running").count(), 1);
        assert_eq!(list[0].state, "done");
    }

    #[test]
    fn the_view_says_which_folder_to_open_first() {
        let b = batch("msgbatch_1", "processing");
        assert_eq!(view(&b, false, false).needs_folder, None);
        assert_eq!(
            view(&b, true, false).needs_folder.as_deref(),
            Some("C:/Users/me/Documents/旅遊")
        );
        let json = serde_json::to_value(view(&b, true, true)).unwrap();
        assert_eq!(json["needsFolder"], "C:/Users/me/Documents/旅遊");
        assert_eq!(json["justDone"], true);
        assert_eq!(json["total"], 2);
    }
}
