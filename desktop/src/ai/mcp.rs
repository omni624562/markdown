//! 編輯器的 MCP 伺服器：讓 Claude Code、Codex 知道使用者正在看哪份文件、選了哪一段，
//! 並能「提出」修改。修改不會直接寫入檔案，而是在編輯器中以差異檢視呈現，由使用者決定。
//! AI 也能要求在編輯器的終端機執行指令；每次都要使用者同意，執行過程顯示在終端機分頁。
//!
//! 只綁定 127.0.0.1，每個請求都要帶 `Authorization: Bearer <權杖>`。
//! 權杖存在 app 設定資料夾，優先使用固定的連接埠，這樣手動註冊過的設定下次啟動仍然有效。
//!
//! 工具的說明與回傳結果是給 AI 看的，維持中文（標 `i18n-ignore`）；回給介面的錯誤才用 `tr!`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::extract::{Request, State as AxumState};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpService,
};
use rmcp::{schemars, tool, tool_handler, tool_router, ServerHandler};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use super::term::{strip_ansi, Terminals};
use crate::workspace::{is_doc, resolve_inside, Workspace};

/// Codex 從這個環境變數讀取權杖。
pub const TOKEN_ENV: &str = "MD_EDITOR_MCP_TOKEN";
const PREFERRED_PORT: u16 = 47321;
const SERVER_NAME: &str = "md-editor";
/// 等使用者決定的時間。有些用戶端（例如 Codex 預設 60 秒）會更早放棄，所以超過就先回覆「還在等」。
const DECISION_WAIT: Duration = Duration::from_secs(50);

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    text: String,
    from_line: u32,
    to_line: u32,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDoc {
    path: Option<String>,
    name: String,
    text: String,
    /// 內容和上次同步時相同：前端不再送全文（大文件每次移動游標都送一次很浪費），沿用上次的。
    #[serde(default)]
    same_text: bool,
    dirty: bool,
    selection: Option<Selection>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenDoc {
    path: Option<String>,
    name: String,
    dirty: bool,
}

/// 前端定時同步過來的編輯器狀態。
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    active: Option<ActiveDoc>,
    open: Vec<OpenDoc>,
}

pub struct Connection {
    pub url: String,
    pub token: String,
    pub config_path: PathBuf,
}

struct Running {
    conn: Connection,
    shutdown: oneshot::Sender<()>,
}

#[derive(Default)]
pub struct Mcp {
    snapshot: Arc<RwLock<Snapshot>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Decision>>>>,
    /// `pending` 裡哪些是要執行指令的要求：只能由終端機的 webview 回覆（見 `mcp_respond`）。
    commands: Arc<Mutex<std::collections::HashSet<u64>>>,
    next: Arc<AtomicU64>,
    running: Mutex<Option<Running>>,
}

impl Mcp {
    /// 伺服器在執行時，回傳連線資訊（給終端機啟動 Claude Code、Codex 時帶入）。
    pub fn connection(&self) -> Option<Connection> {
        self.running.lock().unwrap().as_ref().map(|r| Connection {
            url: r.conn.url.clone(),
            token: r.conn.token.clone(),
            config_path: r.conn.config_path.clone(),
        })
    }
}

/// AI 要求執行的指令（等使用者同意）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommandEvent {
    id: u64,
    command: String,
    reason: String,
    cwd: String,
}

/// 指令執行結果最多回傳的字元數。
const OUTPUT_CHARS: usize = 12_000;

/// 只留最後 `max` 個字元（AI 通常只需要結尾的錯誤訊息）。
fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let skip: String = text.chars().skip(count - max).collect();
    format!("…（前面省略 {} 個字元）\n{skip}", count - max) // i18n-ignore
}

