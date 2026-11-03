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
        ..Default::default()
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
fn create_ops_prefer_the_chosen_assignee() {
    // 從團隊成員清單選的帳號優先，不看「指派給我」。
    let item = NewWorkItem {
        kind: "Task".into(),
        title: "x".into(),
        assign_to_me: true,
        assigned_to: Some(" CORP\\00595436 ".into()),
        ..Default::default()
    };
    let ops = create_ops(&item, "00595436", "https://tfs/DC");
    assert_eq!(ops[1]["path"], "/fields/System.AssignedTo");
    assert_eq!(ops[1]["value"], "CORP\\00595436");
    // 空白的等於沒選：照「指派給我」。
    let blank = NewWorkItem {
        assigned_to: Some("  ".into()),
        ..item
    };
    assert_eq!(
        create_ops(&blank, "王小明", "https://tfs/DC")[1]["value"],
        "王小明"
    );
}

#[test]
fn assign_me_uses_name_when_account_has_no_domain() {
    let mut a = Account {
        url: "https://tfs.corp.com/tfs/DC".into(),
        name: " 詹智丞 ".into(),
        account: Some("CORP\\00595436".into()),
    };
    assert_eq!(assign_me(&a), "CORP\\00595436");
    a.account = Some("ming@corp.com".into());
    assert_eq!(assign_me(&a), "ming@corp.com");
    // 只有帳號本身（員工編號）：伺服器認不得，改用顯示名稱。
    a.account = Some("00595436".into());
    assert_eq!(assign_me(&a), "詹智丞");
    a.account = None;
    assert_eq!(assign_me(&a), "詹智丞");
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
    // 依伺服器上的順序排（和網頁版目錄一樣）；沒有順序的排在後面。
    let ordered = json!({"path": "/", "subPages": [
        {"path": "/C"}, {"path": "/B", "order": 1}, {"path": "/A", "order": 0}
    ]});
    let names: Vec<_> = page_tree(&ordered).into_iter().map(|p| p.path).collect();
    assert_eq!(names, ["/A", "/B", "/C"]);
    assert_eq!(
        wiki_moves_path("p 1", "w1"),
        "/p%201/_apis/wiki/wikis/w1/pagemoves"
    );
    assert_eq!(
        page_move_body("/產品", "/產品", Some(2)),
        json!({"path": "/產品", "newPath": "/產品", "newOrder": 2})
    );
    assert_eq!(
        page_move_body("/A", "/B/A", None),
        json!({"path": "/A", "newPath": "/B/A"})
    );
    assert_eq!(
        wiki_page_by_id_path("p 1", "w1", 53081),
        "/p%201/_apis/wiki/wikis/w1/pages/53081"
    );
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
        kinds: vec!["Bug".into()],
        projects: vec!["產品".into()],
        ..Default::default()
    };
    let q = wiql_for("登入 bug", &all, CONTENT_FIELDS[0]).unwrap();
    assert!(!q.contains("@Me") && !q.contains("[System.State]"));
    assert!(q.contains("[System.WorkItemType] IN ('Bug')"));
    assert!(q.contains("[System.TeamProject] IN ('產品')"));
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
        areas: vec![" 產品\\前端 ".into(), "".into()],
        ..Default::default()
    };
    let q = wiql_for("", &by, &[]).unwrap();
    assert!(q.contains("[System.CreatedBy] CONTAINS '王小明'"));
    assert!(!q.contains("AssignedTo"));
    assert!(q.contains("([System.AreaPath] UNDER '產品\\前端')"));
    // 多選：類型、專案用 IN，區域用 OR；重複與空白的值略過。
    let many = WorkItemFilter {
        kinds: vec!["Bug".into(), "Task".into(), "Bug".into()],
        projects: vec!["A".into(), " ".into(), "B".into()],
        areas: vec!["A\\前端".into(), "B".into()],
        ..Default::default()
    };
    let q = wiql_for("", &many, &[]).unwrap();
    assert!(q.contains("[System.WorkItemType] IN ('Bug', 'Task')"));
    assert!(q.contains("[System.TeamProject] IN ('A', 'B')"));
    assert!(q.contains("([System.AreaPath] UNDER 'A\\前端' OR [System.AreaPath] UNDER 'B')"));
    let me = WorkItemFilter {
        role: "created".into(),
        ..Default::default()
    };
    assert!(wiql_for("", &me, &[])
        .unwrap()
        .contains("[System.CreatedBy] = @Me"));
    // 指定狀態：用 IN 列出來，不再套「進行中」的條件。
    let picked = WorkItemFilter {
        states: vec!["New".into(), "Active".into(), "New".into()],
        ..Default::default()
    };
    let q = wiql_for("", &picked, &[]).unwrap();
    assert!(q.contains("[System.State] IN ('New', 'Active')"));
    assert!(!q.contains("NOT IN"));
}

