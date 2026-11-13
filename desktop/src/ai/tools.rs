//! 偵測使用者安裝的 AI 命令列工具，並組出啟動它們的命令。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Claude,
    Codex,
}

impl Tool {
    pub fn exe(self) -> &'static str {
        match self {
            Tool::Claude => "claude",
            Tool::Codex => "codex",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Tool::Claude => "Claude Code",
            Tool::Codex => "Codex",
        }
    }

    pub fn locate(self) -> Result<PathBuf, String> {
        which::which(self.exe()).map_err(|_| {
            tr!(
                "找不到 {label}。請先安裝並登入，確認在命令提示字元輸入 {exe} 可以執行。",
                label = self.label(),
                exe = self.exe()
            )
        })
    }
}

/// 要執行的程式、前置參數與要另外設定的環境變數。
pub struct Program {
    pub prog: PathBuf,
    pub pre: Vec<OsString>,
    pub env: Vec<(&'static str, &'static str)>,
}

/// cmd.exe 找程式時預設先找目前資料夾。npm 產生的 .cmd 在全域資料夾沒有 node.exe 時會執行 `node …`，
/// 目前資料夾（開著的專案）裡如果放了 `node.cmd`、`node.exe`，就會執行到它。設了這個環境變數，
/// cmd.exe 只照 PATH 找（Windows 的 NeedCurrentDirectoryForExePath 規則）。
const NO_CWD_LOOKUP: (&str, &str) = ("NoDefaultCurrentDirectoryInExePath", "1");

/// 要執行的程式。npm 安裝的工具在 Windows 上是 .cmd 批次檔，必須透過 cmd.exe 執行，
/// 而且不能讓它在目前資料夾找程式（見 `NO_CWD_LOOKUP`）。
/// （使用者內容一律從標準輸入傳入，不放在命令列上，避免被 cmd.exe 解讀。）
pub fn program_for(exe: &Path) -> Program {
    let is_batch = exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if cfg!(windows) && is_batch {
        // 用完整路徑，免得執行到放在本程式旁邊的同名 cmd.exe。
        Program {
            prog: crate::io::system_root().join("System32").join("cmd.exe"),
            pre: vec!["/d".into(), "/c".into(), exe.into()],
            env: vec![NO_CWD_LOOKUP],
        }
    } else {
        Program {
            prog: exe.to_path_buf(),
            pre: vec![],
            env: vec![],
        }
    }
}

#[derive(Serialize)]
pub struct Available {
    claude: Option<String>,
    codex: Option<String>,
}

/// 目前能使用哪些工具（給介面決定要顯示哪些按鈕）。
/// 搜尋 PATH 可能很慢（例如 PATH 裡有斷線的網路磁碟），在背景執行緒進行。
#[tauri::command]
pub async fn ai_tools() -> Result<Available, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let find = |t: Tool| t.locate().ok().map(|p| p.to_string_lossy().into_owned());
        Available {
            claude: find(Tool::Claude),
            codex: find(Tool::Codex),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_files_run_through_cmd_on_windows_only() {
        let p = program_for(Path::new(r"C:\npm\claude.cmd"));
        if cfg!(windows) {
            assert!(
                p.prog.is_absolute() && p.prog.ends_with("System32/cmd.exe"),
                "{:?}",
                p.prog
            );
            assert_eq!(p.pre.len(), 3);
            // cmd.exe 不能在目前資料夾（開著的專案）找 node。
            assert_eq!(p.env, vec![("NoDefaultCurrentDirectoryInExePath", "1")]);
        } else {
            assert_eq!(p.prog, PathBuf::from(r"C:\npm\claude.cmd"));
            assert!(p.pre.is_empty());
            assert!(p.env.is_empty());
        }
        let p = program_for(Path::new("/usr/bin/claude"));
        assert_eq!(p.prog, PathBuf::from("/usr/bin/claude"));
        assert!(p.pre.is_empty());
        assert!(p.env.is_empty());
    }
}
