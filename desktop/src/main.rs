//! oMarker（Markdown 編輯器）桌面版。
//!
//! 介面直接沿用 `web/` 的網頁版（編譯時打包進執行檔），這裡只補上網頁做不到的事：
//! 原生的開檔／存檔對話框、資料夾工作區、檔案監看、全文搜尋、圖片存檔、設定檔讀寫，
//! 以及（預設關閉的）AI 協作：內嵌終端機、編輯器 MCP 伺服器、選取段落快捷動作。
//!
//! 安全考量：前端只能讀寫「使用者在對話框選過」「從命令列帶入」或
//! 「位於使用者開啟的資料夾內」的檔案，不提供任意路徑的檔案存取。

// 正式版不要跳出命令提示字元視窗。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[macro_use]
mod i18n;
mod ado;
mod ai;
mod dav;
mod doc_index;
mod files;
mod fonts;
mod git;
mod git_files;
mod git_flow;
mod git_log;
mod github;
mod history;
mod image_protocol;
mod images;
mod io;
mod locales;
mod navigation;
mod offline;
mod pdf;
mod projects;
mod secrets;
mod settings;
mod ssh;
mod trust;
mod update;
mod watch;
mod winhttp;
mod workspace;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow};

use files::{KnownFiles, OpenedFile};
use trust::Trust;
use watch::Watcher;
use workspace::{FolderInfo, Workspace};

/// 檔案被開啟或存檔後：允許預覽顯示同資料夾（含子資料夾）的圖片（`mdimg:` 協定），並監看外部修改。
pub fn track_file(app: &AppHandle, path: &Path) {
    if let Some(dir) = path.parent() {
        app.state::<image_protocol::ImageRoots>().allow(dir);
    }
    app.state::<Watcher>().watch_file(app, path);
}

/// 建立主視窗。視窗的設定寫在 tauri.conf.json（`create: false`，不自動建立），
/// 在這裡建立是為了加上導覽限制：只能停留在 app 自己的頁面，也不能開新視窗（見 `navigation`）。
fn create_main_window(app: &tauri::App) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .unwrap_or_default();
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(navigation::is_app_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
}

/// 啟動時從命令列帶入的檔案或資料夾。
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum StartupTarget {
    File(OpenedFile),
    Folder(FolderInfo),
}

/// 例如把 .md 檔或資料夾拖到 exe 上、或設定成預設開啟程式時，命令列會帶入路徑。
#[tauri::command]
async fn startup_target(app: AppHandle) -> Result<Option<StartupTarget>, String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let Some(path) = path_arg(std::env::args_os().skip(1), &cwd) else {
        return Ok(None);
    };
    resolve_target(&app, path).await.map(Some)
}

/// 命令列參數中的第一個路徑（略過 `-` 開頭的選項）。相對路徑以 `cwd` 為準。
fn path_arg(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Option<PathBuf> {
    let arg = args
        .into_iter()
        .find(|a| !a.is_empty() && !a.to_string_lossy().starts_with('-'))?;
    Some(cwd.join(arg))
}

/// 開啟命令列帶入的路徑：資料夾成為工作區，檔案則讀進來並加入允許清單。
async fn resolve_target(app: &AppHandle, path: PathBuf) -> Result<StartupTarget, String> {
    let p = path.clone();
    let (path, is_dir) = io::blocking(move || {
        let p = dunce::canonicalize(&p).unwrap_or(p);
        let is_dir = p.is_dir();
        Ok((p, is_dir))
    })
    .await?;
    if is_dir {
        return Ok(StartupTarget::Folder(workspace::open_folder_from_cli(
            app, path,
        )));
    }
    let opened = files::read_in_background(app, path.clone()).await?;
    app.state::<Trust>().add_file(app, &path);
    Ok(StartupTarget::File(opened))
}

/// 已經開著編輯器時再開一次 exe（例如在檔案總管雙擊另一個 .md）：
/// 不開新視窗，把路徑交給原本的視窗開成新分頁。
fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let Some(path) = path_arg(
        args.into_iter().skip(1).map(OsString::from),
        Path::new(&cwd),
    ) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = match resolve_target(&app, path).await {
            Ok(target) => app.emit("open-target", target),
            Err(message) => app.emit("open-target-failed", message),
        };
    });
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

