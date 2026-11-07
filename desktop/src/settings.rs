//! 設定檔讀寫（內容由前端驗證，這裡只負責存放）。

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::confirm::Question;
use crate::features::{Feature, Features};

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("settings.json"))
        .map_err(|e| e.to_string())
}

/// 讀取設定檔；還沒有設定檔時回傳 `None`。
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    match fs::read_to_string(settings_path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(tr!("無法讀取設定：{e}", e = e)),
    }
}

/// 設定檔的內容（沒有設定檔或讀不了時是 `None`）。
pub fn read_value(app: &AppHandle) -> Option<serde_json::Value> {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
}

/// 設定檔裡的「啟用 AI 協作」。執行 AI 工具、啟動 MCP 伺服器前，原生端自己再檢查一次，
/// 不只靠網頁那一端（網頁萬一被注入程式碼，也不能自己偷偷開啟）。
pub fn ai_enabled(app: &AppHandle) -> bool {
    read_value(app).is_some_and(|v| v["aiEnabled"] == true)
}

/// 設定檔裡的「在終端機執行指令」（沒有這一項時是預設的開啟）。AI 要求執行指令時，
/// 原生端自己再檢查一次，不只靠網頁那一端。
pub fn ai_terminal_enabled(app: &AppHandle) -> bool {
    read_value(app).is_some_and(|v| v["aiEnabled"] == true && v["aiTerminal"] != false)
}

/// 需要 AI 協作的功能先呼叫：沒有開啟時回傳錯誤。
pub fn require_ai(app: &AppHandle) -> Result<(), String> {
    if ai_enabled(app) {
        Ok(())
    } else {
        Err(tr!("請先在設定開啟「啟用 AI 協作」"))
    }
}

/// 從關閉改成「啟用 AI 協作」前要問的話。
fn ai_question() -> Question {
    Question::new(
        tr!("啟用 AI 協作"),
        tr!("啟用後，oMarker 可以執行 Claude Code、Codex 等 AI 工具，並讓它們讀取目前的文件。要啟用嗎？"),
    )
}

/// 從關閉改成「Claude API 助理」前要問的話。
fn claude_question() -> Question {
    Question::new(
        tr!("啟用 Claude API 助理"),
        tr!("啟用後，你在允許 AI 的專案裡送出的內容（目前的文件、選取的文字、你的問題）會送到 Anthropic 的 Claude API，費用算在你的 API 金鑰上。公司的電腦請保持關閉。要啟用嗎？"),
    )
}

/// 目前已經開啟的「AI 協作」與「Claude API 助理」（從關閉改成開啟時才要確認）。
#[derive(Clone, Copy, Default)]
struct AiOn {
    ai: bool,
    claude: bool,
}

/// 檢查這次要存的設定：從關閉改成開啟的「啟用 AI 協作」「Claude API 助理」與整合功能（`off` 是目前關掉的），
/// 用 `ask` 問使用者。拒絕的項目在 `value` 裡改回關閉；有任何一項被拒絕時回傳 `false`。
/// `ask` 在指令裡是系統的對話框，測試時換成固定的回答。
async fn review<F, Fut>(
    value: &mut serde_json::Value,
    on: AiOn,
    off: &[Feature],
    mut ask: F,
) -> bool
where
    F: FnMut(Question) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let mut accepted = true;
    if value["aiEnabled"] == true && !on.ai && !ask(ai_question()).await {
        value["aiEnabled"] = serde_json::Value::Bool(false);
        accepted = false;
    }
    if value["claudeApiEnabled"] == true && !on.claude && !ask(claude_question()).await {
        value["claudeApiEnabled"] = serde_json::Value::Bool(false);
        accepted = false;
    }
    let turned_on = crate::features::turned_on(off, value);
    if let Some(q) = crate::features::enable_question(&turned_on) {
        if !ask(q).await {
            crate::features::keep_off(value, &turned_on);
            accepted = false;
        }
    }
    accepted
}

