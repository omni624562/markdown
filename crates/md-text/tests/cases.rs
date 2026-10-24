//! 和前端原本的測試用同一份資料：待辦、標籤、連結的解析結果。

use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    today: String,
    text: String,
    expect: serde_json::Value,
}

#[test]
fn doc_index_cases() {
    let cases: Vec<Case> = serde_json::from_str(include_str!("doc-index.cases.json")).unwrap();
    assert!(cases.len() > 10);
    for c in cases {
        let year = c.today[..4].parse().unwrap();
        let got = serde_json::to_value(md_text::parse_doc(&c.text, year)).unwrap();
        assert_eq!(got, c.expect, "{}", c.name);
    }
}
