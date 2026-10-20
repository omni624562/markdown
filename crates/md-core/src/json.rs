//! JSON：驗證、格式化，以及可摺疊的樹狀預覽。

use serde_json::Value;

use crate::html::escape_html;
use crate::{count_text, Rendered, SourceError};

/// 預設展開的層數，更深的節點一開始是摺疊的。
const OPEN_DEPTH: usize = 2;
/// 單一陣列／物件最多顯示的子節點數，避免巨大檔案讓預覽卡住。
const MAX_CHILDREN: usize = 1000;

fn parse(text: &str) -> Result<Value, SourceError> {
    serde_json::from_str(text).map_err(|e| {
        let raw = e.to_string();
        // serde_json 的訊息結尾附帶 " at line X column Y"，位置另外提供，這裡去掉。
        let raw = raw
            .rsplit_once(" at line ")
            .map_or(raw.as_str(), |(m, _)| m);
        SourceError {
            message: describe(raw),
            line: e.line(),
            column: e.column(),
        }
    })
}

/// 把常見的 serde_json 錯誤訊息換成較好懂的說明，其餘保留原文。
fn describe(raw: &str) -> String {
    let msg = match raw {
        "trailing comma" => "最後一個項目後面多了逗號",
        "trailing characters" => "JSON 結束後還有多餘的內容",
        "expected value" => "這裡應該是一個值（字串、數字、物件、陣列、true、false 或 null）",
        "expected `:`" => "鍵後面缺少冒號 `:`",
        "expected `,` or `}`" => "缺少逗號 `,` 或右大括號 `}`",
        "expected `,` or `]`" => "缺少逗號 `,` 或右中括號 `]`",
        "key must be a string" => "物件的鍵必須是用雙引號包住的字串",
        "invalid escape" => "字串裡有無效的跳脫字元",
        "invalid number" => "數字格式不正確",
        "expected ident" => "無法辨識的值（是不是 true、false、null 拼錯了？）",
        "control character (\\u0000-\\u001F) found while parsing a string" => {
            "字串裡有未跳脫的控制字元（例如直接換行）"
        }
        m if m.starts_with("EOF while parsing") => "內容不完整，可能少了結尾的括號或引號",
        other => return other.to_string(),
    };
    msg.to_string()
}

/// 把 JSON 重新排版成縮排兩格的格式，鍵的順序與數字寫法維持原樣。
pub fn format_json(text: &str) -> Result<String, SourceError> {
    let value = parse(text)?;
    let mut out = serde_json::to_string_pretty(&value).expect("serializing a Value cannot fail");
    out.push('\n');
    Ok(out)
}

pub(crate) fn render(text: &str) -> Rendered {
    let stats = count_text(text);
    match parse(text) {
        Ok(value) => {
            let mut html = String::from("<div class=\"json-tree\">\n");
            node(&mut html, None, &value, 0);
            html.push_str("</div>\n");
            Rendered {
                html,
                headings: Vec::new(),
                stats,
                error: None,
            }
        }
        Err(error) => Rendered {
            html: String::new(),
            headings: Vec::new(),
            stats,
            error: Some(error),
        },
    }
}

enum Key<'a> {
    Name(&'a str),
    Index(usize),
}

fn key_html(out: &mut String, key: Option<Key>) {
    match key {
        Some(Key::Name(k)) => {
            out.push_str("<span class=\"json-key\">\"");
            out.push_str(&escape_html(k));
            out.push_str("\"</span>: ");
        }
        Some(Key::Index(i)) => {
            out.push_str(&format!("<span class=\"json-index\">{i}</span>: "));
        }
        None => {}
    }
}

fn node(out: &mut String, key: Option<Key>, value: &Value, depth: usize) {
    let (open, close, count, unit) = match value {
        Value::Array(a) => ("[", "]", a.len(), "項"),
        Value::Object(o) => ("{", "}", o.len(), "個鍵"),
        scalar => {
            out.push_str("<div class=\"json-row\">");
            key_html(out, key);
            let (class, text) = match scalar {
                Value::Null => ("json-null", "null".to_string()),
                Value::Bool(b) => ("json-bool", b.to_string()),
                Value::Number(n) => ("json-number", n.to_string()),
                Value::String(s) => ("json-string", format!("\"{s}\"")),
                _ => unreachable!(),
            };
            out.push_str(&format!(
                "<span class=\"{class}\">{}</span></div>\n",
                escape_html(&text)
            ));
            return;
        }
    };

    if count == 0 {
        out.push_str("<div class=\"json-row\">");
        key_html(out, key);
        out.push_str(&format!(
            "<span class=\"json-punct\">{open}{close}</span></div>\n"
        ));
        return;
    }

    out.push_str(if depth < OPEN_DEPTH {
        "<details open>"
    } else {
        "<details>"
    });
    out.push_str("<summary>");
    key_html(out, key);
    out.push_str(&format!(
        "<span class=\"json-punct\">{open}</span><span class=\"json-meta\">{count} {unit}</span></summary>\n<div class=\"json-children\">\n"
    ));
    match value {
        Value::Array(a) => {
            for (i, v) in a.iter().take(MAX_CHILDREN).enumerate() {
                node(out, Some(Key::Index(i)), v, depth + 1);
            }
        }
        Value::Object(o) => {
            for (k, v) in o.iter().take(MAX_CHILDREN) {
                node(out, Some(Key::Name(k)), v, depth + 1);
            }
        }
        _ => unreachable!(),
    }
    if count > MAX_CHILDREN {
        out.push_str(&format!(
            "<div class=\"json-row json-more\">…還有 {} {unit}未顯示</div>\n",
            count - MAX_CHILDREN
        ));
    }
    out.push_str(&format!(
        "</div><span class=\"json-punct\">{close}</span></details>\n"
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_tree_and_escapes() {
        let out = render(r#"{"名稱": "<b>", "n": 1.50, "list": [true, null], "empty": {}}"#);
        assert!(out.error.is_none());
        assert!(out.html.contains("\"名稱\""));
        assert!(out.html.contains("&lt;b&gt;"));
        assert!(!out.html.contains("<b>"));
        // 數字保留原始寫法
        assert!(out.html.contains(">1.50<"));
        assert!(out.html.contains("2 項"));
        assert!(out.html.contains("{}"));
    }

    #[test]
    fn reports_error_position() {
        let err = render("{\n  \"a\": 1,\n}").error.unwrap();
        assert_eq!(err.line, 3);
        assert!(err.column >= 1);
        assert_eq!(err.message, "最後一個項目後面多了逗號");
        let err = render("{\"a\": tru}").error.unwrap();
        assert!(err.message.contains("拼錯"), "{}", err.message);
        let err = render("[1, 2").error.unwrap();
        assert!(err.message.contains("不完整"), "{}", err.message);
    }

    #[test]
    fn format_keeps_key_order() {
        let out = format_json(r#"{"z":1,"a":[1,2]}"#).unwrap();
        assert_eq!(out, "{\n  \"z\": 1,\n  \"a\": [\n    1,\n    2\n  ]\n}\n");
    }

    #[test]
    fn huge_arrays_are_truncated() {
        let text = format!("[{}]", vec!["0"; MAX_CHILDREN + 5].join(","));
        assert!(render(&text).html.contains("還有 5 項未顯示"));
    }
}
