use super::*;
use serde_json::json;

/// 模擬一台 TFS：只有 /tfs/DefaultCollection 一個集合，connectionData 只接受預覽版號。
fn fake_tfs() -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let target = req.split(' ').nth(1).unwrap_or("");
            let (status, body) = match target {
                t if t.contains("/_apis/connectionData?api-version=5.0-preview") => (
                    "200 OK",
                    r#"{"authenticatedUser":{"providerDisplayName":"王小明"}}"#,
                ),
                t if t.contains("/_apis/connectionData") => ("400 Bad Request", "{}"),
                "/tfs/_apis/projectCollections?api-version=5.0" => {
                    ("200 OK", r#"{"value":[{"name":"DefaultCollection"}]}"#)
                }
                "/tfs/DefaultCollection/_apis/projects?$top=1&api-version=5.0" => {
                    ("200 OK", r#"{"value":[]}"#)
                }
                _ => ("404 Not Found", "{}"),
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    base
}

#[test]
fn connects_to_the_only_collection_when_given_the_server_url() {
    let host = fake_tfs();
    let a = connect_at(&format!("{host}/tfs"), "pat").unwrap();
    assert_eq!(a.url, format!("{host}/tfs/DefaultCollection"));
    assert_eq!(a.name, "王小明");
    // 只輸入主機名稱：自動試 /tfs。
    let tries = candidates(&host).unwrap();
    let ok = tries
        .iter()
        .find_map(|b| connect_at(b, "pat").ok())
        .unwrap();
    assert_eq!(ok.url, format!("{host}/tfs/DefaultCollection"));
}

#[test]
fn explains_not_found_after_trying_every_url() {
    let tries = vec!["https://tfs/a".to_string(), "https://tfs".to_string()];
    let e = connect_error(
        &tries,
        vec!["連線失敗：找不到（404），請確認網址".into(); 2],
    );
    assert!(e.contains("https://tfs/a、https://tfs"));
    assert!(e.contains("DefaultCollection"));
    // 有其他錯誤（例如權杖不對）時優先顯示，不要被 404 蓋掉。
    let e = connect_error(
        &tries,
        vec![
            "連線失敗：個人存取權杖無效或已過期".into(),
            "連線失敗：找不到（404），請確認網址".into(),
        ],
    );
    assert_eq!(e, "連線失敗：個人存取權杖無效或已過期");
}

#[test]
fn finds_collection_url_from_pasted_links() {
    assert_eq!(
        candidates("https://tfs.corp.com/tfs/DefaultCollection/").unwrap(),
        [
            "https://tfs.corp.com/tfs/DefaultCollection",
            "https://tfs.corp.com/tfs"
        ]
    );
    assert_eq!(
        candidates("https://dev.azure.com/org/專案/_git/repo?path=/a").unwrap(),
        [
            "https://dev.azure.com/org/專案",
            "https://dev.azure.com/org"
        ]
    );
    assert_eq!(
        candidates("http://tfs:8080").unwrap(),
        ["http://tfs:8080", "http://tfs:8080/tfs"]
    );
    // 網際網路上的伺服器不能用 HTTP（權杖會以明文傳出去）。
    assert!(candidates("http://tfs.example.com/tfs").is_err());
    assert!(candidates("tfs.corp.com").is_err());
}

#[test]
fn base_match_does_not_cross_sibling_paths() {
    let base = "https://tfs.corp.com/tfs/DefaultCollection";
    assert!(starts_with_base(
        "https://TFS.corp.com/tfs/defaultcollection/P/_git/r",
        base
    ));
    assert!(!starts_with_base(
        "https://tfs.corp.com/tfs/DefaultCollection2/P/_git/r",
        base
    ));
    assert!(!starts_with_base(
        "https://evil.com/tfs/DefaultCollection",
        base
    ));
}

#[test]
fn finds_project_and_repo_in_remote() {
    let base = "https://tfs.corp.com/tfs/DC";
    assert_eq!(
        project_and_repo(
            "https://ming@tfs.corp.com/tfs/DC/%E7%94%A2%E5%93%81/_git/web",
            base
        ),
        Some(("%E7%94%A2%E5%93%81".into(), "web".into()))
    );
    assert_eq!(
        project_and_repo("https://other.com/tfs/DC/P/_git/r", base),
        None
    );
    assert_eq!(
        project_and_repo("https://tfs.corp.com/tfs/DC/P", base),
        None
    );
}

#[test]
fn same_server_compares_scheme_host_and_port() {
    let base = "https://tfs.corp.com/tfs/DC";
    assert!(same_server("https://TFS.corp.com/tfs/Other/_git/r", base));
    assert!(!same_server("http://tfs.corp.com/tfs/DC/_git/r", base));
    assert!(!same_server("https://tfs.corp.com:8443/tfs/DC", base));
    assert!(!same_server("https://tfs.corp.com.evil.com/tfs/DC", base));
}

#[test]
fn flattens_saved_queries() {
    let v = serde_json::json!({ "value": [
        { "id": "f1", "name": "My Queries", "path": "My Queries", "isFolder": true, "children": [
            { "id": "q1", "name": "我的 Bug", "path": "My Queries/我的 Bug" }
        ] },
        { "id": "f2", "name": "Shared Queries", "path": "Shared Queries", "isFolder": true, "children": [
            { "id": "f3", "name": "團隊", "path": "Shared Queries/團隊", "isFolder": true, "children": [
                { "id": "q2", "name": "本週", "path": "Shared Queries/團隊/本週" }
            ] }
        ] }
    ] });
    let mut out = vec![];
    flatten_queries("P", values(&v), &mut out);
    assert_eq!(
        out,
        vec![
            SavedQuery {
                id: "q1".into(),
                project: "P".into(),
                name: "我的 Bug".into(),
                folder: "My Queries".into()
            },
            SavedQuery {
                id: "q2".into(),
                project: "P".into(),
                name: "本週".into(),
                folder: "Shared Queries/團隊".into()
            },
        ]
    );
}

#[test]
fn reads_wiki_revisions() {
    let v = serde_json::json!({ "value": [
        { "commitId": "b2", "comment": " 更新 安裝.md \n", "author": { "name": "王小明", "date": "2026-10-28T02:42:00Z" } },
        { "commitId": "a1", "author": { "name": "陳大文" } },
        { "comment": "沒有 id 的略過" }
    ] });
    assert_eq!(
        revisions_of(&v),
        vec![
            WikiRevision {
                id: "b2".into(),
                author: "王小明".into(),
                date: "2026-10-28T02:42:00Z".into(),
                comment: "更新 安裝.md".into()
            },
            WikiRevision {
                id: "a1".into(),
                author: "陳大文".into(),
                date: String::new(),
                comment: String::new()
            },
        ]
    );
}

#[test]
fn reads_work_item_parents() {
    let new = serde_json::json!({ "id": 5, "fields": { "System.Parent": 2 } });
    assert_eq!(parent_field(&new), Some((5, 2)));
    assert_eq!(
        parent_field(&serde_json::json!({ "id": 5, "fields": {} })),
        None
    );
    let old = serde_json::json!({ "id": 7, "relations": [
        { "rel": "System.LinkTypes.Related", "url": "https://tfs/DC/_apis/wit/workItems/3" },
        { "rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://tfs/DC/_apis/wit/workItems/4" }
    ] });
    assert_eq!(parent_relation(&old), Some((7, 4)));
    assert_eq!(parent_relation(&serde_json::json!({ "id": 7 })), None);
}

#[test]
fn reads_query_result_ids() {
    let flat = serde_json::json!({ "workItems": [{ "id": 3 }, { "id": 1 }, { "id": 3 }] });
    assert_eq!(query_ids(&flat), vec![3, 1]);
    let tree = serde_json::json!({ "workItemRelations": [
        { "target": { "id": 10 } },
        { "source": { "id": 10 }, "target": { "id": 11 } }
    ] });
    assert_eq!(query_ids(&tree), vec![10, 11]);
    assert!(query_ids(&serde_json::json!({})).is_empty());
}

#[test]
fn names_wiki_attachments_safely() {
    assert_eq!(attachment_name("截圖 1", "png", 42), "1-42.png");
    assert_eq!(attachment_name("", "jpg", 7), "image-7.jpg");
    assert_eq!(attachment_name("../a b", "png", 1), "a-b-1.png");
    assert_eq!(
        attachment_name("screen_shot-2", "gif", 3),
        "screen_shot-2-3.gif"
    );
}

#[test]
fn reads_latest_wiki_author() {
    let v = serde_json::json!({ "count": 1, "value": [
        { "commitId": "abc", "author": { "name": "王小明", "email": "a@b", "date": "2026-10-28T02:42:00Z" } }
    ] });
    assert_eq!(
        latest_author(&v),
        (Some("王小明".into()), Some("2026-10-28T02:42:00Z".into()))
    );
    assert_eq!(
        latest_author(&serde_json::json!({ "value": [] })),
        (None, None)
    );
    assert_eq!(latest_author(&serde_json::json!({})), (None, None));
}

#[test]
fn builds_create_ops() {
    let item = NewWorkItem {
        project: "P".into(),
        kind: "Bug".into(),
        title: " 登入失敗 ".into(),
        description: Some("<p>步驟</p>".into()),
        assign_to_me: true,
        parent: Some(42),
    };
    let ops = create_ops(&item, "me@corp", "https://tfs/DC/");
    assert_eq!(ops[0]["value"], "登入失敗");
    assert_eq!(ops[1]["path"], "/fields/Microsoft.VSTS.TCM.ReproSteps");
    assert_eq!(ops[2]["value"], "me@corp");
    assert_eq!(
        ops[3]["value"]["url"],
        "https://tfs/DC/_apis/wit/workItems/42"
    );
    let task = NewWorkItem {
        kind: "Task".into(),
        title: "x".into(),
        description: Some("<p>a</p>".into()),
        ..Default::default()
    };
    let ops = create_ops(&task, "me", "https://tfs/DC");
    assert_eq!(ops.len(), 2);
    assert_eq!(ops[1]["path"], "/fields/System.Description");
}

#[test]
fn encodes_project_names_in_urls() {
    assert_eq!(encode_segment("My Project"), "My%20Project");
    assert_eq!(encode_segment("專案.wiki"), "%E5%B0%88%E6%A1%88.wiki");
}

#[test]
fn identity_uses_account_or_domain_login() {
    let mut a = Account {
        url: "https://tfs.corp.com/tfs/DefaultCollection".into(),
        name: "王小明".into(),
        account: Some("CORP\\ming".into()),
    };
    assert_eq!(identity_of(&a).unwrap().email, "ming@corp");
    a.account = Some("ming@corp.com".into());
    assert_eq!(identity_of(&a).unwrap().email, "ming@corp.com");
    a.account = None;
    assert_eq!(identity_of(&a).unwrap().email, "王小明@tfs.corp.com");
}

#[test]
fn reads_user_from_connection_data() {
    let data = json!({"authenticatedUser": {"providerDisplayName": "王小明",
        "properties": {"Account": {"$type": "System.String", "$value": "CORP\\ming"}}}});
    assert_eq!(
        user_of(&data),
        Some(("王小明".into(), Some("CORP\\ming".into())))
    );
    let anon = json!({"authenticatedUser": {"providerDisplayName": "Anonymous"}});
    assert_eq!(user_of(&anon), None);
}

#[test]
fn lists_repos_and_project_wikis() {
    let base = "https://tfs.corp.com/tfs/DC";
    let repos = json!({"value": [
        {"name": "web", "remoteUrl": "https://tfs.corp.com/tfs/DC/產品/_git/web", "project": {"name": "產品"}},
        {"name": "old", "remoteUrl": "x", "isDisabled": true, "project": {"name": "產品"}}
    ]});
    let wikis = json!({"value": [
        {"name": "產品.wiki", "type": "projectWiki", "projectId": "p1", "remoteUrl": "https://tfs.corp.com/tfs/DC/產品/_wiki/wikis/產品.wiki"},
        {"name": "docs", "type": "codeWiki", "projectId": "p1"}
    ]});
    let projects = json!({"value": [{"id": "p1", "name": "產品"}]});
    let list = repos_from(base, &repos, &wikis, &projects);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name, "web");
    assert!(list[1].wiki);
    assert_eq!(
        list[1].clone_url,
        "https://tfs.corp.com/tfs/DC/%E7%94%A2%E5%93%81/_git/%E7%94%A2%E5%93%81.wiki"
    );
}

#[test]
fn lists_wikis_and_page_trees() {
    let wikis = json!({"value": [
        {"id": "w2", "name": "docs", "type": "codeWiki", "projectId": "p1", "repositoryId": "r2",
         "mappedPath": "/docs", "versions": [{"version": "main"}]},
        {"id": "w1", "name": "產品.wiki", "type": "projectWiki", "projectId": "p1", "repositoryId": "r1",
         "mappedPath": "/", "versions": [{"version": "wikiMaster"}], "remoteUrl": "https://tfs/DC/x"},
        {"id": "w3", "name": "壞的", "projectId": "p1"}
    ]});
    let projects = json!({"value": [{"id": "p1", "name": "產品"}]});
    let list = wikis_from(&wikis, &projects);
    assert_eq!(list.len(), 2);
    assert_eq!((list[0].id.as_str(), list[0].code), ("w1", false));
    assert_eq!(list[0].project, "產品");
    assert_eq!(list[1].mapped_path, "/docs");
    assert_eq!(list[1].version.as_deref(), Some("main"));
    let tree = json!({"path": "/", "subPages": [
        {"path": "/首頁", "subPages": []},
        {"path": "/產品", "subPages": [{"path": "/產品/安裝", "id": 12}]}
    ]});
    let pages = page_tree(&tree);
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[1].children[0].path, "/產品/安裝");
    assert_eq!(pages[1].children[0].id, Some(12));
    assert_eq!(pages[0].id, None);
    assert_eq!(
        wiki_pages_path("p1", "w1", "/A B", Some("main")),
        "/p1/_apis/wiki/wikis/w1/pages?path=%2FA%20B&versionDescriptor.version=main"
    );
    assert_eq!(image_mime("/.attachments/a.PNG"), Some("image/png"));
    assert_eq!(image_mime("/.attachments/a.svg"), None);
}

