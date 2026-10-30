//! 終端機用獨立的 webview 顯示，疊在主畫面留給終端機面板的位置上。
//!
//! 主畫面會顯示使用者開的文件、遠端的 issue 與 Wiki；萬一被注入程式碼，也不能碰終端機：
//! `term_*` 指令只接受終端機 webview 呼叫，終端機的輸出也只送給它。主畫面只能透過
//! `term_forward` 送幾種固定的要求（顯示、開新分頁、把文字貼到 AI 的輸入列等），
//! 不能直接寫入終端機，所以不能執行任何指令。

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl,
};

use super::term::Program;

/// 終端機 webview 的標籤（也是事件的對象）。
pub const LABEL: &str = "terminal";
const MAIN: &str = "main";
/// 終端機頁面還沒載入完成時，最多先排隊幾個事件。
const QUEUE_LIMIT: usize = 20_000;
/// 傳給 AI 輸入列的文字上限（字元）。
const PASTE_LIMIT: usize = 200_000;

#[derive(Default)]
pub struct TermView(Mutex<ViewState>);

struct ViewState {
    /// 終端機頁面已經載入，可以直接收事件。
    ready: bool,
    queue: Vec<(&'static str, serde_json::Value)>,
    zoom: f64,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            ready: false,
            queue: Vec::new(),
            zoom: 1.0,
        }
    }
}

/// 只有終端機 webview 可以呼叫。
pub fn require_terminal(webview: &Webview) -> Result<(), String> {
    if webview.label() == LABEL {
        Ok(())
    } else {
        Err(tr!("只有終端機面板可以使用這個功能"))
    }
}

fn require_main(webview: &Webview) -> Result<(), String> {
    if webview.label() == MAIN {
        Ok(())
    } else {
        Err(tr!("只有主視窗可以使用這個功能"))
    }
}

/// 送事件給終端機頁面；還沒載入完成時先排隊，載入後由 `term_ready` 一次取走。
pub fn send<S: Serialize + Clone>(app: &AppHandle, event: &'static str, payload: S) {
    let view = app.state::<TermView>();
    let mut state = view.0.lock().unwrap();
    if state.ready {
        drop(state);
        let _ = app.emit_to(LABEL, event, payload);
    } else if state.queue.len() < QUEUE_LIMIT {
        if let Ok(value) = serde_json::to_value(payload) {
            state.queue.push((event, value));
        }
    }
}

/// 請主畫面顯示終端機面板（例如 AI 執行的指令開了新的分頁）。
pub fn ask_main_to_show(app: &AppHandle) {
    let _ = app.emit_to(MAIN, "term-notice", Notice::Show);
}

/// 介面縮放：終端機和主畫面一起縮放。
pub fn set_zoom(app: &AppHandle, scale: f64) {
    app.state::<TermView>().0.lock().unwrap().zoom = scale;
    if let Some(v) = app.get_webview(LABEL) {
        let _ = v.set_zoom(scale);
    }
}

/// 主畫面送給終端機的要求。種類固定，不能直接寫入終端機。
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    /// 顯示面板；還沒有分頁時開一個殼層。
    Show,
    Start {
        program: Program,
    },
    /// 把文字貼到 Claude Code／Codex 的輸入列（括號貼上，不會自己送出）。
    #[serde(rename_all = "camelCase")]
    SendToAi {
        text: String,
        preferred: Program,
    },
    /// 開一個殼層執行 `claude setup-token`（GitHub Actions 的權杖）。
    SetupToken,
    /// 要顯示哪些 AI 工具的按鈕。
    Available {
        claude: bool,
        codex: bool,
    },
    /// 配色與字級跟著主畫面。
    #[serde(rename_all = "camelCase")]
    Style {
        theme: Option<String>,
        font_size: f64,
    },
    Focus,
}

impl Request {
    /// 檢查並整理內容：AI 輸入列只接受可以顯示的文字（去掉控制字元，括號貼上才不會被提早結束）。
    fn checked(self) -> Result<Self, String> {
        Ok(match self {
            Request::SendToAi { text, preferred } => {
                if matches!(preferred, Program::Shell) {
                    return Err(tr!("只能傳給 Claude Code 或 Codex"));
                }
                Request::SendToAi {
                    text: sanitize(&text),
                    preferred,
                }
            }
            Request::Style { theme, font_size } => Request::Style {
                theme: theme.filter(|t| t == "light" || t == "dark"),
                font_size: if font_size.is_finite() {
                    font_size.clamp(8.0, 40.0)
                } else {
                    15.0
                },
            },
            other => other,
        })
    }
}

/// 和前端的 `sanitizeForTerminal` 相同：統一換行，去掉其他控制字元（含 ESC），並限制長度。
fn sanitize(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || !(c.is_control()))
        .take(PASTE_LIMIT)
        .collect()
}

/// 終端機送給主畫面的通知。
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Notice {
    /// 請主畫面顯示面板。
    Show,
    /// 使用者在終端機按了隱藏，或關掉了最後一個分頁。
    Hide,
    /// 在終端機裡按了全域的快速鍵（指令面板、顯示／隱藏終端機）。
    Command { id: String },
    /// 讓終端機取得鍵盤焦點（由原生端處理，不轉給主畫面）。
    Focus,
}

/// 終端機面板在視窗中的位置（CSS 像素乘上介面縮放）。
#[derive(Deserialize, Debug, Clone, Copy)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Linux（GTK）的子 webview 只能上下排列，不能疊在主畫面上：主畫面不留位置，
/// 終端機排在主畫面下方，只照 `height` 設定高度。
pub const STACKED: bool = cfg!(target_os = "linux");

