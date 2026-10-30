//! WebDAV 用戶端：PROPFIND、GET、PUT（If-Match）、MKCOL、MOVE、DELETE，以及解析 multistatus 回應。

use super::*;

pub struct Client {
    pub(super) base: String,
    pub(super) auth: String,
    pub(super) agent: ureq::Agent,
}

impl Client {
    pub fn new(base: &str, user: &str, password: &str) -> Self {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        let agent = ureq::Agent::config_builder()
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .allow_non_standard_methods(true)
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(30)))
            .timeout_connect(Some(Duration::from_secs(10)))
            .user_agent(concat!("md-editor/", env!("CARGO_PKG_VERSION")))
            .build()
            .new_agent();
        Client {
            base: encode_base(base),
            auth: format!("Basic {token}"),
            agent,
        }
    }

    pub(super) fn url(&self, rel: &str) -> String {
        let encoded: Vec<String> = rel
            .split('/')
            .filter(|s| !s.is_empty())
            .map(encode_segment)
            .collect();
        format!("{}{}", self.base, encoded.join("/"))
    }

    pub(super) fn request(
        &self,
        method: &str,
        rel: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<ureq::http::Response<ureq::Body>, DavError> {
        let mut req = ureq::http::Request::builder()
            .method(method)
            .uri(self.url(rel))
            .header("Authorization", &self.auth);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let req = req
            .body(body.map(<[u8]>::to_vec).unwrap_or_default())
            .map_err(|e| DavError::Network(e.to_string()))?;
        let res = self
            .agent
            .run(req)
            .map_err(|e| DavError::Network(e.to_string()))?;
        match res.status().as_u16() {
            401 | 403 => Err(DavError::Unauthorized),
            404 => Err(DavError::NotFound),
            412 => Err(DavError::Changed),
            _ => Ok(res),
        }
    }

    pub(super) fn propfind(&self, rel: &str, depth: u8) -> Result<Vec<Item>, DavError> {
        const BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>"#;
        let depth = depth.to_string();
        let mut res = self.request(
            "PROPFIND",
            rel,
            &[
                ("Depth", &depth),
                ("Content-Type", "application/xml; charset=utf-8"),
            ],
            Some(BODY.as_bytes()),
        )?;
        if res.status().as_u16() != 207 {
            return Err(DavError::Http(res.status().as_u16()));
        }
        let xml = res
            .body_mut()
            .with_config()
            .limit(32 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| DavError::Network(e.to_string()))?;
        Ok(parse_multistatus(&xml, url_path(&self.base)))
    }

    pub(super) fn get(&self, rel: &str) -> Result<(Vec<u8>, Option<String>), DavError> {
        let mut res = self.request("GET", rel, &[], None)?;
        if !res.status().is_success() {
            return Err(DavError::Http(res.status().as_u16()));
        }
        let etag = header_etag(&res);
        let bytes = res
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| DavError::Network(e.to_string()))?;
        Ok((bytes, etag))
    }

    /// 上傳。`if_match` 為 `Some` 時只在遠端的 ETag 相同時寫入；`None` 時只在檔案不存在時建立。
    pub(super) fn put(
        &self,
        rel: &str,
        bytes: &[u8],
        if_match: Option<&str>,
    ) -> Result<Option<String>, DavError> {
        let header = match if_match {
            Some(etag) => ("If-Match", etag),
            None => ("If-None-Match", "*"),
        };
        let res = self.request("PUT", rel, &[header], Some(bytes))?;
        if !res.status().is_success() {
            return Err(DavError::Http(res.status().as_u16()));
        }
        let etag = header_etag(&res);
        // 有些伺服器 PUT 不回 ETag，再查一次。
        Ok(etag.or_else(|| self.stat(rel).ok().and_then(|i| i.etag)))
    }

    pub(super) fn stat(&self, rel: &str) -> Result<Item, DavError> {
        self.propfind(rel, 0)?
            .into_iter()
            .next()
            .ok_or(DavError::NotFound)
    }

    pub(super) fn mkcol(&self, rel: &str) -> Result<(), DavError> {
        let res = self.request("MKCOL", rel, &[], None)?;
        match res.status().as_u16() {
            200..=299 => Ok(()),
            405 => Err(DavError::Exists),
            code => Err(DavError::Http(code)),
        }
    }

    pub(super) fn move_to(&self, from: &str, to: &str) -> Result<(), DavError> {
        let dest = self.url(to);
        let res = self.request(
            "MOVE",
            from,
            &[("Destination", &dest), ("Overwrite", "F")],
            None,
        )?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(DavError::Http(res.status().as_u16()))
        }
    }

    pub(super) fn delete(&self, rel: &str) -> Result<(), DavError> {
        let res = self.request("DELETE", rel, &[], None)?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(DavError::Http(res.status().as_u16()))
        }
    }
}

