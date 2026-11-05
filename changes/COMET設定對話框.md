bump: minor

- **新 COMET 專案改成在對話框裡設定**：不必面對終端機、也不必一題一題回答。對話框多一段「COMET 設定」：已經連線 Azure DevOps 時，直接從清單選專案、團隊與 Sprint（預設目前的 Sprint，Sprint 天數自動算），「指派給」預設是你自己；還沒連線時貼上 Sprint 工作板的網址。按「建立並設定」就在背景執行 `comet setup`，對話框顯示每一步與輸出，完成後列出建立的檔案（可以直接開啟 `AGENTS.md`）；可以按「在背景繼續」，完成時跳出通知。失敗時寫出原因，可以改在終端機一問一答。oMarker 存的 Azure DevOps PAT 會在這次執行時交給 comet，第一次使用 COMET 不必先執行 `comet set-pat`。