/// 主畫面告訴原生端終端機面板的位置；`None` 表示隱藏。第一次顯示時才建立終端機 webview。
/// 回傳是否是上下排列（見 `STACKED`）。
#[tauri::command]
pub async fn term_layout(
    app: AppHandle,
    webview: Webview,
    bounds: Option<Bounds>,
) -> Result<bool, String> {
    require_main(&webview)?;
    let existing = app.get_webview(LABEL);
    let Some(b) = bounds.filter(|b| {
        [b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite())
            && b.width > 0.0
            && b.height > 0.0
    }) else {
        if let Some(v) = existing {
            v.hide().map_err(|e| e.to_string())?;
            // 隱藏後鍵盤焦點回到主畫面。
            let _ = webview.set_focus();
        }
        return Ok(STACKED);
    };
    let position = LogicalPosition::new(b.x.max(0.0), b.y.max(0.0));
    let size = LogicalSize::new(b.width, b.height);
    let v = match existing {
        Some(v) => {
            if !STACKED {
                v.set_position(position).map_err(|e| e.to_string())?;
                v.set_size(size).map_err(|e| e.to_string())?;
            }
            v.show().map_err(|e| e.to_string())?;
            v
        }
        None => {
            let builder = WebviewBuilder::new(LABEL, WebviewUrl::App("terminal.html".into()))
                .on_navigation(crate::navigation::is_app_url)
                .on_new_window(|_, _| NewWindowResponse::Deny);
            let v = webview
                .window()
                .add_child(builder, position, size)
                .map_err(|e| tr!("無法建立終端機：{e}", e = e))?;
            let zoom = app.state::<TermView>().0.lock().unwrap().zoom;
            if zoom != 1.0 {
                let _ = v.set_zoom(zoom);
            }
            v
        }
    };
    #[cfg(target_os = "linux")]
    stack_below(&v, b.height);
    #[cfg(not(target_os = "linux"))]
    let _ = v;
    Ok(STACKED)
}

/// Linux：終端機排在主畫面下方，固定高度，主畫面佔滿其餘空間。
#[cfg(target_os = "linux")]
fn stack_below(v: &Webview, height: f64) {
    let _ = v.with_webview(move |pv| {
        use gtk::prelude::*;
        let w = pv.inner();
        w.set_vexpand(false);
        w.set_size_request(-1, height.round() as i32);
        if let Some(parent) = w.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) {
            parent.set_child_packing(&w, false, true, 0, gtk::PackType::Start);
        }
    });
}

/// 主畫面送要求給終端機。
#[tauri::command]
pub fn term_forward(app: AppHandle, webview: Webview, request: Request) -> Result<(), String> {
    require_main(&webview)?;
    send(&app, "term-request", request.checked()?);
    Ok(())
}

/// 終端機頁面載入完成：回傳排隊中的事件，之後的事件直接送。
#[tauri::command]
pub fn term_ready(
    webview: Webview,
    view: tauri::State<'_, TermView>,
) -> Result<Vec<(String, serde_json::Value)>, String> {
    require_terminal(&webview)?;
    let mut state = view.0.lock().unwrap();
    state.ready = true;
    Ok(std::mem::take(&mut state.queue)
        .into_iter()
        .map(|(e, v)| (e.to_string(), v))
        .collect())
}

/// 終端機送通知給主畫面。
#[tauri::command]
pub fn term_notify(app: AppHandle, webview: Webview, notice: Notice) -> Result<(), String> {
    require_terminal(&webview)?;
    match notice {
        Notice::Focus => webview.set_focus().map_err(|e| e.to_string()),
        Notice::Command { ref id } if id != "palette" && id != "toggle-terminal" => {
            Err(tr!("不支援這個指令"))
        }
        // 快速鍵交給主畫面處理（例如打開指令面板），鍵盤焦點也要跟著過去。
        Notice::Command { .. } => {
            if let Some(main) = app.get_webview(MAIN) {
                let _ = main.set_focus();
            }
            app.emit_to(MAIN, "term-notice", notice)
                .map_err(|e| e.to_string())
        }
        other => app
            .emit_to(MAIN, "term-notice", other)
            .map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_text_cannot_end_bracketed_paste() {
        assert_eq!(sanitize("a\r\nb\rc"), "a\nb\nc");
        assert_eq!(sanitize("x\x1b[201~\rrm -rf ~\r"), "x[201~\nrm -rf ~\n");
        assert_eq!(sanitize("中文\t縮排\u{9b}"), "中文\t縮排");
    }

    #[test]
    fn requests_are_checked() {
        let send = |text: &str, preferred| Request::SendToAi {
            text: text.into(),
            preferred,
        };
        assert!(send("x", Program::Shell).checked().is_err());
        assert_eq!(
            send("a\x1bb", Program::Claude).checked().unwrap(),
            send("ab", Program::Claude)
        );
        let style = Request::Style {
            theme: Some("<script>".into()),
            font_size: f64::NAN,
        }
        .checked()
        .unwrap();
        assert_eq!(
            style,
            Request::Style {
                theme: None,
                font_size: 15.0
            }
        );
    }

    #[test]
    fn requests_parse_from_the_frontend() {
        let r: Request =
            serde_json::from_str(r#"{"kind":"sendToAi","text":"hi","preferred":"codex"}"#).unwrap();
        assert_eq!(r, send_to_ai("hi", Program::Codex));
        // 主畫面不能送「寫入終端機」這種要求。
        assert!(
            serde_json::from_str::<Request>(r#"{"kind":"write","id":1,"data":"ls\r"}"#).is_err()
        );
    }

    fn send_to_ai(text: &str, preferred: Program) -> Request {
        Request::SendToAi {
            text: text.into(),
            preferred,
        }
    }
}
