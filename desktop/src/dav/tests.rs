use super::*;

fn item(rel: &str, is_dir: bool, etag: Option<&str>) -> Item {
    Item::new(rel.into(), is_dir, etag.map(Into::into))
}

#[test]
fn remote_listing_is_bounded() {
    // 惡意的伺服器：每個資料夾都有更深的資料夾與很多檔案，還有指回自己的連結。
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let list = |dir: &str| {
        calls.fetch_add(1, Ordering::Relaxed);
        let mut items = vec![item(dir, true, None), item("", true, None)];
        for n in 0..5 {
            let sub = if dir.is_empty() {
                format!("d{n}")
            } else {
                format!("{dir}/d{n}")
            };
            items.push(item(&sub, true, None));
            items.push(item(&format!("{sub}.md"), false, None));
        }
        Some(items)
    };
    let files = walk_remote(&list);
    let calls = calls.load(Ordering::Relaxed);
    assert!(calls <= LIST_MAX_DIRS, "查了 {calls} 個資料夾");
    assert!(files.len() <= MAX_FILES);
    assert!(files.contains(&"d0.md".to_string()));
    assert!(files
        .iter()
        .all(|f| f.split('/').count() <= LIST_MAX_DEPTH + 1));
}

#[test]
fn walks_a_normal_tree_in_parallel() {
    let list = |dir: &str| {
        Some(match dir {
            "" => vec![
                item("", true, None),
                item("筆記", true, None),
                item(".git", true, None),
                item("a.md", false, None),
                item("圖.png", false, None),
            ],
            "筆記" => vec![item("筆記", true, None), item("筆記/b.md", false, None)],
            _ => return None,
        })
    };
    let mut files = walk_remote(&list);
    files.sort();
    assert_eq!(files, ["a.md", "筆記/b.md"]);
    let doubled = parallel_map(&[1, 2, 3, 4, 5, 6, 7], 3, &|n: &i32| n * 2);
    assert_eq!(doubled, [2, 4, 6, 8, 10, 12, 14]);
}

