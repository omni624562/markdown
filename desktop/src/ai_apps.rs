//! 這台電腦有沒有安裝 Codex、Claude 桌面版：系統有沒有登記開啟 `codex://`、`claude://` 網址的程式。
//! 沒有安裝時，前端不顯示「在 Codex 開啟這個專案」「在 Claude Code 開啟這個專案」
//! （開啟見 `projects.rs`，前端見 `web/src/app/ai-app-presence.ts`）。
//!
//! 誤判成「沒有安裝」會把能用的功能藏起來，所以各種查法只要有一種找到就算有安裝。
//! Windows 查登錄檔與檔案關聯，Linux 問 xdg-mime；macOS 一律當成有安裝（沒有便宜又可靠的查法，
//! 系統遇到不認得的網址會自己提示）。

use serde::Serialize;

#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct AiApps {
    codex: bool,
    claude: bool,
}

/// Codex、Claude 桌面版有沒有安裝（在背景執行緒查）。
#[tauri::command]
pub async fn ai_apps_installed() -> AiApps {
    tauri::async_runtime::spawn_blocking(|| {
        imp::with_com(|| AiApps {
            codex: imp::handles("codex"),
            claude: imp::handles("claude"),
        })
    })
    .await
    // 查不了的時候寧可顯示（按下去頂多是系統說找不到程式）。
    .unwrap_or(AiApps {
        codex: true,
        claude: true,
    })
}

