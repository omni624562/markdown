//! 傳給 ChatGPT：把選取的文字、整份 Wiki 頁面或工作項目等帶進 ChatGPT 的輸入框（不會自動送出）。
//!
//! 網址在這裡組，網頁那一端只能選目標（桌面版或網頁版）、給文字，不能傳任意網址：
//! - 桌面版：`codex://new?prompt=<文字>`（ChatGPT 桌面版沿用 Codex 的網址；官方沒有保證會一直能用，
//!   不行時請使用者在設定改用網頁版）。
//! - 網頁版：`https://chatgpt.com/?q=<文字>`。
//!
//! 設定裡的「傳給 ChatGPT」沒有打開時一律拒絕（網頁萬一被注入程式碼，也不能用這個指令把內容送出去）。

use serde::Deserialize;
use tauri::AppHandle;

/// 要開哪一個 ChatGPT。
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Desktop,
    Web,
}

impl Target {
    /// 設定檔裡「傳給 ChatGPT」（`chatgptSend`）的值。
    fn setting(self) -> &'static str {
        match self {
            Target::Desktop => "desktop",
            Target::Web => "web",
        }
    }
}

/// 網址最長幾個字元（編碼之後）。Windows 交給系統開啟網址時，有些地方仍然只接受 2083 個字元
/// （`INTERNET_MAX_URL_LENGTH`），ChatGPT 的伺服器也不一定收很長的網址，所以保守一點；
/// 超過時網頁那一端改成先複製到剪貼簿，再開一個不帶內容（或只有一句提示）的 ChatGPT。
/// 網頁那一端的 `web/src/app/chatgpt.ts` 用同一個數字判斷。
pub const MAX_URL_LEN: usize = 2000;

/// 組出 ChatGPT 的網址；文字太長或桌面版沒有文字時回傳錯誤。
pub fn chatgpt_url(target: Target, text: &str) -> Result<String, String> {
    let encoded = crate::projects::encode_path(text);
    let url = match target {
        // 桌面版的網址沒有帶內容時什麼都不做，一定要有文字。
        Target::Desktop if text.trim().is_empty() => {
            return Err(tr!("沒有要傳給 ChatGPT 的內容"));
        }
        Target::Desktop => format!("codex://new?prompt={encoded}"),
        Target::Web if text.trim().is_empty() => "https://chatgpt.com/".to_string(),
        Target::Web => format!("https://chatgpt.com/?q={encoded}"),
    };
    if url.len() > MAX_URL_LEN {
        return Err(tr!("內容太長，沒辦法直接帶進 ChatGPT"));
    }
    Ok(url)
}

/// 設定裡選的是不是這個目標。
fn allowed(settings: Option<&serde_json::Value>, target: Target) -> bool {
    settings.is_some_and(|v| v["chatgptSend"] == target.setting())
}

/// 把文字帶進 ChatGPT（交給系統開啟網址；桌面版沒有安裝時由系統提示要用哪個程式開啟）。
#[tauri::command]
pub fn chatgpt_send(app: AppHandle, target: Target, text: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !allowed(crate::settings::read_value(&app).as_ref(), target) {
        return Err(tr!("請先在設定打開「傳給 ChatGPT」"));
    }
    let url = chatgpt_url(target, &text)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| match target {
            Target::Desktop => tr!(
                "無法開啟 ChatGPT 桌面版（請確認已經安裝，或在設定改用網頁版）：{e}",
                e = e
            ),
            Target::Web => tr!("無法開啟 ChatGPT：{e}", e = e),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_encoded_into_the_url() {
        assert_eq!(
            chatgpt_url(Target::Desktop, "你好").unwrap(),
            "codex://new?prompt=%E4%BD%A0%E5%A5%BD"
        );
        assert_eq!(
            chatgpt_url(Target::Web, "a b&c=d?#/").unwrap(),
            "https://chatgpt.com/?q=a%20b%26c%3Dd%3F%23%2F"
        );
        // 換行、引號都編碼，不會變成網址的一部分。
        assert_eq!(
            chatgpt_url(Target::Web, "1\n'x'").unwrap(),
            "https://chatgpt.com/?q=1%0A%27x%27"
        );
    }

    #[test]
    fn empty_text() {
        assert_eq!(
            chatgpt_url(Target::Web, " ").unwrap(),
            "https://chatgpt.com/"
        );
        assert!(chatgpt_url(Target::Desktop, "  ").is_err());
    }

    #[test]
    fn long_text_is_refused() {
        let prefix = "https://chatgpt.com/?q=".len();
        let fits = "a".repeat(MAX_URL_LEN - prefix);
        assert_eq!(chatgpt_url(Target::Web, &fits).unwrap().len(), MAX_URL_LEN);
        assert!(chatgpt_url(Target::Web, &format!("{fits}a")).is_err());
        // 中文一個字編碼後是 9 個字元。
        let chinese = "字".repeat(MAX_URL_LEN / 9);
        assert!(chatgpt_url(Target::Desktop, &chinese).is_err());
    }

    #[test]
    fn only_the_target_chosen_in_settings_is_allowed() {
        let desktop = serde_json::json!({ "chatgptSend": "desktop" });
        let web = serde_json::json!({ "chatgptSend": "web" });
        let off = serde_json::json!({ "chatgptSend": "off" });
        assert!(allowed(Some(&desktop), Target::Desktop));
        assert!(!allowed(Some(&desktop), Target::Web));
        assert!(allowed(Some(&web), Target::Web));
        assert!(!allowed(Some(&off), Target::Web));
        assert!(!allowed(Some(&serde_json::json!({})), Target::Web));
        assert!(!allowed(None, Target::Desktop));
    }

    #[test]
    fn only_two_targets_are_accepted() {
        assert_eq!(
            serde_json::from_str::<Target>("\"desktop\"").unwrap(),
            Target::Desktop
        );
        assert_eq!(
            serde_json::from_str::<Target>("\"web\"").unwrap(),
            Target::Web
        );
        assert!(serde_json::from_str::<Target>("\"https://example.test/\"").is_err());
        assert!(serde_json::from_str::<Target>("\"codex\"").is_err());
    }
}