#[test]
fn polls_folders_with_several_open_files_at_once() {
    let stats = std::cell::RefCell::new(Vec::new());
    let lists = std::cell::RefCell::new(Vec::new());
    let stat = |rel: &str| {
        stats.borrow_mut().push(rel.to_string());
        match rel {
            "b/改名中.md" => Ok(item(rel, false, Some("\"s\""))),
            "c.md" => Ok(item(rel, false, Some("\"c\""))),
            _ => Err(DavError::NotFound),
        }
    };
    let list = |dir: &str| {
        lists.borrow_mut().push(dir.to_string());
        Ok(vec![
            item(dir, true, None),
            item("b/1.md", false, Some("\"1\"")),
            item("b/2.md", false, None),
        ])
    };
    let rels: Vec<String> = ["b/1.md", "b/2.md", "b/改名中.md", "b/不見了.md", "c.md"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let out = remote_etags(&stat, &list, &rels);
    assert_eq!(*lists.borrow(), ["b"]);
    let mut asked = stats.borrow().clone();
    asked.sort();
    assert_eq!(asked, ["b/不見了.md", "b/改名中.md", "c.md"]);
    assert_eq!(out["b/1.md"], Ok(Some("\"1\"".into())));
    assert_eq!(out["b/2.md"], Ok(None));
    assert_eq!(out["b/改名中.md"], Ok(Some("\"s\"".into())));
    assert_eq!(out["b/不見了.md"], Err(DavError::NotFound));
    assert_eq!(out["c.md"], Ok(Some("\"c\"".into())));
    // 資料夾查詢失敗（斷線）：這次都不回報。
    let out = remote_etags(
        &stat,
        &|_| Err(DavError::Network("斷線".into())),
        &rels[..2],
    );
    assert!(out.is_empty());
}

#[test]
fn etags_compare_with_or_without_quotes() {
    assert_eq!(norm_etag("abc-1"), Some("\"abc-1\"".into()));
    assert_eq!(norm_etag("\"abc-1\""), Some("\"abc-1\"".into()));
    assert_eq!(norm_etag(" W/\"abc-1\" "), Some("\"abc-1\"".into()));
    assert_eq!(norm_etag("\"\""), None);
}

#[test]
fn encodes_and_decodes_paths() {
    assert_eq!(encode_segment("週報 1.md"), "%E9%80%B1%E5%A0%B1%201.md");
    assert_eq!(
        decode_percent("/%E7%AD%86%E8%A8%98/a%20b.md"),
        "/筆記/a b.md"
    );
    assert_eq!(decode_percent("%2"), "%2");
    assert_eq!(decode_percent("%中文"), "%中文");
    assert_eq!(url_path("https://nas.local:5006/筆記/"), "/筆記/");
    assert_eq!(url_path("https://nas.local"), "/");
    assert_eq!(
        encode_base("http://nas:5005/筆記/週報 2/"),
        "http://nas:5005/%E7%AD%86%E8%A8%98/%E9%80%B1%E5%A0%B1%202/"
    );
    assert_eq!(
        encode_base("http://nas:5005/%E7%AD%86%E8%A8%98"),
        "http://nas:5005/%E7%AD%86%E8%A8%98/"
    );
    assert_eq!(encode_base("https://nas"), "https://nas/");
    assert_eq!(host_of("https://user@[fe80::1]:5006/x"), "fe80::1");
    assert_eq!(host_of("http://192.168.1.10:5005/home/"), "192.168.1.10");
}

#[test]
fn only_allows_http_on_local_network_with_consent() {
    assert_eq!(
        normalize_url("https://nas.example.com/筆記", false).unwrap(),
        "https://nas.example.com/筆記/"
    );
    assert!(normalize_url("http://nas.example.com/", true)
        .unwrap_err()
        .contains("HTTPS"));
    assert_eq!(
        normalize_url("http://192.168.1.10:5005/", false).unwrap_err(),
        "HTTP_CONFIRM"
    );
    assert_eq!(
        normalize_url("http://192.168.1.10:5005", true).unwrap(),
        "http://192.168.1.10:5005/"
    );
    assert!(normalize_url("http://diskstation:5005/", true).is_ok());
    // 數字寫法的 IPv4 位址（134744072 就是 8.8.8.8）不算區域網路。
    assert!(normalize_url("http://134744072/", true).is_err());
    assert!(normalize_url("http://0x08080808/", true).is_err());
    assert!(normalize_url("http://0X8080808:80/", true).is_err());
    assert!(!is_private_host("2130706433"));
    assert!(is_private_host("nas2"));
    assert!(normalize_url("ftp://nas/", true).is_err());
    assert!(normalize_url("https:///", false).is_err());
    // 主機名稱的判斷和實際連線一致，不能用 `#@`、`?@` 假裝成區域網路。
    assert!(normalize_url("http://evil.com#@10.0.0.1/", true).is_err());
    assert!(normalize_url("http://evil.com?@10.0.0.1/", true).is_err());
    assert_eq!(host_of("http://evil.com#@10.0.0.1/"), "evil.com");
}

#[test]
fn parses_multistatus_from_different_servers() {
    // Synology／Apache 風格：前綴 D:，href 是完整路徑並以 %XX 編碼。
    let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/%E7%AD%86%E8%A8%98/</D:href><D:propstat><D:prop>
<D:resourcetype><D:collection/></D:resourcetype><D:getetag>"dir"</D:getetag></D:prop>
<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/%E7%AD%86%E8%A8%98/%E9%80%B1%E5%A0%B1.md</D:href><D:propstat><D:prop>
<D:resourcetype/><D:getetag>"abc-123"</D:getetag></D:prop></D:propstat></D:response>
  <D:response><D:href>http://nas:5005/%E7%AD%86%E8%A8%98/sub%20dir/</D:href><D:propstat><D:prop>
<D:resourcetype><D:collection></D:collection></D:resourcetype></D:prop></D:propstat></D:response>
  <D:response><D:href>/%E7%AD%86%E8%A8%98/a&amp;b.md</D:href><D:propstat><D:prop>
<D:resourcetype/><D:getetag>W/"x&amp;y"</D:getetag></D:prop></D:propstat></D:response>
</D:multistatus>"#;
    let items = parse_multistatus(xml, "/%E7%AD%86%E8%A8%98/");
    assert_eq!(
        items,
        vec![
            Item::new("".into(), true, Some("\"dir\"".into())),
            Item::new("週報.md".into(), false, Some("\"abc-123\"".into())),
            Item::new("sub dir".into(), true, None),
            Item::new("a&b.md".into(), false, Some("\"x&y\"".into())),
        ]
    );
    // Nextcloud 風格：小寫前綴 d:。
    let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/eric/</d:href>
        <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
        <d:response><d:href>/remote.php/dav/files/eric/x.md</d:href><d:propstat><d:prop><d:resourcetype/>
        <d:getetag>&quot;e1&quot;</d:getetag></d:prop></d:propstat></d:response></d:multistatus>"#;
    let items = parse_multistatus(xml, "/remote.php/dav/files/eric/");
    assert_eq!(
        items[1],
        Item::new("x.md".into(), false, Some("\"e1\"".into()))
    );
}

#[test]
fn splits_remote_paths_safely() {
    assert_eq!(
        split("webdav://ab12/筆記/週報.md"),
        Some(("webdav://ab12", "筆記/週報.md"))
    );
    assert_eq!(split("webdav://ab12/"), Some(("webdav://ab12", "")));
    assert_eq!(split("webdav://ab12"), Some(("webdav://ab12", "")));
    assert_eq!(split("ssh://cd34/a/b.md"), Some(("ssh://cd34", "a/b.md")));
    assert_eq!(join("webdav://ab12", ""), "webdav://ab12");
    assert_eq!(join("ssh://cd34", "a/b.md"), "ssh://cd34/a/b.md");
    assert_eq!(split("webdav://ab12/../etc"), None);
    assert_eq!(split("ssh:///etc"), None);
    assert_eq!(split("C:\\notes"), None);
}

/// 需要本機的 WebDAV 伺服器（例如 wsgidav），預設不執行：
/// `MD_DAV_TEST=http://127.0.0.1:8765/ MD_DAV_USER=eric MD_DAV_PASS=secret cargo test -- --ignored dav_live`
#[test]
#[ignore]
fn dav_live() {
    let base = std::env::var("MD_DAV_TEST").unwrap();
    let c = Client::new(
        &base,
        &std::env::var("MD_DAV_USER").unwrap(),
        &std::env::var("MD_DAV_PASS").unwrap(),
    );
    let wrong = Client::new(&base, "eric", "錯誤的密碼");
    assert_eq!(wrong.stat("").unwrap_err(), DavError::Unauthorized);
    assert!(c.stat("").unwrap().is_dir);
    let _ = c.delete("測試 資料夾");
    c.mkcol("測試 資料夾").unwrap();
    assert_eq!(c.mkcol("測試 資料夾").unwrap_err(), DavError::Exists);
    let etag = c
        .put("測試 資料夾/週報.md", "第一版".as_bytes(), None)
        .unwrap()
        .unwrap();
    // 已存在時不能用「新建」覆蓋。
    assert_eq!(
        c.put("測試 資料夾/週報.md", b"x", None).unwrap_err(),
        DavError::Changed
    );
    let (body, got) = c.get("測試 資料夾/週報.md").unwrap();
    assert_eq!(String::from_utf8(body).unwrap(), "第一版");
    assert_eq!(got.as_deref(), Some(etag.as_str()));
    // 用正確的 ETag 更新成功；用舊的 ETag 更新回 412。
    // （wsgidav 的 ETag 以秒為單位，內容長度不同才保證 ETag 會變。）
    let etag2 = c
        .put(
            "測試 資料夾/週報.md",
            "第二版，比較長".as_bytes(),
            Some(&etag),
        )
        .unwrap()
        .unwrap();
    assert_ne!(etag, etag2);
    assert_eq!(
        c.put("測試 資料夾/週報.md", b"x", Some(&etag)).unwrap_err(),
        DavError::Changed
    );
    let list = c.propfind("測試 資料夾", 1).unwrap();
    assert!(list
        .iter()
        .any(|i| i.rel == "測試 資料夾/週報.md" && !i.is_dir));
    c.move_to("測試 資料夾/週報.md", "測試 資料夾/改名.md")
        .unwrap();
    assert_eq!(
        c.stat("測試 資料夾/週報.md").unwrap_err(),
        DavError::NotFound
    );
    c.delete("測試 資料夾").unwrap();
}
