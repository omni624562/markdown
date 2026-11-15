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

/// 最近幾次拖放的檔案路徑（代號 → 依順序的路徑，和拿不到路徑時的原因）。
#[derive(Default)]
pub struct Dropped(Mutex<VecDeque<(String, Vec<PathBuf>, String)>>);

impl Dropped {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn put(&self, id: String, paths: Vec<PathBuf>, note: String) {
        let mut list = self.0.lock();
        list.retain(|(k, _, _)| *k != id);
        list.push_back((id, paths, note));
        while list.len() > KEEP {
            list.pop_front();
        }
    }

    /// 這次拖放的第 `index` 個檔案的路徑；沒有的話是原因。還沒收到這次拖放的訊息時是 `None`。
    fn get(&self, id: &str, index: usize) -> Option<Result<PathBuf, String>> {
        self.0
            .lock()
            .iter()
            .find(|(k, _, _)| k == id)
            .map(|(_, paths, note)| paths.get(index).cloned().ok_or_else(|| note.clone()))
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

/// 登記事件失敗時的錯誤碼（拿不到路徑時顯示）。
#[cfg_attr(not(windows), allow(dead_code))]
static LISTEN_ERROR: Mutex<Option<String>> = Mutex::new(None);

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
                    // 每一步失敗的原因都記下來：拿不到路徑時前端會顯示，才知道是哪一步。
                    let mut paths = Vec::new();
                    let note = match args
                        .cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
                        .and_then(|a| a.AdditionalObjects())
                    {
                        Ok(objects) => {
                            let mut count = 0u32;
                            let _ = objects.Count(&mut count);
                            let mut seen = format!("objects={count}");
                            for i in 0..count.min(MAX_FILES as u32) {
                                let file = match objects
                                    .GetValueAtIndex(i)
                                    .and_then(|o| o.cast::<ICoreWebView2File>())
                                {
                                    Ok(file) => file,
                                    Err(e) => {
                                        seen = format!("{seen}, file[{i}]: {:#x}", e.code().0);
                                        continue;
                                    }
                                };
                                let mut path = PWSTR::null();
                                match file.Path(&mut path) {
                                    Ok(()) => paths.push(PathBuf::from(take_pwstr(path))),
                                    Err(e) => {
                                        seen = format!("{seen}, path[{i}]: {:#x}", e.code().0);
                                    }
                                }
                            }
                            seen
                        }
                        Err(e) => format!("AdditionalObjects: {:#x}", e.code().0),
                    };
                    app.state::<Dropped>().put(id, paths, note);
                }
                Ok(())
            }));
            // SAFETY: 同上；登記的事件處理常式跟著 webview 一起結束，不用另外移除。
            unsafe {
                let mut token = 0i64;
                let added = webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.add_WebMessageReceived(&handler, &mut token));
                if let Err(e) = added {
                    *LISTEN_ERROR.lock() = Some(format!("{:#x}", e.code().0));
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = webview;
}

/// 開啟拖進來的第 `index` 個檔案（依原本的路徑）。這個平台沒有這個機制時回傳 `None`；
/// 應該拿得到卻拿不到時回傳錯誤（寫明是哪一步），前端顯示原因後改用檔案內容開成新文件。
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
    for _ in 0..40 {
        if let Some(path) = dropped.get(&id, index) {
            found = Some(path);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let path = match found {
        Some(Ok(path)) => path,
        Some(Err(note)) => return Err(tr!("WebView2 沒有交出檔案的路徑（{note}）", note = note)),
        None => {
            let listen = LISTEN_ERROR.lock().clone();
            return Err(match listen {
                Some(code) => tr!("沒辦法接收 WebView2 的訊息（{code}）", code = code),
                None => tr!("沒有收到 WebView2 送來的檔案"),
            });
        }
    };
    // 資料夾：交給前端照原本的方式處理。
    if path.is_dir() {
        return Ok(None);
    }
    if !path.is_file() {
        return Err(tr!("找不到「{path}」", path = path.display().to_string()));
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
            "objects=2".into(),
        );
        assert_eq!(d.get("a", 1), Some(Ok(PathBuf::from("C:/Users/me/b.md"))));
        // 這次拖放沒有第三個檔案（回傳記下的原因）；沒聽過的代號是還沒收到。
        assert_eq!(d.get("a", 2), Some(Err("objects=2".into())));
        assert_eq!(d.get("b", 0), None);
        for i in 0..KEEP {
            d.put(format!("n{i}"), vec![], String::new());
        }
        assert_eq!(d.get("a", 0), None, "太舊的丟掉");
    }
}
