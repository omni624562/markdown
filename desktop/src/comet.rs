//! 新 COMET 專案：在背景用參數執行 `comet setup --assume-yes`（不必回答問題），輸出一行一行用
//! `comet-setup` 事件送給前端（新專案對話框裡的進度，見 web/src/app/comet-setup.ts）。
//!
//! 安全：
//! - 只在目前開啟的資料夾（剛建立的新專案）執行，同一時間只跑一個。
//! - 不經過殼層；參數一律用 `--名稱=值` 傳，值（例如專案名稱）不會被當成其他選項。
//!   Windows 上只直接執行 `.exe`：`.cmd`／`.bat` 要透過 cmd.exe，參數可能被解讀，這時請使用者改在終端機設定。
//! - oMarker 存的 Azure DevOps PAT 只在 Sprint 網址或集合網址就在 oMarker 連線的那一台底下時，
//!   才用環境變數 `COMET_PAT` 交給這一次執行的 comet（不寫到任何檔案）。

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::workspace::Workspace;

/// 正在執行 `comet setup`（同一時間只跑一個）。
#[derive(Default)]
pub struct CometRun(Mutex<bool>);

/// 前端送來的設定（和 web/src/desktop.ts 的 `CometSetupRequest` 一樣）。
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetupRequest {
    dir: String,
    #[serde(default)]
    sprint_url: Option<String>,
    #[serde(default)]
    collection_url: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    team: Option<String>,
    #[serde(default)]
    iteration_path: Option<String>,
    assigned_to: String,
    #[serde(default)]
    cadence_days: Option<u32>,
    connection_test: bool,
    local_tools: bool,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SetupEvent {
    Line {
        text: String,
    },
    Done {
        ok: bool,
        code: Option<i32>,
        error: Option<String>,
    },
}

/// 超過這麼久還沒結束就停掉（例如 comet 在等輸入）。
const TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// 一個欄位的值：去掉前後空白，不能是空的、太長或有控制字元。
fn clean(value: Option<&str>, what: &str) -> Result<String, String> {
    let v = value.unwrap_or("").trim();
    if v.is_empty() || v.chars().count() > 500 || v.chars().any(char::is_control) {
        return Err(tr!("COMET 設定的「{what}」不正確", what = what));
    }
    Ok(v.to_string())
}

fn is_http(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn clean_url(value: Option<&str>, what: &str) -> Result<String, String> {
    let url = clean(value, what)?;
    if !is_http(&url) || url.contains(char::is_whitespace) {
        return Err(tr!("COMET 設定的「{what}」不正確", what = what));
    }
    Ok(url)
}

/// `comet setup` 的參數（不含程式本身）。Sprint 網址與「集合網址＋專案＋團隊＋Sprint」二選一。
fn setup_args(req: &SetupRequest) -> Result<Vec<String>, String> {
    let mut args = vec![
        "setup".to_string(),
        "--assume-yes".to_string(),
        format!("--output-dir={}", req.dir),
    ];
    if req
        .sprint_url
        .as_deref()
        .is_some_and(|u| !u.trim().is_empty())
    {
        let url = clean_url(req.sprint_url.as_deref(), &tr!("Sprint 網址"))?;
        args.push(format!("--sprint-url={url}"));
    } else {
        let collection = clean_url(req.collection_url.as_deref(), &tr!("集合網址"))?;
        args.push(format!("--collection-url={collection}"));
        args.push(format!(
            "--project={}",
            clean(req.project.as_deref(), &tr!("專案"))?
        ));
        args.push(format!(
            "--team={}",
            clean(req.team.as_deref(), &tr!("團隊"))?
        ));
        args.push(format!(
            "--iteration-path={}",
            clean(req.iteration_path.as_deref(), "Sprint")?
        ));
    }
    args.push(format!(
        "--assigned-to={}",
        clean(Some(&req.assigned_to), &tr!("指派給"))?
    ));
    if let Some(days) = req.cadence_days {
        if !(1..=365).contains(&days) {
            return Err(tr!(
                "COMET 設定的「{what}」不正確",
                what = tr!("Sprint 天數")
            ));
        }
        args.push(format!("--sprint-cadence-days={days}"));
    }
    if !req.connection_test {
        args.push("--skip-connection-test".to_string());
    }
    if !req.local_tools {
        args.push("--skip-local-tools".to_string());
    }
    Ok(args)
}

/// `url` 是不是在 oMarker 連線的 Azure DevOps（`base`，集合或組織的網址）底下。
fn same_server(url: &str, base: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('/').to_ascii_lowercase();
    let (url, base) = (norm(url), norm(base));
    !base.is_empty() && (url == base || url.starts_with(&format!("{base}/")))
}

/// 要交給 comet 的 PAT：網址在 oMarker 連線的那一台底下才給。
fn pat_for(app: &AppHandle, req: &SetupRequest) -> Option<String> {
    let target = req
        .sprint_url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
        .or(req.collection_url.as_deref())?;
    let cred = crate::ado::cred(app)?;
    same_server(target, &cred.base)
        .then_some(cred.pat)
        .flatten()
}

/// 一行輸出：去掉控制碼（顏色等）；`\r` 覆寫的進度只留最後一段。
fn clean_line(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let text = text.trim_end_matches(['\r', '\n']);
    let last = text.rsplit('\r').next().unwrap_or(text);
    crate::ai::term::strip_ansi(last)
}

/// 把一個輸出串流一行一行送進 `tx`。
async fn pump<R: AsyncRead + Unpin>(stream: R, tx: tokio::sync::mpsc::UnboundedSender<String>) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if tx.send(clean_line(&buf)).is_err() {
                    break;
                }
            }
        }
    }
}