/// 使用者對提議的決定（由前端回報）。
#[derive(Deserialize)]
pub struct Decision {
    ok: bool,
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProposalEvent {
    id: u64,
    path: Option<String>,
    /// `edits`：依原文取代；`selection`：取代目前選取範圍。
    kind: &'static str,
    edits: Vec<Edit>,
    replacement: String,
    summary: String,
}

#[derive(Deserialize, Serialize, Clone, schemars::JsonSchema)]
pub struct Edit {
    /// 要被取代的原文。必須和文件中的文字完全相同（包括空白與換行），而且只出現一次。
    old_text: String,
    /// 取代後的新文字。
    new_text: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ReadArgs {
    /// 文件的完整路徑（可以從 list_open_documents 取得，或是工作區資料夾內的 .md／.txt／.json 檔）。
    path: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ProposeArgs {
    /// 要修改的文件路徑；省略時是使用者目前正在看的文件。
    path: Option<String>,
    /// 一或多處修改，依原文比對位置。
    edits: Vec<Edit>,
    /// 用一句話向使用者說明這次修改的目的。
    summary: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ReplaceSelectionArgs {
    /// 用來取代使用者目前選取範圍的新文字。
    replacement: String,
    /// 用一句話向使用者說明這次修改的目的。
    summary: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct RunArgs {
    /// 要執行的指令。Windows 上用 PowerShell 執行，其他系統用預設的 shell；工作目錄是使用者開啟的資料夾。
    command: String,
    /// 用一句話說明為什麼要執行（會顯示給使用者，幫助他決定要不要同意）。
    reason: Option<String>,
    /// 最多等幾秒（預設 40，上限 300）。時間到了指令會繼續執行，之後可以用 read_terminal_output 查看。
    wait_seconds: Option<u64>,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct ReadTerminalArgs {
    /// 終端機編號（可以從 list_terminals 或 run_command 的結果取得）。
    id: u32,
    /// 最多回傳最後幾個字元（預設 12000）。
    max_chars: Option<usize>,
}

#[derive(Clone)]
struct EditorTools {
    app: AppHandle,
    snapshot: Arc<RwLock<Snapshot>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Decision>>>>,
    commands: Arc<Mutex<std::collections::HashSet<u64>>>,
    next: Arc<AtomicU64>,
}

fn describe(doc: &ActiveDoc) -> String {
    format!(
        "檔名：{}\n路徑：{}\n有未存檔的變更：{}", // i18n-ignore
        doc.name,
        doc.path.as_deref().unwrap_or("（尚未存檔）"), // i18n-ignore
        if doc.dirty { "是" } else { "否" }            // i18n-ignore
    )
}

#[tool_router]
impl EditorTools {
    #[tool(
        description = "取得使用者目前在 oMarker（Markdown 編輯器）中正在看的文件：檔名、路徑與編輯器中的完整內容（包含尚未存檔的變更）。" // i18n-ignore
    )]
    fn get_active_document(&self) -> Result<String, String> {
        let snap = self.snapshot.read().unwrap();
        let doc = snap.active.as_ref().ok_or("編輯器目前沒有開啟文件")?; // i18n-ignore
        Ok(format!("{}\n\n---\n{}", describe(doc), doc.text))
    }

    #[tool(description = "取得使用者目前在編輯器中選取的文字與所在行號。")] // i18n-ignore
    fn get_selection(&self) -> Result<String, String> {
        let snap = self.snapshot.read().unwrap();
        let doc = snap.active.as_ref().ok_or("編輯器目前沒有開啟文件")?; // i18n-ignore
        match &doc.selection {
            Some(sel) if !sel.text.is_empty() => Ok(format!(
                "文件：{}\n選取範圍：第 {} 行到第 {} 行\n\n---\n{}", // i18n-ignore
                doc.name, sel.from_line, sel.to_line, sel.text
            )),
            _ => Ok("使用者目前沒有選取任何文字。".into()), // i18n-ignore
        }
    }

    #[tool(description = "列出編輯器中所有已開啟的分頁（檔名、路徑、是否有未存檔的變更）。")] // i18n-ignore
    fn list_open_documents(&self) -> String {
        let snap = self.snapshot.read().unwrap();
        let active = snap.active.as_ref().and_then(|d| d.path.clone());
        let lines: Vec<String> = snap
            .open
            .iter()
            .map(|d| {
                format!(
                    "- {}{}{}：{}", // i18n-ignore
                    d.name,
                    if d.dirty { "（未存檔）" } else { "" }, // i18n-ignore
                    if d.path.is_some() && d.path == active {
                        "（目前分頁）" // i18n-ignore
                    } else {
                        ""
                    },
                    d.path.as_deref().unwrap_or("尚未存檔") // i18n-ignore
                )
            })
            .collect();
        if lines.is_empty() {
            "沒有已開啟的分頁。".into() // i18n-ignore
        } else {
            lines.join("\n")
        }
    }

    #[tool(
        description = "讀取一份文件的內容。可以讀取已開啟的分頁（會包含尚未存檔的變更），或使用者開啟的資料夾中的 .md／.txt／.json 檔。" // i18n-ignore
    )]
    fn read_document(&self, Parameters(args): Parameters<ReadArgs>) -> Result<String, String> {
        {
            let snap = self.snapshot.read().unwrap();
            if let Some(doc) = snap
                .active
                .as_ref()
                .filter(|d| d.path.as_deref() == Some(args.path.as_str()))
            {
                return Ok(doc.text.clone());
            }
        }
        let path = self.allowed_path(&args.path)?;
        let limit = crate::workspace::PEEK_LIMIT;
        let bytes = crate::files::read_capped(&path, limit)
            .map_err(|e| format!("無法讀取：{e}"))? // i18n-ignore
            .ok_or_else(|| format!("檔案超過 {} MB，無法讀取", limit / 1024 / 1024))?; // i18n-ignore
        if let Some(why) = crate::files::not_text_reason(&bytes) {
            return Err(format!("這個檔案{why}")); // i18n-ignore
        }
        Ok(crate::files::decode(&bytes).0)
    }

    #[tool(
        description = "向使用者提出修改一份文件。修改不會直接寫入：編輯器會逐段標示差異，由使用者決定接受或拒絕，結果會回覆給你。每一處修改用 old_text（必須與文件內容完全相同且只出現一次）與 new_text 表示。" // i18n-ignore
    )]
    async fn propose_edit(
        &self,
        Parameters(args): Parameters<ProposeArgs>,
    ) -> Result<String, String> {
        if args.edits.is_empty() {
            return Err("edits 不能是空的".into()); // i18n-ignore
        }
        let path = match args.path {
            Some(p) => Some(self.allowed_path(&p)?.to_string_lossy().into_owned()),
            None => None,
        };
        self.propose(ProposalEvent {
            id: 0,
            path,
            kind: "edits",
            edits: args.edits,
            replacement: String::new(),
            summary: args.summary.unwrap_or_default(),
        })
        .await
    }