#[test]
fn lists_states_for_the_filter_in_workflow_order() {
    // 新版：類型定義有 states（含分類）；舊版只有狀態轉換。
    let agile = json!({
        "name": "User Story",
        "states": [
            {"name": "New", "category": "Proposed"},
            {"name": "Active", "category": "InProgress"},
            {"name": "Resolved", "category": "Resolved"},
            {"name": "Closed", "category": "Completed"},
            {"name": "Removed", "category": "Removed"}
        ]
    });
    let old = json!({
        "name": "Task",
        "transitions": {"": [{"to": "To Do"}], "To Do": [{"to": "Doing"}], "Doing": [{"to": "Done"}]}
    });
    assert_eq!(
        type_states(&old),
        vec![
            (0, "To Do".to_string()),
            (1, "Doing".to_string()),
            (3, "Done".to_string())
        ]
    );
    let mut all = type_states(&agile);
    all.extend(type_states(&old));
    // 同名的只列一次（不分大小寫）。
    all.push((1, "active".into()));
    let merged = merge_states(all);
    let names: Vec<&str> = merged.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        ["New", "To Do", "Active", "Doing", "Resolved", "Closed", "Done", "Removed"]
    );
    let closed: Vec<&str> = merged
        .iter()
        .filter(|s| s.closed)
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(closed, ["Closed", "Done", "Removed"]);
    assert_eq!(
        merged.iter().map(|s| s.stage).collect::<Vec<_>>(),
        [0, 0, 1, 1, 2, 3, 3, 4]
    );
}

#[test]
fn groups_states_by_project_and_kind() {
    let types = json!({"value": [
        {"name": "Task", "states": [{"name": "New", "category": "Proposed"}, {"name": "Done", "category": "Completed"}]},
        {"name": "Test Case", "states": [{"name": "Design", "category": "Proposed"}]},
        {"name": "Bug", "transitions": {"": [{"to": "Active"}], "Active": [{"to": "Closed"}]}},
        {"name": "Empty"}
    ]});
    let sets = kind_states("Mgt", &types);
    // 測試、程式碼檢閱等類型不列；沒有狀態的類型也不列。
    let kinds: Vec<(&str, &str)> = sets
        .iter()
        .map(|s| (s.project.as_str(), s.kind.as_str()))
        .collect();
    assert_eq!(kinds, [("Mgt", "Task"), ("Mgt", "Bug")]);
    let bug: Vec<&str> = sets[1].states.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(bug, ["Active", "Closed"]);
    assert!(sets[0].states[1].closed);
}

#[test]
fn builds_children_query_with_the_same_filter() {
    let f = WorkItemFilter {
        person: "".into(),
        state: "all".into(),
        projects: vec!["Mgt".into()],
        areas: vec!["Mgt\\Comet".into()],
        ..Default::default()
    };
    let q = children_wiql(&[1657675, 42], "", &f, &[]);
    assert!(q.starts_with(
        "SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] IN (1657675, 42)"
    ));
    assert!(q.contains("[System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'"));
    // 篩選條件套在子項目（Target）上。
    assert!(q.contains("[Target].[System.TeamProject] IN ('Mgt')"));
    assert!(q.contains("([Target].[System.AreaPath] UNDER 'Mgt\\Comet')"));
    assert!(!q.contains("[Target].[System.State]"), "全部狀態不加條件");
    assert!(q.ends_with("MODE (MustContain)"));
    let mine = children_wiql(&[1], "登入", &WorkItemFilter::default(), CONTENT_FIELDS[1]);
    assert!(mine.contains("[Target].[System.AssignedTo] = @Me"));
    assert!(mine.contains("[Target].[System.State] NOT IN ("));
    assert!(mine.contains("([Target].[System.Title] CONTAINS '登入' OR [Target].[System.Description] CONTAINS WORDS '登入')"));
}

