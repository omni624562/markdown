//! 自動更新（免安裝版）。
//!
//! 每次 CI 建置都會把流水號編進執行檔（`MD_EDITOR_BUILD`），並在公開的 `latest` Release
//! 附上 `version.json`（流水號、SHA-256、下載網址）。這裡比對流水號，有新版時下載、
//! 核對 SHA-256，再用新檔取代正在執行的 exe（Windows 允許改名執行中的檔案），重新啟動後生效。
//!
//! `version.json` 另外有 Ed25519 簽章（`scripts/sign-update.mjs`，私鑰只在 GitHub Secrets），
//! 用內建的公鑰驗證。只有 SHA-256 時，能改 Release 檔案的人可以連檢查碼一起換掉；有簽章就做不到。
//!
//! 自己編譯的版本沒有流水號，不會檢查更新，避免把開發中的版本換掉。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const MANIFEST_URL: &str =
    "https://github.com/omni624562/markdown/releases/download/latest/version.json";
/// 只接受從這個網址開頭下載執行檔。
const DOWNLOAD_PREFIX: &str = "https://github.com/omni624562/markdown/releases/download/";
const MAX_SIZE: u64 = 200 * 1024 * 1024;
/// 驗證更新簽章的公鑰（Ed25519，base64）。對應的私鑰是 GitHub Actions secret `UPDATE_SIGNING_KEY`。
const UPDATE_PUBLIC_KEY: &str = "jrj/RFTEfLoSMPa3Bi+GMm6qhgOTyx7DbeGvNdsg08E=";

/// 這個執行檔的建置流水號（CI 建置時才有）。
fn build_number() -> Option<u64> {
    option_env!("MD_EDITOR_BUILD").and_then(|s| s.parse().ok())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersion {
    version: &'static str,
    build: Option<u64>,
    commit: Option<&'static str>,
    /// 建置日期（CI 建置時才有，例如 2026-10-22）。
    date: Option<&'static str>,
    /// 這個版本能不能自動更新（只有 CI 建置的 Windows 版可以）。
    updatable: bool,
}

pub fn current() -> AppVersion {
    let build = build_number();
    AppVersion {
        version: env!("CARGO_PKG_VERSION"),
        build,
        commit: option_env!("MD_EDITOR_COMMIT").map(|c| &c[..c.len().min(7)]),
        date: option_env!("MD_EDITOR_DATE"),
        updatable: cfg!(windows) && build.is_some(),
    }
}

#[tauri::command]
pub fn app_version() -> AppVersion {
    current()
}

/// `version.json` 的內容。
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    build: u64,
    version: String,
    #[serde(default)]
    commit: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    notes: String,
    /// CHANGELOG.md 中這一版的完整說明（Markdown），更新視窗列出改了什麼。只用來顯示，不在簽章範圍內。
    #[serde(default)]
    changes: String,
    url: String,
    sha256: String,
    size: u64,
    /// `signed_message` 的 Ed25519 簽章（base64）。
    #[serde(default)]
    signature: String,
}

impl Manifest {
    /// 簽章的內容；要和 `scripts/sign-update.mjs` 的 `signedMessage` 完全一致。
    fn signed_message(&self) -> String {
        format!(
            "md-editor-update/v1\n{}\n{}\n{}\n{}\n{}",
            self.build,
            self.version,
            self.url,
            self.sha256.to_ascii_lowercase(),
            self.size
        )
    }

    fn verify_signature(&self, public_key: &str) -> Result<(), String> {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let key = b64.decode(public_key).map_err(|e| e.to_string())?;
        let sig = b64
            .decode(self.signature.trim())
            .map_err(|_| tr!("更新資訊沒有正確的簽章，已取消更新"))?;
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
            .verify(self.signed_message().as_bytes(), &sig)
            .map_err(|_| tr!("更新資訊的簽章不符，可能被竄改，已取消更新"))
    }

    fn validate(&self) -> Result<(), String> {
        self.check_fields()?;
        self.verify_signature(UPDATE_PUBLIC_KEY)
    }

