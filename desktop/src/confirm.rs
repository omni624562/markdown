//! 重要操作前的系統確認對話框。
//!
//! 網頁會顯示不可信的內容（Markdown、Wiki、工作項目、issue），萬一網頁被注入程式碼，網頁自己的
//! 確認對話框可以直接略過。把內容公開到網路上、更換 Azure DevOps 伺服器、重新開啟關掉的功能這類操作，
//! 原生端自己用系統的對話框再問一次（網頁無法代按）。刪除專案（資料夾移到資源回收筒，可以還原）
//! 照使用者的選擇只在網頁的提示窗問一次（要輸入資料夾名稱），不在這裡。
//! 按鈕是中文（「確定」或指定的字，與「取消」），預設的按鈕是「取消」，不小心按到 Enter 也不會答應。
//!
//! 要不要問、問什麼由各模組的純函式決定（回傳 `Option<Question>`，可以單獨測試），
//! 指令裡只在需要時呼叫 `confirm`。

use tauri::Window;

/// 要問使用者的事：對話框的標題（Windows 上是對話框裡的大字）與內容。
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

/// 需要確認時用系統的對話框詢問；使用者按「確定」才回傳 true（按「取消」或關掉對話框都是 false）。
/// 不需要確認（`None`）時直接回傳 true。一次只顯示一個對話框，網頁連續呼叫也不會疊好幾個。
pub async fn confirm(window: &Window, question: Option<Question>) -> bool {
    let Some(q) = question else {
        return true;
    };
    choose(window, q, tr!("確定"), None).await.is_some()
}

/// 用系統的對話框問一次，按鈕是 `ok` 與「取消」（預設是「取消」）；`check` 是對話框下方的勾選框
/// （文字與預設值）。按 `ok` 時回傳勾選框的狀態（沒有勾選框時是 false），取消或關掉時回傳 None。
pub async fn choose(
    window: &Window,
    q: Question,
    ok: String,
    check: Option<(String, bool)>,
) -> Option<bool> {
    static ASKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = ASKING.lock().await;
    ask(window, q, ok, check).await
}

/// Windows：用 TaskDialog（按鈕的字可以自訂成中文、可以放勾選框、預設按鈕是「取消」）。
/// 舊版的通用控制項沒有 TaskDialog（例如沒有套用程式清單的測試程式）時退回 MessageBox。
#[cfg(windows)]
async fn ask(
    window: &Window,
    q: Question,
    ok: String,
    check: Option<(String, bool)>,
) -> Option<bool> {
    // 視窗代號只是一個數字，轉成整數才能交給另一個執行緒。
    let parent = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    // 對話框會一直等到使用者回答，放在另一個執行緒，不會卡住其他指令。
    tauri::async_runtime::spawn_blocking(move || {
        let check = check.as_ref().map(|(text, on)| (text.as_str(), *on));
        win::task_dialog(parent, &q, &ok, check)
            .unwrap_or_else(|| win::message_box(parent, &q, check))
    })
    .await
    .unwrap_or(None)
}

#[cfg(windows)]
mod win {
    use super::Question;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::UI::Controls::{
        TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
        TDF_POSITION_RELATIVE_TO_WINDOW, TDF_VERIFICATION_FLAG_CHECKED, TD_WARNING_ICON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDCANCEL, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO,
    };

    const OK: i32 = 100;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    type TaskDialogIndirect = unsafe extern "system" fn(
        *const TASKDIALOGCONFIG,
        *mut i32,
        *mut i32,
        *mut windows_sys::core::BOOL,
    ) -> windows_sys::core::HRESULT;

    /// TaskDialog 不在的時候回傳 None（呼叫端改用 MessageBox）；否則是使用者的回答。
    /// 不直接連結 TaskDialogIndirect：舊版 comctl32 沒有它，程式會整個開不起來。
    pub fn task_dialog(
        parent: isize,
        q: &Question,
        ok: &str,
        check: Option<(&str, bool)>,
    ) -> Option<Option<bool>> {
        // SAFETY：字串以 0 結尾；拿到的函式指標型別和 TaskDialogIndirect 的宣告一致。
        let f: TaskDialogIndirect = unsafe {
            let lib = LoadLibraryW(wide("comctl32.dll").as_ptr());
            if lib.is_null() {
                return None;
            }
            std::mem::transmute(GetProcAddress(lib, c"TaskDialogIndirect".as_ptr().cast())?)
        };
        let (title, main, content) = (wide("oMarker"), wide(&q.title), wide(&q.message));
        let (ok_text, cancel_text) = (wide(ok), wide(&tr!("取消")));
        let verification = check.map(|(text, _)| wide(text));
        let buttons = [
            TASKDIALOG_BUTTON {
                nButtonID: OK,
                pszButtonText: ok_text.as_ptr(),
            },
            TASKDIALOG_BUTTON {
                nButtonID: IDCANCEL,
                pszButtonText: cancel_text.as_ptr(),
            },
        ];
        let mut flags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
        if check.is_some_and(|(_, on)| on) {
            flags |= TDF_VERIFICATION_FLAG_CHECKED;
        }
        let mut config = TASKDIALOGCONFIG {
            cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
            hwndParent: parent as _,
            dwFlags: flags,
            pszWindowTitle: title.as_ptr(),
            pszMainInstruction: main.as_ptr(),
            pszContent: content.as_ptr(),
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            // 預設按鈕是「取消」：不小心按到 Enter 也不會答應。
            nDefaultButton: IDCANCEL,
            pszVerificationText: verification
                .as_ref()
                .map_or(std::ptr::null(), |v| v.as_ptr()),
            ..Default::default()
        };
        config.Anonymous1.pszMainIcon = TD_WARNING_ICON;
        let (mut button, mut checked) = (0, 0);
        // SAFETY：設定裡的字串與按鈕陣列在呼叫期間一直有效；輸出參數指向區域變數。
        let hr = unsafe { f(&config, &mut button, std::ptr::null_mut(), &mut checked) };
        if hr < 0 {
            return None;
        }
        Some((button == OK).then_some(checked != 0))
    }

    /// 退路：MessageBox 的按鈕是「是／否」（字跟著 Windows 的語言），沒有勾選框，照預設值。
    pub fn message_box(parent: isize, q: &Question, check: Option<(&str, bool)>) -> Option<bool> {
        let (text, caption) = (wide(&q.message), wide(&q.title));
        // SAFETY：兩個字串都以 0 結尾，在呼叫期間一直有效；視窗代號是 0 時沒有上層視窗。
        let answer = unsafe {
            MessageBoxW(
                parent as _,
                text.as_ptr(),
                caption.as_ptr(),
                MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2,
            )
        };
        (answer == IDYES).then_some(check.is_some_and(|(_, on)| on))
    }
}

/// 其他平台：用 rfd 的對話框（按鈕的字可以自訂；沒有勾選框，照預設值）。
#[cfg(not(windows))]
async fn ask(
    window: &Window,
    q: Question,
    ok: String,
    check: Option<(String, bool)>,
) -> Option<bool> {
    let answer = rfd::AsyncMessageDialog::new()
        .set_parent(window)
        .set_level(rfd::MessageLevel::Warning)
        .set_title(q.title)
        .set_description(q.message)
        .set_buttons(rfd::MessageButtons::OkCancelCustom(ok.clone(), tr!("取消")))
        .show()
        .await;
    (answer == rfd::MessageDialogResult::Custom(ok)).then_some(check.is_some_and(|(_, on)| on))
}