    #[tool(
        description = "在使用者的編輯器內嵌終端機執行一個指令，並回傳結束代碼與輸出。每次執行前編輯器都會請使用者同意；使用者會在終端機分頁看到執行過程。適合跑 git、建置、轉檔等需要讓使用者看到的指令。" // i18n-ignore
    )]
    async fn run_command(&self, Parameters(args): Parameters<RunArgs>) -> Result<String, String> {
        let command = args.command.trim().to_string();
        if command.is_empty() {
            return Err("command 不能是空的".into()); // i18n-ignore
        }
        if !crate::settings::ai_terminal_enabled(&self.app) {
            // 回覆給 AI 的訊息（不是介面）。
            let msg =
                "使用者沒有開放讓 AI 在終端機執行指令（設定 → AI 協作 →「在終端機執行指令」）。"; // i18n-ignore
            return Err(msg.into());
        }
        let cwd = self
            .app
            .state::<Workspace>()
            .root()
            .or_else(|| self.app.path().home_dir().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let decision = self
            .ask(
                id,
                "ai-command",
                CommandEvent {
                    id,
                    command: command.clone(),
                    reason: args.reason.unwrap_or_default(),
                    cwd,
                },
            )
            .await?;
        if !decision.ok {
            return Err(decision.message);
        }
        let terms = self.app.state::<Terminals>();
        let term = terms.run_command(&self.app, &command)?;
        let wait = Duration::from_secs(args.wait_seconds.unwrap_or(40).clamp(1, 300));
        let started = tokio::time::Instant::now();
        loop {
            let log = terms.log(term).ok_or("終端機已被使用者關閉")?; // i18n-ignore
            if let Some(code) = log.exit {
                let code = code.map_or("未知".to_string(), |c| c.to_string()); // i18n-ignore
                return Ok(format!(
                    "終端機編號：{term}\n結束代碼：{code}\n\n輸出：\n{}", // i18n-ignore
                    tail(&strip_ansi(&log.text), OUTPUT_CHARS)
                ));
            }
            if started.elapsed() >= wait {
                return Ok(format!(
                    "終端機編號：{term}\n指令還在執行中（已等 {} 秒）。之後可以用 read_terminal_output 查看。\n\n目前的輸出：\n{}", // i18n-ignore
                    wait.as_secs(),
                    tail(&strip_ansi(&log.text), OUTPUT_CHARS)
                ));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    #[tool(description = "列出編輯器中的終端機分頁（編號、名稱、是否還在執行）。")] // i18n-ignore
    fn list_terminals(&self) -> String {
        let list = self.app.state::<Terminals>().list();
        if list.is_empty() {
            return "目前沒有開啟的終端機。".into(); // i18n-ignore
        }
        list.iter()
            .map(|(id, log)| {
                let state = match log.exit {
                    None => "執行中".to_string(),                   // i18n-ignore
                    Some(Some(c)) => format!("已結束（代碼 {c}）"), // i18n-ignore
                    Some(None) => "已結束".to_string(),             // i18n-ignore
                };
                format!("- {id}：{}｜{state}", log.label) // i18n-ignore
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tool(
        description = "讀取編輯器中某個終端機分頁最近的輸出（已去掉顏色等控制碼）。可以用來查看使用者在終端機看到的錯誤訊息，或 run_command 還沒跑完的指令。" // i18n-ignore
    )]
    fn read_terminal_output(
        &self,
        Parameters(args): Parameters<ReadTerminalArgs>,
    ) -> Result<String, String> {
        let log = self
            .app
            .state::<Terminals>()
            .log(args.id)
            .ok_or("沒有這個終端機（可能已被關閉），可以用 list_terminals 查看")?; // i18n-ignore
        let state = match log.exit {
            None => "執行中".to_string(),                   // i18n-ignore
            Some(Some(c)) => format!("已結束（代碼 {c}）"), // i18n-ignore
            Some(None) => "已結束".to_string(),             // i18n-ignore
        };
        Ok(format!(
            "{}｜{state}\n\n{}", // i18n-ignore
            log.label,
            tail(
                &strip_ansi(&log.text),
                args.max_chars.unwrap_or(OUTPUT_CHARS).max(100)
            )
        ))
    }

    #[tool(
        description = "向使用者提出用新文字取代目前的選取範圍。編輯器會標示差異，由使用者決定是否套用，結果會回覆給你。" // i18n-ignore
    )]
    async fn propose_replace_selection(
        &self,
        Parameters(args): Parameters<ReplaceSelectionArgs>,
    ) -> Result<String, String> {
        self.propose(ProposalEvent {
            id: 0,
            path: None,
            kind: "selection",
            edits: vec![],
            replacement: args.replacement,
            summary: args.summary.unwrap_or_default(),
        })
        .await
    }
}

impl EditorTools {
    /// 只允許已開啟的分頁，或工作區內的文件。
    ///
    /// 分頁清單是前端傳來的（`mcp_sync`），網頁端萬一被注入程式碼，可以把 `~/.ssh/id_rsa`
    /// 之類的路徑列成「已開啟的分頁」。所以分頁也要是原生端真的開過的檔案（`KnownFiles`）。
    fn allowed_path(&self, path: &str) -> Result<PathBuf, String> {
        let p = PathBuf::from(path);
        let open = self
            .snapshot
            .read()
            .unwrap()
            .open
            .iter()
            .any(|d| d.path.as_deref() == Some(path));
        if open && self.app.state::<crate::files::KnownFiles>().contains(&p) {
            return Ok(p);
        }
        let root = self
            .app
            .state::<Workspace>()
            .root()
            .ok_or("只能存取已開啟的分頁，或使用者開啟的資料夾中的文件")?; // i18n-ignore
        resolve_inside(&root, &p)?;
        if !is_doc(&p) {
            // i18n-ignore
            return Err("只能存取 Markdown、純文字、JSON、YAML、CSV、HTML、程式碼等文字檔".into());
        }
        Ok(p)
    }

    /// 請使用者同意執行指令。等太久就取消，避免使用者稍後按下同意時 AI 已經不在等結果。
    ///
    /// 同意的畫面在終端機的 webview（不顯示任何文件內容），回覆也只接受那裡送來的：
    /// 主畫面萬一被注入程式碼，也不能替使用者按下同意。
    async fn ask(
        &self,
        id: u64,
        event: &'static str,
        payload: CommandEvent,
    ) -> Result<Decision, String> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.commands.lock().unwrap().insert(id);
        super::view::send(&self.app, event, payload);
        super::view::ask_main_to_show(&self.app);
        let result = tokio::time::timeout(DECISION_WAIT, rx).await;
        self.commands.lock().unwrap().remove(&id);
        match result {
            Ok(Ok(d)) => Ok(d),
            Ok(Err(_)) => Err("編輯器已取消這個要求".into()), // i18n-ignore
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                super::view::send(&self.app, "ai-command-expired", id);
                Err(
                    "使用者沒有在時間內同意，指令沒有執行。需要的話可以請使用者準備好後再試一次。" // i18n-ignore
                        .into(),
                )
            }
        }
    }

    async fn propose(&self, mut event: ProposalEvent) -> Result<String, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        event.id = id;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.app
            .emit("ai-proposal", event)
            .map_err(|e| e.to_string())?;
        match tokio::time::timeout(DECISION_WAIT, rx).await {
            Ok(Ok(d)) if d.ok => Ok(d.message),
            Ok(Ok(d)) => Err(d.message),
            Ok(Err(_)) => Err("編輯器已關閉這個提議".into()), // i18n-ignore
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                // i18n-ignore
                Ok("修改已顯示在使用者的編輯器中，使用者還沒做出決定。不需要重複提出，使用者會自行接受或拒絕；之後可以用 get_active_document 確認結果。".into())
            }
        }
    }
}