#[test]
fn reads_child_links_from_link_query() {
    let res = json!({"workItemRelations": [
        {"rel": null, "source": null, "target": {"id": 1657675}},
        {"rel": "System.LinkTypes.Hierarchy-Forward", "source": {"id": 1657675}, "target": {"id": 1897033}},
        {"rel": "System.LinkTypes.Hierarchy-Forward", "source": {"id": 1657675}, "target": {"id": 1896200}},
        {"rel": "System.LinkTypes.Related", "source": {"id": 1657675}, "target": {"id": 5}}
    ]});
    assert_eq!(
        child_links(&res),
        vec![(1897033, 1657675), (1896200, 1657675)]
    );
    assert!(child_links(&json!({})).is_empty());
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
        ..Default::default()
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
fn builds_work_item_field_changes() {
    let change = WorkItemChange {
        title: Some("  新標題 ".into()),
        priority: Some(1),
        iteration: Some("P\\Sprint 3".into()),
        tags: Some(vec![
            "UAT".into(),
            " uat ".into(),
            "a;b".into(),
            "".into(),
            "AI 聊天".into(),
        ]),
        rev: Some(3),
        ..Default::default()
    };
    assert!(check_change(&change).is_ok());
    let ops = change_ops(&change, "me");
    assert_eq!(ops[0]["op"], "test");
    assert_eq!(
        ops[1],
        json!({"op": "add", "path": "/fields/System.Title", "value": "新標題"})
    );
    assert_eq!(
        ops[2],
        json!({"op": "add", "path": "/fields/Microsoft.VSTS.Common.Priority", "value": 1})
    );
    assert_eq!(
        ops[3],
        json!({"op": "add", "path": "/fields/System.IterationPath", "value": "P\\Sprint 3"})
    );
    assert_eq!(
        ops[4],
        json!({"op": "add", "path": "/fields/System.Tags", "value": "UAT; a b; AI 聊天"})
    );
    // 空的標籤清單：清除所有標籤。
    let clear = WorkItemChange {
        tags: Some(vec![]),
        ..Default::default()
    };
    assert_eq!(change_ops(&clear, "me")[0]["value"], "");
    // 標題不可以是空的或太長；優先順序只能是 1～4。
    let blank = WorkItemChange {
        title: Some("  ".into()),
        ..Default::default()
    };
    assert!(check_change(&blank).is_err());
    let long = WorkItemChange {
        title: Some("字".repeat(MAX_TITLE + 1)),
        ..Default::default()
    };
    assert!(check_change(&long).is_err());
    let ok = WorkItemChange {
        title: Some("字".repeat(MAX_TITLE)),
        ..Default::default()
    };
    assert!(check_change(&ok).is_ok());
    for p in [0, 5] {
        assert!(check_change(&WorkItemChange {
            priority: Some(p),
            ..Default::default()
        })
        .is_err());
    }
}

#[test]
fn builds_long_text_field_changes() {
    let change = WorkItemChange {
        description: Some(" <p>說明</p> ".into()),
        acceptance_criteria: Some("".into()),
        repro_steps: Some("<ol><li>步驟</li></ol>".into()),
        ..Default::default()
    };
    let ops = change_ops(&change, "me");
    assert_eq!(
        ops[0],
        json!({"op": "add", "path": "/fields/System.Description", "value": "<p>說明</p>"})
    );
    // 空字串：清除欄位。
    assert_eq!(
        ops[1],
        json!({"op": "add", "path": "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", "value": ""})
    );
    assert_eq!(ops[2]["path"], "/fields/Microsoft.VSTS.TCM.ReproSteps");
    assert!(change_ops(&WorkItemChange::default(), "me").is_empty());
}

#[test]
fn flattens_iterations() {
    let v = json!({
        "name": "P",
        "children": [
            {"name": "Release 1", "children": [
                {"name": "Sprint 1", "attributes": {"startDate": "2026-10-01T00:00:00Z", "finishDate": "2026-10-14T00:00:00Z"}},
            ]},
            {"name": "Backlog"},
        ]
    });
    let list = iteration_list(&v);
    let paths: Vec<&str> = list.iter().map(|i| i.path.as_str()).collect();
    assert_eq!(
        paths,
        ["P", "P\\Release 1", "P\\Release 1\\Sprint 1", "P\\Backlog"]
    );
    assert_eq!(list[2].start.as_deref(), Some("2026-10-01T00:00:00Z"));
    assert_eq!(list[2].finish.as_deref(), Some("2026-10-14T00:00:00Z"));
    assert_eq!(list[1].start, None);
}

#[test]
fn reads_states_from_transitions() {
    let v = json!({"transitions": {"": [{"to": "New"}], "New": [{"to": "Active"}], "Active": [{"to": "Resolved"}, {"to": "New"}]}});
    let states = states_from_transitions(&v);
    assert_eq!(states, ["New", "Active", "Resolved"]);
}

#[test]
fn orders_states_by_workflow_not_alphabetically() {
    // TFS 2019 的 Task（Agile）：JSON 物件讀進來是依字母排的，要照流程排回來。
    let v = json!({"transitions": {
        "": [{"to": "New"}],
        "Active": [{"to": "Closed"}, {"to": "New"}, {"to": "Removed"}, {"to": "Resolved"}],
        "Closed": [{"to": "Active"}],
        "New": [{"to": "Active"}, {"to": "Closed"}, {"to": "Removed"}],
        "Removed": [{"to": "New"}],
        "Resolved": [{"to": "Active"}, {"to": "Closed"}]
    }});
    assert_eq!(
        states_from_transitions(&v),
        ["New", "Active", "Resolved", "Closed", "Removed"]
    );
    // 新版 API 有分類：依分類排。
    let v = json!({"value": [
        {"name": "Closed", "category": "Completed"},
        {"name": "Removed", "category": "Removed"},
        {"name": "Active", "category": "InProgress"},
        {"name": "New", "category": "Proposed"},
        {"name": "Resolved", "category": "Resolved"}
    ]});
    assert_eq!(
        states_by_category(&v),
        ["New", "Active", "Resolved", "Closed", "Removed"]
    );
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
    let c = comments_of(&v, false);
    assert_eq!(c.len(), 2);
    assert_eq!((c[0].author.as_str(), c[1].author.as_str()), ("A", "B"));
    assert_eq!(c[0].id, None);
}

#[test]
fn editable_comments_keep_their_id_and_skip_deleted_ones() {
    let v = json!({"comments": [
        {"id": 7, "text": "<p>留著</p>", "createdBy": {"displayName": "A"}, "createdDate": "2026-10-01T00:00:00Z"},
        {"id": 8, "isDeleted": true, "text": "<p>刪掉了</p>", "createdBy": {"displayName": "A"}, "createdDate": "2026-10-02T00:00:00Z"}
    ]});
    let c = comments_of(&v, true);
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].id, Some(7));
}