/// 在預設瀏覽器（或郵件程式）開啟預覽中的外部連結。只接受 http、https、mailto。
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let lower = url.trim().to_ascii_lowercase();
    if !["http://", "https://", "mailto:"]
        .iter()
        .any(|p| lower.starts_with(p))
    {
        return Err(tr!("只能開啟網頁或電子郵件連結"));
    }
    app.opener()
        .open_url(url.trim(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

/// 介面大小：整個視窗一起縮放（和瀏覽器的縮放一樣，版面會依縮放後的寬度重新排）。
#[tauri::command]
fn set_ui_zoom(window: WebviewWindow, scale: f64) -> Result<(), String> {
    if !scale.is_finite() {
        return Err("invalid scale".into());
    }
    window
        .set_zoom(scale.clamp(0.5, 3.0))
        .map_err(|e| e.to_string())
}

/// Windows 不用系統的標題列，改由網頁的頂端列兼當標題列（拖曳、最小化、最大化、關閉）。
const CUSTOM_TITLE_BAR: bool = cfg!(windows);

#[tauri::command]
fn custom_title_bar() -> bool {
    CUSTOM_TITLE_BAR
}

#[tauri::command]
fn window_control(window: WebviewWindow, action: String) -> Result<bool, String> {
    let r = match action.as_str() {
        "minimize" => window.minimize(),
        "toggle-maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        // 在頂端列按住滑鼠拖曳視窗（和拖曳系統標題列一樣，可以拖到螢幕邊緣貼齊）。
        "drag" => window.start_dragging(),
        "state" => Ok(()),
        _ => return Err(tr!("未知的視窗動作：{action}", action = action)),
    };
    r.map_err(|e| e.to_string())?;
    // 回傳是否最大化，按鈕圖示跟著切換。
    window.is_maximized().map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // 必須最先註冊，第二個執行個體才會在建立視窗前就結束。
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            on_second_instance(app, args, cwd)
        }))
        // 只給 open_external 使用；沒有在 capabilities 開放給網頁直接呼叫。
        .plugin(tauri_plugin_opener::init())
        .manage(KnownFiles::default())
        .manage(Workspace::default())
        .manage(Watcher::default())
        .manage(ai::term::Terminals::default())
        .manage(ai::mcp::Mcp::default())
        .manage(ai::run::Runs::default())
        .manage(dav::Dav::default())
        .manage(pdf::PdfTarget::default())
        .manage(image_protocol::ImageRoots::default())
        .register_asynchronous_uri_scheme_protocol(
            image_protocol::SCHEME,
            |ctx, request, responder| {
                image_protocol::handle(ctx.app_handle().clone(), request, responder)
            },
        )
        .setup(|app| {
            app.manage(Trust::load(app.handle()));
            history::maintain(app.handle());
            create_main_window(app)?;
            if CUSTOM_TITLE_BAR {
                if let Some(window) = app.get_webview_window("main") {
                    // 拿掉標題列後仍保留視窗陰影與可拖曳調整大小的邊框。
                    window.set_decorations(false)?;
                    let _ = window.set_shadow(true);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_target,
            probe_path,
            open_external,
            set_title,
            set_ui_zoom,
            custom_title_bar,
            window_control,
            files::open_file,
            files::reopen_file,
            files::save_file,
            files::export_binary,
            files::import_docx,
            files::import_docx_data,
            files::export_docx,
            fonts::list_fonts,
            git_files::git_file_history,
            git_files::git_file_at,
            git_files::git_web_url,
            git_flow::git_branches,
            git_flow::git_checkout,
            git_flow::git_create_branch,
            git_flow::git_merge_start,
            git_flow::git_merge_conflicts,
            git_flow::git_merge_finish,
            git_flow::git_merge_abort,
            git_flow::git_create_pr,
            git_log::git_log,
            git_log::git_commit_detail,
            git_log::git_compare,
            git_log::git_worktree_changes,
            git_log::git_file_pair,
            git_log::git_abs_path,
            git_log::git_stats,
            git_log::git_branch_at,
            git_log::git_delete_branch,
            git_log::git_tag,
            git_log::git_delete_tag,
            git_log::git_merge_branch,
            git_log::git_revert,
            git_log::git_cherry_pick,
            git_log::git_reset,
            git_log::git_amend_message,
            git_log::git_undo,
            github::github_pages,
            github::github_gist,
            github::github_issues,
            github::github_issue,
            github::github_workspace_repo,
            ado::ado_account,
            ado::ado_connect,
            ado::ado_disconnect,
            ado::ado_repos,
            ado::ado_clone,
            ado::ado_work_items,
            ado::ado_work_item,
            ado::ado_image,
            ado::ado_work_item_filters,
            ado::ado_work_item_scope,
            ado::ado_wikis,
            ado::ado_wiki_pages,
            ado::ado_wiki_page,
            offline::offline_put,
            offline::offline_get,
            offline::offline_release,
            ado::ado_wiki_search,
            ado::ado_work_items_by_ids,
            ado::ado_queries,
            ado::ado_query_run,
            ado::ado_ping,
            ado::ado_check,
            ado::ado_repo_text,
            ado::ado_attachment_text,
            ado::ado_work_item_states,
            ado::ado_work_item_update,
            ado::ado_work_item_create,
            ado::ado_wiki_save,
            ado::ado_wiki_page_info,
            ado::ado_wiki_history,
            ado::ado_wiki_create,
            ado::ado_wiki_attach,
            ado::ado_wiki_image,
            pdf::pick_pdf_path,
            pdf::print_to_pdf,
            settings::load_settings,
            settings::save_settings,
            workspace::open_folder,
            workspace::reopen_folder,
            workspace::close_folder,
            workspace::current_folder,
            workspace::recent,
            i18n::set_language,
            projects::projects_list,
            projects::project_update,
            projects::project_forget,
            projects::project_relocate,
            projects::project_reveal,
            workspace::list_dir,
            workspace::list_files,
            workspace::create_entry,
            workspace::create_workflow,
            workspace::rename_entry,
            workspace::trash_entry,
            workspace::reveal_entry,
            workspace::search,
            workspace::replace_in_folder,
            doc_index::scan_docs,
            doc_index::read_docs,
            doc_index::link_updates,
            doc_index::update_doc,
            workspace::peek_text,
            images::save_image,
            history::history_list,
            dav::dav_connections,
            dav::dav_connect,
            dav::dav_reconnect,
            dav::dav_disconnect,
            dav::dav_forget,
            dav::dav_list,
            dav::dav_list_files,
            dav::dav_read,
            dav::dav_write,
            dav::dav_create,
            dav::dav_upload,
            dav::dav_download,
            dav::dav_rename,
            dav::dav_delete,
            dav::dav_save_image,
            dav::dav_image,
            dav::dav_peek,
            dav::dav_probe,
            ssh::ssh_connect,
            git::git_status,
            git::git_commit,
            git::git_pull,
            git::git_fetch,
            git::git_push,
            github::github_account,
            github::github_login_start,
            github::github_login_wait,
            github::github_login_cancel,
            github::github_logout,
            github::github_repos,
            github::github_clone,
            github::github_publish,
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
        .expect("無法啟動應用程式") // i18n-ignore：程式錯誤，不是介面文字
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // 關閉 app 時，終端機裡的程式（含 Claude Code、Codex）一併結束。
                app.state::<ai::term::Terminals>().kill_all();
                ai::mcp::mcp_stop(app.state());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_path_argument() {
        let cwd = Path::new("/home/me");
        let args = |a: &[&str]| a.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(path_arg(args(&[]), cwd), None);
        assert_eq!(path_arg(args(&["--flag", ""]), cwd), None);
        assert_eq!(
            path_arg(args(&["-x", "筆記.md"]), cwd),
            Some(PathBuf::from("/home/me/筆記.md"))
        );
        assert_eq!(
            path_arg(args(&["/abs/a.md"]), cwd),
            Some(PathBuf::from("/abs/a.md"))
        );
    }
}
