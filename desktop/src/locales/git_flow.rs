//! Git：分支、合併衝突。

pub static EN: &[(&str, &str)] = &[
    (
        "還有未提交的變更，請先提交再切換分支",
        "You have uncommitted changes. Commit them before switching branches.",
    ),
    (
        "找不到分支「{name}」",
        "Couldn't find the branch \"{name}\".",
    ),
    ("切換分支失敗：{e}", "Couldn't switch branches: {e}"),
    ("已切換到「{name}」", "Switched to \"{name}\"."),
    (
        "分支名稱不正確：不能有空白與 ~ ^ : ? * [ \\ 等符號",
        "Invalid branch name: it can't contain spaces or symbols such as ~ ^ : ? * [ \\.",
    ),
    (
        "已經有「{name}」這個分支",
        "A branch named \"{name}\" already exists.",
    ),
    (
        "還沒有任何提交，請先提交一次",
        "There are no commits yet. Make a commit first.",
    ),
    (
        "已建立並切換到「{name}」",
        "Created and switched to \"{name}\".",
    ),
    (
        "找不到遠端的分支，請先拉取",
        "Couldn't find the remote branch. Pull first.",
    ),
    ("合併失敗：{e}", "Merge failed: {e}"),
    (
        "不是文字檔，保留本機的版本",
        "Not a text file. Kept the local version.",
    ),
    (
        "遠端刪除了這個檔案，保留本機的版本",
        "The remote deleted this file. Kept the local version.",
    ),
    (
        "本機刪除了這個檔案，維持刪除",
        "This file was deleted locally. It stays deleted.",
    ),
    (
        "「{rel}」裡還有 <<<<<<< 衝突標記，請先處理完再完成合併",
        "\"{rel}\" still has <<<<<<< conflict markers. Resolve them before finishing the merge.",
    ),
    ("找不到要合併的提交", "Couldn't find the commit to merge."),
    ("合併遠端的變更", "Merge remote changes"),
    ("完成合併失敗：{e}", "Couldn't finish the merge: {e}"),
    ("已完成合併，記得推送", "Merge finished. Remember to push."),
    ("放棄合併失敗：{e}", "Couldn't abort the merge: {e}"),
    (
        "已放棄合併，回到合併前的狀態",
        "Merge aborted. Everything is back to how it was before the merge.",
    ),
    (
        "請輸入 Pull Request 的標題",
        "Enter a title for the pull request.",
    ),
    ("目前不在任何分支上", "You're not on any branch."),
];