#[test]
fn reads_tfs_2019_comments() {
    // 5.0-preview.2 的留言用 revisedBy／revisedDate，不是 createdBy／createdDate。
    let v = json!({"totalCount": 2, "comments": [
        {"revision": 5, "text": "<div>已正常顯示</div>", "revisedBy": {"displayName": "晉萱", "uniqueName": "DOMAIN\\u1"}, "revisedDate": "2026-10-29T03:00:00Z"},
        {"revision": 3, "text": "<div>請協助確認</div>", "revisedBy": {"displayName": "林冠霖"}, "revisedDate": "2026-10-28T03:00:00Z"}
    ]});
    let c = comments_of(&v, false);
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
        "Microsoft.VSTS.TCM.ReproSteps": "<div>步驟</div>", "Microsoft.VSTS.TCM.SystemInfo": "<div>Chrome</div>",
        "System.Reason": "Fixed",
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
    assert_eq!(d.system_info.as_deref(), Some("<div>Chrome</div>"));
    assert_eq!(d.reason.as_deref(), Some("Fixed"));
    assert_eq!(
        d.item.web_url,
        "https://tfs/DC/%E7%94%A2%E5%93%81/_workitems/edit/42"
    );
    assert_eq!(
        person(Some(&json!("王小明 <CORP\\ming>"))).as_deref(),
        Some("王小明")
    );
}

#[test]
fn reads_work_item_attachments_newest_first() {
    let v = json!({"relations": [
        {"rel": "AttachedFile", "url": "https://tfs/DC/_apis/wit/attachments/a1", "attributes": {"name": "舊.md", "resourceSize": 512, "resourceCreatedDate": "2026-10-05T06:38:00Z"}},
        {"rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://tfs/DC/_apis/wit/workItems/7"},
        {"rel": "AttachedFile", "url": "https://tfs/DC/_apis/wit/attachments/b2", "attributes": {"name": " 新.png ", "resourceSize": 2048, "resourceCreatedDate": "2026-10-29T03:00:00Z", "comment": "截圖"}},
        {"rel": "AttachedFile", "url": "https://tfs/DC/_apis/wit/attachments/c3", "attributes": {}}
    ]});
    let list = attachments_of(&v);
    assert_eq!(
        list.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
        ["新.png", "舊.md", "c3"]
    );
    assert_eq!(list[0].size, Some(2048));
    assert_eq!(list[0].comment.as_deref(), Some("截圖"));
    assert_eq!(list[2].created, None);
}

#[test]
fn attachment_names_are_safe_and_runnable_files_are_flagged() {
    assert_eq!(safe_file_name("..\\..\\evil.md"), ".._.._evil.md");
    assert_eq!(safe_file_name("a/b:c?.txt"), "a_b_c_.txt");
    assert_eq!(safe_file_name("報告.md. "), "報告.md");
    assert_eq!(safe_file_name("CON.txt"), "_CON.txt");
    assert_eq!(safe_file_name("com1"), "_com1");
    assert_eq!(safe_file_name("company.txt"), "company.txt");
    assert_eq!(safe_file_name("   "), tr!("附件"));
    assert!(safe_file_name(&"字".repeat(300)).chars().count() <= 150);
    assert!(is_runnable("setup.EXE"));
    assert!(is_runnable("run.bat. "));
    assert!(is_runnable("x.ps1"));
    assert!(!is_runnable("報表.xlsx"));
    assert!(!is_runnable("說明.md"));
    assert!(!is_runnable("noext"));
}

#[test]
fn lists_teams_with_the_default_first() {
    let v = json!({"value": [
        {"id": "B", "name": "前端"},
        {"id": "a1", "name": "ITA"},
        {"id": "C", "name": "後端"}
    ]});
    let teams = teams_of(&v, Some("A1"));
    let names: Vec<&str> = teams.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["ITA", "前端", "後端"]);
    assert!(teams[0].default);
}

#[test]
fn orders_team_iterations_by_start_date() {
    let v = json!({"value": [
        {"id": "2", "name": "Sprint 102", "path": "P\\Sprint 102", "attributes": {"startDate": "2026-10-26T00:00:00Z", "finishDate": "2026-11-06T00:00:00Z", "timeFrame": "current"}},
        {"id": "x", "name": "未排定", "path": "P\\未排定", "attributes": {}},
        {"id": "1", "name": "Sprint 101", "path": "P\\Sprint 101", "attributes": {"startDate": "2026-10-12T00:00:00Z", "timeFrame": "past"}}
    ]});
    let list = team_iterations_of(&v);
    let names: Vec<&str> = list.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["Sprint 101", "Sprint 102", "未排定"]);
    assert!(list[1].current && !list[0].current);
}

#[test]
fn board_query_uses_the_team_area() {
    let scope = json!({"field": {"referenceName": "System.AreaPath"}, "values": [
        {"value": "P\\ITA", "includeChildren": true},
        {"value": "P\\共用", "includeChildren": false}
    ]});
    let q = board_wiql("P", "P\\Sprint 102", Some(&scope));
    assert!(
        q.contains("[System.IterationPath] = 'P\\Sprint 102'"),
        "{q}"
    );
    assert!(
        q.contains("([System.AreaPath] UNDER 'P\\ITA' OR [System.AreaPath] = 'P\\共用')"),
        "{q}"
    );
    assert!(q.contains("<> 'Removed'"));
    // 欄位名稱怪怪的（可能被竄改）：改用區域路徑。
    let odd = json!({"field": {"referenceName": "X] OR 1=1 --"}, "values": [{"value": "v"}]});
    assert!(board_wiql("P", "I", Some(&odd)).contains("[System.AreaPath] = 'v'"));
    // 名稱裡的單引號要跳脫。
    assert!(board_wiql("P", "it's", None).contains("'it''s'"));
}

