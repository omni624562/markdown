bump: patch
section: 調整

- **新 COMET 專案**：找 COMET CLI 時，PATH 裡沒有就先找 `COMET_HOME`（安裝 COMET 時設定的環境變數）的 bin 資料夾，再找預設的 `%USERPROFILE%\Comet\bin`。COMET 裝在其他位置的電腦也認得到，會用完整路徑執行 `comet setup`。
