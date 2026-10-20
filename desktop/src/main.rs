//! Markdown 編輯器桌面版。
//!
//! 介面直接沿用 `web/` 的網頁版（編譯時打包進執行檔），這裡只補上網頁做不到的事：
//! 原生的開檔／存檔對話框、資料夾工作區、檔案監看、全文搜尋、圖片存檔、設定檔讀寫，
//! 以及（預設關閉的）AI 協作：內嵌終端機、編輯器 MCP 伺服器、選取段落快捷動作。
//!
//! 安全考量：前端只能讀寫「使用者在對話框選過」「從命令列帶入」或
//! 「位於使用者開啟的資料夾內」的檔案，不提供任意路徑的檔案存取。

// 正式版不要跳出命令提示字元視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod files;
mod git;
mod history;
mod images;
mod io;
mod settings;
mod trust;
mod update;
mod watch;
mod workspace;

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewWindow};

use files::{KnownFiles, OpenedFile};
use trust::Trust;
use watch::Watcher;
use workspace::{FolderInfo, Workspace};

/// 讓預覽可以顯示資料夾內的本機圖片（Tauri asset 協定）。
pub fn allow_assets_in(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

/// 檔案被開啟或存檔後：允許預覽顯示同資料夾的圖片，並監看外部修改。
pub fn track_file(app: &AppHandle, path: &Path) {
    if let Some(dir) = path.parent() {
        allow_assets_in(app, dir);
    }
    app.state::<Watcher>().watch_file(app, path);
}

/// 啟動時從命令列帶入的檔案或資料夾。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum StartupTarget {
    File(OpenedFile),
    Folder(FolderInfo),
}

/// 例如把 .md 檔或資料夾拖到 exe 上、或設定成預設開啟程式時，命令列會帶入路徑。
#[tauri::command]
async fn startup_target(
    app: AppHandle,
    trust: State<'_, Trust>,
) -> Result<Option<StartupTarget>, String> {
    let Some(arg) = std::env::args_os()
        .skip(1)
        .find(|a| !a.to_string_lossy().starts_with('-'))
    else {
        return Ok(None);
    };
    let path = PathBuf::from(arg);
    let p = path.clone();
    let (path, is_dir) = io::blocking(move || {
        let p = dunce::canonicalize(&p).unwrap_or(p);
        let is_dir = p.is_dir();
        Ok((p, is_dir))
    })
    .await?;
    if is_dir {
        return Ok(Some(StartupTarget::Folder(
            workspace::open_folder_from_cli(&app, path),
        )));
    }
    let opened = files::read_in_background(&app, path.clone()).await?;
    trust.add_file(&app, &path);
    Ok(Some(StartupTarget::File(opened)))
}

/// 檢查檔案所在的資料夾現在連得到嗎（網路磁碟斷線後，前端定時呼叫來偵測恢復）。
#[tauri::command]
async fn probe_path(path: String, known: State<'_, KnownFiles>) -> Result<bool, String> {
    let path = PathBuf::from(path);
    // 只回答已開啟過的檔案，避免變成任意路徑的探測工具。
    if !known.contains(&path) {
        return Ok(false);
    }
    let dir = path.parent().map(Path::to_path_buf).unwrap_or(path);
    Ok(
        io::blocking_for(std::time::Duration::from_secs(5), move || Ok(dir.is_dir()))
            .await
            .unwrap_or(false),
    )
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(KnownFiles::default())
        .manage(Workspace::default())
        .manage(Watcher::default())
        .manage(ai::term::Terminals::default())
        .manage(ai::mcp::Mcp::default())
        .manage(ai::run::Runs::default())
        .setup(|app| {
            app.manage(Trust::load(app.handle()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_target,
            probe_path,
            set_title,
            files::open_file,
            files::reopen_file,
            files::save_file,
            settings::load_settings,
            settings::save_settings,
            workspace::open_folder,
            workspace::reopen_folder,
            workspace::current_folder,
            workspace::recent,
            workspace::list_dir,
            workspace::list_files,
            workspace::create_entry,
            workspace::rename_entry,
            workspace::trash_entry,
            workspace::reveal_entry,
            workspace::search,
            images::save_image,
            history::history_list,
            git::git_status,
            git::git_commit,
            git::git_pull,
            git::git_push,
            history::history_read,
            ai::tools::ai_tools,
            ai::term::term_open,
            ai::term::term_write,
            ai::term::term_resize,
            ai::term::term_close,
            ai::mcp::mcp_start,
            ai::mcp::mcp_stop,
            ai::mcp::mcp_sync,
            ai::mcp::mcp_respond,
            ai::run::ai_run,
            ai::run::ai_cancel,
            update::app_version,
            update::update_check,
            update::update_install,
            update::update_restart,
        ])
        .build(tauri::generate_context!())
        .expect("無法啟動應用程式")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // 關閉 app 時，終端機裡的程式（含 Claude Code、Codex）一併結束。
                app.state::<ai::term::Terminals>().kill_all();
                ai::mcp::mcp_stop(app.state());
            }
        });
}