#[test]
fn builds_wiql_for_each_search() {
    let mine = WorkItemFilter::default();
    assert!(wiql_for("", &mine, &[])
        .unwrap()
        .contains("[System.AssignedTo] = @Me"));
    assert!(wiql_for("", &mine, &[]).unwrap().contains("'已關閉'"));
    assert_eq!(wiql_for("#123", &mine, &[]), None);
    let all = WorkItemFilter {
        person: "".into(),
        state: "all".into(),
        kind: Some("Bug".into()),
        project: Some("產品".into()),
        ..Default::default()
    };
    let q = wiql_for("登入 bug", &all, CONTENT_FIELDS[0]).unwrap();
    assert!(!q.contains("@Me") && !q.contains("[System.State]"));
    assert!(q.contains("[System.WorkItemType] = 'Bug'"));
    assert!(q.contains("[System.TeamProject] = '產品'"));
    assert!(q.contains(
        "([System.Title] CONTAINS '登入 bug' OR [System.Description] CONTAINS WORDS '登入 bug'"
    ));
    assert!(q.contains("[Microsoft.VSTS.Common.AcceptanceCriteria] CONTAINS WORDS"));
    let closed = WorkItemFilter {
        person: " ".into(),
        state: "closed".into(),
        ..Default::default()
    };
    assert!(wiql_for("", &closed, &[])
        .unwrap()
        .contains("[System.State] IN ("));
    let none = WorkItemFilter {
        state: "all".into(),
        ..closed
    };
    assert!(wiql_for("", &none, &[])
        .unwrap()
        .contains("WHERE [System.Id] > 0"));
    assert!(wiql_for("it's", &mine, &[]).unwrap().contains("'it''s'"));
    // 依人與區域。
    let by = WorkItemFilter {
        role: "created".into(),
        person: "王小明".into(),
        area: Some(" 產品\\前端 ".into()),
        ..Default::default()
    };
    let q = wiql_for("", &by, &[]).unwrap();
    assert!(q.contains("[System.CreatedBy] CONTAINS '王小明'"));
    assert!(!q.contains("AssignedTo"));
    assert!(q.contains("[System.AreaPath] UNDER '產品\\前端'"));
    let me = WorkItemFilter {
        role: "created".into(),
        ..Default::default()
    };
    assert!(wiql_for("", &me, &[])
        .unwrap()
        .contains("[System.CreatedBy] = @Me"));
}

