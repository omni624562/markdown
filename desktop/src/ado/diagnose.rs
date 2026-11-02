//! 連線診斷：伺服器支援的 API 版本（推算是哪一版的 TFS／Azure DevOps Server），
//! 以及「儲存診斷資料」：把幾個常用請求的實際回應（拿掉人名、信箱、標題與內容）存成檔案，
//! 遇到某一版伺服器的格式不一樣時，可以直接拿來對照。

use super::*;
use std::time::Instant;

/// 由新到舊試的 API 版本。
const API_VERSIONS: [&str; 6] = ["7.0", "6.0", "5.1", "5.0", "4.1", "3.0"];

/// 伺服器支援的最高 API 版本（試讀專案清單；都不行時是 `None`）。
pub(super) fn newest_api(base: &str, pat: &str) -> Option<&'static str> {
    API_VERSIONS
        .into_iter()
        .find(|v| get_version(base, pat, "/_apis/projects?$top=1", Some(v), "API").is_ok())
}

/// API 版本對應的伺服器版本（大約；雲端版也支援最新的版本）。
pub(super) fn server_of(api: &str) -> String {
    match api {
        "7.0" => tr!("Azure DevOps Server 2022 或雲端版"),
        "6.0" => tr!("Azure DevOps Server 2020"),
        "5.1" => tr!("Azure DevOps Server 2019 Update 1"),
        "5.0" => tr!("Azure DevOps Server 2019"),
        "4.1" => tr!("TFS 2018"),
        _ => tr!("TFS 2017 或更舊"),
    }
}

/// 檢查清單的第一項：伺服器版本與連線速度。
pub(super) fn server_check(base: &str, pat: &str) -> AccessCheck {
    let start = Instant::now();
    let api = newest_api(base, pat);
    let took = seconds(start);
    match api {
        Some(v) => check(
            "server",
            tr!("伺服器版本"),
            Ok(tr!(
                "{server}（API {api}；回應 {took} 秒）",
                server = server_of(v),
                api = v,
                took = took
            )),
        ),
        None => check(
            "server",
            tr!("伺服器版本"),
            Err(tr!(
                "無法判斷（試過的 API 版本都失敗；{took} 秒）",
                took = took
            )),
        ),
    }
}

fn seconds(start: Instant) -> String {
    format!("{:.1}", start.elapsed().as_secs_f64())
}

// ---- 去除個人資料 ----------------------------------------------------------------

/// 人員欄位：整個換掉（名稱、帳號、信箱、頭像都在裡面）。
const PERSON_KEYS: [&str; 16] = [
    "displayName",
    "uniqueName",
    "mailAddress",
    "imageUrl",
    "providerDisplayName",
    "customDisplayName",
    "authenticatedUser",
    "authorizedUser",
    "System.AssignedTo",
    "System.CreatedBy",
    "System.ChangedBy",
    "System.AuthorizedAs",
    "createdBy",
    "modifiedBy",
    "revisedBy",
    "author",
];

/// 內容欄位：只留長度（標題、說明、留言等可能有公司資料）。
const CONTENT_KEYS: [&str; 9] = [
    "System.Title",
    "System.Description",
    "System.History",
    "Microsoft.VSTS.Common.AcceptanceCriteria",
    "Microsoft.VSTS.TCM.ReproSteps",
    "text",
    "renderedText",
    "content",
    "title",
];

/// 拿掉回應裡的人名、信箱、標題與內容，伺服器網址換成 `https://tfs.example`；其他結構與欄位名稱照留。
pub(super) fn anonymize(v: &mut Value, base: &str) {
    let host = base
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("")
        .to_string();
    scrub(v, &host);
}

fn scrub(v: &mut Value, host: &str) {
    match v {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                if PERSON_KEYS.contains(&key.as_str()) {
                    *value = Value::String(tr!("（人員）"));
                } else if CONTENT_KEYS.contains(&key.as_str()) && value.is_string() {
                    let n = value.as_str().map_or(0, |s| s.chars().count());
                    *value = Value::String(tr!("（內容已移除，{n} 字）", n = n));
                } else {
                    scrub(value, host);
                }
            }
        }
        Value::Array(list) => list.iter_mut().for_each(|x| scrub(x, host)),
        Value::String(s) => *s = scrub_text(s, host),
        _ => {}
    }
}

/// 字串裡的伺服器名稱、信箱換掉。
fn scrub_text(s: &str, host: &str) -> String {
    let mut out = if host.is_empty() {
        s.to_string()
    } else {
        s.replace(host, "tfs.example")
    };
    // 信箱：`名稱@網域` 換成 `user(at)example`（不再含 @，迴圈才會結束）。
    while let Some(at) = out.find('@') {
        let start = out[..at]
            .rfind(|c: char| !(c.is_alphanumeric() || "._%+-".contains(c)))
            .map_or(0, |i| i + 1);
        let end = out[at + 1..]
            .find(|c: char| !(c.is_alphanumeric() || ".-".contains(c)))
            .map_or(out.len(), |i| at + 1 + i);
        if start == at || end == at + 1 {
            break;
        }
        out.replace_range(start..end, "user(at)example");
    }
    out
}

// ---- 儲存診斷資料 ----------------------------------------------------------------

