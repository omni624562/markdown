# 給 AI 協作者的專案規則

- 介面文字、文件、提交說明以外的說明都用台灣的中文用語（不用中國用語）。
- **版本號**：每個改到程式（`web/src`、`desktop/src`、`crates/` 等）的 PR 都要依 [VERSIONING.md](VERSIONING.md) 升版：新功能 `node scripts/version.mjs bump minor`、修正與調整 `bump patch`、不相容的改變 `bump major`，並在 [CHANGELOG.md](CHANGELOG.md) 寫好這一版的說明（用使用者看得懂的話）。CI 的 `version` 工作會檢查。
- 送出前執行：`cargo fmt --check`、`cargo clippy -D warnings`（根目錄與 `desktop/`，桌面版也要檢查 `--target x86_64-pc-windows-gnu`）、`cargo test`、`web/` 的 `npm test`、`npm run typecheck`、`npm run build`。
