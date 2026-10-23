//! WebDAV 連線與遠端檔案。

pub static EN: &[(&str, &str)] = &[
    ("{what}：帳號或密碼不正確，或沒有權限", "{what}: The user name or password is incorrect, or you don't have permission."),
    ("{what}：遠端找不到這個項目", "{what}: The item wasn't found on the server."),
    ("{what}：遠端的檔案已被其他人修改", "{what}: The file on the server was changed by someone else."),
    ("{what}：已經有同名的項目", "{what}: An item with the same name already exists."),
    ("{what}：伺服器回應 {code}", "{what}: The server responded with {code}."),
    ("網址格式不正確，例如：https://nas.local:5006/筆記/", "Invalid URL. Example: https://nas.local:5006/notes/"),
    ("只能用 HTTPS 連線到網際網路上的伺服器（HTTP 不加密，密碼可能被看到）", "Servers on the internet can only be reached over HTTPS (HTTP isn't encrypted, so your password could be exposed)."),
    ("網址要以 https:// 開頭", "The URL must start with https://."),
    ("遠端路徑不正確", "Invalid remote path."),
    ("找不到這個 WebDAV 連線，請重新設定", "Couldn't find this WebDAV connection. Set it up again."),
    ("這個網址不是資料夾", "This URL isn't a folder."),
    ("這個網址不是 WebDAV 伺服器（請確認 NAS 已開啟 WebDAV 服務與連接埠）", "This URL isn't a WebDAV server (make sure the WebDAV service and port are enabled on the NAS)."),
    ("無法連線", "Couldn't connect"),
    ("無法儲存「{name}」", "Couldn't save \"{name}\""),
    ("不能重新命名遠端資料夾本身", "You can't rename the remote folder itself."),
    ("不能刪除遠端資料夾本身", "You can't delete the remote folder itself."),
    ("無法刪除", "Couldn't delete"),
    ("不是圖片", "Not an image."),
    ("無法讀取圖片", "Couldn't read the image"),
];
