//! 收緊 WebView2（Windows 的瀏覽器核心）的設定：關掉 app 用不到、留著反而有風險或會打擾的瀏覽器功能。
//!
//! - **瀏覽器內建的快速鍵**：重新整理（F5、Ctrl+R）、尋找（Ctrl+F、F3、Ctrl+G）、列印（Ctrl+P）、
//!   開發人員工具等。app 沒有自己處理的按鍵會落到瀏覽器核心手上：重新整理會丟掉還沒存的狀態，
//!   內建的尋找框會蓋在視窗按鈕上。複製、貼上、復原、全選這些編輯用的按鍵不受影響。
//! - **儲存密碼、自動填入**：設定裡有金鑰、權杖、密碼的欄位，不讓瀏覽器核心提議記住或自動填入。
//! - **瀏覽器內建的右鍵選單**（重新整理、另存新檔、列印…）：前端已經把所有右鍵換成自己的選單，
//!   這裡在原生端再關一次，哪天前端漏了也不會出現。
//!
//! 其他平台的 webview 沒有這些設定，什麼都不做。

use tauri::Webview;

/// 套用到一個 webview（主畫面、終端機各呼叫一次）。設定失敗不影響啟動（舊版的 WebView2 沒有其中某些設定）。
pub fn harden(webview: &Webview) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Settings3, ICoreWebView2Settings4,
        };
        use windows_core::Interface;

        let _ = webview.with_webview(|webview| {
            let run = || -> windows_core::Result<()> {
                // SAFETY: 這些都是 WebView2 的 COM 介面，在 with_webview 給的執行緒（建立 webview 的那一個）上呼叫。
                unsafe {
                    let settings = webview.controller().CoreWebView2()?.Settings()?;
                    settings.SetAreDefaultContextMenusEnabled(false)?;
                    if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                        s3.SetAreBrowserAcceleratorKeysEnabled(false)?;
                    }
                    if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
                        s4.SetIsPasswordAutosaveEnabled(false)?;
                        s4.SetIsGeneralAutofillEnabled(false)?;
                    }
                }
                Ok(())
            };
            let _ = run();
        });
    }
    #[cfg(not(windows))]
    let _ = webview;
}