/// 在目前開啟的專案資料夾用參數執行 `comet setup`。呼叫本身在開始執行後就返回；輸出與結果用
/// `comet-setup` 事件送出。
#[tauri::command]
pub async fn comet_setup_run(
    app: AppHandle,
    req: SetupRequest,
    workspace: State<'_, Workspace>,
    run: State<'_, CometRun>,
) -> Result<(), String> {
    let root = workspace
        .root()
        .ok_or_else(|| tr!("只能在目前開啟的專案執行 COMET 設定"))?;
    if Path::new(&req.dir) != root {
        return Err(tr!("只能在目前開啟的專案執行 COMET 設定"));
    }
    let args = setup_args(&req)?;
    let (comet_home, home) = crate::new_project::comet_roots(&app);
    let exe = tauri::async_runtime::spawn_blocking(move || {
        crate::new_project::comet_program(comet_home, home)
    })
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| tr!("找不到 COMET CLI（comet 指令）"))?;
    let is_exe = exe
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if cfg!(windows) && !is_exe {
        return Err(tr!(
            "comet 不是 .exe 執行檔，無法在背景設定；請改在終端機執行 comet setup。"
        ));
    }
    let pat = pat_for(&app, &req);
    {
        let mut busy = run.0.lock();
        if *busy {
            return Err(tr!("COMET 設定正在執行，請等它完成"));
        }
        *busy = true;
    }
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.args(&args)
        .current_dir(&root)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(pat) = pat {
        cmd.env("COMET_PAT", pat);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不要閃出命令提示字元視窗
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            *run.0.lock() = false;
            return Err(tr!("無法執行 comet：{e}", e = e));
        }
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    if let Some(out) = child.stdout.take() {
        tauri::async_runtime::spawn(pump(out, tx.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tauri::async_runtime::spawn(pump(err, tx.clone()));
    }
    drop(tx);

    tauri::async_runtime::spawn(async move {
        let emit = |e: SetupEvent| {
            let _ = app.emit("comet-setup", e);
        };
        let deadline = tokio::time::sleep(TIMEOUT);
        tokio::pin!(deadline);
        let mut timed_out = false;
        loop {
            tokio::select! {
                line = rx.recv() => match line {
                    Some(text) => emit(SetupEvent::Line { text }),
                    None => break,
                },
                _ = &mut deadline => {
                    timed_out = true;
                    let _ = child.kill().await;
                    break;
                }
            }
        }
        let status = child.wait().await;
        let done = match (timed_out, status) {
            (true, _) => SetupEvent::Done {
                ok: false,
                code: None,
                error: Some(tr!("comet setup 超過 10 分鐘還沒結束，已經停止")),
            },
            (false, Ok(s)) => SetupEvent::Done {
                ok: s.success(),
                code: s.code(),
                error: None,
            },
            (false, Err(e)) => SetupEvent::Done {
                ok: false,
                code: None,
                error: Some(e.to_string()),
            },
        };
        emit(done);
        *app.state::<CometRun>().0.lock() = false;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ado_request() -> SetupRequest {
        SetupRequest {
            dir: r"C:\Users\me\Documents\產品交付".into(),
            collection_url: Some("https://ado.test/tfs/DefaultCollection".into()),
            project: Some("產品".into()),
            team: Some("Contoso".into()),
            iteration_path: Some(r"產品\Sprint 12".into()),
            assigned_to: r"CONTOSO\wang".into(),
            cadence_days: Some(14),
            connection_test: true,
            local_tools: true,
            ..Default::default()
        }
    }

    #[test]
    fn setup_args_from_the_lists() {
        assert_eq!(
            setup_args(&ado_request()).unwrap(),
            [
                "setup",
                "--assume-yes",
                r"--output-dir=C:\Users\me\Documents\產品交付",
                "--collection-url=https://ado.test/tfs/DefaultCollection",
                "--project=產品",
                "--team=Contoso",
                r"--iteration-path=產品\Sprint 12",
                r"--assigned-to=CONTOSO\wang",
                "--sprint-cadence-days=14",
            ]
        );
    }

    #[test]
    fn setup_args_from_a_sprint_url() {
        let req = SetupRequest {
            sprint_url: Some(
                " https://ado.test/tfs/DefaultCollection/產品/_sprints/taskboard/Contoso/產品/Sprint%2012 "
                    .into(),
            ),
            collection_url: None,
            connection_test: false,
            local_tools: false,
            cadence_days: None,
            ..ado_request()
        };
        assert_eq!(
            setup_args(&req).unwrap()[3..],
            [
                "--sprint-url=https://ado.test/tfs/DefaultCollection/產品/_sprints/taskboard/Contoso/產品/Sprint%2012",
                r"--assigned-to=CONTOSO\wang",
                "--skip-connection-test",
                "--skip-local-tools",
            ]
        );
    }

    #[test]
    fn values_stay_values() {
        // 以「--」開頭的值仍然是那個選項的值，不會變成另一個選項。
        let req = SetupRequest {
            project: Some("--force".into()),
            ..ado_request()
        };
        assert!(setup_args(&req)
            .unwrap()
            .contains(&"--project=--force".to_string()));
    }

    #[test]
    fn rejects_bad_values() {
        let bad = [
            SetupRequest {
                assigned_to: "  ".into(),
                ..ado_request()
            },
            SetupRequest {
                team: Some("Contoso\nrm".into()),
                ..ado_request()
            },
            SetupRequest {
                project: None,
                ..ado_request()
            },
            SetupRequest {
                collection_url: Some("file:///C:/Windows".into()),
                ..ado_request()
            },
            SetupRequest {
                sprint_url: Some("https://ado.test/a b".into()),
                ..ado_request()
            },
            SetupRequest {
                cadence_days: Some(0),
                ..ado_request()
            },
        ];
        for req in bad {
            assert!(setup_args(&req).is_err(), "{req:?}");
        }
    }

    #[test]
    fn pat_only_for_the_connected_server() {
        let base = "https://ado.test/tfs/DefaultCollection/";
        assert!(same_server("https://ado.test/tfs/DefaultCollection", base));
        assert!(same_server(
            "https://ADO.test/tfs/DefaultCollection/產品/_sprints/taskboard/Contoso",
            base
        ));
        assert!(!same_server(
            "https://ado.test/tfs/DefaultCollectionX",
            base
        ));
        assert!(!same_server(
            "https://evil.test/tfs/DefaultCollection",
            base
        ));
        assert!(!same_server("https://ado.test/tfs/DefaultCollection", ""));
    }

    #[test]
    fn output_lines_are_cleaned() {
        assert_eq!(clean_line(b"\x1b[32m[DONE]\x1b[0m ok\r\n"), "[DONE] ok");
        assert_eq!(clean_line(b"10%\r50%\r100%\n"), "100%");
        assert_eq!(
            clean_line("建立專案設定...\n".as_bytes()),
            "建立專案設定..."
        );
    }
}