impl RemoteFs for Client {
    fn stat(&self, rel: &str) -> Result<Item, DavError> {
        Client::stat(self, rel)
    }
    fn list(&self, rel: &str) -> Result<Vec<Item>, DavError> {
        self.propfind(rel, 1)
    }
    fn get(&self, rel: &str) -> Result<(Vec<u8>, Option<String>), DavError> {
        Client::get(self, rel)
    }
    fn put(
        &self,
        rel: &str,
        bytes: &[u8],
        if_match: Option<&str>,
    ) -> Result<Option<String>, DavError> {
        Client::put(self, rel, bytes, if_match)
    }
    fn mkdir(&self, rel: &str) -> Result<(), DavError> {
        self.mkcol(rel)
    }
    fn rename(&self, from: &str, to: &str) -> Result<(), DavError> {
        self.move_to(from, to)
    }
    fn delete(&self, rel: &str) -> Result<(), DavError> {
        Client::delete(self, rel)
    }
}

/// ETag 統一成 `"值"`。有些伺服器（例如 wsgidav）PROPFIND 回的 ETag 沒有引號，
/// GET／PUT 的標頭卻有，不統一的話每次輪詢都會誤判成檔案被改過。
/// 弱 ETag（`W/"…"`）也當成一般 ETag 比較。
pub(super) fn norm_etag(raw: &str) -> Option<String> {
    let v = raw.trim();
    let v = v.strip_prefix("W/").unwrap_or(v).trim_matches('"');
    (!v.is_empty()).then(|| format!("\"{v}\""))
}

pub(super) fn header_etag(res: &ureq::http::Response<ureq::Body>) -> Option<String> {
    res.headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .and_then(norm_etag)
}

/// 解析 PROPFIND 的 207 回應。`base_path` 是連線根目錄的網址路徑（例如 `/筆記/`，可能有 %XX）。
pub(super) fn parse_multistatus(xml: &str, base_path: &str) -> Vec<Item> {
    let base = decode_percent(base_path);
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut items = Vec::new();
    let (mut href, mut etag, mut is_dir) = (String::new(), None::<String>, false);
    let mut in_href = false;
    let mut in_etag = false;
    let mut in_response = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "response" => {
                    in_response = true;
                    href.clear();
                    etag = None;
                    is_dir = false;
                }
                "href" if in_response => in_href = true,
                "getetag" => in_etag = true,
                "collection" => is_dir = true,
                _ => {}
            },
            Ok(Event::Empty(e)) if e.local_name().as_ref() == "collection" => is_dir = true,
            Ok(Event::Text(t)) => {
                if in_href {
                    href.push_str(t.as_ref());
                } else if in_etag {
                    etag.get_or_insert_with(String::new).push_str(t.as_ref());
                }
            }
            Ok(Event::GeneralRef(r)) => {
                // `&amp;`、`&#38;` 之類的實體（quick-xml 會分開回報）。
                let ch = match r.resolve_char_ref() {
                    Ok(Some(c)) => c,
                    _ => match r.as_ref() {
                        "amp" => '&',
                        "lt" => '<',
                        "gt" => '>',
                        "quot" => '"',
                        "apos" => '\'',
                        _ => continue,
                    },
                };
                if in_href {
                    href.push(ch);
                } else if in_etag {
                    etag.get_or_insert_with(String::new).push(ch);
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "href" => in_href = false,
                "getetag" => in_etag = false,
                "response" => {
                    in_response = false;
                    let path = decode_percent(url_path(&href));
                    if let Some(rest) = path
                        .strip_prefix(&base)
                        .or_else(|| (path.clone() + "/").strip_prefix(&base).map(|_| ""))
                    {
                        items.push(Item {
                            rel: rest.trim_matches('/').to_string(),
                            is_dir,
                            etag: etag.as_deref().and_then(norm_etag),
                            detail: None,
                        });
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    items
}
