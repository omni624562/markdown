//! 預覽顯示本機圖片用的 `mdimg:` 協定（取代 Tauri 內建的 asset 協定）。
//!
//! 內建的 asset 協定有兩個問題：允許的範圍是整個資料夾、而且不限檔案類型（開啟 `~/x.md`
//! 之後，網頁就能讀取整個家目錄，包括 `.ssh`）；它也會在檢查範圍「之前」先存取檔案，
//! 文件裡一張 `\\attacker\share\a.png` 的圖片就會讓 Windows 連到對方的 SMB 伺服器，
//! 洩漏使用者的 NTLM 雜湊。這裡的規則：
//!
//! - 只提供圖片（依副檔名），回應帶正確的 Content-Type，並限制大小；
//! - 只提供目前工作區、以及已開啟的檔案所在資料夾（含子資料夾）內的檔案；
//! - 先只用字串判斷路徑是否在允許的資料夾內，通過之後才碰檔案系統。
//!   UNC、`\\?\`、裝置路徑只有在允許的資料夾本身就在同一個位置時才會通過；
//! - 再解析符號連結，確認實際位置仍在允許的資料夾內。

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeResponder};

use crate::workspace::Workspace;

pub const SCHEME: &str = "mdimg";
/// 單張圖片最大多大。
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// 最多記住幾個已開啟檔案的資料夾（太多時忘掉最舊的）。
const MAX_ROOTS: usize = 200;

/// 已開啟的檔案所在的資料夾（預覽可以顯示裡面的圖片）。工作區資料夾每次直接查目前的工作區。
#[derive(Default)]
pub struct ImageRoots(Mutex<Vec<PathBuf>>);

impl ImageRoots {
    pub fn allow(&self, dir: &Path) {
        let mut roots = self.0.lock().unwrap();
        if roots.iter().any(|r| r == dir) {
            return;
        }
        if roots.len() >= MAX_ROOTS {
            roots.remove(0);
        }
        roots.push(dir.to_path_buf());
    }

    fn snapshot(&self) -> Vec<PathBuf> {
        self.0.lock().unwrap().clone()
    }
}

fn mime_type(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// Windows 保留的裝置名稱（`con.png` 在舊版 Windows 上指的是主控台，不是檔案）。
fn is_device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ');
    let stem = stem.to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || ((stem.starts_with("com") || stem.starts_with("lpt"))
        && stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit())
}

/// 只用字串判斷 `path` 是否在 `root` 之內（不碰檔案系統）。
/// `windows` 時不分大小寫，`/` 和 `\` 視為相同。
fn lexically_inside(path: &str, root: &str, windows: bool) -> bool {
    let sep = if windows { '\\' } else { '/' };
    let norm = |s: &str| {
        let mut s = if windows {
            s.replace('/', "\\").to_lowercase()
        } else {
            s.to_string()
        };
        while s.chars().count() > 1 && s.ends_with(sep) && !s.ends_with(":\\") {
            s.pop();
        }
        s
    };
    let (p, r) = (norm(path), norm(root));
    !r.is_empty()
        && p.len() > r.len()
        && p.starts_with(&r)
        && (r.ends_with(sep) || p[r.len()..].starts_with(sep))
}

/// 拒絕的原因（對應 HTTP 狀態碼）。
#[derive(Debug, PartialEq)]
enum Reject {
    Forbidden,
    NotFound,
    TooLarge,
    Offline,
}

/// 碰檔案系統之前的檢查：只能是圖片、路徑寫法沒有可疑的地方、而且（只看字串）位於某個允許的資料夾內。
/// 通過時回傳 MIME 類型與包含它的資料夾。
fn precheck<'a>(
    path: &str,
    roots: &'a [PathBuf],
    windows: bool,
) -> Result<(&'static str, Vec<&'a PathBuf>), Reject> {
    if path.is_empty() || path.contains('\0') {
        return Err(Reject::Forbidden);
    }
    let is_sep = |c: char| c == '/' || (windows && c == '\\');
    let segments: Vec<&str> = path.split(is_sep).collect();
    let name = segments.last().copied().unwrap_or("");
    let mime = name
        .rsplit_once('.')
        .and_then(|(_, ext)| mime_type(ext))
        .ok_or(Reject::Forbidden)?;
    for (i, seg) in segments.iter().enumerate() {
        if *seg == "." || *seg == ".." {
            return Err(Reject::Forbidden);
        }
        if windows {
            // Windows 會去掉每一段結尾的點和空白（`.. ` 等於 `..`）；`:` 是替代資料流，
            // 萬用字元和裝置名稱也不是一般的檔案。第一段可以是磁碟機代號（`C:`）。
            let trimmed = seg.trim_end_matches(['.', ' ']);
            let drive = i == 0 && seg.len() == 2 && seg.ends_with(':');
            if (!seg.is_empty() && trimmed.is_empty())
                || (seg.contains(':') && !drive)
                || seg.contains(['*', '?', '<', '>', '|', '"'])
                || is_device_name(seg)
            {
                return Err(Reject::Forbidden);
            }
        }
    }
    let inside: Vec<&PathBuf> = roots
        .iter()
        .filter(|r| lexically_inside(path, &r.to_string_lossy(), windows))
        .collect();
    if inside.is_empty() {
        return Err(Reject::Forbidden);
    }
    Ok((mime, inside))
}

