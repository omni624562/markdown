//! 從 Office 文件與 Outlook 郵件取出文字（一行一段），給資料夾搜尋用。
//!
//! - .docx、.xlsx、.pptx 是 ZIP 裡放 XML：自己讀 ZIP 的目錄、用 flate2 解壓縮需要的那幾個檔案，
//!   再用 quick-xml 取出文字。Word 一段一行、Excel 一列一行（儲存格用 Tab 分開）、PowerPoint 一段一行。
//! - .msg 是微軟的複合檔（cfb）：取主旨與純文字內文。
//!
//! 只讀看得到的文字，不解讀公式、格式。檔案太大、解壓縮後太大（可能是壓縮炸彈）或格式不對時回傳空的，
//! 搜尋就當作這個檔案沒有符合的內容。

use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;

/// 超過這個大小的檔案不搜尋。
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// ZIP 裡單一個檔案解壓縮後最多多大。
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// 最多取出幾行（再多搜尋結果也看不完）。
const MAX_LINES: usize = 200_000;

/// 取出檔案裡的文字（依副檔名）；不是支援的類型、讀不到或格式不對時回傳空的。
pub fn lines(path: &Path) -> Vec<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(ext.as_str(), "docx" | "xlsx" | "pptx" | "msg") {
        return vec![];
    }
    let Ok(Some(bytes)) = crate::files::read_capped(path, MAX_FILE_BYTES) else {
        return vec![];
    };
    let mut out = match ext.as_str() {
        "docx" => docx(&bytes),
        "xlsx" => xlsx(&bytes),
        "pptx" => pptx(&bytes),
        _ => msg(&bytes),
    };
    out.truncate(MAX_LINES);
    out
}

// ---------- ZIP ----------

struct Entry {
    name: String,
    method: u16,
    compressed: u64,
    uncompressed: u64,
    offset: u64,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// 讀 ZIP 的中央目錄（不支援 ZIP64、加密、分割檔；Office 文件用不到）。
fn entries(zip: &[u8]) -> Vec<Entry> {
    // 結尾的目錄記錄：從後面往前找簽章（後面可能有註解）。
    let Some(end) = (0..=zip.len().saturating_sub(22))
        .rev()
        .take(66_000)
        .find(|&i| zip[i..].starts_with(b"PK\x05\x06"))
    else {
        return vec![];
    };
    let (Some(count), Some(start)) = (u16_at(zip, end + 10), u32_at(zip, end + 16)) else {
        return vec![];
    };
    let mut out = Vec::new();
    let mut at = start as usize;
    for _ in 0..count {
        if !zip.get(at..).is_some_and(|b| b.starts_with(b"PK\x01\x02")) {
            break;
        }
        let (
            Some(method),
            Some(compressed),
            Some(uncompressed),
            Some(name_len),
            Some(extra),
            Some(comment),
            Some(offset),
        ) = (
            u16_at(zip, at + 10),
            u32_at(zip, at + 20),
            u32_at(zip, at + 24),
            u16_at(zip, at + 28),
            u16_at(zip, at + 30),
            u16_at(zip, at + 32),
            u32_at(zip, at + 42),
        )
        else {
            break;
        };
        let Some(name) = zip.get(at + 46..at + 46 + name_len as usize) else {
            break;
        };
        out.push(Entry {
            name: String::from_utf8_lossy(name).into_owned(),
            method,
            compressed: compressed.into(),
            uncompressed: uncompressed.into(),
            offset: offset.into(),
        });
        at += 46 + name_len as usize + extra as usize + comment as usize;
    }
    out
}

/// 解出 ZIP 裡的一個檔案；太大、壓縮方式不支援或資料不對時回傳 None。
fn read_entry(zip: &[u8], entry: &Entry) -> Option<Vec<u8>> {
    if entry.uncompressed > MAX_ENTRY_BYTES {
        return None;
    }
    let at = usize::try_from(entry.offset).ok()?;
    if !zip.get(at..)?.starts_with(b"PK\x03\x04") {
        return None;
    }
    let start = at + 30 + u16_at(zip, at + 26)? as usize + u16_at(zip, at + 28)? as usize;
    let data = zip.get(start..start + usize::try_from(entry.compressed).ok()?)?;
    match entry.method {
        0 => Some(data.to_vec()),
        8 => {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(data)
                .take(MAX_ENTRY_BYTES + 1)
                .read_to_end(&mut out)
                .ok()?;
            (out.len() as u64 <= MAX_ENTRY_BYTES).then_some(out)
        }
        _ => None,
    }
}

fn file(zip: &[u8], all: &[Entry], name: &str) -> Option<Vec<u8>> {
    read_entry(zip, all.iter().find(|e| e.name == name)?)
}

/// 名稱是 `prefix` + 數字 + `.xml` 的檔案，依數字排序（`slide2.xml` 排在 `slide10.xml` 前面）。
fn numbered<'a>(all: &'a [Entry], prefix: &str) -> Vec<&'a Entry> {
    let mut found: Vec<(u32, &Entry)> = all
        .iter()
        .filter_map(|e| {
            let n = e.name.strip_prefix(prefix)?.strip_suffix(".xml")?;
            Some((n.parse().ok()?, e))
        })
        .collect();
    found.sort_by_key(|(n, _)| *n);
    found.into_iter().map(|(_, e)| e).collect()
}