#[tool_handler]
impl ServerHandler for EditorTools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION")))
            .with_instructions(
            "oMarker（Markdown 編輯器）：可以讀取使用者正在編輯的文件與選取範圍。要修改文件時請使用 propose_edit 或 propose_replace_selection，由使用者在編輯器中確認，不要直接寫入檔案。需要讓使用者看到執行過程的指令可以用 run_command（每次都會請使用者同意），用 read_terminal_output 讀取終端機的輸出。", // i18n-ignore
        )
    }
}

async fn require_token(
    AxumState(token): AxumState<Arc<str>>,
    req: Request,
    next: Next,
) -> Response {
    if !local_host(req.headers()) {
        return (StatusCode::FORBIDDEN, "只接受本機連線").into_response(); // i18n-ignore
    }
    let given = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if given.is_some_and(|t| constant_time_eq(t.as_bytes(), token.as_bytes())) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "需要正確的權杖").into_response() // i18n-ignore
    }
}

/// `Host` 必須是本機位址：網頁用 DNS rebinding 把自己的網域指到 127.0.0.1 時，
/// 送來的 `Host` 會是那個網域。
fn local_host(headers: &axum::http::HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let name = match host.rsplit_once(':') {
        Some((name, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => name,
        _ => host,
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "[::1]"
    )
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// 換一組新的權杖並存起來。
fn rotate_token(dir: &Path) -> Result<String, String> {
    let token = new_token()?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    crate::files::write_private(&dir.join("mcp-token"), token.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(token)
}

/// 讀取（或第一次時建立）權杖。存在 app 設定資料夾，不放在使用者的筆記資料夾裡。
fn load_token(dir: &Path) -> Result<String, String> {
    let path = dir.join("mcp-token");
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim();
        if t.len() >= 32 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            // 舊版建立的權杖檔可能是其他使用者也能讀的權限，順便收緊。
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            return Ok(t.to_string());
        }
    }
    // 權杖只有自己能讀（Unix 上權限 0600）。
    rotate_token(dir)
}

/// 回給前端的連線資訊。不含權杖：網頁端萬一被注入程式碼，也拿不到權杖。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    url: String,
}

fn info(conn: &Connection) -> McpInfo {
    McpInfo {
        url: conn.url.clone(),
    }
}

/// 手動註冊到 Claude Code／Codex 的指令（含權杖）。Codex 要先把權杖設成環境變數。
fn registration(conn: &Connection, tool: &str) -> Option<String> {
    match tool {
        "claude" => Some(format!(
            "claude mcp add --transport http {SERVER_NAME} {} --header \"Authorization: Bearer {}\"",
            conn.url, conn.token
        )),
        "codex" => Some(format!(
            "setx {TOKEN_ENV} {}\ncodex mcp add {SERVER_NAME} --url {} --bearer-token-env-var {TOKEN_ENV}",
            conn.token, conn.url
        )),
        _ => None,
    }
}

/// 把註冊指令放進剪貼簿（設定的「複製註冊指令」）。由原生端複製，權杖不經過網頁。
#[tauri::command]
pub async fn mcp_copy_registration(
    app: AppHandle,
    tool: String,
    mcp: State<'_, Mcp>,
) -> Result<(), String> {
    crate::settings::require_ai(&app)?;
    let text = {
        let running = mcp.running.lock().unwrap();
        let conn = &running
            .as_ref()
            .ok_or_else(|| tr!("請先開啟「讓 AI 讀取目前的文件」"))?
            .conn;
        registration(conn, &tool).ok_or_else(|| tr!("不支援這個工具"))?
    };
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text))
        .map_err(|e| tr!("無法複製到剪貼簿：{e}", e = e))
}

