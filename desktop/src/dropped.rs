//! 拖進視窗的檔案原本的路徑。
//!
//! 網頁拿到拖進來的檔案時只有檔名與內容，沒有路徑：開起來是「還沒存檔的新文件」，存檔要另存新檔，
//! 而且找不到原本的資料夾。WebView2 可以讓網頁把檔案物件交給原生端
//! （`chrome.webview.postMessageWithAdditionalObjects`），原生端再問出它的路徑。前端放下檔案時送一則
//! `{ "omarkerDrop": "<代號>" }` 的訊息帶著那些檔案，這裡記下路徑；接著前端用 `dropped_file` 指令
//! 依代號與順序把檔案開起來（和「開啟檔案」一樣：記得路徑、加入允許清單、監看外部修改）。
//!
//! 路徑來自 WebView2 交出來的檔案物件，不是網頁給的字串，網頁沒辦法指定任意路徑。
//! 只有 Windows（WebView2）有這個機制；其他平台 `dropped_file` 回傳 `None`，前端照原本的方式開啟。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, State, Webview};

use crate::files::OpenedFile;
use crate::trust::Trust;

/// 最多記幾次拖放（舊的丟掉）；一次最多幾個檔案。
const KEEP: usize = 8;
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_FILES: usize = 32;

/// 最近幾次拖放的檔案路徑（代號 → 依順序的路徑）。
#[derive(Default)]
pub struct Dropped(Mutex<VecDeque<(String, Vec<PathBuf>)>>);

impl Dropped {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn put(&self, id: String, paths: Vec<PathBuf>) {
        let mut list = self.0.lock();
        list.retain(|(k, _)| *k != id);
        list.push_back((id, paths));
        while list.len() > KEEP {
            list.pop_front();
        }
    }

    fn get(&self, id: &str, index: usize) -> Option<Option<PathBuf>> {
        self.0
            .lock()
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, paths)| paths.get(index).cloned())
    }
}

/// 代號只會是前端產生的短字串（英數與連字號）。
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// 訊息是不是「拖放的檔案」，是的話回傳代號。
#[cfg_attr(not(windows), allow(dead_code))]
fn drop_id(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let id = v.as_object()?.get("omarkerDrop")?.as_str()?;
    valid_id(id).then(|| id.to_string())
}

/// 開始收主畫面送來的拖放訊息（只有 Windows 有作用）。
pub fn listen(webview: &Webview) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
        };
        use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
        use windows_core::{Interface, PWSTR};

        let app = webview.app_handle().clone();
        let _ = webview.with_webview(move |webview| {
            let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                // SAFETY: WebView2 的 COM 介面，在它自己的執行緒（這個事件的執行緒）上呼叫；
                // 回傳的字串由 take_pwstr 接手釋放。
                unsafe {
                    let mut json = PWSTR::null();
                    if args.WebMessageAsJson(&mut json).is_err() {
                        return Ok(());
                    }
                    let Some(id) = drop_id(&take_pwstr(json)) else {
                        return Ok(());
                    };
                    let mut paths = Vec::new();
                    if let Ok(objects) = args
                        .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
                        .and_then(|a| a.AdditionalObjects())
                    {
                        let mut count = 0u32;
                        let _ = objects.Count(&mut count);
                        for i in 0..count.min(MAX_FILES as u32) {
                            let Ok(file) = objects
                                .GetValueAtIndex(i)
                                .and_then(|o| o.cast::<ICoreWebView2File>())
                            else {
                                continue;
                            };
                            let mut path = PWSTR::null();
                            if file.Path(&mut path).is_ok() {
                                paths.push(PathBuf::from(take_pwstr(path)));
                            }
                        }
                    }
                    app.state::<Dropped>().put(id, paths);
                }
                Ok(())
            }));
            // SAFETY: 同上；登記的事件處理常式跟著 webview 一起結束，不用另外移除。
            unsafe {
                if let Ok(core) = webview.controller().CoreWebView2() {
                    let mut token = 0i64;
                    let _ = core.add_WebMessageReceived(&handler, &mut token);
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = webview;
}

/// 開啟拖進來的第 `index` 個檔案（依原本的路徑）。拿不到路徑時回傳 `None`：前端改用檔案內容開成新文件。
/// 訊息和這個指令走不同的管道、先後不一定，所以最多等一下子。
#[tauri::command]
pub async fn dropped_file(
    app: AppHandle,
    dropped: State<'_, Dropped>,
    trust: State<'_, Trust>,
    id: String,
    index: usize,
) -> Result<Option<OpenedFile>, String> {
    if !cfg!(windows) || !valid_id(&id) {
        return Ok(None);
    }
    let mut found = None;
    for _ in 0..20 {
        if let Some(path) = dropped.get(&id, index) {
            found = path;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let Some(path) = found else { return Ok(None) };
    // 資料夾、已經不在的檔案：交給前端照原本的方式處理。
    if !path.is_file() {
        return Ok(None);
    }
    let opened = crate::files::read_in_background(&app, path.clone()).await?;
    trust.add_file(&app, &path);
    Ok(Some(opened))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_drop_messages_with_a_plain_id_count() {
        assert_eq!(
            drop_id(r#"{"omarkerDrop":"a1b2-c3"}"#),
            Some("a1b2-c3".into())
        );
        assert_eq!(drop_id(r#"{"omarkerDrop":"../x"}"#), None);
        assert_eq!(drop_id(r#"{"omarkerDrop":""}"#), None);
        assert_eq!(drop_id(r#"{"omarkerDrop":7}"#), None);
        assert_eq!(drop_id(r#"{"cmd":"open_file"}"#), None);
        assert_eq!(drop_id(r#""omarkerDrop""#), None);
        assert_eq!(drop_id("not json"), None);
    }

    #[test]
    fn remembers_the_last_few_drops_in_order() {
        let d = Dropped::default();
        d.put(
            "a".into(),
            vec![
                PathBuf::from("C:/Users/me/a.md"),
                PathBuf::from("C:/Users/me/b.md"),
            ],
        );
        assert_eq!(d.get("a", 1), Some(Some(PathBuf::from("C:/Users/me/b.md"))));
        // 這次拖放沒有第三個檔案；沒聽過的代號是還沒收到。
        assert_eq!(d.get("a", 2), Some(None));
        assert_eq!(d.get("b", 0), None);
        for i in 0..KEEP {
            d.put(format!("n{i}"), vec![]);
        }
        assert_eq!(d.get("a", 0), None, "太舊的丟掉");
    }
}