    fn check_fields(&self) -> Result<(), String> {
        if !self.url.starts_with(DOWNLOAD_PREFIX) {
            return Err(tr!("更新資訊中的下載網址不正確"));
        }
        if self.sha256.len() != 64 || !self.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(tr!("更新資訊中的檢查碼格式不正確"));
        }
        if self.size == 0 || self.size > MAX_SIZE {
            return Err(tr!("更新資訊中的檔案大小不正確"));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    current: AppVersion,
    /// 有比較新的版本時才有值。
    latest: Option<Manifest>,
}

/// 共用的 HTTP 連線（GitHub、Azure DevOps、更新）：連線可以重複使用，
/// 不必每次重新 TLS 交握、重新載入系統憑證。
static AGENT: std::sync::LazyLock<ureq::Agent> = std::sync::LazyLock::new(|| {
    ureq::Agent::config_builder()
        // 使用系統的憑證（公司網路常有自己的憑證）與系統的 Proxy 設定。
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .timeout_connect(Some(Duration::from_secs(15)))
        // 伺服器一直不回應時不要永遠等：等回應最多 60 秒，下載內容（例如新版程式）最多 30 分鐘。
        .timeout_recv_response(Some(Duration::from_secs(60)))
        .timeout_recv_body(Some(Duration::from_secs(30 * 60)))
        .user_agent(concat!("md-editor/", env!("CARGO_PKG_VERSION")))
        .build()
        .new_agent()
});

pub(crate) fn agent() -> ureq::Agent {
    AGENT.clone()
}

/// GET，自己處理轉址（GitHub 的下載會轉到另一個網域）。
/// ureq 自動轉址在部分 Proxy 環境下會讀錯回應，所以逐一處理，並只允許轉到 HTTPS。
fn get(
    url: &str,
    timeout: Option<Duration>,
) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
    let agent = agent();
    let mut url = url.to_string();
    for _ in 0..5 {
        let mut res = agent
            .get(&url)
            .config()
            .max_redirects(0)
            .timeout_global(timeout)
            .build()
            .call()?;
        if !res.status().is_redirection() {
            return Ok(res);
        }
        let next = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .filter(|l| l.starts_with("https://"))
            .map(str::to_string)
            .ok_or_else(|| ureq::Error::BadUri(tr!("轉址的網址不正確")))?;
        // 讀完轉址回應的內容，連線才能重複使用。
        let _ = res.body_mut().read_to_string();
        url = next;
    }
    Err(ureq::Error::TooManyRedirects)
}

/// 開始下載 `url`，回傳內容的讀取器。Windows 上 ureq 連不上（例如公司的 Proxy 用自動設定指令碼，
/// 或要用 Windows 帳號驗證）時，改用 WinHTTP 再試一次。
fn open(url: &str, timeout: Option<Duration>) -> Result<Box<dyn Read>, String> {
    match get(url, timeout) {
        Ok(res) => Ok(Box::new(res.into_body().into_reader())),
        // 檔案不存在不必換方式再試。
        Err(e @ ureq::Error::StatusCode(404)) => Err(e.to_string()),
        Err(e) => fallback(url, timeout, e),
    }
}

#[cfg(windows)]
fn fallback(
    url: &str,
    timeout: Option<Duration>,
    first: ureq::Error,
) -> Result<Box<dyn Read>, String> {
    // 下載執行檔時沒有整體的時間限制，WinHTTP 的逾時是每一次連線、讀取的等待時間。
    let wait = timeout.unwrap_or(Duration::from_secs(60));
    let agent = concat!("md-editor/", env!("CARGO_PKG_VERSION"));
    crate::winhttp::get(url, wait, agent)
        .map(|r| Box::new(r) as Box<dyn Read>)
        .map_err(|e| tr!("{e}（另一種連線方式的錯誤：{first}）", e = e, first = first))
}

#[cfg(not(windows))]
fn fallback(
    _url: &str,
    _timeout: Option<Duration>,
    first: ureq::Error,
) -> Result<Box<dyn Read>, String> {
    Err(first.to_string())
}

fn fetch_manifest() -> Result<Manifest, String> {
    let mut text = String::new();
    open(MANIFEST_URL, Some(Duration::from_secs(30)))
        .map_err(|e| tr!("無法連線到 GitHub：{e}", e = e))?
        .take(64 * 1024)
        .read_to_string(&mut text)
        .map_err(|e| tr!("無法讀取更新資訊：{e}", e = e))?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|e| tr!("更新資訊格式不正確：{e}", e = e))?;
    manifest.validate()?;
    Ok(manifest)
}