#[test]
fn reads_board_items_with_parent_and_hours() {
    let v = json!({"id": 1936947, "rev": 4, "fields": {
        "System.Title": "提供SRE監控", "System.State": "New", "System.WorkItemType": "Task",
        "System.TeamProject": "P", "System.AssignedTo": {"displayName": "梁朝為"},
        "Microsoft.VSTS.Scheduling.RemainingWork": 6.5, "Microsoft.VSTS.Scheduling.CompletedWork": 1
    }, "relations": [
        {"rel": "System.LinkTypes.Related", "url": "https://ado.test/c/_apis/wit/workItems/5"},
        {"rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://ado.test/c/_apis/wit/workItems/1931940"}
    ]});
    let b = board_item_of("https://ado.test/c", &v).unwrap();
    assert_eq!(b.item.id, 1936947);
    assert_eq!(b.parent, Some(1931940));
    assert_eq!(b.rev, Some(4));
    assert_eq!(
        (b.remaining, b.completed, b.original),
        (Some(6.5), Some(1.0), None)
    );
}

#[test]
fn change_assigns_someone_and_sets_hours() {
    let change = WorkItemChange {
        assigned_to: Some("CORP\\hua".into()),
        remaining: Some(3.5),
        completed: Some(0.0),
        ..Default::default()
    };
    let ops = change_ops(&change, "CORP\\ming");
    let fields: Vec<(String, Value)> = ops
        .iter()
        .map(|op| {
            (
                op["path"].as_str().unwrap().to_string(),
                op["value"].clone(),
            )
        })
        .collect();
    assert!(fields.contains(&("/fields/System.AssignedTo".into(), json!("CORP\\hua"))));
    assert!(fields.contains(&(
        "/fields/Microsoft.VSTS.Scheduling.RemainingWork".into(),
        json!(3.5)
    )));
    assert!(fields.contains(&(
        "/fields/Microsoft.VSTS.Scheduling.CompletedWork".into(),
        json!(0.0)
    )));
    // 空字串是取消指派。
    let none = WorkItemChange {
        assigned_to: Some(String::new()),
        ..Default::default()
    };
    assert_eq!(change_ops(&none, "me")[0]["value"], "");
    // 工時不能是負的。
    let bad = WorkItemChange {
        remaining: Some(-1.0),
        ..Default::default()
    };
    assert!(check_change(&bad).is_err());
}

#[test]
fn reads_team_members_from_old_and_new_servers() {
    // 5.0 以後包在 identity 裡；4.1 直接是身分。停用的帳號不列出，重複的只留一個。
    let v = json!({ "value": [
        { "identity": { "displayName": "王小明", "uniqueName": "CORP\\ming" } },
        { "displayName": "李大同", "uniqueName": "CORP\\tong" },
        { "identity": { "displayName": "已離職", "uniqueName": "CORP\\gone", "inactive": true } },
        { "identity": { "displayName": "王小明", "uniqueName": "corp\\MING" } }
    ]});
    let list = team_members_of(&v);
    let names: Vec<&str> = list.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names.len(), 2);
    assert!(names.contains(&"王小明") && names.contains(&"李大同"));
    // 有身分編號時帶回來（留言 @ 人用），沒有時是空字串。
    let v = json!({ "value": [{ "identity": { "id": "a1b2", "displayName": "王小明", "uniqueName": "CORP\\ming" } }]});
    assert_eq!(team_members_of(&v)[0].id, "a1b2");
    assert_eq!(list[0].id, "");
}

#[test]
fn reads_people_from_identity_search() {
    // 網域帳號寫成「網域\帳號」；沒有伺服器身分（localId 是空的）的不列出；重複的只留一個。
    let v = json!({ "results": [{ "queryToken": "王", "identities": [
        { "localId": "id-1", "displayName": "王小明", "scopeName": "CORP", "samAccountName": "ming" },
        { "localId": null, "displayName": "沒登入過", "scopeName": "CORP", "samAccountName": "never" },
        { "localId": "", "displayName": "也沒登入過" },
        { "localId": "id-2", "displayName": "Wang Da", "signInAddress": "da@corp.test" },
        { "localId": "ID-1", "displayName": "王小明", "scopeName": "CORP", "samAccountName": "ming" }
    ]}]});
    let list = picked_people(&v);
    assert_eq!(
        list,
        vec![
            TeamMember {
                name: "王小明".into(),
                unique: "CORP\\ming".into(),
                id: "id-1".into()
            },
            TeamMember {
                name: "Wang Da".into(),
                unique: "da@corp.test".into(),
                id: "id-2".into()
            },
        ]
    );
    assert!(picked_people(&json!({})).is_empty());
}

#[test]
fn new_task_goes_into_the_sprint_with_hours() {
    let task = NewWorkItem {
        kind: "Task".into(),
        title: "寫測試".into(),
        iteration: Some("產品\\Sprint 102".into()),
        remaining: Some(4.0),
        parent: Some(7),
        ..Default::default()
    };
    let ops = create_ops(&task, "me", "https://tfs/DC");
    let paths: Vec<&str> = ops.iter().map(|o| o["path"].as_str().unwrap()).collect();
    assert!(paths.contains(&"/fields/System.IterationPath"));
    assert!(paths.contains(&"/fields/Microsoft.VSTS.Scheduling.RemainingWork"));
    assert_eq!(
        ops.iter()
            .find(|o| o["path"] == "/fields/System.IterationPath")
            .unwrap()["value"],
        "產品\\Sprint 102"
    );
}

