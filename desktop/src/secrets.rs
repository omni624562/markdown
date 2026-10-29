//! 密碼與權杖存在 Windows 認證管理員（WebDAV 密碼、GitHub 登入）。
//! 其他平台不保存，只在這次開啟期間記在記憶體裡（由呼叫端處理）。

fn ready() -> bool {
    use std::sync::OnceLock;
    static READY: OnceLock<bool> = OnceLock::new();
    *READY.get_or_init(|| {
        #[cfg(windows)]
        {
            match windows_native_keyring_store::Store::new() {
                Ok(store) => {
                    keyring_core::set_default_store(store);
                    true
                }
                Err(_) => false,
            }
        }
        #[cfg(not(windows))]
        {
            false
        }
    })
}

pub fn get(service: &str, id: &str) -> Option<String> {
    ready()
        .then(|| {
            keyring_core::Entry::new(service, id)
                .ok()?
                .get_password()
                .ok()
        })
        .flatten()
}

/// 存起來；這個平台不能保存時回傳 false。
pub fn set(service: &str, id: &str, secret: &str) -> bool {
    ready()
        && keyring_core::Entry::new(service, id)
            .and_then(|e| e.set_password(secret))
            .is_ok()
}

pub fn forget(service: &str, id: &str) {
    if ready() {
        if let Ok(e) = keyring_core::Entry::new(service, id) {
            let _ = e.delete_credential();
        }
    }
}

/// 記在記憶體裡的帳號資料（GitHub、Azure DevOps 的 `*-account.json`）：每個指令都會用到，
/// 不必每次讀檔、解析。登入、登出時由 `set` 更新。
pub struct CachedAccount<T>(std::sync::Mutex<Option<Option<T>>>);

impl<T: Clone + serde::de::DeserializeOwned> CachedAccount<T> {
    pub const fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    /// 帳號資料；第一次從 `path` 讀取（沒有檔案或格式不對時是 None）。
    pub fn get(&self, path: impl FnOnce() -> Option<std::path::PathBuf>) -> Option<T> {
        let mut cached = self.0.lock().unwrap();
        if cached.is_none() {
            let value = path()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|text| serde_json::from_str(&text).ok());
            *cached = Some(value);
        }
        cached.clone().flatten()
    }

    /// 存檔或刪掉帳號資料之後呼叫。
    pub fn set(&self, value: Option<T>) {
        *self.0.lock().unwrap() = Some(value);
    }
}
