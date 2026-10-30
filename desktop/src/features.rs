//! 可以整個關掉的整合功能：Git（含 GitHub）、Azure DevOps、遠端資料夾（WebDAV、SSH）。
//!
//! 在設定裡關掉後，這些功能的原生指令一律拒絕（等於沒有註冊），網頁那一端就算被注入程式碼
//! 也叫不動它們。開關記在設定檔；啟動時讀一次，之後每次存設定時更新。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feature {
    Git,
    Ado,
    Remote,
}

impl Feature {
    const ALL: [Feature; 3] = [Feature::Git, Feature::Ado, Feature::Remote];

    /// 設定檔裡的欄位（沒有這一項時是開啟）。
    fn key(self) -> &'static str {
        match self {
            Feature::Git => "gitEnabled",
            Feature::Ado => "adoEnabled",
            Feature::Remote => "remoteEnabled",
        }
    }

    fn name(self) -> String {
        match self {
            Feature::Git => tr!("Git 與 GitHub"),
            Feature::Ado => tr!("Azure DevOps／TFS"),
            Feature::Remote => tr!("遠端資料夾（WebDAV、SSH）"),
        }
    }

    /// 這個原生指令屬於哪一項功能（不屬於任何一項時是 `None`，一律可以用）。
    pub fn of(command: &str) -> Option<Feature> {
        if command.starts_with("git_") || command.starts_with("github_") {
            Some(Feature::Git)
        } else if command.starts_with("ado_") || command == "notify_work_items" {
            Some(Feature::Ado)
        } else if command.starts_with("dav_") || command.starts_with("ssh_") {
            Some(Feature::Remote)
        } else {
            None
        }
    }
}

#[derive(Default)]
pub struct Features {
    off: [AtomicBool; 3],
}

impl Features {
    /// 從設定檔的內容讀出開關。
    pub fn load(settings: Option<&serde_json::Value>) -> Self {
        let features = Self::default();
        features.update(settings);
        features
    }

    pub fn update(&self, settings: Option<&serde_json::Value>) {
        for (i, f) in Feature::ALL.into_iter().enumerate() {
            let off = settings.is_some_and(|v| v[f.key()] == false);
            self.off[i].store(off, Ordering::Relaxed);
        }
    }

    pub fn enabled(&self, f: Feature) -> bool {
        let i = Feature::ALL
            .iter()
            .position(|&x| x == f)
            .unwrap_or_default();
        !self.off[i].load(Ordering::Relaxed)
    }

    /// 原生指令被關掉時回傳錯誤訊息。
    pub fn check(&self, command: &str) -> Result<(), String> {
        match Feature::of(command) {
            Some(f) if !self.enabled(f) => Err(tr!(
                "「{name}」已在設定關閉，要使用請先到設定開啟。",
                name = f.name()
            )),
            _ => Ok(()),
        }
    }
}

/// 收到原生指令時先呼叫：所屬的功能關掉時拒絕。
pub fn check<R: Runtime>(app: &AppHandle<R>, command: &str) -> Result<(), String> {
    app.try_state::<Features>()
        .map_or(Ok(()), |f| f.check(command))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_belong_to_their_feature() {
        assert_eq!(Feature::of("git_status"), Some(Feature::Git));
        assert_eq!(Feature::of("github_clone"), Some(Feature::Git));
        assert_eq!(Feature::of("ado_wiki_save"), Some(Feature::Ado));
        assert_eq!(Feature::of("notify_work_items"), Some(Feature::Ado));
        assert_eq!(Feature::of("dav_read"), Some(Feature::Remote));
        assert_eq!(Feature::of("ssh_connect"), Some(Feature::Remote));
        assert_eq!(Feature::of("save_file"), None);
        assert_eq!(Feature::of("load_settings"), None);
    }

    #[test]
    fn missing_settings_keep_everything_on() {
        let f = Features::load(None);
        assert!(Feature::ALL.iter().all(|&x| f.enabled(x)));
        let f = Features::load(Some(&serde_json::json!({ "gitEnabled": true })));
        assert!(Feature::ALL.iter().all(|&x| f.enabled(x)));
    }

    #[test]
    fn turned_off_features_reject_their_commands() {
        let f = Features::load(Some(
            &serde_json::json!({ "adoEnabled": false, "remoteEnabled": false }),
        ));
        assert!(f.check("git_push").is_ok());
        assert!(f.check("ado_work_items").is_err());
        assert!(f.check("dav_write").is_err());
        assert!(f.check("ssh_connect").is_err());
        assert!(f.check("save_file").is_ok());
        f.update(Some(&serde_json::json!({})));
        assert!(f.check("ado_work_items").is_ok());
    }
}
