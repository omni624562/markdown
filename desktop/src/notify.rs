//! 系統通知：工作項目有新指派或有更新、oMarker 有新版本時，在 Windows 右下角跳出通知，
//! 點一下就回到 oMarker（打開那個工作項目，或更新的說明）。
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
    /// 看過之後有更新（不是新指派的）。
    #[serde(default)]
    pub updated: bool,
}

/// 通知的標題與內文：一個工作項目時寫出類型、編號與標題，好幾個時列出前兩個的標題。
pub fn notice_text(items: &[NoticeItem]) -> Option<(String, String)> {
    let first = items.first()?;
    if items.len() == 1 {
        let title = if first.updated {
            tr!(
                "你的工作項目有更新：{kind} {id}",
                kind = first.kind,
                id = first.id
            )
        } else {
            tr!("新指派給你：{kind} {id}", kind = first.kind, id = first.id)
        };
        return Some((title, first.title.clone()));
    }
    let titles: Vec<&str> = items.iter().take(2).map(|w| w.title.as_str()).collect();
    let more = if items.len() > 2 { "…" } else { "" };
    let updated = items.iter().filter(|w| w.updated).count();
    let heading = if updated == 0 {
        tr!("有 {n} 個工作項目新指派給你", n = items.len())
    } else if updated == items.len() {
        tr!("你有 {n} 個工作項目有更新", n = items.len())
    } else {
        tr!("有 {n} 個工作項目是新指派或有更新", n = items.len())
    };
    Some((
        heading,
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

    pub fn show(
        app: &AppHandle,
        title: &str,
        body: &str,
        event: &'static str,
        payload: u64,
    ) -> Result<(), String> {
        let handle = app.clone();
        Toast::new(app_id(app))
            .title(title)
            .text1(body)
            .on_activated(move |_| {
                if let Some(w) = handle.get_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = handle.emit(event, payload);
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
    pub fn show(
        _app: &AppHandle,
        _title: &str,
        _body: &str,
        _event: &'static str,
        _payload: u64,
    ) -> Result<(), String> {
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
    crate::io::blocking(move || imp::show(&app, &title, &body, "notification-open", open)).await
}

/// Wiki 頁面通知的標題與內文：一頁時寫出頁名，好幾頁時列出前兩頁。
pub fn wiki_notice_text(pages: &[String]) -> Option<(String, String)> {
    let first = pages.first()?;
    if pages.len() == 1 {
        return Some((tr!("Wiki 頁面有更新"), first.clone()));
    }
    let names: Vec<&str> = pages.iter().take(2).map(String::as_str).collect();
    let more = if pages.len() > 2 { "…" } else { "" };
    Some((
        tr!("有 {n} 個 Wiki 頁面有更新", n = pages.len()),
        format!("{}{more}", names.join(&tr!("、"))),
    ))
}

/// 開著的 Wiki 分頁被別人改了：跳出通知，點一下回到 oMarker 打開那一頁（`notification-wiki`）。
#[tauri::command]
pub async fn notify_wiki_pages(app: AppHandle, pages: Vec<String>) -> Result<(), String> {
    let Some((title, body)) = wiki_notice_text(&pages) else {
        return Ok(());
    };
    crate::io::blocking(move || imp::show(&app, &title, &body, "notification-wiki", 0)).await
}

/// 有新版本時的通知；點一下回到 oMarker，看這一版改了什麼、更新。
#[tauri::command]
pub async fn notify_app_update(app: AppHandle, version: String) -> Result<(), String> {
    let title = tr!("oMarker {version} 可以更新了", version = version);
    let body = tr!("點一下看這一版改了什麼");
    crate::io::blocking(move || imp::show(&app, &title, &body, "notification-update", 0)).await
}

/// 縮到系統匣的說明（只在第一次縮下去時顯示）。
pub fn tray_hint(app: &AppHandle) {
    let title = tr!("oMarker 還在背景執行");
    let body = tr!(
        "會照設定的間隔檢查工作項目與新版本。要結束請在右下角的 oMarker 圖示按右鍵，選「結束」。"
    );
    let _ = imp::show(app, &title, &body, "notification-open", 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: u64, title: &str) -> NoticeItem {
        NoticeItem {
            id,
            title: title.into(),
            kind: "Bug".into(),
            updated: false,
        }
    }

    #[test]
    fn writes_wiki_notice_text() {
        assert_eq!(wiki_notice_text(&[]), None);
        assert_eq!(
            wiki_notice_text(&["安裝說明".into()]),
            Some(("Wiki 頁面有更新".into(), "安裝說明".into()))
        );
        assert_eq!(
            wiki_notice_text(&["甲".into(), "乙".into(), "丙".into()]),
            Some(("有 3 個 Wiki 頁面有更新".into(), "甲、乙…".into()))
        );
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
        let changed = NoticeItem {
            updated: true,
            ..item(8, "匯出報表")
        };
        assert_eq!(
            notice_text(std::slice::from_ref(&changed)),
            Some(("你的工作項目有更新：Bug 8".into(), "匯出報表".into()))
        );
        assert_eq!(
            notice_text(&[changed.clone(), item(9, "丁")]).map(|n| n.0),
            Some("有 2 個工作項目是新指派或有更新".into())
        );
        assert_eq!(
            notice_text(&[changed.clone(), changed]).map(|n| n.0),
            Some("你有 2 個工作項目有更新".into())
        );
    }
}