/// 儲存設定。從關閉改成「啟用 AI 協作」「Claude API 助理」，或重新開啟關掉的整合功能（Git、Azure DevOps、遠端資料夾）時，
/// 用系統的對話框再確認一次；使用者拒絕的項目存成關閉，並回傳 `false`（前端會把開關改回去）。
/// 內容不是 JSON 物件時不存（壞掉的設定檔會讓關掉的功能全部變回開啟）。
#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    window: tauri::Window,
    json: String,
) -> Result<bool, String> {
    // 一次只存一份，確認對話框不會重複跳出。
    static SAVING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SAVING.lock().await;
    let path = settings_path(&app)?;
    let mut value = serde_json::from_str::<serde_json::Value>(&json)
        .ok()
        .filter(serde_json::Value::is_object)
        .ok_or_else(|| tr!("無法儲存設定：格式不正確"))?;
    let off = app
        .try_state::<Features>()
        .map(|f| f.off())
        .unwrap_or_default();
    let current = read_value(&app);
    let on = AiOn {
        ai: current.as_ref().is_some_and(|v| v["aiEnabled"] == true),
        claude: current
            .as_ref()
            .is_some_and(|v| v["claudeApiEnabled"] == true),
    };
    let accepted = review(&mut value, on, &off, |q| {
        crate::confirm::confirm(&window, Some(q))
    })
    .await;
    let json = if accepted {
        json
    } else {
        serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| tr!("無法建立設定資料夾：{e}", e = e))?;
    }
    crate::files::write_atomic(&path, json.as_bytes())
        .map_err(|e| tr!("無法儲存設定：{e}", e = e))?;
    // 整合功能的開關立刻生效（關掉的功能，原生指令從現在起一律拒絕）。
    if let Some(features) = app.try_state::<Features>() {
        features.update(Some(&value));
    }
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 依序回答 `answers`，記下問了哪些標題。
    async fn run(
        value: &mut serde_json::Value,
        ai_on: bool,
        off: &[Feature],
        answers: &[bool],
    ) -> (bool, Vec<String>) {
        let asked = RefCell::new(Vec::new());
        let on = AiOn {
            ai: ai_on,
            claude: true,
        };
        let accepted = review(value, on, off, |q| {
            let mut asked = asked.borrow_mut();
            let answer = answers[asked.len()];
            asked.push(q.title);
            async move { answer }
        })
        .await;
        (accepted, asked.into_inner())
    }

    #[tokio::test]
    async fn nothing_to_confirm_when_nothing_turns_on() {
        let mut v = serde_json::json!({ "aiEnabled": true, "gitEnabled": false, "theme": "dark" });
        let before = v.clone();
        let (ok, asked) = run(&mut v, true, &[Feature::Git], &[]).await;
        assert!(ok);
        assert!(asked.is_empty());
        assert_eq!(v, before);
    }

    #[tokio::test]
    async fn refusing_turns_switches_back_off() {
        let mut v =
            serde_json::json!({ "aiEnabled": true, "gitEnabled": true, "adoEnabled": true });
        let (ok, asked) = run(
            &mut v,
            false,
            &[Feature::Git, Feature::Ado],
            &[false, false],
        )
        .await;
        assert!(!ok);
        assert_eq!(asked, ["啟用 AI 協作", "開啟整合功能"]);
        assert_eq!(
            v,
            serde_json::json!({ "aiEnabled": false, "gitEnabled": false, "adoEnabled": false })
        );
    }

    #[tokio::test]
    async fn claude_api_needs_its_own_confirmation() {
        let mut v = serde_json::json!({ "aiEnabled": false, "claudeApiEnabled": true });
        let asked = RefCell::new(Vec::new());
        let ok = review(&mut v, AiOn::default(), &[], |q| {
            asked.borrow_mut().push(q.title);
            async { false }
        })
        .await;
        assert!(!ok);
        assert_eq!(asked.into_inner(), ["啟用 Claude API 助理"]);
        assert_eq!(v["claudeApiEnabled"], false);
        // 已經開著的不再問。
        let mut v = serde_json::json!({ "claudeApiEnabled": true });
        let on = AiOn {
            ai: false,
            claude: true,
        };
        assert!(review(&mut v, on, &[], |_| async { false }).await);
        assert_eq!(v["claudeApiEnabled"], true);
    }

    #[tokio::test]
    async fn agreeing_keeps_switches_on() {
        let mut v = serde_json::json!({ "aiEnabled": true, "remoteEnabled": true });
        let before = v.clone();
        let (ok, asked) = run(&mut v, false, &[Feature::Remote], &[true, true]).await;
        assert!(ok);
        assert_eq!(asked.len(), 2);
        assert_eq!(v, before);
        // 只同意其中一項：另一項改回關閉。
        let mut v = serde_json::json!({ "aiEnabled": true, "remoteEnabled": true });
        let (ok, _) = run(&mut v, false, &[Feature::Remote], &[true, false]).await;
        assert!(!ok);
        assert_eq!(
            v,
            serde_json::json!({ "aiEnabled": true, "remoteEnabled": false })
        );
    }
}
