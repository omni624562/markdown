bump: patch

- **新 COMET 專案**：修正按「建立並設定」後 comet setup 出現「--assume-yes 需要 --sprint-number」而失敗：現在會一起送出 Sprint 編號（從 Sprint 名稱取，例如「Sprint 102」）；Sprint 名稱沒有編號時改送 Sprint 工作板的網址。
- **新 COMET 專案的對話框改成橫的**：左邊是專案名稱、位置、Git 與顏色，右邊是 COMET 設定，不用再上下捲動；團隊或 Sprint 的名稱很長時，選單也不會撐出對話框外。視窗太窄時照舊上下排。