/// 通過字串檢查之後：解析符號連結確認實際位置，再讀檔。
fn load(path: &Path, roots: &[PathBuf]) -> Result<Vec<u8>, Reject> {
    let real = dunce::canonicalize(path).map_err(|e| classify(&e))?;
    let inside = roots.iter().any(|root| {
        dunce::canonicalize(root)
            .map(|r| real.starts_with(r))
            .unwrap_or(false)
    });
    if !inside {
        return Err(Reject::Forbidden);
    }
    let meta = std::fs::metadata(&real).map_err(|e| classify(&e))?;
    if !meta.is_file() {
        return Err(Reject::NotFound);
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(Reject::TooLarge);
    }
    crate::files::read_capped(&real, MAX_IMAGE_BYTES)
        .map_err(|e| classify(&e))?
        .ok_or(Reject::TooLarge)
}

fn classify(e: &std::io::Error) -> Reject {
    if crate::io::is_network_error(e) {
        Reject::Offline
    } else if e.kind() == std::io::ErrorKind::PermissionDenied {
        Reject::Forbidden
    } else {
        Reject::NotFound
    }
}

/// 網址的路徑部分（`convertFileSrc` 把整個本機路徑編碼成一段）還原成本機路徑。
fn decode_path(request: &Request<Vec<u8>>) -> String {
    let raw = request.uri().path();
    crate::dav::decode_percent(raw.strip_prefix('/').unwrap_or(raw))
}

fn response(
    status: StatusCode,
    mime: Option<&str>,
    body: Vec<u8>,
    origin: Option<&str>,
) -> Response<Cow<'static, [u8]>> {
    let mut b = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        // 直接開啟這個網址時（例如 SVG），不執行任何指令碼。
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; sandbox",
        );
    if let Some(mime) = mime {
        b = b.header(header::CONTENT_TYPE, mime);
    }
    // 只讓 app 自己的頁面跨來源讀取（例如匯出 Word 時用 fetch 取得圖片）。
    if let Some(origin) = origin.filter(|o| crate::navigation::is_app_origin(o)) {
        b = b
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
            .header(header::VARY, "Origin");
    }
    b.body(Cow::Owned(body)).unwrap_or_else(|_| {
        let mut r = Response::new(Cow::Borrowed(&[][..]));
        *r.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        r
    })
}

fn status_of(reject: &Reject) -> StatusCode {
    match reject {
        Reject::Forbidden => StatusCode::FORBIDDEN,
        Reject::NotFound => StatusCode::NOT_FOUND,
        Reject::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        Reject::Offline => StatusCode::GATEWAY_TIMEOUT,
    }
}

