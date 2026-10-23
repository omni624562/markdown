//! 介面語言（後端回給使用者看的訊息）。以繁體中文原文當作鍵：`tr!("找不到資料夾")`；
//! 英文介面時查 `locales`，查不到就用中文。參數用名稱：
//! `tr!("無法開啟「{name}」：{e}", name = path.display(), e = err)`。
//! 前端啟動時依設定呼叫 `set_language`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

static ENGLISH: AtomicBool = AtomicBool::new(false);

static EN: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    crate::locales::ALL
        .iter()
        .flat_map(|part| part.iter().copied())
        .collect()
});

pub fn english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// 前端告訴後端目前的介面語言（`en` 或 `zh-TW`）。
#[tauri::command]
pub fn set_language(lang: String) {
    ENGLISH.store(lang == "en", Ordering::Relaxed);
}

/// 依目前的語言取出訊息（`tr!` 使用）。
pub fn text(zh: &'static str) -> &'static str {
    lookup(zh, english())
}

fn lookup(zh: &'static str, english: bool) -> &'static str {
    if english {
        EN.get(zh).copied().unwrap_or(zh)
    } else {
        zh
    }
}

/// 把 `{name}` 換成參數；沒有對應參數的保持原樣。只掃一次，參數內容裡的大括號不會被再次替換。
pub fn fill(template: &str, args: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end)
                if after[..end]
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_') =>
            {
                let key = &after[..end];
                match args.iter().find(|(k, _)| *k == key) {
                    Some((_, v)) => out.push_str(v),
                    None => out.push_str(&rest[start..start + end + 2]),
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 翻譯訊息，回傳 `String`。用法見模組說明。
macro_rules! tr {
    ($s:literal) => {
        $crate::i18n::text($s).to_string()
    };
    ($s:literal, $($k:ident = $v:expr),+ $(,)?) => {
        $crate::i18n::fill(
            $crate::i18n::text($s),
            &[$((stringify!($k), format!("{}", $v))),+],
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn fills_named_parameters_once() {
        assert_eq!(
            fill(
                "無法開啟「{name}」：{e}",
                &[("name", "a{e}.md".into()), ("e", "拒絕".into())]
            ),
            "無法開啟「a{e}.md」：拒絕"
        );
        assert_eq!(fill("{沒有} {x} {", &[]), "{沒有} {x} {");
    }

    // 不切換全域的語言：測試是平行執行的，會影響其他比對中文訊息的測試。
    #[test]
    fn falls_back_to_chinese() {
        assert_eq!(lookup("這句還沒有翻譯", true), "這句還沒有翻譯");
        assert_eq!(tr!("這句還沒有翻譯 {n}", n = 3), "這句還沒有翻譯 3");
        if let Some((zh, en)) = crate::locales::ALL.iter().flat_map(|p| p.iter()).next() {
            assert_eq!(lookup(zh, true), *en);
            assert_eq!(lookup(zh, false), *zh);
        }
    }

    /// 前端會比對這幾句的英文（`web/src/locales/en`），翻譯要保留這些字。
    #[test]
    fn shared_texts_match_frontend() {
        let en = |zh| lookup(zh, true);
        assert!(en(
            "遠端和本機改到了同樣的地方。已經取消拉取，檔案都維持原樣；可以按「逐段處理」決定每一段要用哪一邊。"
        )
        .contains("Resolve Chunk by Chunk"));
        assert_eq!(en("已取消登入"), "Sign-in canceled");
        assert!(en("還沒有連線到遠端資料夾").starts_with("Not connected to a remote folder"));
        assert!(en("這個檔案屬於另一個遠端連線，請先重新連線")
            .starts_with("This file belongs to another remote connection"));
        assert_eq!(en("網路磁碟無法連線"), "Network drive unreachable");
    }

    /// 原始碼裡的字串常值（含 raw string），回傳（行號、內容、前面的程式碼）。
    fn literals(src: &str) -> Vec<(usize, String, String)> {
        let mut out = vec![];
        let b = src.as_bytes();
        let (mut i, mut line) = (0, 1);
        while i < b.len() {
            match b[i] {
                b'\n' => line += 1,
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                    continue;
                }
                b'\'' => {
                    // 字元常值（'"'、'\''）或生命週期：跳過字元常值。
                    if b.get(i + 2) == Some(&b'\'') {
                        i += 3;
                        continue;
                    }
                    if b.get(i + 1) == Some(&b'\\') {
                        if let Some(end) = src[i + 2..].find('\'') {
                            i += end + 3;
                            continue;
                        }
                    }
                }
                b'r' if matches!(b.get(i + 1), Some(b'"') | Some(b'#'))
                    && (i == 0 || !b[i - 1].is_ascii_alphanumeric() && b[i - 1] != b'_') =>
                {
                    let hashes = b[i + 1..].iter().take_while(|&&c| c == b'#').count();
                    if b.get(i + 1 + hashes) == Some(&b'"') {
                        let start = i + 2 + hashes;
                        let close = format!("\"{}", "#".repeat(hashes));
                        if let Some(end) = src[start..].find(&close) {
                            let text = &src[start..start + end];
                            out.push((line, text.to_string(), src[..i].to_string()));
                            line += text.matches('\n').count();
                            i = start + end + close.len();
                            continue;
                        }
                    }
                }
                b'"' => {
                    let start = i + 1;
                    let mut j = start;
                    while j < b.len() && b[j] != b'"' {
                        if b[j] == b'\\' {
                            j += 1;
                        }
                        j += 1;
                    }
                    let text = &src[start..j.min(b.len())];
                    out.push((line, text.to_string(), src[..i].to_string()));
                    line += text.matches('\n').count();
                    i = j + 1;
                    continue;
                }
                _ => {}
            }
            i += 1;
        }
        out
    }

    fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().is_some_and(|n| n != "locales") {
                    sources(&p, out);
                }
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    fn is_cjk(s: &str) -> bool {
        s.chars().any(|c| {
            matches!(c, '\u{3400}'..='\u{9fff}' | '\u{3000}'..='\u{303f}' | '\u{ff01}'..='\u{ff5e}')
        })
    }

    fn params(s: &str) -> Vec<String> {
        let mut v: Vec<String> = s
            .split('{')
            .skip(1)
            .filter_map(|p| p.split_once('}').map(|(k, _)| k))
            .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            .map(str::to_string)
            .collect();
        v.sort();
        v.dedup();
        v
    }

    /// 回給使用者的中文訊息都要經過 `tr!`，而且有英文翻譯；其他中文字串（例如送給 AI 的說明、
    /// 比對用的關鍵字）標上 `i18n-ignore`（同一行或上一行）。測試區塊（`#[cfg(test)]` 以下）不檢查。
    #[test]
    fn messages_are_translated() {
        let mut files = vec![];
        sources(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let mut problems = vec![];
        for file in files {
            let src = std::fs::read_to_string(&file).unwrap();
            let src = src.split("#[cfg(test)]").next().unwrap();
            let lines: Vec<&str> = src.lines().collect();
            let name = file.file_name().unwrap().to_string_lossy();
            for (line, text, before) in literals(src) {
                if !is_cjk(&text) {
                    continue;
                }
                let at = format!("{name}:{line}");
                let near = |n: usize| {
                    lines
                        .get(n.wrapping_sub(1))
                        .is_some_and(|l| l.contains("i18n-ignore"))
                };
                if before.trim_end().ends_with("tr!(") {
                    let key = text
                        .replace("\\n", "\n")
                        .replace("\\\"", "\"")
                        .replace("\\\\", "\\");
                    match EN.get(key.as_str()) {
                        None => problems.push(format!("{at} 沒有英文翻譯：{text}")),
                        Some(en) if params(en) != params(&key) => {
                            problems.push(format!("{at} 參數不一致：{text} → {en}"))
                        }
                        Some(en) if is_cjk(en) => {
                            problems.push(format!("{at} 英文翻譯裡有中文：{en}"))
                        }
                        _ => {}
                    }
                } else if !near(line) && !near(line - 1) {
                    problems.push(format!("{at} 中文字串沒有經過 tr!：{text}"));
                }
            }
        }
        assert!(
            problems.is_empty(),
            "{} 個問題：\n{}",
            problems.len(),
            problems.join("\n")
        );
    }

    #[test]
    fn no_duplicate_keys() {
        let mut seen = std::collections::HashSet::new();
        let dup: Vec<_> = crate::locales::ALL
            .iter()
            .flat_map(|p| p.iter())
            .filter(|(k, _)| !seen.insert(*k))
            .map(|(k, _)| *k)
            .collect();
        assert!(dup.is_empty(), "重複的翻譯：{dup:?}");
    }
}
