//! 主視窗只能停留在 app 自己的頁面。
//!
//! 預覽中的連結由前端攔下、用系統瀏覽器開啟；但有些內容繞得過去，例如流程圖（mermaid）的
//! `click` 連結是 SVG 裡的 `<a xlink:href>`，點下去會讓整個視窗換成別的網站，
//! 那個網站就能冒充編輯器的介面。所以在原生端再擋一次：不是 app 自己的網址一律不載入，
//! 也不允許開新視窗（`window.open`、`target="_blank"`）。

use tauri::Url;

/// 用 Vite 開發伺服器時的網址（`cargo run --no-default-features`）。
const DEV_ORIGIN: &str = "http://localhost:5173";

/// 是不是 app 自己的頁面：正式版是 `tauri://localhost`（Linux、macOS）或
/// `http(s)://tauri.localhost`（Windows）；開發時另外允許 Vite 開發伺服器。
pub fn is_app_url(url: &Url) -> bool {
    let host = url.host_str();
    match url.scheme() {
        "tauri" => host == Some("localhost"),
        "http" | "https" if host == Some("tauri.localhost") => true,
        "http" if dev_server_allowed() => url.origin().ascii_serialization() == DEV_ORIGIN,
        _ => false,
    }
}

/// 開發版（沒有把前端打包進執行檔，或是除錯建置）才允許連到開發伺服器。
fn dev_server_allowed() -> bool {
    cfg!(debug_assertions) || !cfg!(feature = "custom-protocol")
}

/// `Origin` 標頭是不是 app 自己的頁面（給自訂協定決定要不要允許跨來源讀取）。
pub fn is_app_origin(origin: &str) -> bool {
    Url::parse(origin).is_ok_and(|u| is_app_url(&u))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str) -> bool {
        is_app_url(&Url::parse(url).unwrap())
    }

    #[test]
    fn only_the_app_itself_can_be_loaded() {
        assert!(allowed("tauri://localhost/"));
        assert!(allowed("tauri://localhost/index.html#x"));
        assert!(allowed("http://tauri.localhost/"));
        assert!(allowed("https://tauri.localhost/settings"));
        assert!(!allowed("https://attacker.example/"));
        assert!(!allowed("http://tauri.localhost.attacker.example/"));
        assert!(!allowed("tauri://attacker/"));
        assert!(!allowed("file:///C:/Users/me/.ssh/id_rsa"));
        assert!(!allowed("data:text/html,<script>alert(1)</script>"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed("mdimg://localhost/%2Fetc%2Fpasswd"));
        // 測試是除錯建置：開發伺服器允許，但只限那個連接埠。
        assert!(allowed("http://localhost:5173/"));
        assert!(!allowed("http://localhost:8080/"));
        assert!(!allowed("https://localhost:5173/"));
        assert!(is_app_origin("http://tauri.localhost"));
        assert!(!is_app_origin("null"));
        assert!(!is_app_origin("https://attacker.example"));
    }
}