#[derive(Serialize)]
struct Step {
    name: String,
    request: String,
    ok: bool,
    seconds: f64,
    response: Value,
}

fn step(
    name: &str,
    request: String,
    run: impl FnOnce() -> Result<Value, String>,
    base: &str,
) -> Step {
    let start = Instant::now();
    let result = run();
    let seconds = (start.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let (ok, mut response) = match result {
        Ok(v) => (true, v),
        Err(e) => (false, Value::String(e)),
    };
    anonymize(&mut response, base);
    Step {
        name: name.to_string(),
        request: scrub_text(&request, ""),
        ok,
        seconds,
        response,
    }
}

/// 依序讀幾個常用的請求，收集（去除個人資料後的）回應。
fn collect(base: &str, pat: &str) -> Vec<Step> {
    let mut steps = vec![step(
        "connectionData",
        "/_apis/connectionData".into(),
        || connection_data(base, pat),
        base,
    )];
    let api = newest_api(base, pat);
    let projects = get(base, pat, "/_apis/projects?$top=3", "projects");
    let project = projects
        .as_ref()
        .ok()
        .and_then(|v| values(v).first())
        .and_then(|p| str_of(p, "name"))
        .map(str::to_string);
    steps.push(step(
        "projects",
        "/_apis/projects?$top=3".into(),
        || projects.clone(),
        base,
    ));
    let wiql = serde_json::json!({
        "query": "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC"
    });
    let found = post(base, pat, "/_apis/wit/wiql?$top=3", &wiql, "wiql");
    let ids: Vec<String> = found
        .as_ref()
        .ok()
        .and_then(|v| v.get("workItems").and_then(Value::as_array))
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(|w| w.get("id").and_then(Value::as_u64))
        .take(3)
        .map(|id| id.to_string())
        .collect();
    steps.push(step(
        "wiql",
        "POST /_apis/wit/wiql?$top=3".into(),
        || found.clone(),
        base,
    ));
    if !ids.is_empty() {
        let path = format!(
            "/_apis/wit/workitems?ids={}&$expand=relations&errorPolicy=omit",
            ids.join(",")
        );
        steps.push(step(
            "workItems",
            path.clone(),
            || get(base, pat, &path, "workItems"),
            base,
        ));
    }
    if let Some(p) = project.as_deref() {
        let p = encode_segment(p);
        for (name, path, version) in [
            (
                "workItemTypes",
                format!("/{p}/_apis/wit/workitemtypes"),
                Some(API_VERSION),
            ),
            (
                "taskStates",
                format!("/{p}/_apis/wit/workitemtypes/Task/states"),
                Some("5.0-preview.1"),
            ),
            (
                "teams",
                format!("/_apis/projects/{p}/teams?$top=5"),
                Some(API_VERSION),
            ),
        ] {
            steps.push(step(
                name,
                path.clone(),
                || get_version(base, pat, &path, version, name),
                base,
            ));
        }
        if let Some(id) = ids.first() {
            for version in ["5.0-preview.2", "5.1-preview.3"] {
                let path = format!("/{p}/_apis/wit/workItems/{id}/comments?$top=2");
                steps.push(step(
                    &format!("comments {version}"),
                    format!("{path}&api-version={version}"),
                    || get_version(base, pat, &path, Some(version), "comments"),
                    base,
                ));
            }
        }
    }
    steps.push(step(
        "wikis",
        "/_apis/wiki/wikis".into(),
        || get(base, pat, "/_apis/wiki/wikis", "wikis"),
        base,
    ));
    steps.insert(
        0,
        Step {
            name: "server".into(),
            request: "/_apis/projects?$top=1 (api-version 7.0 → 3.0)".into(),
            ok: api.is_some(),
            seconds: 0.0,
            response: Value::String(
                api.map_or_else(|| tr!("無法判斷"), |v| format!("API {v}: {}", server_of(v))),
            ),
        },
    );
    steps
}

/// 儲存診斷資料：選好檔案後讀幾個常用的請求，把回應（去除人名、信箱、標題與內容）存成 JSON。
/// 回傳存檔的路徑；取消時是 `None`。
#[tauri::command]
pub async fn ado_diagnostics_save(
    app: AppHandle,
    window: Window,
) -> Result<Option<String>, String> {
    let (a, pat) = require(&app)?;
    let name = format!(
        "oMarker-ADO-diagnostics-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M")
    );
    let picked = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(tr!("儲存診斷資料"))
        .set_file_name(name)
        .add_filter("JSON", &["json"])
        .save_file()
        .await;
    let Some(handle) = picked else {
        return Ok(None);
    };
    let path = handle.path().to_path_buf();
    let p = path.clone();
    crate::io::blocking_for(Duration::from_secs(180), move || {
        let report = serde_json::json!({
            "app": env!("CARGO_PKG_VERSION"),
            "created": chrono::Local::now().to_rfc3339(),
            "note": tr!("人名、信箱、標題與內容已經拿掉；寄出前可以先打開看看。"),
            "steps": collect(&a.url, &pat),
        });
        let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        crate::files::write_atomic(&p, text.as_bytes())
            .map_err(|e| crate::io::describe(&e, &tr!("無法寫入檔案")))
    })
    .await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