#[cfg(windows)]
mod imp {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_DISABLE_OLE1DDE, COINIT_MULTITHREADED,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CLASSES_ROOT, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_READ,
    };
    use windows_sys::Win32::UI::Shell::{
        AssocQueryStringW, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCF_IS_PROTOCOL, ASSOCF_NOTRUNCATE,
        ASSOCSTR, ASSOCSTR_APPID, ASSOCSTR_EXECUTABLE, ASSOCSTR_FRIENDLYAPPNAME,
    };

    /// Microsoft Store（MSIX 套件）的 App 在資訊清單宣告的網址（`windows.protocol`）安裝時登記在這裡
    /// （微軟沒有正式文件，是社群整理的位置；查不到時還有下面的檔案關聯）。
    /// `HKEY_CLASSES_ROOT\Local Settings` 對應到 `HKEY_CURRENT_USER\Software\Classes\Local Settings`，兩個都查。
    const PACKAGED: &str = r"Software\Microsoft\Windows\CurrentVersion\AppModel\PackageRepository\Extensions\windows.protocol";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// 登錄檔裡有這個機碼；`value` 不是 None 時，機碼裡還要有這個值。
    fn has_key(root: HKEY, path: &str, value: Option<&str>) -> bool {
        let path = wide(path);
        let mut key: HKEY = null_mut();
        // SAFETY: 參數都是以 0 結尾的 UTF-16 字串，key 由系統填入，用完關閉；只問值存不存在，不讀內容。
        unsafe {
            if RegOpenKeyExW(root, path.as_ptr(), 0, KEY_READ, &mut key) != ERROR_SUCCESS {
                return false;
            }
            let found = value.is_none_or(|v| {
                let v = wide(v);
                RegQueryValueExW(key, v.as_ptr(), null(), null_mut(), null_mut(), null_mut())
                    == ERROR_SUCCESS
            });
            RegCloseKey(key);
            found
        }
    }

    /// 用系統的檔案關聯查網址由哪個程式開啟（和開啟網址時的規則一樣，包含「預設應用程式」裡選的 App）。
    fn assoc(scheme: &str, what: ASSOCSTR) -> Option<String> {
        let scheme = wide(scheme);
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: scheme 以 0 結尾，buf 有 len 個字元；ASSOCF_NOTRUNCATE 讓太長時回傳錯誤而不截斷。
        let hr = unsafe {
            AssocQueryStringW(
                ASSOCF_IS_PROTOCOL | ASSOCF_INIT_IGNOREUNKNOWN | ASSOCF_NOTRUNCATE,
                what,
                scheme.as_ptr(),
                null(),
                buf.as_mut_ptr(),
                &mut len,
            )
        };
        if hr < 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let text = String::from_utf16_lossy(&buf[..end]);
        (!text.trim().is_empty()).then_some(text)
    }

    /// 「開啟方式」對話框（OpenWith.exe）：沒有程式能開時，檔案關聯可能回傳它，不算有安裝。
    fn is_open_with(text: &str) -> bool {
        text.to_ascii_lowercase().contains("openwith")
    }

    /// 系統有沒有登記開啟 `scheme://` 網址的程式。下面任何一種找到就算有：
    /// 1. 一般安裝程式登記的 `HKEY_CURRENT_USER\Software\Classes\<scheme>`、
    ///    `HKEY_LOCAL_MACHINE\Software\Classes\<scheme>`，而且有 `URL Protocol` 值；
    /// 2. Microsoft Store（MSIX）App 登記的 `…\AppModel\PackageRepository\Extensions\windows.protocol\<scheme>`；
    /// 3. `AssocQueryStringW`（`ASSOCF_IS_PROTOCOL`）查得到開啟的程式、App 識別碼或名稱。
    pub fn handles(scheme: &str) -> bool {
        let classic = format!(r"Software\Classes\{scheme}");
        if has_key(HKEY_CURRENT_USER, &classic, Some("URL Protocol"))
            || has_key(HKEY_LOCAL_MACHINE, &classic, Some("URL Protocol"))
        {
            return true;
        }
        if has_key(
            HKEY_CURRENT_USER,
            &format!(r"Software\Classes\Local Settings\{PACKAGED}\{scheme}"),
            None,
        ) || has_key(
            HKEY_CLASSES_ROOT,
            &format!(r"Local Settings\{PACKAGED}\{scheme}"),
            None,
        ) {
            return true;
        }
        match assoc(scheme, ASSOCSTR_EXECUTABLE) {
            Some(exe) => !is_open_with(&exe),
            // Store App 沒有執行檔指令，改查 App 識別碼（AppUserModelID）或名稱。
            None => [ASSOCSTR_APPID, ASSOCSTR_FRIENDLYAPPNAME]
                .into_iter()
                .filter_map(|what| assoc(scheme, what))
                .any(|text| !is_open_with(&text)),
        }
    }

    /// 在初始化好 COM 的執行緒上執行（Store App 的檔案關聯要用到 COM）。
    pub fn with_com<T>(f: impl FnOnce() -> T) -> T {
        // SAFETY: 成功（S_OK、S_FALSE）才配對呼叫 CoUninitialize；執行緒已經用別的模式初始化過
        // （RPC_E_CHANGED_MODE）時照用原本的，不呼叫 CoUninitialize。
        let hr = unsafe {
            CoInitializeEx(
                null(),
                (COINIT_MULTITHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        };
        let out = f();
        if hr >= 0 {
            // SAFETY: 和上面成功的 CoInitializeEx 配對。
            unsafe { CoUninitialize() };
        }
        out
    }
}

#[cfg(not(windows))]
mod imp {
    /// Linux 問 xdg-mime 有沒有設定開啟這種網址的程式；問不到（沒有 xdg-mime）以及其他系統一律當成有安裝。
    pub fn handles(scheme: &str) -> bool {
        #[cfg(target_os = "linux")]
        if let Ok(out) = std::process::Command::new("xdg-mime")
            .args(["query", "default", &format!("x-scheme-handler/{scheme}")])
            .output()
        {
            if out.status.success() {
                return !out.stdout.trim_ascii().is_empty();
            }
        }
        let _ = scheme;
        true
    }

    pub fn with_com<T>(f: impl FnOnce() -> T) -> T {
        f()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_both_flags() {
        let json = serde_json::to_value(AiApps {
            codex: true,
            claude: false,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "codex": true, "claude": false }));
    }
}