#[test]
fn flattens_areas_and_members() {
    let tree = json!({"name": "產品", "children": [
        {"name": "前端", "children": [{"name": "登入"}]},
        {"name": "後端"}
    ]});
    assert_eq!(
        area_paths(&tree),
        ["產品\\前端", "產品\\前端\\登入", "產品\\後端"]
    );
    let members = json!({"value": [
        {"identity": {"displayName": "王小明"}},
        {"displayName": "Amy Lin"},
        {"identity": {"displayName": "[產品]\\Contributors", "isContainer": true}},
        {"identity": {"displayName": " "}}
    ]});
    assert_eq!(member_names(&members), ["王小明", "Amy Lin"]);
}

#[test]
fn searches_wikis() {
    assert_eq!(
        search_base("https://dev.azure.com/acme"),
        "https://almsearch.dev.azure.com/acme"
    );
    assert_eq!(
        search_base("https://acme.visualstudio.com/DefaultCollection"),
        "https://acme.almsearch.visualstudio.com/DefaultCollection"
    );
    assert_eq!(search_base("https://tfs/DC"), "https://tfs/DC");
    let v = json!({"results": [
        {"path": "/產品/安裝-說明.md", "hits": [{"fieldReferenceName": "fileName", "highlights": ["x"]},
            {"fieldReferenceName": "content", "highlights": ["先<highlighthit>安裝</highlighthit>工具"]}]},
        {"path": "/首頁.md"}
    ]});
    let hits = wiki_hits(&v);
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].snippet, "先<highlighthit>安裝</highlighthit>工具");
    assert_eq!(hits[1].snippet, "");
}

