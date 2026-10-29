//! 連線檢查：權限檢查（設定頁的「檢查權限」）與連線狀態（狀態列）。

use super::*;

/// 一項權限檢查的結果。`status` 是 `ok`、`fail` 或 `unknown`（無法事先檢查）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccessCheck {
    pub(super) id: &'static str,
    pub(super) label: String,
    pub(super) status: &'static str,
    pub(super) detail: String,
}

pub(super) fn check(
    id: &'static str,
    label: String,
    result: Result<String, String>,
) -> AccessCheck {
    match result {
        Ok(detail) => AccessCheck {
            id,
            label,
            status: "ok",
            detail,
        },
        Err(detail) => AccessCheck {
            id,
            label,
            status: "fail",
            detail,
        },
    }
}

/// 用 `validateOnly` 試改工作項目（不會真的存檔）：確認權杖與帳號能不能修改工作項目。
pub(super) fn can_edit_work_item(base: &str, pat: &str, id: u64) -> Result<String, String> {
    let res = crate::update::agent()
        .patch(&format!(
            "{base}/_apis/wit/workitems/{id}?validateOnly=true&api-version={API_VERSION}"
        ))
        .config()
        .http_status_as_error(false)
        .build()
        .header("Authorization", &basic(pat))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json-patch+json")
        .send(r#"[{"op":"add","path":"/fields/System.History","value":""}]"#)
        .map_err(|e| e.to_string())?;
    match res.status().as_u16() {
        code if code < 400 => Ok(tr!(
            "可以修改（用工作項目 {id} 試過，沒有真的修改）",
            id = id
        )),
        401 => Err(tr!("權杖沒有「Work Items（Read & write）」權限")),
        403 => Err(tr!("帳號沒有修改這個專案工作項目的權限")),
        code => Err(tr!("無法確認：伺服器回應 {code}", code = code)),
    }
}

/// 逐項檢查這個權杖能做什麼：登入、專案、工作項目（讀、改）、Wiki、程式碼。
#[tauri::command]
pub async fn ado_check(app: AppHandle) -> Result<Vec<AccessCheck>, String> {
    let (a, pat) = require(&app)?;
    crate::io::blocking_for(TIMEOUT, move || {
        let base = a.url.as_str();
        let mut out = vec![];
        out.push(check(
            "login",
            tr!("登入"),
            connection_data(base, &pat).and_then(|d| {
                user_of(&d)
                    .map(|(name, _)| tr!("以「{name}」登入", name = name))
                    .ok_or_else(|| tr!("個人存取權杖無效或已過期"))
            }),
        ));
        out.push(check(
            "projects",
            tr!("讀取專案"),
            get(base, &pat, "/_apis/projects?$top=100", &tr!("讀取專案"))
                .map(|v| tr!("看得到 {n} 個專案", n = values(&v).len())),
        ));
        let wiql = serde_json::json!({
            "query": "SELECT [System.Id] FROM WorkItems ORDER BY [System.ChangedDate] DESC"
        });
        let items = post(
            base,
            &pat,
            "/_apis/wit/wiql?$top=1",
            &wiql,
            &tr!("讀取工作項目"),
        );
        let first = items.as_ref().ok().and_then(|v| {
            v.get("workItems")
                .and_then(Value::as_array)
                .and_then(|l| l.first())
                .and_then(|w| w.get("id"))
                .and_then(Value::as_u64)
        });
        out.push(check(
            "workItemsRead",
            tr!("讀取工作項目"),
            items.map(|_| tr!("可以讀取")),
        ));
        out.push(match first {
            Some(id) => check(
                "workItemsWrite",
                tr!("修改工作項目（改狀態、指派、留言）"),
                can_edit_work_item(base, &pat, id),
            ),
            None => AccessCheck {
                id: "workItemsWrite",
                label: tr!("修改工作項目（改狀態、指派、留言）"),
                status: "unknown",
                detail: tr!("沒有可以試的工作項目，無法確認"),
            },
        });
        out.push(check(
            "wikiRead",
            tr!("讀取 Wiki"),
            get(base, &pat, "/_apis/wiki/wikis", &tr!("讀取 Wiki"))
                .map(|v| tr!("看得到 {n} 個 Wiki", n = values(&v).len())),
        ));
        out.push(AccessCheck {
            id: "wikiWrite",
            label: tr!("編輯 Wiki 頁面"),
            status: "unknown",
            detail: tr!("無法事先確認，第一次存回時就知道；權杖需要「Wiki（Read & write）」權限"),
        });
        out.push(check(
            "code",
            tr!("讀取程式碼（儲存庫）"),
            get(base, &pat, "/_apis/git/repositories", &tr!("讀取儲存庫"))
                .map(|v| tr!("看得到 {n} 個儲存庫", n = values(&v).len())),
        ));
        Ok(out)
    })
    .await
}

// ---- 連線狀態（狀態列） --------------------------------------------------------

/// 連線狀態：`ok`（連得到、權杖有效）、`offline`（連不到伺服器）、`auth`（權杖無效或過期）、
/// `error`（其他錯誤）、`none`（還沒有設定連線）。
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdoPing {
    pub(super) status: &'static str,
    /// 登入者（`ok` 時）。
    pub(super) name: Option<String>,
    pub(super) message: String,
}

/// 依 connectionData 的回應分類（`code` 是 HTTP 狀態碼，`body` 是內容）。
pub(super) fn ping_of(code: u16, body: &str) -> AdoPing {
    let auth = || AdoPing {
        status: "auth",
        name: None,
        message: tr!("個人存取權杖無效或已過期，請到設定的 Azure DevOps／TFS 頁更新權杖"),
    };
    match code {
        401 | 403 => auth(),
        c if c < 400 => match serde_json::from_str::<Value>(body)
            .ok()
            .as_ref()
            .and_then(user_of)
        {
            Some((name, _)) => AdoPing {
                status: "ok",
                name: Some(name),
                message: String::new(),
            },
            // 權杖不對時，雲端版會回傳登入網頁（不是 JSON）或匿名使用者。
            None => auth(),
        },
        c => AdoPing {
            status: "error",
            name: None,
            message: tr!("伺服器回應 {code}", code = c),
        },
    }
}

/// 檢查連線狀態（不會修改任何資料，最多等 20 秒）。
#[tauri::command]
pub async fn ado_ping(app: AppHandle) -> Result<AdoPing, String> {
    let Some((a, pat)) = connection(&app) else {
        return Ok(AdoPing {
            status: "none",
            name: None,
            message: String::new(),
        });
    };
    crate::io::blocking_for(Duration::from_secs(20), move || {
        let call = |version: Option<&str>| {
            let url = match version {
                Some(v) => format!("{}/_apis/connectionData?api-version={v}", a.url),
                None => format!("{}/_apis/connectionData", a.url),
            };
            crate::update::agent()
                .get(&url)
                .config()
                .http_status_as_error(false)
                .build()
                .header("Authorization", &basic(&pat))
                .header("Accept", "application/json")
                .call()
        };
        // 舊版伺服器不接受預覽版號（回 400），再不帶版號試一次。
        let res = match call(Some("5.0-preview")) {
            Ok(r) if r.status().as_u16() == 400 => call(None),
            other => other,
        };
        Ok(match res {
            Ok(mut r) => {
                let code = r.status().as_u16();
                let body = r.body_mut().read_to_string().unwrap_or_default();
                ping_of(code, &body)
            }
            Err(e) => AdoPing {
                status: "offline",
                name: None,
                message: tr!(
                    "連不到 Azure DevOps 伺服器，請確認網路或 VPN 連線（{e}）",
                    e = e
                ),
            },
        })
    })
    .await
}
