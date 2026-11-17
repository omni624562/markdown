//! 常駐在系統匣：關閉視窗時（設定「關閉視窗時縮到系統匣」，預設開啟）不結束程式，只把視窗藏起來，
//! 前端照設定的間隔在背景檢查工作項目與新版本，有消息就跳出系統通知。
//!
//! 系統匣的圖示：按一下打開視窗；右鍵選單有「開啟 oMarker」「立即檢查」「結束」。
//! 要真的結束程式：選單的「結束」，或在設定裡關掉這個選項後再關閉視窗。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};

/// 設定裡的「關閉視窗時縮到系統匣」（沒設定過時是開啟）。
pub fn close_to_tray(settings: Option<&serde_json::Value>) -> bool {
    settings
        .and_then(|v| v.get("closeToTray"))
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// 打開主視窗（從系統匣、通知回來時）。
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 建立系統匣的圖示與選單。
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", tr!("開啟 oMarker"), true, None::<&str>)?;
    let check = MenuItem::with_id(app, "tray-check", tr!("立即檢查"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", tr!("結束"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &check, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("oMarker")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_main(app),
            "tray-check" => {
                let _ = app.emit("tray-check", ());
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// 主視窗按關閉時：設定要常駐就只藏起視窗（第一次藏起來時說明程式還在背景執行）。
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let app = window.app_handle();
    if !close_to_tray(crate::settings::read_value(app).as_ref()) {
        return;
    }
    api.prevent_close();
    let _ = window.hide();
    // 視窗藏起來之前存下大小與位置（之後選「結束」時視窗已經藏著）。
    crate::window_state::save(app);
    if first_hide(app) {
        crate::notify::tray_hint(app);
    }
}

/// 這台電腦第一次縮到系統匣嗎（記在 App 的資料夾裡，之後不再說明）。
fn first_hide(app: &AppHandle) -> bool {
    let Ok(dir) = app.path().app_data_dir() else {
        return false;
    };
    let mark = dir.join("tray-hint-shown");
    if mark.exists() {
        return false;
    }
    let _ = std::fs::create_dir_all(&dir);
    std::fs::write(mark, b"1").is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closes_to_the_tray_unless_turned_off() {
        assert!(close_to_tray(None));
        assert!(close_to_tray(Some(&serde_json::json!({}))));
        assert!(close_to_tray(Some(
            &serde_json::json!({ "closeToTray": true })
        )));
        assert!(!close_to_tray(Some(
            &serde_json::json!({ "closeToTray": false })
        )));
    }
}