/// 啟動 MCP 伺服器（已在執行時直接回傳連線資訊）。
#[tauri::command]
pub async fn mcp_start(app: AppHandle, mcp: State<'_, Mcp>) -> Result<McpInfo, String> {
    crate::settings::require_ai(&app)?;
    if let Some(r) = mcp.running.lock().unwrap().as_ref() {
        return Ok(info(&r.conn));
    }
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut token = load_token(&config_dir)?;
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => {
            // 固定的連接埠被別的程式占用：照舊註冊的 AI 工具會把權杖送給那個程式，
            // 所以換一組新的權杖，舊的就算被拿走也沒有用（需要重新註冊）。
            token = rotate_token(&config_dir)?;
            tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| tr!("無法啟動 MCP 伺服器：{e}", e = e))?
        }
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let url = format!("http://127.0.0.1:{port}/mcp");

    // 給 `claude --mcp-config` 用的設定檔。
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let config_path = cache_dir.join("mcp.json");
    let config = serde_json::json!({
        "mcpServers": { SERVER_NAME: {
            "type": "http",
            "url": url,
            "headers": { "Authorization": format!("Bearer {token}") }
        }}
    });
    // 設定檔裡有權杖，同樣只有自己能讀。
    crate::files::write_private(&config_path, config.to_string().as_bytes())
        .map_err(|e| e.to_string())?;

    let tools = EditorTools {
        app: app.clone(),
        snapshot: mcp.snapshot.clone(),
        pending: mcp.pending.clone(),
        commands: mcp.commands.clone(),
        next: mcp.next.clone(),
    };
    let service: StreamableHttpService<EditorTools, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(tools.clone()),
            Default::default(),
            Default::default(),
        );
    let router = axum::Router::new().nest_service("/mcp", service).layer(
        axum::middleware::from_fn_with_state(Arc::<str>::from(token.as_str()), require_token),
    );
    let (shutdown, stop) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stop.await;
            })
            .await;
    });

    let conn = Connection {
        url,
        token,
        config_path,
    };
    let result = info(&conn);
    *mcp.running.lock().unwrap() = Some(Running { conn, shutdown });
    Ok(result)
}