/// 處理一個 `mdimg:` 請求（在背景執行，不會卡住視窗）。
pub fn handle(app: AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    tauri::async_runtime::spawn(async move {
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let origin = origin.as_deref();
        if !matches!(request.method().as_str(), "GET" | "HEAD") {
            responder.respond(response(
                StatusCode::METHOD_NOT_ALLOWED,
                None,
                vec![],
                origin,
            ));
            return;
        }
        let path = decode_path(&request);
        let mut roots = app.state::<ImageRoots>().snapshot();
        roots.extend(app.state::<Workspace>().root());
        let (mime, inside) = match precheck(&path, &roots, cfg!(windows)) {
            Ok((mime, inside)) => (mime, inside.into_iter().cloned().collect::<Vec<_>>()),
            Err(r) => {
                responder.respond(response(status_of(&r), None, vec![], origin));
                return;
            }
        };
        let head = request.method() == "HEAD";
        let result = crate::io::blocking(move || Ok(load(Path::new(&path), &inside))).await;
        let reply = match result {
            Ok(Ok(bytes)) => response(
                StatusCode::OK,
                Some(mime),
                if head { vec![] } else { bytes },
                origin,
            ),
            Ok(Err(r)) => response(status_of(&r), None, vec![], origin),
            Err(_) => response(StatusCode::GATEWAY_TIMEOUT, None, vec![], origin),
        };
        responder.respond(reply);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_paths_by_string_first() {
        let roots = [PathBuf::from(r"C:\Users\me\筆記")];
        let ok = |p: &str| precheck(p, &roots, true).map(|(m, _)| m);
        assert_eq!(ok(r"C:\Users\me\筆記\assets\a.png"), Ok("image/png"));
        assert_eq!(ok(r"c:/users/me/筆記/assets/A.JPG"), Ok("image/jpeg"));
        // 不是圖片、不在允許的資料夾內。
        assert_eq!(ok(r"C:\Users\me\筆記\a.md"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:\Users\me\.ssh\id_rsa"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:\Users\me\筆記2\a.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:\Users\me\筆記.png"), Err(Reject::Forbidden));
        // 想跳出資料夾的寫法。
        assert_eq!(ok(r"C:\Users\me\筆記\..\x.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:\Users\me\筆記\.. \x.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:\Users\me\筆記\...\x.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:\Users\me\筆記\a:b.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:\Users\me\筆記\con.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:\Users\me\筆記\*.png"), Err(Reject::Forbidden));
        // 網路與裝置路徑：資料夾不在那裡就一律拒絕（還沒碰到網路）。
        assert_eq!(ok(r"\\attacker\share\a.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"//attacker/share/a.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"\\?\UNC\attacker\share\a.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"\\?\C:\Users\me\筆記\a.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"\\.\C:\Users\me\筆記\a.png"), Err(Reject::Forbidden));
        assert_eq!(ok(r"C:Users\me\筆記\a.png"), Err(Reject::Forbidden));
        // 工作區本身在網路共用上時，同一個共用裡的圖片可以。
        let nas = [PathBuf::from(r"\\NAS\共用\筆記")];
        assert!(precheck(r"\\nas\共用\筆記\圖\a.png", &nas, true).is_ok());
        assert!(precheck(r"\\nas\共用\別的\a.png", &nas, true).is_err());
        assert!(precheck(r"\\attacker\共用\筆記\a.png", &nas, true).is_err());
    }

    #[test]
    fn unix_paths() {
        let roots = [PathBuf::from("/home/me/筆記"), PathBuf::from("/")];
        assert!(precheck("/home/me/筆記/a.svg", &roots[..1], false).is_ok());
        assert!(precheck("/home/me/筆記/../.ssh/a.png", &roots[..1], false).is_err());
        assert!(precheck("/home/me/a.png", &roots[..1], false).is_err());
        assert!(precheck("home/me/筆記/a.png", &roots[..1], false).is_err());
        // 根目錄當成允許的資料夾也能正確判斷。
        assert!(precheck("/a.png", &roots[1..], false).is_ok());
        // Linux 上反斜線只是檔名的一部分。
        assert!(precheck(r"\\attacker\share\a.png", &roots, false).is_err());
    }

    #[test]
    fn lexical_containment() {
        assert!(lexically_inside(r"C:\a\b.png", r"C:\a\", true));
        assert!(lexically_inside(r"C:\a\b.png", r"C:\", true));
        assert!(!lexically_inside(r"C:\ab.png", r"C:\a", true));
        assert!(!lexically_inside(r"C:\a", r"C:\a", true));
        assert!(lexically_inside("/a/b.png", "/a/", false));
        assert!(!lexically_inside("/A/b.png", "/a", false));
    }

    #[test]
    fn serves_files_inside_real_roots_only() {
        let dir = std::env::temp_dir().join(format!("md-mdimg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("筆記")).unwrap();
        std::fs::write(dir.join("筆記/a.png"), b"png").unwrap();
        std::fs::write(dir.join("外面.png"), b"secret").unwrap();
        let roots = [dir.join("筆記")];
        assert_eq!(load(&dir.join("筆記/a.png"), &roots).unwrap(), b"png");
        assert_eq!(
            load(&dir.join("筆記/沒有.png"), &roots),
            Err(Reject::NotFound)
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("外面.png"), dir.join("筆記/連結.png")).unwrap();
            assert_eq!(
                load(&dir.join("筆記/連結.png"), &roots),
                Err(Reject::Forbidden)
            );
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn decodes_converted_paths() {
        let req = Request::builder()
            .uri("http://mdimg.localhost/C%3A%5CUsers%5C%E7%AD%86%E8%A8%98%5Ca%20b.png")
            .body(vec![])
            .unwrap();
        assert_eq!(decode_path(&req), r"C:\Users\筆記\a b.png");
        let req = Request::builder()
            .uri("mdimg://localhost/%2Fhome%2Fme%2Fa.png")
            .body(vec![])
            .unwrap();
        assert_eq!(decode_path(&req), "/home/me/a.png");
    }
}
