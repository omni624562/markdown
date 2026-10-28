//! 系統通知：工作項目有新指派時，在 Windows 右下角跳出通知，點一下就回到 oMarker 打開那個工作項目。
//!
//! 免安裝的 exe 沒有在系統註冊過應用程式識別碼（AUMID），通知會不顯示：第一次通知前在
//! `HKCU\Software\Classes\AppUserModelId\<識別碼>` 寫入顯示名稱（不需要系統管理員權限）。

use serde::Deserialize;
use tauri::AppHandle;

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoticeItem {
    pub id: u64,
    pub title: String,
    pub kind: String,
}

/// 通知的標題與內文：一個工作項目時寫出類型、編號與標題，好幾個時列出前兩個的標題。
pub fn notice_text(items: &[NoticeItem]) -> Option<(String, String)> {
    let first = items.first()?;
    if items.len() == 1 {
        return Some((
            tr!("新指派給你：{kind} {id}", kind = first.kind, id = first.id),
            first.title.clone(),
        ));
    }
    let titles: Vec<&str> = items.iter().take(2).map(|w| w.title.as_str()).collect();
    let more = if items.len() > 2 { "…" } else { "" };
    Some((
        tr!("有 {n} 個工作項目新指派給你", n = items.len()),
        // 標題之間的分隔：中文用頓號，英文用逗號。
        format!("{}{more}", titles.join(&tr!("、"))),
    ))
}

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter, Manager};
    use tauri_winrt_notification::Toast;

    /// 在登錄檔註冊通知的顯示名稱；失敗時改用 PowerShell 的識別碼（通知仍會出現，只是來源顯示成 PowerShell）。
    fn app_id(app: &AppHandle) -> &'static str {
        static ID: OnceLock<String> = OnceLock::new();
        ID.get_or_init(|| {
            let id = app.config().identifier.clone();
            if register(&id, "oMarker") {
                id
            } else {
                Toast::POWERSHELL_APP_ID.to_string()
            }
        })
    }

    fn register(id: &str, name: &str) -> bool {
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
            REG_OPTION_NON_VOLATILE, REG_SZ,
        };
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let path = wide(&format!("Software\\Classes\\AppUserModelId\\{id}"));
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
                return false;
            }
            let value = wide(name);
            let field = wide("DisplayName");
            let ok = RegSetValueExW(
                key,
                field.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            ) == 0;
            RegCloseKey(key);
            ok
        }
    }

    pub fn show(app: &AppHandle, title: &str, body: &str, open: u64) -> Result<(), String> {
        let handle = app.clone();
        Toast::new(app_id(app))
            .title(title)
            .text1(body)
            .on_activated(move |_| {
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = handle.emit("notification-open", open);
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;

    /// 其他平台目前不顯示通知（oMarker 主要在 Windows 上使用）。
    pub fn show(_app: &AppHandle, _title: &str, _body: &str, _open: u64) -> Result<(), String> {
        Ok(())
    }
}

/// 顯示「新指派給你」的通知；點一下打開第一個工作項目（只有一個時）或工作項目清單（`0`）。
#[tauri::command]
pub async fn notify_work_items(app: AppHandle, items: Vec<NoticeItem>) -> Result<(), String> {
    let Some((title, body)) = notice_text(&items) else {
        return Ok(());
    };
    let open = if items.len() == 1 { items[0].id } else { 0 };
    crate::io::blocking(move || imp::show(&app, &title, &body, open)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: u64, title: &str) -> NoticeItem {
        NoticeItem {
            id,
            title: title.into(),
            kind: "Bug".into(),
        }
    }

    #[test]
    fn writes_notice_text() {
        assert_eq!(notice_text(&[]), None);
        assert_eq!(
            notice_text(&[item(7, "登入失敗")]),
            Some(("新指派給你：Bug 7".into(), "登入失敗".into()))
        );
        assert_eq!(
            notice_text(&[item(1, "甲"), item(2, "乙"), item(3, "丙")]),
            Some(("有 3 個工作項目新指派給你".into(), "甲、乙…".into()))
        );
    }
}