#[test]
fn diagnostics_remove_people_titles_and_server_name() {
    let mut v = serde_json::json!({
        "authenticatedUser": { "providerDisplayName": "王小明" },
        "value": [{
            "id": 42,
            "url": "https://tfs.corp.local/tfs/Coll/_apis/wit/workItems/42",
            "fields": {
                "System.Title": "修正登入",
                "System.State": "Active",
                "System.AssignedTo": { "displayName": "王小明", "uniqueName": "corp\\ming" },
                "System.Description": "<p>聯絡 ming.wang@corp.com</p>",
                "System.Tags": "寄給 ming.wang@corp.com"
            }
        }]
    });
    diagnose::anonymize(&mut v, "https://tfs.corp.local/tfs/Coll");
    let text = v.to_string();
    for secret in [
        "王小明",
        "修正登入",
        "ming.wang",
        "corp.com",
        "tfs.corp.local",
        "corp\\\\ming",
    ] {
        assert!(!text.contains(secret), "還留著「{secret}」：{text}");
    }
    let fields = &v["value"][0]["fields"];
    assert_eq!(fields["System.State"], "Active", "狀態等結構照留");
    assert_eq!(v["value"][0]["id"], 42);
    assert!(v["value"][0]["url"]
        .as_str()
        .unwrap()
        .starts_with("https://tfs.example/tfs/Coll/"));
    assert!(
        fields["System.Title"].as_str().unwrap().contains('4'),
        "標題只留長度"
    );
}

#[test]
fn api_version_maps_to_server_release() {
    assert!(diagnose::server_of("5.0").contains("2019"));
    assert!(diagnose::server_of("6.0").contains("2020"));
    assert!(diagnose::server_of("4.1").contains("2018"));
    assert!(diagnose::server_of("2.0").contains("2017"));
}

#[test]
fn reads_capacity_from_old_and_new_servers() {
    let old = json!({ "value": [{
        "teamMember": { "displayName": "王小明" },
        "activities": [{ "capacityPerDay": 4.0, "name": "Development" }, { "capacityPerDay": 2.0, "name": "Testing" }],
        "daysOff": [{ "start": "2026-11-03T00:00:00Z", "end": "2026-11-04T00:00:00Z" }]
    }]});
    let team =
        json!({ "daysOff": [{ "start": "2026-11-05T00:00:00Z", "end": "2026-11-05T00:00:00Z" }] });
    let c = capacity_of(&old, Some(&team));
    assert_eq!(c.members.len(), 1);
    assert_eq!(c.members[0].per_day, 6.0);
    assert_eq!(c.members[0].days_off.len(), 1);
    assert_eq!(c.team_days_off.len(), 1);
    let new = json!({ "teamMembers": [{ "teamMember": { "displayName": "李大同" }, "activities": [], "daysOff": [] }] });
    let c = capacity_of(&new, None);
    assert_eq!(c.members[0].name, "李大同");
    assert_eq!(c.members[0].per_day, 0.0);
    assert!(c.team_days_off.is_empty());
}

#[test]
fn backlog_query_and_iteration() {
    let scope = json!({ "field": { "referenceName": "System.AreaPath" }, "values": [{ "value": "產品\\前端", "includeChildren": true }] });
    let q = backlog_wiql(
        "產品",
        "產品",
        Some(&scope),
        Some("Microsoft.VSTS.Common.StackRank"),
    );
    assert!(q.contains("[System.IterationPath] = '產品'"));
    assert!(q.contains("IN GROUP 'Microsoft.RequirementCategory'"));
    assert!(q.contains("[System.AreaPath] UNDER '產品\\前端'"));
    assert!(q.ends_with("ORDER BY [Microsoft.VSTS.Common.StackRank]"));
    assert!(backlog_wiql("P", "P", None, None).ends_with("ORDER BY [System.Id]"));
    // 分類節點的路徑換成 WIQL 用的；沒有路徑時用名稱，再沒有就用專案名稱。
    let s = json!({ "backlogIteration": { "name": "產品", "path": "\\產品\\Iteration\\發行 1" } });
    assert_eq!(backlog_iteration_of(&s, "產品"), "產品\\發行 1");
    assert_eq!(
        backlog_iteration_of(
            &json!({ "backlogIteration": { "name": "產品", "path": "" } }),
            "x"
        ),
        "產品"
    );
    assert_eq!(backlog_iteration_of(&Value::Null, "產品"), "產品");
}

#[test]
fn wiki_file_paths_become_page_paths() {
    // 專案 Wiki：`-` 是空白、`%2D` 是 `-`；附件、.order、不是 .md 的不算。
    assert_eq!(
        page_of_git_path("/產品/安裝-說明.md", "/").as_deref(),
        Some("/產品/安裝 說明")
    );
    assert_eq!(
        page_of_git_path("/A%2DB/C%3A.md", "/").as_deref(),
        Some("/A-B/C:")
    );
    assert_eq!(page_of_git_path("/產品.MD", "/").as_deref(), Some("/產品"));
    assert_eq!(page_of_git_path("/.attachments/圖.png", "/"), None);
    assert_eq!(page_of_git_path("/產品/.order", "/"), None);
    assert_eq!(page_of_git_path("/.order", "/"), None);
    // 程式碼 Wiki：只看 Wiki 所在的資料夾（不分大小寫），路徑從那裡算起。
    assert_eq!(
        page_of_git_path("/Docs/Guide/Start.md", "/docs").as_deref(),
        Some("/Guide/Start")
    );
    assert_eq!(page_of_git_path("/src/readme.md", "/docs"), None);
    assert_eq!(page_of_git_path("/docs.md", "/docs"), None);
}

