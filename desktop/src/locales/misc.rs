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
];
