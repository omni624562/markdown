//! 桌面版的助理程式（desktop/src/assistant.rs，直接拿來編譯）用到的幾個模組，換成 Android 版的做法：
//! 金鑰存在 App 自己的私有資料夾、設定由前端交過來、沒有專案資料夾（不分專案）。
//! 名稱和桌面版一樣（`crate::secrets` 等），助理的程式不用改。

use std::path::PathBuf;
use std::sync::OnceLock;

/// App 的私有資料夾（其他 App 讀不到）；啟動時設定。
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_data_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = DATA_DIR.set(dir);
}

fn data_file(name: &str) -> Option<PathBuf> {
    DATA_DIR.get().map(|d| d.join(name))
}

/// API 金鑰：存在 App 的私有資料夾（Android 的沙箱，其他 App 與網頁畫面都讀不到）。
pub mod secrets {
    use super::data_file;

    fn file(service: &str, id: &str) -> Option<std::path::PathBuf> {
        // 名稱只用英數字（服務名稱裡有空白）。
        let safe: String = format!("{service}-{id}")
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        data_file(&format!("secret-{safe}"))
    }

    pub fn get(service: &str, id: &str) -> Option<String> {
        let s = std::fs::read_to_string(file(service, id)?).ok()?;
        let s = s.trim().to_string();
        (!s.is_empty()).then_some(s)
    }

    pub fn set(service: &str, id: &str, secret: &str) -> bool {
        file(service, id).is_some_and(|p| super::files::write_atomic(&p, secret.as_bytes()).is_ok())
    }

    pub fn forget(service: &str, id: &str) {
        if let Some(p) = file(service, id) {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 設定：前端（存在網頁的儲存空間）每次改設定時交一份過來（`save_settings`），助理送出前看開關與每月上限。
pub mod settings {
    use super::data_file;

    pub fn read_value<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Option<serde_json::Value> {
        let text = std::fs::read_to_string(data_file("settings.json")?).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(json: &str) -> Result<(), String> {
        serde_json::from_str::<serde_json::Value>(json).map_err(|e| e.to_string())?;
        let path = data_file("settings.json").ok_or("沒有資料夾可以存設定")?;
        super::files::write_atomic(&path, json.as_bytes()).map_err(|e| e.to_string())
    }
}

/// 沒有專案資料夾。
pub mod workspace {
    pub struct Workspace;

    impl Workspace {
        pub fn root(&self) -> Option<std::path::PathBuf> {
            None
        }
    }
}

pub mod git {
    pub fn origin_at(_root: &std::path::Path) -> Option<String> {
        None
    }
}

pub mod files {
    use std::path::Path;

    pub fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// 先寫到暫存檔再改名，寫到一半當掉也不會留下壞掉的檔案。
    pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, path)
    }
}

/// 連到 Claude API 用的 HTTP 用戶端。憑證用內建的根憑證（Android 上沒有桌面版用的系統驗證方式）。
pub mod update {
    use std::sync::LazyLock;
    use std::time::Duration;

    static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .timeout_recv_body(Some(Duration::from_secs(30 * 60)))
            .user_agent(concat!("md-editor-android/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent()
    });

    pub(crate) fn agent() -> ureq::Agent {
        AGENT.clone()
    }
}