#[test]
fn reads_text_files() {
    assert_eq!(
        text_of("\u{feff}# 標題".as_bytes().to_vec()).unwrap(),
        "# 標題"
    );
    assert!(text_of(vec![0x89, b'P', b'N', b'G', 0, 0]).is_err());
    assert_eq!(text_of(vec![b'a', 0xff, b'b']).unwrap(), "a\u{fffd}b");
}

#[test]
fn builds_work_item_change() {
    let change = WorkItemChange {
        state: Some("Resolved".into()),
        assign_to_me: true,
        comment: Some("<p>好了</p>".into()),
        rev: Some(7),
    };
    let ops = change_ops(&change, "CORP\\ming");
    assert_eq!(ops.len(), 4);
    assert_eq!(ops[0], json!({"op": "test", "path": "/rev", "value": 7}));
    assert_eq!(ops[1]["path"], "/fields/System.State");
    assert_eq!(ops[2]["value"], "CORP\\ming");
    assert_eq!(ops[3]["path"], "/fields/System.History");
    let empty = WorkItemChange {
        comment: Some("  ".into()),
        ..Default::default()
    };
    assert!(change_ops(&empty, "x").is_empty());
}

#[test]
fn reads_states_from_transitions() {
    let v = json!({"transitions": {"": [{"to": "New"}], "New": [{"to": "Active"}], "Active": [{"to": "Resolved"}, {"to": "New"}]}});
    let states = states_from_transitions(&v);
    assert_eq!(states.len(), 3);
    assert!(states.contains(&"Resolved".to_string()));
    assert!(!states.contains(&String::new()));
}

