//! 檔案操作一律在背景執行緒進行並設逾時：網路磁碟（NAS）斷線時，介面不會卡住。
//!
//! 和網路有關的錯誤訊息都以 [`offline`] 開頭，前端看到就顯示「網路磁碟無法連線」的提示，
//! 保留未存檔的內容，等連線恢復再存檔。

use std::io;
use std::path::Path;
use std::time::Duration;

/// 網路錯誤訊息的開頭（前端用它判斷；英文要和前端的翻譯一致）。
pub fn offline() -> String {
    tr!("網路磁碟無法連線")
}
const TIMEOUT: Duration = Duration::from_secs(20);

/// 在背景執行緒執行檔案操作；超過時間沒有回應就當成網路斷線。
/// （逾時後那個執行緒可能還卡著，但不影響介面，系統恢復後會自己結束。）
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    blocking_for(TIMEOUT, f).await
}

pub async fn blocking_for<T, F>(timeout: Duration, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tokio::time::timeout(timeout, tauri::async_runtime::spawn_blocking(f)).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(tr!(
            "{offline}：等了 {timeout} 秒沒有回應",
            offline = offline(),
            timeout = timeout.as_secs()
        )),
    }
}

/// 網路斷線、找不到網路路徑之類的錯誤。
pub fn is_network_error(e: &io::Error) -> bool {
    use io::ErrorKind::*;
    if matches!(
        e.kind(),
        TimedOut
            | NotConnected
            | ConnectionReset
            | ConnectionAborted
            | ConnectionRefused
            | HostUnreachable
            | NetworkUnreachable
            | NetworkDown
    ) {
        return true;
    }
    // Windows 的網路相關錯誤代碼：找不到網路路徑、共用名稱、網路忙碌、連線中斷、逾時等。
    cfg!(windows)
        && matches!(
            e.raw_os_error(),
            Some(51 | 53 | 54 | 55 | 59 | 64 | 67 | 121 | 1222 | 1231 | 1232 | 2250)
        )
}

/// 把 I/O 錯誤轉成給使用者看的訊息；網路錯誤加上固定的開頭。
pub fn describe(e: &io::Error, what: &str) -> String {
    if is_network_error(e) {
        tr!(
            "{offline}：{what}（{e}）",
            offline = offline(),
            what = what,
            e = e
        )
    } else {
        tr!("{what}：{e}", what = what, e = e)
    }
}

/// Windows 資料夾（`%SystemRoot%`，通常是 `C:\Windows`）。
///
/// 啟動 cmd.exe、explorer.exe 這類系統程式時一律用完整路徑：只寫檔名的話，Windows 會先找
/// 本程式所在的資料夾，免安裝版旁邊被放了同名的程式就會執行到它。
pub fn system_root() -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
}

/// 路徑是否在網路上：`\\NAS\共用` 這類 UNC 路徑，或 Windows 對應的網路磁碟機（例如 Z:）。
pub fn is_network_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    if s.starts_with(r"\\") && !s.starts_with(r"\\?\") && !s.starts_with(r"\\.\") {
        return true;
    }
    if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        return !unc.is_empty();
    }
    is_remote_drive(&s)
}

#[cfg(windows)]
fn is_remote_drive(path: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    const DRIVE_REMOTE: u32 = 4;

    let bytes = path.as_bytes();
    if bytes.len() < 2 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let root: Vec<u16> = std::ffi::OsStr::new(&format!("{}:\\", bytes[0] as char))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY：root 是以 0 結尾的 UTF-16 字串，呼叫期間一直有效。
    unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
}

#[cfg(not(windows))]
fn is_remote_drive(_path: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_unc_paths() {
        assert!(is_network_path(Path::new(r"\\nas\共用\筆記")));
        assert!(is_network_path(Path::new(r"\\?\UNC\nas\共用")));
        assert!(!is_network_path(Path::new(r"\\?\C:\筆記")));
        assert!(!is_network_path(Path::new("/home/user")));
    }

    #[test]
    fn classifies_network_errors() {
        assert!(is_network_error(&io::Error::from(io::ErrorKind::TimedOut)));
        assert!(!is_network_error(&io::Error::from(io::ErrorKind::NotFound)));
        let msg = describe(
            &io::Error::from(io::ErrorKind::TimedOut),
            "無法讀取「週報.md」",
        );
        assert!(msg.starts_with(&offline()), "{msg}");
        let msg = describe(
            &io::Error::from(io::ErrorKind::PermissionDenied),
            "無法讀取",
        );
        assert!(!msg.starts_with(&offline()));
    }

    #[tokio::test]
    async fn times_out_instead_of_hanging() {
        let r: Result<(), String> = blocking_for(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(500));
            Ok(())
        })
        .await;
        assert!(r.unwrap_err().starts_with(&offline()));
        assert_eq!(blocking(|| Ok::<_, String>(7)).await, Ok(7));
    }
}
