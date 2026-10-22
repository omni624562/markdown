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