#[test]
fn reads_work_item_relations() {
    let v = json!({"relations": [
        {"rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://tfs/DC/_apis/wit/workItems/10", "attributes": {"name": "Parent"}},
        {"rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://tfs/DC/_apis/wit/workItems/11", "attributes": {"name": "Child"}},
        {"rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://tfs/DC/_apis/wit/workItems/11", "attributes": {"name": "Child"}},
        {"rel": "Microsoft.VSTS.Common.TestedBy-Forward", "url": "https://tfs/DC/_apis/wit/workitems/12", "attributes": {"name": "Tested By"}},
        {"rel": "AttachedFile", "url": "https://tfs/DC/_apis/wit/attachments/abc", "attributes": {"name": "a.png"}},
        {"rel": "ArtifactLink", "url": "vstfs:///Git/Commit/x", "attributes": {"name": "Fixed in Commit"}},
        {"rel": "System.LinkTypes.Related", "url": "https://tfs/DC/_apis/wit/workItems/13"}
    ]});
    assert_eq!(
        relation_links(&v),
        vec![
            ("parent", "Parent".to_string(), 10),
            ("child", "Child".to_string(), 11),
            ("other", "Tested By".to_string(), 12),
            ("related", "System.LinkTypes.Related".to_string(), 13),
        ]
    );
    assert!(relation_links(&json!({})).is_empty());
}

