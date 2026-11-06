//! 檔案與資料夾的讀寫。

pub static EN: &[(&str, &str)] = &[
    (
        "「{name}」所在的資料夾和開啟時不同（可能被改名、搬移，或換成了連結），為了安全沒有讀寫。請重新從「開啟檔案」選取。",
        "The folder containing \"{name}\" has changed since the file was opened (it may have been renamed, moved or replaced with a link), so for safety it wasn't read or written. Select the file again with Open File.",
    ),
    (
        "「{name}」的編碼無法辨識，請先開啟確認內容",
        "Couldn't detect the encoding of \"{name}\". Open it and check its content first.",
    ),
    (
        "「{name}」是 {encoding} 編碼，寫不進「{chars}」",
        "\"{name}\" is {encoding} encoded, which can't store \"{chars}\".",
    ),
    (
        "這份文件還沒存成檔案",
        "This document hasn't been saved as a file yet.",
    ),
    ("不支援的編碼：{id}", "Unsupported encoding: {id}"),
    (
        "{encoding} 存不了這幾個字：{chars}",
        "{encoding} can't store these characters: {chars}",
    ),
    (
        "「{name}」剛被修改過，請重新整理後再試",
        "\"{name}\" was just modified. Refresh and try again.",
    ),
    (
        "不是文字檔（可能是圖片、PDF、壓縮檔或執行檔），無法開啟",
        "is not a text file (it may be an image, PDF, archive, or executable) and can't be opened.",
    ),
    (
        "「{name}」超過 {mb} MB，無法開啟",
        "\"{name}\" is larger than {mb} MB and can't be opened.",
    ),
    (
        "「{name}」在磁碟上已經超過 {mb} MB，可能被其他程式改過；為了不蓋掉它，沒有存檔。請用「另存新檔」存到其他位置。",
        "\"{name}\" is now larger than {mb} MB on disk and may have been changed by another program. It wasn't saved, so that it isn't overwritten. Use Save As to save to another location.",
    ),
    (
        "「{name}」超過 {mb} MB，不能在這裡修改",
        "\"{name}\" is larger than {mb} MB and can't be changed here.",
    ),
    ("無法建立暫存檔", "Couldn't create a temporary file."),
    (
        "這個檔案是符號連結，不直接覆寫",
        "This file is a symbolic link and won't be overwritten directly.",
    ),
    ("開啟檔案", "Open File"),
    ("文件與程式碼", "Documents and Code"),
    ("所有檔案", "All Files"),
    (
        "這個檔案不在最近開啟的清單中，請重新從「開啟檔案」選取。",
        "This file isn't in the recently opened list. Select it again with \"Open File\".",
    ),
    ("匯出的資料無效：{e}", "The exported data is invalid: {e}"),
    ("匯出", "Export"),
    ("無法寫入檔案", "Couldn't write the file"),
    ("匯入", "Imported"),
    ("匯入 Word 文件", "Import Word Document"),
    ("Word 文件", "Word Documents"),
    ("［圖片：{alt}］", "[Image: {alt}]"),
    (
        "「{name}」超過 100 MB，無法匯入",
        "\"{name}\" is larger than 100 MB and can't be imported.",
    ),
    ("另存新檔", "Save As"),
    ("提交編號不正確", "Invalid commit ID."),
    ("找不到這個提交", "Couldn't find this commit."),
    (
        "這個版本沒有這個檔案",
        "This file doesn't exist in this version.",
    ),
    ("這個版本的檔案{why}", "This version of the file {why}"),
    (
        "目前只支援 GitHub 與 Azure DevOps 上的儲存庫",
        "Only repositories on GitHub and Azure DevOps are supported.",
    ),
    (
        "請先開啟檔案所在的資料夾",
        "Open the folder that contains the file first.",
    ),
    (
        "請先開啟連到 GitHub 的資料夾",
        "Open a folder that's connected to GitHub first.",
    ),
    (
        "這個資料夾還沒有連到 GitHub",
        "This folder isn't connected to GitHub yet.",
    ),
    (
        "這個資料夾不是連到 GitHub 的儲存庫",
        "This folder isn't a repository connected to GitHub.",
    ),
    (
        "這個檔案不在 Git 儲存庫裡",
        "This file isn't in a Git repository.",
    ),
    (
        "這個儲存庫沒有工作目錄",
        "This repository has no working directory.",
    ),
    ("沒有要匯入的 Word 檔", "There's no Word file to import."),
];