// ---------- XML ----------

fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// `&amp;`、`&#20013;`、`&#x4E2D;` 這類參照換成字；認不得的略過。
fn reference(name: &str) -> Option<String> {
    if let Some(num) = name.strip_prefix('#') {
        let code = match num.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => num.parse().ok()?,
        };
        return char::from_u32(code).map(String::from);
    }
    quick_xml::escape::resolve_predefined_entity(name).map(str::to_string)
}

/// 讀 XML：`on` 收到開始標籤（名稱不含名稱空間、屬性 `t` 的值）、結束標籤與文字。
enum Xml<'a> {
    Start(&'a str, Option<String>),
    End(&'a str),
    Text(&'a str),
}

fn walk(xml: &[u8], mut on: impl FnMut(Xml) -> bool) {
    let text = String::from_utf8_lossy(xml);
    let mut reader = Reader::from_str(&text);
    loop {
        let go = match reader.read_event() {
            Ok(Event::Start(e)) => {
                let t = e
                    .attributes()
                    .flatten()
                    .find(|a| a.key.as_ref() == "t")
                    .map(|a| a.value.into_owned());
                on(Xml::Start(local(e.name().as_ref()), t))
            }
            Ok(Event::Empty(e)) => {
                let name = e.name();
                let name = local(name.as_ref());
                on(Xml::Start(name, None)) && on(Xml::End(name))
            }
            Ok(Event::End(e)) => on(Xml::End(local(e.name().as_ref()))),
            Ok(Event::Text(t)) => on(Xml::Text(&t.xml10_content())),
            Ok(Event::CData(t)) => on(Xml::Text(&t.xml10_content())),
            Ok(Event::GeneralRef(r)) => match reference(&r.xml10_content()) {
                Some(c) => on(Xml::Text(&c)),
                None => true,
            },
            Ok(Event::Eof) | Err(_) => false,
            _ => true,
        };
        if !go {
            break;
        }
    }
}

/// 取出 XML 裡的文字：`text` 元素裡的字接在一起，遇到 `para` 元素結尾換一行。
fn paragraphs(xml: &[u8], para: &str, text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = String::new();
    let mut in_text = false;
    walk(xml, |ev| {
        match ev {
            Xml::Start(name, _) if name == text => in_text = true,
            Xml::End(name) if name == text => in_text = false,
            Xml::End(name) if name == para => {
                if !line.trim().is_empty() {
                    out.push(std::mem::take(&mut line));
                }
                line.clear();
            }
            Xml::Text(t) if in_text => line.push_str(t),
            _ => {}
        }
        out.len() < MAX_LINES
    });
    if !line.trim().is_empty() {
        out.push(line);
    }
    out
}

fn docx(zip: &[u8]) -> Vec<String> {
    let all = entries(zip);
    file(zip, &all, "word/document.xml")
        .map(|xml| paragraphs(&xml, "p", "t"))
        .unwrap_or_default()
}

fn pptx(zip: &[u8]) -> Vec<String> {
    let all = entries(zip);
    numbered(&all, "ppt/slides/slide")
        .into_iter()
        .filter_map(|e| read_entry(zip, e))
        .flat_map(|xml| paragraphs(&xml, "p", "t"))
        .collect()
}

fn xlsx(zip: &[u8]) -> Vec<String> {
    let all = entries(zip);
    // 共用字串：一個 <si> 一個字串。
    let strings = file(zip, &all, "xl/sharedStrings.xml")
        .map(|xml| shared_strings(&xml))
        .unwrap_or_default();
    numbered(&all, "xl/worksheets/sheet")
        .into_iter()
        .filter_map(|e| read_entry(zip, e))
        .flat_map(|xml| sheet_rows(&xml, &strings))
        .collect()
}

fn shared_strings(xml: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_text = false;
    walk(xml, |ev| {
        match ev {
            Xml::Start("t", _) => in_text = true,
            Xml::End("t") => in_text = false,
            Xml::End("si") => out.push(std::mem::take(&mut cur)),
            Xml::Text(t) if in_text => cur.push_str(t),
            _ => {}
        }
        true
    });
    out
}

/// 一列一行，儲存格的值用 Tab 分開（共用字串換成文字，數字照原樣）。
fn sheet_rows(xml: &[u8], strings: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut shared = false;
    let mut in_value = false;
    let mut value = String::new();
    walk(xml, |ev| {
        match ev {
            Xml::Start("c", t) => {
                shared = t.as_deref() == Some("s");
                value.clear();
            }
            Xml::Start("v" | "t", _) => in_value = true,
            Xml::End("v" | "t") => in_value = false,
            Xml::End("c") => {
                let text = if shared {
                    value
                        .trim()
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| strings.get(i).cloned())
                        .unwrap_or_default()
                } else {
                    std::mem::take(&mut value)
                };
                if !text.is_empty() {
                    row.push(text.replace(['\n', '\r', '\t'], " "));
                }
            }
            Xml::End("row") => {
                if !row.is_empty() {
                    out.push(row.join("\t"));
                    row.clear();
                }
            }
            Xml::Text(t) if in_value => value.push_str(t),
            _ => {}
        }
        out.len() < MAX_LINES
    });
    out
}

// ---------- Outlook 郵件 ----------

/// 主旨、寄件人與純文字內文（UTF-16 的字串屬性）。
fn msg(bytes: &[u8]) -> Vec<String> {
    let Ok(mut file) = cfb::CompoundFile::open(std::io::Cursor::new(bytes)) else {
        return vec![];
    };
    let mut out = Vec::new();
    // 主旨、寄件人名稱、內文。
    for tag in ["0037", "0C1A", "1000"] {
        let mut data = Vec::new();
        let read = file
            .open_stream(format!("/__substg1.0_{tag}001F"))
            .ok()
            .and_then(|s| s.take(MAX_ENTRY_BYTES).read_to_end(&mut data).ok());
        if read.is_none() {
            continue;
        }
        let units: Vec<u16> = data
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        let text = String::from_utf16_lossy(&units);
        out.extend(
            text.lines()
                .map(|l| l.trim_end_matches('\0').to_string())
                .filter(|l| !l.trim().is_empty()),
        );
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// 最簡單的 ZIP（不壓縮或 deflate），測試用。
    pub(crate) fn zip(files: &[(&str, &str, bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut dir = Vec::new();
        for (name, text, deflate) in files {
            let raw = text.as_bytes();
            let data = if *deflate {
                let mut e =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(raw).unwrap();
                e.finish().unwrap()
            } else {
                raw.to_vec()
            };
            let offset = out.len() as u32;
            let method: u16 = if *deflate { 8 } else { 0 };
            let head = |sig: &[u8], extra: &[u8]| {
                let mut h = sig.to_vec();
                h.extend_from_slice(extra);
                h.extend_from_slice(&[0, 0]); // flags
                h.extend_from_slice(&method.to_le_bytes());
                h.extend_from_slice(&[0; 8]); // time, date, crc
                h.extend_from_slice(&(data.len() as u32).to_le_bytes());
                h.extend_from_slice(&(raw.len() as u32).to_le_bytes());
                h.extend_from_slice(&(name.len() as u16).to_le_bytes());
                h.extend_from_slice(&[0, 0]); // extra length
                h
            };
            out.extend(head(b"PK\x03\x04", &[20, 0]));
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&data);
            dir.extend(head(b"PK\x01\x02", &[20, 0, 20, 0]));
            dir.extend_from_slice(&[0; 10]); // comment length, disk, attrs
            dir.extend_from_slice(&offset.to_le_bytes());
            dir.extend_from_slice(name.as_bytes());
        }
        let start = out.len() as u32;
        out.extend_from_slice(&dir);
        out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(dir.len() as u32).to_le_bytes());
        out.extend_from_slice(&start.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    #[test]
    fn reads_word_paragraphs() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>系統設計書</w:t></w:r></w:p><w:p><w:r><w:t>王小明</w:t></w:r><w:r><w:t xml:space="preserve"> 負責 A&amp;B</w:t></w:r></w:p><w:p/></w:body></w:document>"#;
        for deflate in [false, true] {
            let z = zip(&[("word/document.xml", xml, deflate)]);
            assert_eq!(docx(&z), ["系統設計書", "王小明 負責 A&B"]);
        }
    }

    #[test]
    fn reads_excel_rows_with_shared_strings() {
        let z = zip(&[
            ("xl/sharedStrings.xml", "<sst><si><t>項目</t></si><si><r><t>王小明</t></r><r><t>的差旅</t></r></si></sst>", true),
            ("xl/worksheets/sheet2.xml", "<worksheet><sheetData><row><c t=\"inlineStr\"><is><t>李大同</t></is></c></row></sheetData></worksheet>", true),
            ("xl/worksheets/sheet1.xml", "<worksheet><sheetData><row><c t=\"s\"><v>0</v></c><c><v>1234.5</v></c></row><row><c t=\"s\"><v>1</v></c></row><row/></sheetData></worksheet>", false),
        ]);
        assert_eq!(xlsx(&z), ["項目\t1234.5", "王小明的差旅", "李大同"]);
    }

    #[test]
    fn reads_slides_in_order() {
        let slide = |t: &str| {
            format!(
                "<p:sld xmlns:a=\"a\" xmlns:p=\"p\"><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:sld>"
            )
        };
        let (s1, s2, s10) = (slide("第一張"), slide("第二張"), slide("第十張"));
        let z = zip(&[
            ("ppt/slides/slide10.xml", &s10, true),
            ("ppt/slides/slide2.xml", &s2, true),
            ("ppt/slides/slide1.xml", &s1, true),
        ]);
        assert_eq!(pptx(&z), ["第一張", "第二張", "第十張"]);
    }

    #[test]
    fn reads_outlook_message_subject_and_body() {
        let utf16 = |s: &str| {
            s.encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<u8>>()
        };
        let mut file = cfb::CompoundFile::create(std::io::Cursor::new(Vec::new())).unwrap();
        for (name, text) in [
            ("/__substg1.0_0037001F", "上線時程確認"),
            ("/__substg1.0_1000001F", "大家好，\r\n\r\n上線時程如下。"),
        ] {
            file.create_stream(name)
                .unwrap()
                .write_all(&utf16(text))
                .unwrap();
        }
        let bytes = file.into_inner().into_inner();
        assert_eq!(msg(&bytes), ["上線時程確認", "大家好，", "上線時程如下。"]);
    }

    #[test]
    fn broken_or_oversized_files_yield_nothing() {
        assert!(docx(b"not a zip").is_empty());
        assert!(msg(b"not a compound file").is_empty());
        // 目錄宣稱解壓縮後超過上限：不解。
        let mut z = zip(&[("word/document.xml", "<w:p><w:t>x</w:t></w:p>", false)]);
        let at = z.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        z[at + 24..at + 28].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(docx(&z).is_empty());
    }
}
