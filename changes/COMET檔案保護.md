bump: minor
section: 新功能

- **COMET 的檔案不會被不小心動到**：COMET 專案裡由 COMET 管理的檔案，在檔案面板的名稱後面標一個「C」（`.comet.json`、`.comet` 資料夾、`AGENTS.md`、`docs/spec` 資料夾）。`.comet.json` 與 `.comet` 裡的設定檔在 oMarker 開啟時預設唯讀，上方說明原因，要改時按「仍要編輯」；`AGENTS.md` 上方提醒重新設定 COMET 時可能被覆蓋；`docs/spec` 的規格照常編輯。唯讀只擋在 oMarker 裡的手動編輯，不改檔案的屬性，comet 指令、Git、AI 直接改檔案都不受影響
- 在檔案面板刪除或改名 COMET 的檔案時，確認對話框會說明動到哪些，預設是「取消」
- 「重新設定 COMET」的對話框提醒：comet 可能依新的規則更新 `AGENTS.md` 等它產生的檔案，手動改過的話先提交到 Git 或留個備份