#[test]
fn lists_wiki_page_files_from_repository_items() {
    // 資料夾、附件、.order 不算；頁面路徑依 Wiki 的規則轉換，帶著內容的編號。
    let v = json!({ "value": [
        { "path": "/", "isFolder": true, "gitObjectType": "tree", "objectId": "t0" },
        { "path": "/產品", "isFolder": true, "gitObjectType": "tree", "objectId": "t1" },
        { "path": "/產品.md", "gitObjectType": "blob", "objectId": "b1" },
        { "path": "/產品/安裝-說明.md", "gitObjectType": "blob", "objectId": "b2" },
        { "path": "/產品/.order", "gitObjectType": "blob", "objectId": "b3" },
        { "path": "/.attachments/圖.png", "gitObjectType": "blob", "objectId": "b4" },
        { "path": "/沒有編號.md", "gitObjectType": "blob" }
    ]});
    assert_eq!(
        wiki_page_files(&v, "/"),
        vec![
            (
                "/產品".to_string(),
                "/產品.md".to_string(),
                "b1".to_string()
            ),
            (
                "/產品/安裝 說明".to_string(),
                "/產品/安裝-說明.md".to_string(),
                "b2".to_string()
            ),
        ]
    );
    // 程式碼 Wiki：只看 Wiki 所在的資料夾。
    let code = json!({ "value": [
        { "path": "/docs/Start.md", "gitObjectType": "blob", "objectId": "c1" },
        { "path": "/src/readme.md", "gitObjectType": "blob", "objectId": "c2" }
    ]});
    assert_eq!(
        wiki_page_files(&code, "/docs"),
        vec![(
            "/Start".to_string(),
            "/docs/Start.md".to_string(),
            "c1".to_string()
        )]
    );
}

#[test]
fn reads_changed_wiki_pages_of_a_commit() {
    let v = json!({ "changes": [
        { "item": { "path": "/產品", "gitObjectType": "tree" }, "changeType": "edit" },
        { "item": { "path": "/產品/安裝.md", "gitObjectType": "blob" }, "changeType": "edit" },
        { "item": { "path": "/產品/新頁面.md", "gitObjectType": "blob" }, "changeType": "add" },
        { "item": { "path": "/舊頁面.md", "gitObjectType": "blob" }, "changeType": "delete" },
        { "item": { "path": "/改名後.md", "gitObjectType": "blob" }, "changeType": "edit, rename" },
        { "item": { "path": "/產品/.order", "gitObjectType": "blob" }, "changeType": "edit" },
        { "item": { "path": "/產品/安裝.md" }, "changeType": "edit" }
    ]});
    assert_eq!(
        changed_pages(&v, "/"),
        vec![
            ("/產品/安裝".to_string(), "edit".to_string()),
            ("/產品/新頁面".to_string(), "add".to_string()),
            ("/舊頁面".to_string(), "delete".to_string()),
            ("/改名後".to_string(), "rename".to_string()),
        ]
    );
    assert!(changed_pages(&json!({}), "/").is_empty());
}

#[test]
fn builds_link_ops() {
    let rel = |rel: &str, id: u64| json!({"rel": rel, "url": format!("https://tfs/DC/_apis/wit/workItems/{id}")});
    let relations = vec![
        rel("System.LinkTypes.Hierarchy-Reverse", 10),
        rel("System.LinkTypes.Related", 20),
        json!({"rel": "AttachedFile", "url": "https://tfs/DC/_apis/wit/attachments/x"}),
        rel("System.LinkTypes.Hierarchy-Forward", 30),
    ];
    // 換上層：拿掉原本的上層，加新的；移除相關 #20；加子項目 #31（#30 已經有了不重複加）。
    let change = WorkItemChange {
        parent: Some(11),
        links_add: vec![
            LinkChange {
                kind: "child".into(),
                id: 31,
            },
            LinkChange {
                kind: "child".into(),
                id: 30,
            },
        ],
        links_remove: vec![LinkChange {
            kind: "related".into(),
            id: 20,
        }],
        ..Default::default()
    };
    let ops = link_ops(&change, &relations, "https://tfs/DC/", 42).unwrap();
    assert_eq!(
        ops[0],
        json!({"op": "remove", "path": "/relations/1"}),
        "由後往前移除"
    );
    assert_eq!(ops[1], json!({"op": "remove", "path": "/relations/0"}));
    assert_eq!(ops[2]["value"]["rel"], "System.LinkTypes.Hierarchy-Reverse");
    assert_eq!(
        ops[2]["value"]["url"],
        "https://tfs/DC/_apis/wit/workItems/11"
    );
    assert_eq!(
        ops[3]["value"]["url"],
        "https://tfs/DC/_apis/wit/workItems/31"
    );
    assert_eq!(ops.len(), 4);
    // 移除上層（0）：只有移除。
    let none = WorkItemChange {
        parent: Some(0),
        ..Default::default()
    };
    assert_eq!(
        link_ops(&none, &relations, "https://tfs/DC", 42).unwrap(),
        vec![json!({"op": "remove", "path": "/relations/0"})]
    );
    // 連到自己、看不懂的種類：不接受。
    let me = WorkItemChange {
        parent: Some(42),
        ..Default::default()
    };
    assert!(link_ops(&me, &relations, "https://tfs/DC", 42).is_err());
    let odd = WorkItemChange {
        links_add: vec![LinkChange {
            kind: "cousin".into(),
            id: 1,
        }],
        ..Default::default()
    };
    assert!(link_ops(&odd, &relations, "https://tfs/DC", 42).is_err());
}

