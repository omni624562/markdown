//! GFM 表格排版：依東亞字寬（中日韓文字算兩格）對齊每一欄，讓原始碼中的直線對齊。

use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Align {
    None,
    Left,
    Center,
    Right,
}

/// 把一行表格拆成儲存格。跳脫的 `\|` 與行內程式碼裡的 `|` 不算分隔線。
fn split_row(line: &str) -> Vec<String> {
    let s = line.trim();
    let s = s.strip_prefix('|').unwrap_or(s);
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut chars = s.chars().peekable();
    let mut in_code = false;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                cur.push(c);
                if let Some(&next) = chars.peek() {
                    cur.push(next);
                    chars.next();
                }
            }
            '`' => {
                in_code = !in_code;
                cur.push(c);
            }
            '|' if !in_code => cells.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    // 最後一格：結尾有 `|` 時是空字串，不算一欄。
    if !cur.trim().is_empty() || cells.is_empty() {
        cells.push(cur);
    }
    cells.into_iter().map(|c| c.trim().to_string()).collect()
}

fn parse_delimiter(line: &str) -> Option<Vec<Align>> {
    if !line.contains('-') {
        return None;
    }
    split_row(line)
        .iter()
        .map(|cell| {
            let left = cell.starts_with(':');
            let right = cell.ends_with(':');
            let dashes = cell.trim_matches(':');
            if dashes.is_empty() || !dashes.chars().all(|c| c == '-') {
                return None;
            }
            Some(match (left, right) {
                (true, true) => Align::Center,
                (true, false) => Align::Left,
                (false, true) => Align::Right,
                (false, false) => Align::None,
            })
        })
        .collect()
}

/// 這兩行是否構成表格的開頭（標題列＋分隔列）。
fn is_table_start(header: &str, delimiter: &str) -> bool {
    header.contains('|')
        && parse_delimiter(delimiter)
            .is_some_and(|a| !a.is_empty() && a.len() == split_row(header).len().max(1))
}

fn pad(cell: &str, width: usize, align: Align) -> String {
    let gap = width.saturating_sub(cell.width());
    match align {
        Align::Right => format!("{}{cell}", " ".repeat(gap)),
        Align::Center => {
            let left = gap / 2;
            format!("{}{cell}{}", " ".repeat(left), " ".repeat(gap - left))
        }
        _ => format!("{cell}{}", " ".repeat(gap)),
    }
}

/// 排版一個表格區塊（標題列、分隔列與後續資料列）。不是有效的表格時回傳 `None`。
///
/// 欄數取各列最大值，缺少的儲存格補空白；第一行的縮排會保留。
pub fn format_table(block: &str) -> Option<String> {
    let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() < 2 || !is_table_start(lines[0], lines[1]) {
        return None;
    }
    let indent: String = lines[0].chars().take_while(|c| c.is_whitespace()).collect();
    let mut aligns = parse_delimiter(lines[1])?;
    let mut rows: Vec<Vec<String>> = std::iter::once(lines[0])
        .chain(lines[2..].iter().copied())
        .map(split_row)
        .collect();

    let cols = rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
        .max(aligns.len());
    aligns.resize(cols, Align::None);
    for row in &mut rows {
        row.resize(cols, String::new());
    }
    let widths: Vec<usize> = (0..cols)
        // 至少三格，分隔列才放得下 `:-:`。
        .map(|c| rows.iter().map(|r| r[c].width()).max().unwrap_or(0).max(3))
        .collect();

    let line = |cells: Vec<String>| format!("{indent}| {} |", cells.join(" | "));
    let mut out = Vec::with_capacity(rows.len() + 1);
    let fmt_row = |row: &Vec<String>| {
        line(
            row.iter()
                .zip(&widths)
                .zip(&aligns)
                .map(|((cell, &w), &a)| pad(cell, w, a))
                .collect(),
        )
    };
    out.push(fmt_row(&rows[0]));
    out.push(line(
        widths
            .iter()
            .zip(&aligns)
            .map(|(&w, &a)| match a {
                Align::None => "-".repeat(w),
                Align::Left => format!(":{}", "-".repeat(w - 1)),
                Align::Right => format!("{}:", "-".repeat(w - 1)),
                Align::Center => format!(":{}:", "-".repeat(w - 2)),
            })
            .collect(),
    ));
    out.extend(rows[1..].iter().map(fmt_row));
    Some(out.join("\n"))
}

/// 排版文件中所有的表格，略過圍欄程式碼區塊。
pub fn format_all_tables(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut fence: Option<String> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if let Some(f) = &fence {
            if trimmed.starts_with(f.as_str()) {
                fence = None;
            }
            out.push(line.to_string());
            i += 1;
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fence = Some(trimmed[..3].to_string());
            out.push(line.to_string());
            i += 1;
            continue;
        }
        if i + 1 < lines.len() && is_table_start(line, lines[i + 1]) {
            let end = (i + 2..lines.len())
                .find(|&j| !lines[j].contains('|') || lines[j].trim().is_empty())
                .unwrap_or(lines.len());
            let block = lines[i..end].join("\n");
            match format_table(&block) {
                Some(formatted) => out.extend(formatted.split('\n').map(str::to_string)),
                None => out.extend(lines[i..end].iter().map(|l| l.to_string())),
            }
            i = end;
            continue;
        }
        out.push(line.to_string());
        i += 1;
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aligns_cjk_by_display_width() {
        let input = "|功能|Windows|\n|-|-|\n|粗體|`Ctrl+B`|\n|行內程式碼|x|";
        let out = format_table(input).unwrap();
        assert_eq!(
            out,
            "| 功能       | Windows  |\n\
             | ---------- | -------- |\n\
             | 粗體       | `Ctrl+B` |\n\
             | 行內程式碼 | x        |"
        );
        // 每一行的顯示寬度都相同。
        let widths: Vec<usize> = out.lines().map(|l| l.width()).collect();
        assert!(widths.windows(2).all(|w| w[0] == w[1]), "{widths:?}");
    }

    #[test]
    fn keeps_alignment_markers() {
        let out = format_table("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |").unwrap();
        assert_eq!(
            out,
            "| a   |  b  |   c |\n| :-- | :-: | --: |\n| 1   |  2  |   3 |"
        );
    }

    #[test]
    fn pads_ragged_rows_and_respects_escapes() {
        let out = format_table("a | b\n--- | ---\n`x|y` | \\| | extra").unwrap();
        assert_eq!(
            out,
            "| a     | b   |       |\n| ----- | --- | ----- |\n| `x|y` | \\|  | extra |"
        );
    }

    #[test]
    fn rejects_non_tables() {
        assert!(format_table("just | text\nmore | text").is_none());
        assert!(format_table("| a |").is_none());
    }

    #[test]
    fn formats_all_tables_but_not_code() {
        let doc = "# 標題\n\n|a|b|\n|-|-|\n|1|2|\n\n```\n|a|b|\n|-|-|\n```\n";
        let out = format_all_tables(doc);
        assert!(out.contains("| a   | b   |\n| --- | --- |\n| 1   | 2   |"));
        assert!(out.contains("```\n|a|b|\n|-|-|\n```"));
        assert_eq!(format_all_tables(&out), out, "排版結果應該穩定");
    }
}
