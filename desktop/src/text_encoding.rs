//! 文字檔的編碼：開檔時判斷（UTF-8、有 BOM 的 UTF-16，都不是時改用台灣常見的 Big5）、
//! 使用者在狀態列指定編碼重新讀取，以及存檔時照檔案原本的編碼與換行寫回（Big5 的舊檔存檔後還是 Big5）。

use encoding_rs::Encoding;
use std::borrow::Cow;

/// 狀態列的編碼選單可以選的編碼（和前端 web/src/app/file-format.ts 的清單一致）。
pub const CHOICES: &[&str] = &[
    "utf-8",
    "utf-16le",
    "utf-16be",
    "big5",
    "shift_jis",
    "gb18030",
    "euc-kr",
    "windows-1252",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum TextEncoding {
    #[default]
    Utf8,
    Utf16Le,
    Utf16Be,
    /// 其他 encoding_rs 支援的編碼（Big5、Shift_JIS、GB18030…，見 [`CHOICES`]）。
    Other(&'static Encoding),
}

impl TextEncoding {
    /// 前端用的名稱（[`CHOICES`] 裡的一個）。
    pub fn id(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf16Le => "utf-16le",
            Self::Utf16Be => "utf-16be",
            Self::Other(e) => CHOICES
                .iter()
                .copied()
                .find(|id| Encoding::for_label(id.as_bytes()) == Some(e))
                .unwrap_or("utf-8"),
        }
    }

    /// 給使用者看的名稱（訊息裡用）。
    pub fn label(self) -> &'static str {
        match self.id() {
            "utf-8" => "UTF-8",
            "utf-16le" => "UTF-16 LE",
            "utf-16be" => "UTF-16 BE",
            "big5" => "Big5",
            "shift_jis" => "Shift_JIS",
            "gb18030" => "GB18030",
            "euc-kr" => "EUC-KR",
            _ => "Windows-1252",
        }
    }

    /// [`CHOICES`] 裡的名稱；其他的回傳 `None`。
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "utf-8" => Some(Self::Utf8),
            "utf-16le" => Some(Self::Utf16Le),
            "utf-16be" => Some(Self::Utf16Be),
            _ if CHOICES.contains(&id) => Encoding::for_label(id.as_bytes()).map(Self::Other),
            _ => None,
        }
    }

    /// 這個編碼的 BOM（沒有 BOM 的編碼是空的）。
    fn bom(self) -> &'static [u8] {
        match self {
            Self::Utf8 => b"\xEF\xBB\xBF",
            Self::Utf16Le => b"\xFF\xFE",
            Self::Utf16Be => b"\xFE\xFF",
            Self::Other(_) => b"",
        }
    }
}

/// 開啟檔案時記下的格式，存檔時照原樣寫回，避免 Windows 的 CRLF、BOM 或 Big5 被悄悄改掉。
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct FileFormat {
    pub crlf: bool,
    pub bom: bool,
    pub encoding: TextEncoding,
}

/// 檔案開頭的 BOM 標出的編碼。
fn sniff_bom(bytes: &[u8]) -> Option<TextEncoding> {
    [
        TextEncoding::Utf8,
        TextEncoding::Utf16Le,
        TextEncoding::Utf16Be,
    ]
    .into_iter()
    .find(|e| bytes.starts_with(e.bom()))
}

/// 解讀檔案內容：有 BOM 時照 BOM（UTF-8、UTF-16），沒有時優先當 UTF-8，失敗時改用台灣常見的 Big5。
///
/// 第三個值是編碼的名稱（見 [`CHOICES`]）；Big5 也解讀不乾淨（例如 Shift-JIS、GBK 或混了壞位元組）時是 `"unknown"`：
/// 前端不自動存檔，存檔前先問使用者，免得把原檔換成亂碼；這時存回用 UTF-8。
pub fn decode(bytes: &[u8]) -> (String, FileFormat, &'static str) {
    let guess = sniff_bom(bytes).or_else(|| {
        std::str::from_utf8(bytes)
            .is_ok()
            .then_some(TextEncoding::Utf8)
    });
    let (text, mut format, lossy) = decode_as(
        bytes,
        guess.unwrap_or(TextEncoding::Other(encoding_rs::BIG5)),
    );
    if lossy {
        format.encoding = TextEncoding::Utf8;
        return (text, format, "unknown");
    }
    (text, format, format.encoding.id())
}

/// 用指定的編碼解讀（使用者在狀態列選「用其他編碼重新讀取」）。開頭有這個編碼的 BOM 時拿掉並記下。
/// 第三個值：有解不了的位元組（畫面上會有 �）。編輯器內部一律用 `\n`，存檔時再依原格式轉回。
pub fn decode_as(bytes: &[u8], encoding: TextEncoding) -> (String, FileFormat, bool) {
    let bom = !encoding.bom().is_empty() && bytes.starts_with(encoding.bom());
    let body = if bom {
        &bytes[encoding.bom().len()..]
    } else {
        bytes
    };
    let (text, lossy) = match encoding {
        TextEncoding::Utf8 => encoding_rs::UTF_8.decode_without_bom_handling(body),
        TextEncoding::Utf16Le => encoding_rs::UTF_16LE.decode_without_bom_handling(body),
        TextEncoding::Utf16Be => encoding_rs::UTF_16BE.decode_without_bom_handling(body),
        TextEncoding::Other(e) => e.decode_without_bom_handling(body),
    };
    let crlf = text.contains("\r\n");
    let text = if crlf {
        text.replace("\r\n", "\n")
    } else {
        text.into_owned()
    };
    (
        text,
        FileFormat {
            crlf,
            bom,
            encoding,
        },
        lossy,
    )
}