#[tauri::command]
pub fn mcp_stop(mcp: State<'_, Mcp>) {
    if let Some(r) = mcp.running.lock().unwrap().take() {
        let _ = r.shutdown.send(());
        let _ = std::fs::remove_file(&r.conn.config_path);
    }
    // 還在等決定的提議一律取消。
    mcp.pending.lock().unwrap().clear();
}

/// 前端同步目前的文件、選取範圍與分頁清單。
/// 用非同步指令：內容可能很大，不要在主執行緒上解析。
#[tauri::command]
pub async fn mcp_sync(mut snapshot: Snapshot, mcp: State<'_, Mcp>) -> Result<(), String> {
    let mut current = mcp.snapshot.write().unwrap();
    if let (Some(new), Some(old)) = (snapshot.active.as_mut(), current.active.as_ref()) {
        if new.same_text && new.path == old.path && new.name == old.name {
            new.text = old.text.clone();
        }
    }
    *current = snapshot;
    Ok(())
}

/// 使用者對提議或指令的決定。回傳 false 表示 AI 已經不在等了（逾時或伺服器已停止）。
#[tauri::command]
pub fn mcp_respond(
    webview: tauri::Webview,
    id: u64,
    decision: Decision,
    mcp: State<'_, Mcp>,
) -> Result<bool, String> {
    // 執行指令的要求只能在終端機的 webview 同意。
    if mcp.commands.lock().unwrap().contains(&id) {
        super::view::require_terminal(&webview)?;
    }
    Ok(match mcp.pending.lock().unwrap().remove(&id) {
        Some(tx) => tx.send(decision).is_ok(),
        None => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_end_of_long_output() {
        assert_eq!(tail("短", 10), "短");
        let t = tail("一二三四五", 2);
        assert!(t.ends_with("\n四五"));
        assert!(t.contains("省略 3 個字元"));
    }

    #[test]
    fn only_accepts_local_host_header() {
        let with = |host: &str| {
            let mut h = axum::http::HeaderMap::new();
            h.insert(header::HOST, host.parse().unwrap());
            local_host(&h)
        };
        assert!(with("127.0.0.1:43821"));
        assert!(with("localhost:43821"));
        assert!(with("[::1]:43821"));
        assert!(!with("evil.example:43821"));
        assert!(!with("127.0.0.1.evil.example"));
        assert!(!local_host(&axum::http::HeaderMap::new()));
    }

    #[test]
    fn token_comparison() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    #[test]
    fn token_is_created_once_and_reused() {
        let dir = std::env::temp_dir().join(format!("md-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = load_token(&dir).unwrap();
        assert_eq!(a.len(), 64);
        assert_eq!(load_token(&dir).unwrap(), a);
        // 換新之後，下次讀到的是新的。
        let b = rotate_token(&dir).unwrap();
        assert_ne!(a, b);
        assert_eq!(load_token(&dir).unwrap(), b);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("mcp-token"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "權杖只有自己能讀");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
