//! 記住主視窗的大小、位置與是否最大化：關閉時存到設定資料夾的 `window.json`，下次開啟時照樣還原。
//! 第一次開啟（還沒有紀錄）照 tauri.conf.json 的設定：最大化。
//!
//! 存的是「一般大小」時的位置與大小（實體像素）；最大化時關閉，下次開啟一樣最大化，按「還原」回到上次的一般大小。
//! 上次的位置已經不在任何螢幕上（例如拔掉了外接螢幕）時不採用，改用預設的大小並置中。

use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Window, WindowEvent};

/// 視窗至少要有這麼大一塊（標題列那一帶）落在某個螢幕裡，才算看得到、拖得動。
const VISIBLE_W: i32 = 120;
const VISIBLE_H: i32 = 40;
/// 比這個還小的紀錄不採用（寫壞的檔案、最小化時量到的大小）。
const MIN_W: u32 = 320;
const MIN_H: u32 = 240;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// 螢幕的位置與大小（實體像素）。
#[derive(Clone, Copy, Debug)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl WindowState {
    /// 這個位置在目前接著的螢幕上看得到（視窗最上面那一條和某個螢幕重疊夠大）。
    pub fn fits(&self, screens: &[Screen]) -> bool {
        if self.width < MIN_W || self.height < MIN_H {
            return false;
        }
        let (left, top) = (i64::from(self.x), i64::from(self.y));
        let right = left + i64::from(self.width);
        let bottom = top + i64::from(VISIBLE_H);
        screens.iter().any(|s| {
            let (sl, st) = (i64::from(s.x), i64::from(s.y));
            let (sr, sb) = (sl + i64::from(s.width), st + i64::from(s.height));
            right.min(sr) - left.max(sl) >= i64::from(VISIBLE_W)
                && bottom.min(sb) - top.max(st) >= i64::from(VISIBLE_H)
        })
    }
}

/// 執行期間記著的最新狀態（視窗移動、調整大小時更新；關閉時寫進檔案）。
#[derive(Default)]
pub struct Remembered(Mutex<Option<WindowState>>);

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("window.json"))
}

/// 上次關閉時存的狀態；沒有紀錄或讀不了時是 `None`。
pub fn load(app: &AppHandle) -> Option<WindowState> {
    let text = fs::read_to_string(path(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

/// 把記著的狀態寫進檔案（視窗關閉、程式結束時）。
pub fn save(app: &AppHandle) {
    let Some(state) = *app.state::<Remembered>().0.lock() else {
        return;
    };
    let Some(path) = path(app) else { return };
    let Ok(json) = serde_json::to_string(&state) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = crate::files::write_atomic(&path, json.as_bytes());
}

/// 視窗剛建立（還沒顯示）時套用上次的狀態。回傳是否要最大化（顯示之前由呼叫的人處理）。
pub fn restore(window: &Window, state: WindowState) -> bool {
    let screens: Vec<Screen> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Screen {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        })
        .collect();
    if state.fits(&screens) {
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));
        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
        *window.state::<Remembered>().0.lock() = Some(state);
    }
    state.maximized
}

/// 視窗移動、調整大小時記下來；關閉時存檔。`fullscreen_was_maximized` 是進入全螢幕（簡報）之前是不是最大化。
pub fn track(window: &Window, event: &WindowEvent, fullscreen_was_maximized: bool) {
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            // 最小化時位置是螢幕外面的假座標，不記。
            if window.is_minimized().unwrap_or(false) {
                return;
            }
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            let maximized = if fullscreen {
                fullscreen_was_maximized
            } else {
                window.is_maximized().unwrap_or(false)
            };
            let remembered = window.state::<Remembered>();
            let mut slot = remembered.0.lock();
            if fullscreen || maximized {
                // 一般大小留著上次的，只記「最大化」。還沒有任何紀錄時先不記（還原後才知道一般大小）。
                if let Some(s) = slot.as_mut() {
                    s.maximized = maximized;
                } else {
                    // 還沒有一般大小可以記（第一次開啟就是最大化）：只存「最大化」，大小留 0，
                    // 下次開啟時不採用這個大小（`fits` 不通過），還原後是設定檔的預設大小。
                    *slot = Some(WindowState {
                        x: 0,
                        y: 0,
                        width: 0,
                        height: 0,
                        maximized,
                    });
                }
                return;
            }
            if let (Ok(p), Ok(sz)) = (window.outer_position(), window.inner_size()) {
                if sz.width >= MIN_W && sz.height >= MIN_H {
                    *slot = Some(WindowState {
                        x: p.x,
                        y: p.y,
                        width: sz.width,
                        height: sz.height,
                        maximized: false,
                    });
                }
            }
        }
        WindowEvent::CloseRequested { .. } => save(window.app_handle()),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Screen = Screen {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    /// 接在左邊的第二個螢幕（座標是負的）。
    const LEFT: Screen = Screen {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
    };

    fn at(x: i32, y: i32) -> WindowState {
        WindowState {
            x,
            y,
            width: 1280,
            height: 820,
            maximized: false,
        }
    }

    #[test]
    fn a_window_on_screen_fits() {
        assert!(at(100, 80).fits(&[MAIN]));
        // 大部分超出右邊，但還有夠寬的一段標題列在螢幕裡。
        assert!(at(1700, 80).fits(&[MAIN]));
        assert!(at(-1500, 200).fits(&[MAIN, LEFT]));
    }

    #[test]
    fn a_window_off_every_screen_does_not_fit() {
        // 上次在左邊的螢幕，現在只剩主螢幕。
        assert!(!at(-1500, 200).fits(&[MAIN]));
        // 只剩一點點在螢幕裡、標題列在螢幕上方或下方外面。
        assert!(!at(1850, 80).fits(&[MAIN]));
        assert!(!at(100, -60).fits(&[MAIN]));
        assert!(!at(100, 1070).fits(&[MAIN]));
        assert!(!at(100, 80).fits(&[]));
    }

    #[test]
    fn tiny_or_broken_sizes_do_not_fit() {
        let mut s = at(100, 80);
        s.width = 100;
        assert!(!s.fits(&[MAIN]));
        let mut s = at(100, 80);
        s.height = 0;
        assert!(!s.fits(&[MAIN]));
    }

    #[test]
    fn state_round_trips_through_json() {
        let s = WindowState {
            x: -40,
            y: 12,
            width: 1400,
            height: 900,
            maximized: true,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(serde_json::from_str::<WindowState>(&json).unwrap(), s);
        assert!(serde_json::from_str::<WindowState>("{\"x\":1}").is_err());
    }
}
