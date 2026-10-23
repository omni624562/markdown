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

/// 要執行的程式與前置參數。npm 安裝的工具在 Windows 上是 .cmd 批次檔，必須透過 cmd.exe 執行。
/// （使用者內容一律從標準輸入傳入，不放在命令列上，避免被 cmd.exe 解讀。）
pub fn program_for(exe: &Path) -> (PathBuf, Vec<OsString>) {
    let is_batch = exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if cfg!(windows) && is_batch {
        // 用完整路徑，免得執行到放在本程式旁邊的同名 cmd.exe。
        (
            crate::io::system_root().join("System32").join("cmd.exe"),
            vec!["/d".into(), "/c".into(), exe.into()],
        )
    } else {
        (exe.to_path_buf(), vec![])
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
        let (prog, pre) = program_for(Path::new(r"C:\npm\claude.cmd"));
        if cfg!(windows) {
            assert!(
                prog.is_absolute() && prog.ends_with("System32/cmd.exe"),
                "{prog:?}"
            );
            assert_eq!(pre.len(), 3);
        } else {
            assert_eq!(prog, PathBuf::from(r"C:\npm\claude.cmd"));
            assert!(pre.is_empty());
        }
        let (prog, pre) = program_for(Path::new("/usr/bin/claude"));
        assert_eq!(prog, PathBuf::from("/usr/bin/claude"));
        assert!(pre.is_empty());
    }
}