#[test]
fn attaches_uploaded_files_from_this_server_only() {
    let change = WorkItemChange {
        attachments: Some(vec![
            "https://tfs.corp.com/tfs/DC/_apis/wit/attachments/1a2b?fileName=log.txt".into(),
        ]),
        ..Default::default()
    };
    assert!(check_attachments(&change, "https://tfs.corp.com/tfs/DC/").is_ok());
    let ops = change_ops(&change, "me");
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0]["path"], "/relations/-");
    assert_eq!(ops[0]["value"]["rel"], "AttachedFile");
    // 別台伺服器、或不是附件的網址：不接受。
    for url in [
        "https://evil.example/tfs/DC/_apis/wit/attachments/1",
        "https://tfs.corp.com/tfs/DC/_apis/git/repositories/x",
        "https://tfs.corp.com/tfs/DCX/_apis/wit/attachments/1",
    ] {
        let bad = WorkItemChange {
            attachments: Some(vec![url.into()]),
            ..Default::default()
        };
        assert!(
            check_attachments(&bad, "https://tfs.corp.com/tfs/DC").is_err(),
            "{url}"
        );
    }
}

#[test]
fn reads_work_item_history() {
    let res = json!({"value": [
        // 建立：系統欄位以外的都列出來。
        {"rev": 1, "revisedBy": {"displayName": "王小明"}, "fields": {
            "System.Rev": {"newValue": 1},
            "System.ChangedDate": {"newValue": "2026-10-01T01:00:00Z"},
            "System.ChangedBy": {"newValue": "王小明 <CORP\\ming>"},
            "System.State": {"newValue": "New"},
            "System.Title": {"newValue": "登入失敗"},
            "System.Description": {"newValue": "<p>很長的說明</p>"}
        }},
        // 只改了系統欄位：略過。
        {"rev": 2, "fields": {"System.Rev": {"oldValue": 1, "newValue": 2}, "System.Watermark": {"oldValue": 5, "newValue": 6}}},
        // 改狀態、指派，加留言、加關聯、移除附件。
        {"rev": 3, "revisedBy": {"displayName": "李大同"}, "revisedDate": "9999-01-01T00:00:00Z", "fields": {
            "System.ChangedDate": {"oldValue": "2026-10-01T01:00:00Z", "newValue": "2026-10-02T03:00:00Z"},
            "System.AssignedTo": {"oldValue": {"displayName": "王小明"}, "newValue": "李大同 <CORP\\tong>"},
            "System.State": {"oldValue": "New", "newValue": "Active"},
            "Microsoft.VSTS.Scheduling.RemainingWork": {"oldValue": 4.0, "newValue": 2.5},
            "System.History": {"newValue": "<p>開始處理</p>"}
        }, "relations": {
            "added": [{"rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://tfs/DC/_apis/wit/workItems/42", "attributes": {"name": "Parent"}}],
            "removed": [{"rel": "AttachedFile", "url": "https://tfs/DC/_apis/wit/attachments/x", "attributes": {"name": "log.txt"}}]
        }}
    ]});
    let list = work_item_revisions(&res);
    assert_eq!(list.len(), 2, "只改了系統欄位的那次略過");
    // 最新的在前。
    let latest = &list[0];
    assert_eq!(latest.rev, 3);
    assert_eq!(latest.author, "李大同");
    assert_eq!(latest.date.as_deref(), Some("2026-10-02T03:00:00Z"));
    assert_eq!(
        latest
            .fields
            .iter()
            .map(|f| f.field.as_str())
            .collect::<Vec<_>>(),
        [
            "System.State",
            "System.AssignedTo",
            "Microsoft.VSTS.Scheduling.RemainingWork"
        ],
        "常看的欄位排前面"
    );
    assert_eq!(latest.fields[1].old.as_deref(), Some("王小明"));
    assert_eq!(
        latest.fields[1].new.as_deref(),
        Some("李大同"),
        "人只留名字"
    );
    assert_eq!(latest.fields[2].new.as_deref(), Some("2.5"));
    assert_eq!(latest.comment.as_deref(), Some("<p>開始處理</p>"));
    assert_eq!(
        latest.added,
        vec![RevisionLink {
            kind: "parent",
            id: Some(42),
            name: "Parent".into()
        }]
    );
    assert_eq!(
        latest.removed,
        vec![RevisionLink {
            kind: "attachment",
            id: None,
            name: "log.txt".into()
        }]
    );
    let created = &list[1];
    assert_eq!(created.author, "王小明");
    let desc = created
        .fields
        .iter()
        .find(|f| f.field == "System.Description")
        .unwrap();
    assert!(desc.long && desc.new.is_none(), "長文字只標出有修改");
    assert!(work_item_revisions(&json!({})).is_empty());
}
