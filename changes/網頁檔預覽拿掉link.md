bump: patch

- 安全性：網頁檔（.html）的預覽拿掉所有 `<link>`，並關掉 DNS 預先查詢。原本別人給的網頁檔裡如果有 `preconnect`、`dns-prefetch`，一打開就會連到對方的伺服器（就算開著「封鎖遠端圖片」），對方可以知道你的 IP 和開檔時間。
