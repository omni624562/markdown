//! 開機（登入 Windows）時自動啟動 oMarker（設定「開機時自動啟動」，預設關閉）。
//!
//! 寫在目前使用者的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（不需要系統管理員權限，
//! 「工作管理員 → 啟動應用程式」也看得到、可以停用）。自動啟動時帶 `--tray`：設定「關閉視窗時縮到系統匣」
//! 開著的話，啟動後直接縮在系統匣，在背景檢查工作項目，不跳出視窗打擾。
//! 免安裝的 exe 可能被搬走或更新換檔名：每次啟動時，開著這個設定就重新寫一次目前的路徑。

/// 自動啟動時帶的參數：啟動後縮在系統匣。
pub const TRAY_ARG: &str = "--tray";

/// 登錄檔裡的名稱。
#[cfg(windows)]
const VALUE: &str = "oMarker";

/// 這次是不是開機自動啟動的（命令列有 `--tray`）。
pub fn started_in_tray(args: impl IntoIterator<Item = std::ffi::OsString>) -> bool {
    args.into_iter().any(|a| a == TRAY_ARG)
}

/// 寫進登錄檔的指令：exe 的完整路徑（加引號，路徑有空白也可以）加上 `--tray`。
pub fn command_line(exe: &std::path::Path) -> String {
    format!("\"{}\" {TRAY_ARG}", exe.display())
}

/// 設定裡的「開機時自動啟動」。
pub fn wanted(settings: Option<&serde_json::Value>) -> bool {
    settings
        .and_then(|v| v.get("launchAtLogin"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn set(on: bool, command: &str) -> Result<(), String> {
        let path = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
        let name = wide(super::VALUE);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: 參數都是以 0 結尾的 UTF-16 字串，key 由系統填入，用完關閉。
        unsafe {
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            ) != 0
            {
                return Err(tr!("無法設定開機時自動啟動"));
            }
            let ok = if on {
                let value = wide(command);
                RegSetValueExW(
                    key,
                    name.as_ptr(),
                    0,
                    REG_SZ,
                    value.as_ptr().cast(),
                    (value.len() * 2) as u32,
                ) == 0
            } else {
                // 本來就沒有也算成功。
                let r = RegDeleteValueW(key, name.as_ptr());
                r == 0 || r == windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND
            };
            RegCloseKey(key);
            if ok {
                Ok(())
            } else {
                Err(tr!("無法設定開機時自動啟動"))
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// 其他平台目前不支援（oMarker 主要在 Windows 上使用）。
    pub fn set(_on: bool, _command: &str) -> Result<(), String> {
        Ok(())
    }
}

/// 打開或關閉開機時自動啟動（設定改了時由前端呼叫；啟動時也照設定重寫一次目前的路徑）。
#[tauri::command]
pub fn set_launch_at_login(on: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    imp::set(on, &command_line(&exe))
}

/// 啟動時：開著這個設定就重新寫一次目前 exe 的路徑（免安裝的 exe 可能被搬走、更新）。
pub fn refresh(settings: Option<&serde_json::Value>) {
    if wanted(settings) {
        let _ = set_launch_at_login(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_quoted_command_with_the_tray_flag() {
        let exe = std::path::Path::new("C:\\Users\\me\\工具\\oMarker.exe");
        assert_eq!(
            command_line(exe),
            "\"C:\\Users\\me\\工具\\oMarker.exe\" --tray"
        );
    }

    #[test]
    fn knows_when_it_was_started_at_login() {
        let args = |a: &[&str]| a.iter().map(std::ffi::OsString::from).collect::<Vec<_>>();
        assert!(started_in_tray(args(&["oMarker.exe", "--tray"])));
        assert!(!started_in_tray(args(&[
            "oMarker.exe",
            "C:\\Users\\me\\a.md"
        ])));
    }

    #[test]
    fn off_unless_turned_on() {
        assert!(!wanted(None));
        assert!(!wanted(Some(&serde_json::json!({}))));
        assert!(wanted(Some(&serde_json::json!({ "launchAtLogin": true }))));
    }
}
