//! 重要操作前的系統確認對話框。
//!
//! 網頁會顯示不可信的內容（Markdown、Wiki、工作項目、issue），萬一網頁被注入程式碼，網頁自己的
//! 確認對話框可以直接略過。把內容公開到網路上、把資料夾移到資源回收筒、更換 Azure DevOps 伺服器、
//! 重新開啟關掉的功能這類操作，原生端自己用系統的對話框再問一次（網頁無法代按）。
//! 預設的按鈕是「否」，不小心按到 Enter 也不會答應。
//!
//! 要不要問、問什麼由各模組的純函式決定（回傳 `Option<Question>`，可以單獨測試），
//! 指令裡只在需要時呼叫 `confirm`。

use tauri::Window;

/// 要問使用者的事：對話框的標題與內容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub title: String,
    pub message: String,
}

impl Question {
    pub fn new(title: String, message: String) -> Self {
        Question { title, message }
    }
}

/// 需要確認時用系統的對話框詢問；使用者按「是」才回傳 true（按「否」或關掉對話框都是 false）。
/// 不需要確認（`None`）時直接回傳 true。一次只顯示一個對話框，網頁連續呼叫也不會疊好幾個。
pub async fn confirm(window: &Window, question: Option<Question>) -> bool {
    static ASKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let Some(q) = question else {
        return true;
    };
    let _guard = ASKING.lock().await;
    ask(window, q).await
}

/// Windows：直接用 MessageBox，才能把預設按鈕設成「否」（rfd 沒有這個選項）。
#[cfg(windows)]
async fn ask(window: &Window, q: Question) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO,
    };
    // 視窗代號只是一個數字，轉成整數才能交給另一個執行緒。
    let parent = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(&q.message), wide(&q.title));
    // 對話框會一直等到使用者回答，放在另一個執行緒，不會卡住其他指令。
    tauri::async_runtime::spawn_blocking(move || {
        // SAFETY：兩個字串都以 0 結尾，在呼叫期間一直有效；視窗代號是 0 時沒有上層視窗。
        let answer = unsafe {
            MessageBoxW(
                parent as _,
                text.as_ptr(),
                caption.as_ptr(),
                MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
            )
        };
        answer == IDYES
    })
    .await
    .unwrap_or(false)
}

#[cfg(not(windows))]
async fn ask(window: &Window, q: Question) -> bool {
    rfd::AsyncMessageDialog::new()
        .set_parent(window)
        .set_level(rfd::MessageLevel::Warning)
        .set_title(q.title)
        .set_description(q.message)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await
        == rfd::MessageDialogResult::Yes
}