/// 檢查有沒有新版。
#[tauri::command]
pub async fn update_check() -> Result<CheckResult, String> {
    let current = current();
    if !current.updatable {
        return Ok(CheckResult {
            current,
            latest: None,
        });
    }
    let manifest = tauri::async_runtime::spawn_blocking(fetch_manifest)
        .await
        .map_err(|e| e.to_string())??;
    let newer = current.build.is_some_and(|b| manifest.build > b);
    Ok(CheckResult {
        current,
        latest: newer.then_some(manifest),
    })
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 下載到暫存檔，邊下載邊算 SHA-256；大小或檢查碼不符就刪掉暫存檔並回報錯誤。
fn download(m: &Manifest, dest: &PathBuf, mut progress: impl FnMut(u64)) -> Result<(), String> {
    let mut reader = open(&m.url, None)
        .map_err(|e| tr!("無法下載新版：{e}", e = e))?
        .take(MAX_SIZE);
    let mut file = std::fs::File::create(dest).map_err(|e| tr!("無法建立暫存檔：{e}", e = e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut downloaded = 0u64;
    let mut last_emit = 0u64;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| tr!("下載中斷：{e}", e = e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n])
            .map_err(|e| tr!("無法寫入暫存檔：{e}", e = e))?;
        downloaded += n as u64;
        if downloaded - last_emit >= 512 * 1024 {
            last_emit = downloaded;
            progress(downloaded);
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    if downloaded != m.size {
        return Err(tr!(
            "下載的檔案大小不符（{downloaded} / {expected} 位元組）",
            downloaded = downloaded,
            expected = m.size
        ));
    }
    if !hex(&hasher.finalize()).eq_ignore_ascii_case(&m.sha256) {
        return Err(tr!(
            "下載的檔案檢查碼不符，可能下載不完整或被竄改，已取消更新"
        ));
    }
    Ok(())
}

/// 下載新版並取代目前的執行檔。完成後需要重新啟動才會生效。
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let current = current();
    if !current.updatable {
        return Err(tr!("這個版本不支援自動更新"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = fetch_manifest()?;
        if !current.build.is_some_and(|b| manifest.build > b) {
            return Err(tr!("已經是最新版本"));
        }
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().ok_or_else(|| tr!("找不到執行檔所在的資料夾"))?;
        let tmp = dir.join(".md-editor.update.tmp");
        let no_permission = || {
            tr!("沒有權限更新「{dir}」裡的執行檔。請把 oMarker 的執行檔放到自己的資料夾（例如桌面或文件），或改為手動下載新版。", dir = dir.display())
        };
        // 先確認能在執行檔旁邊寫入，避免下載完才發現沒有權限。
        if let Err(e) = std::fs::File::create(&tmp) {
            return Err(if e.kind() == std::io::ErrorKind::PermissionDenied {
                no_permission()
            } else {
                tr!("無法建立暫存檔：{e}", e = e)
            });
        }
        let total = manifest.size;
        let report = |downloaded| {
            let _ = app.emit("update-progress", Progress { downloaded, total });
        };
        let result = download(&manifest, &tmp, report).and_then(|_| {
            self_replace::self_replace(&tmp).map_err(|e| {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    no_permission()
                } else {
                    tr!("無法取代執行檔：{e}", e = e)
                }
            })
        });
        let _ = std::fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 重新啟動以套用更新。
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            build: 45,
            version: "0.1.0".into(),
            commit: "abc1234".into(),
            date: "2026-10-20".into(),
            notes: String::new(),
            changes: String::new(),
            url: "https://github.com/omni624562/markdown/releases/download/latest/md-editor.exe"
                .into(),
            sha256: "a".repeat(64),
            size: 1234,
            signature: String::new(),
        }
    }

    #[test]
    fn accepts_a_valid_manifest() {
        assert!(manifest().check_fields().is_ok());
        let json = serde_json::to_string(&manifest()).unwrap();
        assert_eq!(serde_json::from_str::<Manifest>(&json).unwrap(), manifest());
    }

    #[test]
    fn rejects_foreign_urls_and_bad_checksums() {
        let mut m = manifest();
        m.url = "https://evil.example.com/omarker.exe".into();
        assert!(m.check_fields().is_err());
        let mut m = manifest();
        m.sha256 = "xyz".into();
        assert!(m.check_fields().is_err());
        let mut m = manifest();
        m.size = 0;
        assert!(m.check_fields().is_err());
    }

    /// 在本機開一個只回應一次的 HTTP 伺服器，回傳網址。
    fn serve_once(body: Vec<u8>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/omarker.exe", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut req = [0u8; 1024];
            let _ = stream.read(&mut req);
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        });
        url
    }

    #[test]
    fn download_verifies_size_and_checksum() {
        let body = vec![7u8; 700 * 1024];
        let good = Manifest {
            sha256: hex(&Sha256::digest(&body)),
            size: body.len() as u64,
            ..manifest()
        };
        let dir = std::env::temp_dir().join(format!("md-update-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("new.exe");

        let mut reported = vec![];
        let m = Manifest {
            url: serve_once(body.clone()),
            ..good.clone()
        };
        download(&m, &dest, |n| reported.push(n)).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        // 每下載 512 KB 左右回報一次（每次讀到的大小不固定）。
        assert_eq!(reported.len(), 1);
        assert!(reported[0] >= 512 * 1024 && reported[0] < body.len() as u64);

        let m = Manifest {
            url: serve_once(body.clone()),
            sha256: "0".repeat(64),
            ..good.clone()
        };
        assert!(download(&m, &dest, |_| {})
            .unwrap_err()
            .contains("檢查碼不符"));

        let m = Manifest {
            url: serve_once(body[..1000].to_vec()),
            ..good
        };
        assert!(download(&m, &dest, |_| {})
            .unwrap_err()
            .contains("大小不符"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 實際連到 GitHub（需要網路，預設不執行：`cargo test -- --ignored`）。
    #[test]
    #[ignore]
    fn downloads_from_github_release() {
        let mut res = get(
            "https://github.com/omni624562/markdown/releases/download/latest/md-editor.exe",
            None,
        )
        .unwrap();
        let mut head = [0u8; 2];
        res.body_mut().as_reader().read_exact(&mut head).unwrap();
        assert_eq!(&head, b"MZ", "Windows 執行檔開頭");
    }

    #[test]
    fn hex_encodes_digest() {
        assert_eq!(
            hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// 測試用的金鑰對（不是正式的金鑰）；簽章由 `scripts/sign-update.mjs` 產生。
    const TEST_PUBLIC_KEY: &str = "k/jJUUWf7oXHqNQDFWjbWsMjxZs8uadP4DACFnpFhCM=";
    const TEST_SIGNATURE: &str =
        "FPPn4B7cOrF1yqA2r+4aOkoLWiu9rF7bQAtDJUSoORlBt/H0gG/Ts92rK4Bhd+k3tKAGIWyeaT7nK9svdJCWBA==";

    fn signed() -> Manifest {
        Manifest {
            build: 123,
            version: "1.1.0".into(),
            sha256: "AB".repeat(32),
            size: 4096,
            signature: TEST_SIGNATURE.into(),
            ..manifest()
        }
    }

    #[test]
    fn verifies_update_signature() {
        assert_eq!(signed().verify_signature(TEST_PUBLIC_KEY), Ok(()));
        // 正式的公鑰不接受測試金鑰的簽章。
        assert!(signed().verify_signature(UPDATE_PUBLIC_KEY).is_err());
        assert!(signed().validate().is_err());
        // 改任何一個簽過的欄位都會失敗；沒有簽章也會失敗。
        for tamper in [
            |m: &mut Manifest| m.build += 1,
            |m: &mut Manifest| m.sha256 = "cd".repeat(32),
            |m: &mut Manifest| m.size += 1,
            |m: &mut Manifest| m.url.push('x'),
            |m: &mut Manifest| m.version = "9.9.9".into(),
            |m: &mut Manifest| m.signature.clear(),
        ] {
            let mut m = signed();
            tamper(&mut m);
            assert!(m.verify_signature(TEST_PUBLIC_KEY).is_err());
        }
        // 沒有簽到的說明文字可以改。
        let mut m = signed();
        m.notes = "其他說明".into();
        assert_eq!(m.verify_signature(TEST_PUBLIC_KEY), Ok(()));
    }
}
