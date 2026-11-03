# 改動片段

每個改到程式的 PR 在這裡新增一個 `.md` 檔（檔名隨意，例如 `工作板配色.md`），**不要自己改版本號**。
合併到 main 時不會升版，片段先累積在這裡；發佈時（GitHub Actions → Desktop → Run workflow），CI 依這裡所有的片段升一個版本、把說明寫進 `CHANGELOG.md`，再刪掉片段（見 [VERSIONING.md](../VERSIONING.md)）。

```md
bump: minor

- **Sprint 工作板**：左側圖示列新的「工作板」……
```

- 第一行 `bump:` 是升哪一碼：`minor`（新功能）、`patch`（修正與調整）、`major`（不相容的改變）。一次合併好幾個片段時取最大的。
- 可以再加一行 `section:` 指定分類（`新功能`、`調整`、`修正`、`不相容的改變`）；沒寫時 `minor` 放「新功能」、`patch` 放「修正」、`major` 放「不相容的改變」。
- 空一行之後是 `CHANGELOG.md` 的項目，`- ` 開頭，用使用者看得懂的話寫。
