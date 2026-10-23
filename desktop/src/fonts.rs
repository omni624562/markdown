//! 列出電腦上安裝的字型，給設定裡的「自訂字型」挑選。

use std::collections::BTreeMap;

use fontdb::{Database, Language};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FontFamily {
    /// 寫進 CSS `font-family` 的名稱（字型的英文名稱）。
    pub name: String,
    /// 字型的台灣中文名稱（例如「微軟正黑體」）；和英文名稱相同或沒有時省略。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 是否為等寬字型。
    pub mono: bool,
}

/// 依字型檔記錄的各語言名稱整理出要顯示的家族名稱。
fn family_of(names: &[(String, Language)], mono: bool) -> Option<FontFamily> {
    let english = names
        .iter()
        .find(|(_, l)| *l == Language::English_UnitedStates)
        .or_else(|| names.first())?
        .0
        .trim();
    // 以 . 開頭的是系統內部用的字型（例如 macOS 的 .SF NS），不列出來。
    if english.is_empty() || english.starts_with('.') {
        return None;
    }
    let label = names
        .iter()
        .find(|(_, l)| matches!(l, Language::Chinese_Taiwan | Language::Chinese_HongKongSAR))
        .map(|(n, _)| n.trim().to_string())
        .filter(|n| !n.is_empty() && n != english);
    Some(FontFamily {
        name: english.to_string(),
        label,
        mono,
    })
}

/// 列出安裝的字型家族（同名的只留一個，依名稱排序）。
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<FontFamily>, String> {
    // 載入所有系統字型要一兩秒，結果記下來（裝了新字型要重新開啟程式才會看到）。
    static FONTS: std::sync::OnceLock<Vec<FontFamily>> = std::sync::OnceLock::new();
    if let Some(fonts) = FONTS.get() {
        return Ok(fonts.clone());
    }
    let fonts = crate::io::blocking(|| {
        let mut db = Database::new();
        db.load_system_fonts();
        let mut families: BTreeMap<String, FontFamily> = BTreeMap::new();
        for face in db.faces() {
            let Some(f) = family_of(&face.families, face.monospaced) else {
                continue;
            };
            let entry = families.entry(f.name.to_lowercase()).or_insert(f);
            // 同一家族有一個字重是等寬的就算等寬。
            entry.mono |= face.monospaced;
        }
        Ok(families.into_values().collect::<Vec<_>>())
    })
    .await?;
    Ok(FONTS.get_or_init(|| fonts).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_english_name_and_keeps_taiwan_label() {
        let names = vec![
            ("微軟正黑體".to_string(), Language::Chinese_Taiwan),
            (
                "Microsoft JhengHei".to_string(),
                Language::English_UnitedStates,
            ),
        ];
        assert_eq!(
            family_of(&names, false),
            Some(FontFamily {
                name: "Microsoft JhengHei".into(),
                label: Some("微軟正黑體".into()),
                mono: false,
            })
        );
    }

    #[test]
    fn skips_hidden_system_fonts_and_duplicate_labels() {
        let hidden = vec![(".SF NS".to_string(), Language::English_UnitedStates)];
        assert_eq!(family_of(&hidden, false), None);
        let same = vec![
            ("Consolas".to_string(), Language::English_UnitedStates),
            ("Consolas".to_string(), Language::Chinese_Taiwan),
        ];
        assert_eq!(family_of(&same, true).unwrap().label, None);
    }
}