/// 存檔時寫不進檔案編碼的字（例如 Big5 沒有的表情符號、罕用字）。
#[derive(Debug, PartialEq, Eq)]
pub struct Unencodable {
    /// 寫不進去的字（不重複，最多幾個），讓使用者知道是哪些字。
    pub chars: String,
}

/// 依檔案的格式（編碼、換行、BOM）轉成要寫進檔案的位元組。
pub fn encode(text: &str, format: FileFormat) -> Result<Vec<u8>, Unencodable> {
    let text: Cow<str> = if format.crlf {
        Cow::Owned(text.replace("\r\n", "\n").replace('\n', "\r\n"))
    } else {
        Cow::Borrowed(text)
    };
    let mut out = Vec::with_capacity(text.len() + 3);
    if format.bom {
        out.extend_from_slice(format.encoding.bom());
    }
    match format.encoding {
        TextEncoding::Utf8 => out.extend_from_slice(text.as_bytes()),
        TextEncoding::Utf16Le => text
            .encode_utf16()
            .for_each(|u| out.extend_from_slice(&u.to_le_bytes())),
        TextEncoding::Utf16Be => text
            .encode_utf16()
            .for_each(|u| out.extend_from_slice(&u.to_be_bytes())),
        TextEncoding::Other(e) => {
            let (bytes, _, had_errors) = e.encode(&text);
            if had_errors {
                return Err(Unencodable {
                    chars: unencodable_chars(&text, e),
                });
            }
            out.extend_from_slice(&bytes);
        }
    }
    Ok(out)
}

/// 寫不進 `e` 的字（不重複，最多 8 個）。
fn unencodable_chars(text: &str, e: &'static Encoding) -> String {
    let mut found = String::new();
    let mut buf = [0u8; 4];
    for c in text.chars() {
        if c.is_ascii() || found.contains(c) {
            continue;
        }
        if e.encode(c.encode_utf8(&mut buf)).2 {
            found.push(c);
            if found.chars().count() == 8 {
                break;
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_crlf_and_bom_round_trip() {
        let original = b"\xEF\xBB\xBF# \xE6\xA8\x99\xE9\xA1\x8C\r\n\r\nabc\r\n";
        let (text, format, enc) = decode(original);
        assert_eq!(text, "# 標題\n\nabc\n");
        assert_eq!(enc, "utf-8");
        assert_eq!(encode(&text, format).unwrap(), original);
    }

    #[test]
    fn lf_files_stay_lf() {
        let (text, format, _) = decode(b"a\nb\n");
        assert_eq!(encode(&text, format).unwrap(), b"a\nb\n");
    }

    #[test]
    fn big5_files_stay_big5() {
        // 「中文」的 Big5 編碼，Windows 的換行。
        let original = b"\xA4\xA4\xA4\xE5\r\n";
        let (text, format, enc) = decode(original);
        assert_eq!(text, "中文\n");
        assert_eq!(enc, "big5");
        assert_eq!(encode(&text, format).unwrap(), original);
        // Big5 沒有的字：不寫入，回報是哪幾個字。
        assert_eq!(
            encode("中文😀한😀", format),
            Err(Unencodable {
                chars: "😀한".into()
            })
        );
    }

    #[test]
    fn unknown_bytes_are_lossy_and_save_as_utf8() {
        let (_, format, enc) = decode(b"abc\xA4");
        assert_eq!(enc, "unknown");
        assert_eq!(format.encoding, TextEncoding::Utf8);
    }

    #[test]
    fn utf16_with_bom_round_trip() {
        let le = b"\xFF\xFEa\0\r\0\n\0-N\x87e";
        let (text, format, enc) = decode(le);
        assert_eq!(text, "a\n中文");
        assert_eq!(enc, "utf-16le");
        assert!(format.crlf && format.bom);
        assert_eq!(encode(&text, format).unwrap(), le);
        let be = b"\xFE\xFF\0aN-";
        let (text, format, enc) = decode(be);
        assert_eq!((text.as_str(), enc), ("a中", "utf-16be"));
        assert_eq!(encode(&text, format).unwrap(), be);
    }

    #[test]
    fn reopen_with_another_encoding() {
        // Shift_JIS 的「日本」：猜成 Big5 會是別的字，指定 Shift_JIS 才對。
        let sjis = b"\x93\xFA\x96\x7B";
        let enc = TextEncoding::from_id("shift_jis").unwrap();
        let (text, format, lossy) = decode_as(sjis, enc);
        assert_eq!(text, "日本");
        assert!(!lossy);
        assert_eq!(format.encoding.id(), "shift_jis");
        assert_eq!(encode(&text, format).unwrap(), sjis);
        // 當成 UTF-8 讀：解不了的位元組。
        assert!(decode_as(sjis, TextEncoding::Utf8).2);
    }

    #[test]
    fn ids_round_trip() {
        for id in CHOICES {
            assert_eq!(TextEncoding::from_id(id).map(TextEncoding::id), Some(*id));
        }
        assert_eq!(TextEncoding::from_id("big5").unwrap().label(), "Big5");
        assert_eq!(
            TextEncoding::from_id("windows-1252").unwrap().label(),
            "Windows-1252"
        );
        assert_eq!(TextEncoding::from_id("utf-7"), None);
        assert_eq!(TextEncoding::from_id("x-user-defined"), None);
    }
}
