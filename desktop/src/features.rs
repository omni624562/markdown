//! 可以整個關掉的整合功能：Git（含 GitHub）、Azure DevOps、遠端資料夾（WebDAV、SSH）。
//!
//! 在設定裡關掉後，這些功能的原生指令一律拒絕（等於沒有註冊），網頁那一端就算被注入程式碼
//! 也叫不動它們。開關記在設定檔；啟動時讀一次，之後每次存設定時更新。
//! 從關閉改回開啟時，存設定的原生指令會用系統的對話框再確認一次（見 `settings::save_settings`），
//! 網頁不能自己把使用者關掉的功能打開。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, Runtime};

use crate::confirm::Question;

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
            Feature::Ado => "Azure DevOps".to_string(),
            Feature::Remote => tr!("遠端資料夾（WebDAV、SSH）"),
        }
    }

    /// 這個原生指令屬於哪一項功能（不屬於任何一項時是 `None`，一律可以用）。
    pub fn of(command: &str) -> Option<Feature> {
        // create_workflow 在儲存庫裡建立 GitHub Actions 的設定檔，屬於 Git 與 GitHub。
        if command.starts_with("git_")
            || command.starts_with("github_")
            || command == "create_workflow"
        {
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

    /// 目前關掉的功能。
    pub fn off(&self) -> Vec<Feature> {
        Feature::ALL
            .into_iter()
            .filter(|&f| !self.enabled(f))
            .collect()
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

/// 存設定時，原本關掉、這次會打開的功能（設定裡沒有這一項，或不是 `false`，都算打開）。
pub fn turned_on(off: &[Feature], settings: &serde_json::Value) -> Vec<Feature> {
    off.iter()
        .copied()
        .filter(|f| settings[f.key()] != false)
        .collect()
}

/// 重新開啟關掉的功能前要問的話，列出會開啟哪些；沒有要開啟的功能時不用問。
pub fn enable_question(list: &[Feature]) -> Option<Question> {
    if list.is_empty() {
        return None;
    }
    let names: Vec<String> = list.iter().map(|f| format!("• {}", f.name())).collect();
    Some(Question::new(
        tr!("開啟整合功能"),
        tr!(
            "要開啟下面這些在設定裡關掉的功能嗎？\n\n{names}\n\n只有在你自己剛剛打開這些開關時才選「是」。",
            names = names.join("\n")
        ),
    ))
}

/// 使用者拒絕時，把這些功能在設定裡改回關閉（`settings` 是物件）。
pub fn keep_off(settings: &mut serde_json::Value, list: &[Feature]) {
    for f in list {
        settings[f.key()] = serde_json::Value::Bool(false);
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

    /// 不屬於任何整合功能、一律可以用的原生指令（AI 協作另有自己的開關，見 `settings::require_ai`）。
    /// 新增原生指令時，要歸到某一項功能（`Feature::of`），或明確加進這裡。
    const ALWAYS: &[&str] = &[
        "startup_target",
        "probe_path",
        "open_external",
        "set_title",
        "set_ui_zoom",
        "custom_title_bar",
        "window_control",
        "open_file",
        "reopen_file",
        "project_default_parent",
        "pick_project_parent",
        "create_project",
        "comet_installed",
        "comet_path_ready",
        "comet_setup_line",
        "comet_setup_run",
        "chatgpt_send",
        "reopen_with_encoding",
        "file_format",
        "set_file_format",
        "set_file_shortcuts",
        "save_file",
        "export_binary",
        "import_docx",
        "import_docx_data",
        "export_docx",
        "list_fonts",
        "offline_put",
        "offline_get",
        "offline_release",
        "pick_pdf_path",
        "print_to_pdf",
        "load_settings",
        "save_settings",
        "open_folder",
        "reopen_folder",
        "close_folder",
        "current_folder",
        "recent",
        "set_language",
        "projects_list",
        "project_update",
        "project_forget",
        "project_delete",
        "project_open_codex",
        "project_open_claude",
        "ai_apps_installed",
        "project_relocate",
        "project_reveal",
        "list_dir",
        "list_files",
        "paths_exist",
        "create_entry",
        "rename_entry",
        "trash_entry",
        "reveal_entry",
        "search",
        "replace_in_folder",
        "scan_docs",
        "read_docs",
        "link_updates",
        "update_doc",
        "peek_text",
        "save_image",
        "history_list",
        "history_read",
        "ai_tools",
        "term_open",
        "term_layout",
        "term_forward",
        "term_ready",
        "term_notify",
        "term_write",
        "term_resize",
        "term_close",
        "mcp_start",
        "mcp_copy_registration",
        "mcp_stop",
        "mcp_sync",
        "mcp_respond",
        "ai_run",
        "ai_cancel",
        // Claude API 助理有自己的開關（`claudeApiEnabled`，送出前在 assistant.rs 檢查）。
        "assistant_key_status",
        "assistant_key_set",
        "assistant_key_forget",
        "assistant_usage",
        "assistant_send",
        "assistant_cancel",
        "app_version",
        "update_check",
        "update_install",
        "update_restart",
    ];

    /// main.rs 註冊的每個原生指令都要分好類，新的指令不會因為名稱沒對上而關不掉。
    #[test]
    fn every_registered_command_is_classified() {
        let main = include_str!("main.rs");
        let start = main
            .find("generate_handler![")
            .expect("main.rs 裡找不到指令清單"); // i18n-ignore
        let list = &main[start..start + main[start..].find(']').unwrap()];
        let names: Vec<&str> = list
            .split(|c: char| c == ',' || c == '[' || c.is_whitespace())
            .filter(|s| !s.is_empty() && !s.starts_with("generate_handler"))
            .map(|s| s.rsplit("::").next().unwrap())
            .collect();
        assert!(names.len() > 100, "只找到 {} 個指令", names.len()); // i18n-ignore
        for name in names {
            assert!(
                Feature::of(name).is_some() || ALWAYS.contains(&name),
                "{name} 沒有歸到任何整合功能，也不在 ALWAYS 清單裡" // i18n-ignore
            );
        }
        for name in ALWAYS {
            assert_eq!(Feature::of(name), None, "{name} 同時在 ALWAYS 和某項功能裡");
            // i18n-ignore
        }
    }

    #[test]
    fn commands_belong_to_their_feature() {
        assert_eq!(Feature::of("git_status"), Some(Feature::Git));
        assert_eq!(Feature::of("github_clone"), Some(Feature::Git));
        assert_eq!(Feature::of("create_workflow"), Some(Feature::Git));
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
    fn asks_only_when_a_turned_off_feature_comes_back_on() {
        let f = Features::load(Some(
            &serde_json::json!({ "gitEnabled": false, "adoEnabled": false }),
        ));
        assert_eq!(f.off(), [Feature::Git, Feature::Ado]);
        // 還是關著、或本來就開著的功能不用問。
        let same =
            serde_json::json!({ "gitEnabled": false, "adoEnabled": false, "remoteEnabled": true });
        assert!(turned_on(&f.off(), &same).is_empty());
        assert_eq!(enable_question(&turned_on(&f.off(), &same)), None);
        // 網頁把關掉的功能打開：設成 true、拿掉這一項、或寫成不是 false 的值，都要問。
        let on = serde_json::json!({ "gitEnabled": true, "adoEnabled": "false" });
        let list = turned_on(&f.off(), &on);
        assert_eq!(list, [Feature::Git, Feature::Ado]);
        let q = enable_question(&list).unwrap();
        assert!(q.message.contains("Git 與 GitHub"), "{}", q.message);
        assert!(q.message.contains("Azure DevOps"), "{}", q.message);
        assert!(!q.message.contains("WebDAV"), "{}", q.message);
        let removed = serde_json::json!({ "theme": "dark" });
        assert_eq!(turned_on(&f.off(), &removed), [Feature::Git, Feature::Ado]);
        // 全部開著時，怎麼存都不用問。
        let all_on = Features::load(None);
        assert!(turned_on(&all_on.off(), &on).is_empty());
    }

    #[test]
    fn refused_features_stay_off() {
        let f = Features::load(Some(&serde_json::json!({ "remoteEnabled": false })));
        let mut settings =
            serde_json::json!({ "remoteEnabled": true, "gitEnabled": true, "theme": "dark" });
        let list = turned_on(&f.off(), &settings);
        assert_eq!(list, [Feature::Remote]);
        keep_off(&mut settings, &list);
        assert_eq!(
            settings,
            serde_json::json!({ "remoteEnabled": false, "gitEnabled": true, "theme": "dark" })
        );
        f.update(Some(&settings));
        assert!(f.check("dav_read").is_err());
        assert!(f.check("git_status").is_ok());
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