#[test]
fn classifies_ping() {
    let ok = r#"{"authenticatedUser":{"providerDisplayName":"王小明"}}"#;
    assert_eq!(ping_of(200, ok).status, "ok");
    assert_eq!(ping_of(200, ok).name.as_deref(), Some("王小明"));
    assert_eq!(ping_of(200, "<html>login</html>").status, "auth");
    assert_eq!(
        ping_of(
            200,
            r#"{"authenticatedUser":{"providerDisplayName":"Anonymous"}}"#
        )
        .status,
        "auth"
    );
    assert_eq!(ping_of(401, "").status, "auth");
    assert_eq!(ping_of(500, "").status, "error");
}

#[test]
fn reads_comments_oldest_first() {
    let v = json!({"comments": [
        {"text": "<p>第二則</p>", "createdBy": {"displayName": "B"}, "createdDate": "2026-10-02T00:00:00Z"},
        {"text": "  ", "createdBy": {"displayName": "空"}, "createdDate": "2026-10-03T00:00:00Z"},
        {"text": "<p>第一則</p>", "createdBy": {"displayName": "A"}, "createdDate": "2026-10-01T00:00:00Z"}
    ]});
    let c = comments_of(&v);
    assert_eq!(c.len(), 2);
    assert_eq!((c[0].author.as_str(), c[1].author.as_str()), ("A", "B"));
}

#[test]
fn reads_tfs_2019_comments() {
    // 5.0-preview.2 的留言用 revisedBy／revisedDate，不是 createdBy／createdDate。
    let v = json!({"totalCount": 2, "comments": [
        {"revision": 5, "text": "<div>已正常顯示</div>", "revisedBy": {"displayName": "晉萱", "uniqueName": "DOMAIN\\u1"}, "revisedDate": "2026-10-29T03:00:00Z"},
        {"revision": 3, "text": "<div>請協助確認</div>", "revisedBy": {"displayName": "林冠霖"}, "revisedDate": "2026-10-28T03:00:00Z"}
    ]});
    let c = comments_of(&v);
    assert_eq!(
        c.iter()
            .map(|c| (c.author.as_str(), c.created.as_deref()))
            .collect::<Vec<_>>(),
        [
            ("林冠霖", Some("2026-10-28T03:00:00Z")),
            ("晉萱", Some("2026-10-29T03:00:00Z"))
        ]
    );
}

#[test]
fn reads_work_item_fields() {
    let v = json!({"id": 42, "fields": {
        "System.Title": "修正登入", "System.State": "Active", "System.WorkItemType": "Bug",
        "System.TeamProject": "產品", "System.AssignedTo": {"displayName": "王小明"},
        "Microsoft.VSTS.TCM.ReproSteps": "<div>步驟</div>",
        "System.Tags": "前端; 登入 ;", "Microsoft.VSTS.Common.Priority": 2,
        "System.AreaPath": "產品\\前端"
    }});
    let d = detail_of("https://tfs/DC", &v).unwrap();
    assert_eq!(d.tags, ["前端", "登入"]);
    assert_eq!(d.item.priority, Some(2));
    assert_eq!(d.area.as_deref(), Some("產品\\前端"));
    assert_eq!(d.iteration, None);
    assert_eq!(d.item.title, "修正登入");
    assert_eq!(d.item.assigned_to.as_deref(), Some("王小明"));
    assert_eq!(d.details.as_deref(), Some("<div>步驟</div>"));
    assert_eq!(
        d.item.web_url,
        "https://tfs/DC/%E7%94%A2%E5%93%81/_workitems/edit/42"
    );
    assert_eq!(
        person(Some(&json!("王小明 <CORP\\ming>"))).as_deref(),
        Some("王小明")
    );
}
