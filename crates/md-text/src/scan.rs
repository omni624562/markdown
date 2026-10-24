//! 逐字掃描用的小工具（取代正規表示式）。

/// 空白字元：和 JavaScript 的 `\s` 相同（比 Unicode 的 White_Space 多 U+FEFF、少 U+0085）。
pub fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\x0B' | '\x0C' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// 去掉前後的空白（和 JavaScript 的 `trim()` 相同）。
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

/// 前一個字元（`at` 是位元組位置）。
pub fn before(text: &str, at: usize) -> Option<char> {
    text[..at].chars().next_back()
}

/// 從 `at` 開始，連續符合 `keep` 的字元有多少位元組。
pub fn run(text: &str, at: usize, keep: impl Fn(char) -> bool) -> usize {
    text[at..]
        .char_indices()
        .find(|&(_, c)| !keep(c))
        .map_or(text.len() - at, |(i, _)| i)
}

/// 和 `decodeURIComponent` 相同：編碼不合法時回傳 `None`。
pub fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_owned());
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 把行內程式碼換成空白（位元組長度不變，位置才對得上）。
/// 開頭一段反引號配上後面第一段一樣長的；配不到就從下一個位置再試（和 CommonMark 略有不同，但不會漏算）。
pub fn blank_code(line: &str) -> String {
    let b = line.as_bytes();
    let mut out = b.to_vec();
    let ticks = |from: usize| b[from..].iter().take_while(|&&c| c == b'`').count();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let n = ticks(i);
        let mut j = i + n;
        let mut close = None;
        while j < b.len() {
            if b[j] == b'`' {
                let m = ticks(j);
                if m == n {
                    close = Some(j + m);
                    break;
                }
                j += m;
            } else {
                j += 1;
            }
        }
        match close {
            Some(end) => {
                out[i..end].fill(b' ');
                i = end;
            }
            None => i += 1,
        }
    }
    // 只把 ASCII 的反引號範圍換成空白，切在字元邊界上，結果一定是合法的 UTF-8。
    String::from_utf8(out).unwrap_or_else(|_| line.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_code_is_blanked() {
        assert_eq!(blank_code("a `中` b"), "a       b");
        assert_eq!(blank_code("``a`"), "`   ");
        assert_eq!(blank_code("`` x ` y ``z"), "           z");
        assert_eq!(blank_code("`未關"), "`未關");
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("%E6%9C%83.md").as_deref(), Some("會.md"));
        assert_eq!(percent_decode("a%E6.md"), None);
        assert_eq!(percent_decode("100%"), None);
    }
}
