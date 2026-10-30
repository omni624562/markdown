//! 其他：圖片、PDF、版本記錄、設定等。

pub static EN: &[(&str, &str)] = &[
    ("找不到這個版本", "Couldn't find this version."),
    (
        "無法查看這個檔案的版本記錄",
        "Can't view the version history of this file.",
    ),
    (
        "找不到版本記錄資料夾",
        "Couldn't find the version history folder.",
    ),
    ("無法讀取版本：{e}", "Couldn't read the version: {e}"),
    ("不支援的圖片格式：{ext}", "Unsupported image format: {ext}"),
    ("圖片資料無效", "Invalid image data."),
    ("圖片超過 30 MB", "The image is larger than 30 MB."),
    (
        "請先存檔，圖片會存在文件旁的 assets 資料夾",
        "Save the document first. Images are stored in the assets folder next to it.",
    ),
    (
        "assets 資料夾指向文件資料夾以外的位置，無法存放圖片",
        "The assets folder points outside the document's folder, so images can't be stored there.",
    ),
    (
        "只能開啟網頁或電子郵件連結",
        "Only web or email links can be opened.",
    ),
    (
        "未知的視窗動作：{action}",
        "Unknown window action: {action}",
    ),
    (
        "無法寫入 PDF（檔案可能正被其他程式開著）",
        "Couldn't write the PDF (the file may be open in another program).",
    ),
    (
        "這個平台不支援直接匯出 PDF",
        "Exporting directly to PDF isn't supported on this platform.",
    ),
    ("匯出 PDF", "Export PDF"),
    ("PDF 文件", "PDF Documents"),
    (
        "請重新選擇 PDF 的存檔位置",
        "Choose where to save the PDF again.",
    ),
    ("匯出 PDF 逾時", "PDF export timed out."),
    ("無法讀取設定：{e}", "Couldn't read the settings: {e}"),
    ("無法儲存設定：{e}", "Couldn't save the settings: {e}"),
    // 1.17.2 安全修正
    ("這個資料夾的 Git 設定會把檔案寫到資料夾以外的地方（core.worktree 或 gitdir），為了安全不使用。", "This folder's Git settings would write files outside the folder (core.worktree or gitdir), so it isn't used, for safety."),
    ("遠端網址用的是沒有加密的 HTTP，密碼和內容可能被看到，只能用在區域網路。請改用 HTTPS 的網址：{url}", "The remote uses unencrypted HTTP, so passwords and content could be seen. HTTP is only allowed on a local network. Use an HTTPS URL instead: {url}"),
    ("帳號不正確", "Invalid user name."),
    ("HTTP 不會加密，個人存取權杖可能被看到，只能用在公司內部網路的伺服器。請改用 https:// 開頭的網址", "HTTP isn't encrypted, so your personal access token could be seen. It's only allowed for servers on your company network. Use a URL starting with https:// instead."),
    ("請先在設定開啟「啟用 AI 協作」", "Turn on \"Enable AI Collaboration\" in Settings first."),
    ("Git 與 GitHub", "Git and GitHub"),
    ("Azure DevOps／TFS", "Azure DevOps/TFS"),
    ("遠端資料夾（WebDAV、SSH）", "Remote folders (WebDAV, SSH)"),
    ("「{name}」已在設定關閉，要使用請先到設定開啟。", "\"{name}\" is turned off in Settings. Turn it on there to use it."),
    ("啟用 AI 協作", "Enable AI Collaboration"),
    ("啟用後，oMarker 可以執行 Claude Code、Codex 等 AI 工具，並讓它們讀取目前的文件。要啟用嗎？", "Once enabled, oMarker can run AI tools such as Claude Code and Codex and let them read the current document. Enable it?"),
];
