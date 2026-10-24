use super::*;

/// 從（不壓縮的）ZIP 取出一個檔案。
fn entry(zip: &[u8], name: &str) -> String {
    let mut i = 0;
    while i + 30 <= zip.len() && zip[i..i + 4] == *b"PK\x03\x04" {
        let u16_at = |at: usize| usize::from(u16::from_le_bytes([zip[at], zip[at + 1]]));
        let size = u32::from_le_bytes(zip[i + 18..i + 22].try_into().unwrap()) as usize;
        let name_len = u16_at(i + 26);
        let start = i + 30 + name_len + u16_at(i + 28);
        if &zip[i + 30..i + 30 + name_len] == name.as_bytes() {
            return String::from_utf8_lossy(&zip[start..start + size]).into_owned();
        }
        i = start + size;
    }
    panic!("找不到 {name}");
}

fn export(markdown: &str, images: &HashMap<String, Image>) -> Vec<u8> {
    let missing = |alt: &str| format!("［圖片：{alt}］");
    markdown_to_docx(
        markdown,
        &Options {
            title: "測試 & <文件>",
            images,
            missing_image: &missing,
        },
    )
}

fn document(markdown: &str) -> String {
    entry(&export(markdown, &HashMap::new()), "word/document.xml")
}

#[test]
fn package_has_the_required_parts() {
    let zip = export("# 標題\n\n內容", &HashMap::new());
    for part in [
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/styles.xml",
        "word/numbering.xml",
        "word/_rels/document.xml.rels",
    ] {
        entry(&zip, part);
    }
    assert!(
        entry(&zip, "docProps/core.xml").contains("<dc:title>測試 &amp; &lt;文件&gt;</dc:title>")
    );
}

#[test]
fn headings_get_bookmarks_and_internal_links() {
    let doc = document("# 第一章\n\n[跳到第一章](#第一章) [外部](https://example.com/?a=1&b=2)");
    assert!(doc.contains(r#"<w:pStyle w:val="Heading1"/>"#));
    assert!(doc.contains(r#"<w:bookmarkStart w:id="1" w:name="_h1"/>"#));
    assert!(doc.contains(r#"<w:hyperlink w:anchor="_h1">"#));
    assert!(doc.contains(r#"<w:hyperlink r:id="rId3">"#));
    let zip = export("[外部](https://example.com/?a=1&b=2)", &HashMap::new());
    assert!(entry(&zip, "word/_rels/document.xml.rels")
        .contains(r#"Target="https://example.com/?a=1&amp;b=2" TargetMode="External""#));
}

#[test]
fn inline_formatting() {
    let doc = document(
        "**粗**、*斜*、~~刪~~、`code`、<u>底線</u>、<mark>螢光</mark>、x<sup>2</sup>、$E=mc^2$",
    );
    for part in [
        "<w:b/>",
        "<w:i/>",
        "<w:strike/>",
        "Consolas",
        r#"<w:u w:val="single"/>"#,
        r#"<w:highlight w:val="yellow"/>"#,
        r#"<w:vertAlign w:val="superscript"/>"#,
        ">E=mc^2<",
    ] {
        assert!(doc.contains(part), "{part}");
    }
}

#[test]
fn soft_breaks_join_chinese_lines() {
    let doc = document("第一行\n第二行\n\nfirst\nsecond");
    let between = |a: &str, b: &str| {
        let i = doc.find(a).unwrap();
        let j = doc.find(b).unwrap();
        doc[i..j].contains(r#"<w:t xml:space="preserve"> </w:t>"#)
    };
    assert!(!between("第一行", "第二行"));
    assert!(between("first", "second"));
}

#[test]
fn lists_tasks_and_numbering() {
    let zip = export(
        "1. 一\n2. 二\n   - 子項目\n\n3) 另一個清單\n\n- [x] 完成\n- [ ] 待辦",
        &HashMap::new(),
    );
    let doc = entry(&zip, "word/document.xml");
    assert!(doc.contains(r#"<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>"#));
    assert!(doc.contains(r#"<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>"#));
    assert!(doc.contains(r#"<w:numId w:val="3"/>"#));
    assert!(doc.contains("☑ ") && doc.contains("☐ "));
    let numbering = entry(&zip, "word/numbering.xml");
    assert!(numbering.contains(r#"<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/>"#));
}

#[test]
fn quotes_code_tables_and_rules() {
    let doc = document(
        "> 引言\n\n```\nfn main() {}\n\n```\n\n| 名稱 | 數量 |\n|:-:|--:|\n| 蘋果 | 3 |\n\n---",
    );
    assert!(doc.contains(r#"<w:left w:val="single" w:sz="12""#));
    assert!(doc.contains(r#"<w:ind w:left="360"/>"#));
    assert!(doc.contains(r#"w:fill="F6F8FA""#) && doc.contains(">fn main() {}<"));
    assert!(doc.contains("<w:tbl>") && doc.contains("<w:tblHeader/>"));
    assert!(doc.contains(r#"<w:jc w:val="center"/>"#) && doc.contains(r#"<w:jc w:val="right"/>"#));
    assert!(doc.contains(r#"<w:bottom w:val="single" w:sz="6""#));
}

#[test]
fn images_are_embedded_or_described() {
    let mut images = HashMap::new();
    images.insert(
        "圖/a.png".to_owned(),
        Image {
            data: vec![1, 2, 3],
            kind: ImageKind::Png,
            width: 1200,
            height: 800,
        },
    );
    let zip = export(
        "![架構圖](圖/a.png) ![小圖|300](圖/a.png) ![沒有](b.png)",
        &images,
    );
    let doc = entry(&zip, "word/document.xml");
    // 寬 1200 → 縮到 600（EMU = 像素 × 9525）
    assert!(doc.contains(r#"<wp:extent cx="5715000" cy="3810000"/>"#));
    assert!(doc.contains(r#"<wp:extent cx="2857500" cy="1905000"/>"#));
    assert!(doc.contains("［圖片：沒有］"));
    // 同一張圖只放一次
    assert_eq!(entry(&zip, "word/media/image1.png").len(), 3);
    assert_eq!(
        entry(&zip, "word/_rels/document.xml.rels")
            .matches("media/")
            .count(),
        1
    );
}

#[test]
fn alt_sizes() {
    assert_eq!(sized_alt("圖|400"), ("圖", Some(400), None));
    assert_eq!(sized_alt("圖 | 400x300"), ("圖", Some(400), Some(300)));
    assert_eq!(sized_alt("a|b"), ("a|b", None, None));
    assert_eq!(sized_alt("圖|12345"), ("圖|12345", None, None));
    assert_eq!(fit_image(300, 200), (300, 200));
    assert_eq!(fit_image(1200, 800), (600, 400));
}

#[test]
fn footnotes_and_alerts() {
    let doc = document("正文[^1]\n\n[^1]: 註腳內容\n\n> [!NOTE]\n> 提示內容");
    assert!(
        doc.contains(r#"<w:vertAlign w:val="superscript"/></w:rPr><w:t xml:space="preserve">1<"#)
    );
    assert!(doc.contains("註腳內容"));
    assert!(doc.contains(">Note<") && doc.contains("提示內容"));
}
