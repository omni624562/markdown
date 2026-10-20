//! 中英文混排的字數統計。
//!
//! 英文等拼音文字以「單字」計算；中日韓文字每個字各算一個字。

/// 英文閱讀速度（字／分鐘）。
const LATIN_WPM: f64 = 200.0;
/// 中文閱讀速度（字／分鐘）。
const CJK_CPM: f64 = 400.0;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Serialize),
    serde(rename_all = "camelCase")
)]
pub struct Stats {
    /// 總字數：`latin_words + cjk_chars`。
    pub words: usize,
    pub latin_words: usize,
    pub cjk_chars: usize,
    /// 不含空白的字元數。
    pub chars: usize,
    /// 預估閱讀時間（分鐘，無條件進位；有內容時至少 1 分鐘）。
    pub reading_minutes: usize,
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF     // 平假名、片假名
        | 0x3400..=0x4DBF   // CJK 擴充 A
        | 0x4E00..=0x9FFF   // CJK 統一表意文字
        | 0xAC00..=0xD7AF   // 韓文音節
        | 0xF900..=0xFAFF   // CJK 相容表意文字
        | 0x20000..=0x3134F // CJK 擴充 B–G
    )
}

pub fn count_text(text: &str) -> Stats {
    let mut stats = Stats::default();
    let mut in_word = false;

    for c in text.chars() {
        if !c.is_whitespace() {
            stats.chars += 1;
        }
        if is_cjk(c) {
            stats.cjk_chars += 1;
            in_word = false;
        } else if c.is_alphanumeric() || (in_word && matches!(c, '\'' | '’' | '-' | '_')) {
            if !in_word {
                stats.latin_words += 1;
                in_word = true;
            }
        } else {
            in_word = false;
        }
    }

    stats.words = stats.latin_words + stats.cjk_chars;
    if stats.words > 0 {
        let minutes = stats.latin_words as f64 / LATIN_WPM + stats.cjk_chars as f64 / CJK_CPM;
        stats.reading_minutes = (minutes.ceil() as usize).max(1);
    }
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_cjk_and_latin() {
        let s = count_text("我用 Rust 寫 Markdown 編輯器");
        assert_eq!(s.cjk_chars, 6);
        assert_eq!(s.latin_words, 2);
        assert_eq!(s.words, 8);
        assert_eq!(s.reading_minutes, 1);
    }

    #[test]
    fn contractions_and_hyphens_stay_one_word() {
        assert_eq!(count_text("don't re-use it").latin_words, 3);
    }

    #[test]
    fn punctuation_is_not_a_word() {
        let s = count_text("，。！ -- ...");
        assert_eq!(s.words, 0);
        assert_eq!(s.reading_minutes, 0);
    }

    #[test]
    fn japanese_and_korean() {
        assert_eq!(count_text("ひらがな 한국어").cjk_chars, 7);
    }

    #[test]
    fn reading_time_rounds_up() {
        let text = "字".repeat(401);
        assert_eq!(count_text(&text).reading_minutes, 2);
    }
}
