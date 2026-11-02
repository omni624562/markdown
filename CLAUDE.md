# 給 AI 協作者的專案規則

- 介面文字、文件、提交說明以外的說明都用台灣的中文用語（不用中國用語）。
- **分支**：每一項調整都從最新的 `main` 拉一條新分支（名稱看得出在改什麼，例如 `claude/close-project`），一個 PR 只放一件事；不要直接改 `main`，也不要把不相關的調整疊在同一條分支上。CI 全部通過後合併，再刪掉分支。CI 的 `version` 工作會檢查分支（`scripts/branch-check.mjs`）：PR 要合併到 `main`，也不能把其他還沒合併的分支合併進來（把 `main` 合併進來可以）。
- **版本號與更新紀錄**：不要自己改版本號。每個改到程式（`web/src`、`desktop/src`、`crates/` 等）的 PR 新增一個 `changes/*.md` 片段（第一行 `bump: minor`／`patch`／`major`，空一行後寫給使用者看的說明，見 [changes/README.md](changes/README.md)）；合併到 main 後 CI 會依片段升版並寫進 [CHANGELOG.md](CHANGELOG.md)。所以 PR 之間不會因為版本號互相衝突。CI 的 `version` 工作會檢查。
- 送出前執行：`cargo fmt --check`、`cargo clippy -D warnings`（根目錄與 `desktop/`，桌面版也要檢查 `--target x86_64-pc-windows-gnu`）、`cargo test`、`web/` 的 `npm test`、`npm run typecheck`、`npm run build`。
- **前端的新功能放在 `web/src/app/`**：`web/src/main.ts` 只放目前分頁的狀態（`cur`）、編輯器與預覽、分頁、存檔、版面。新功能各自一個模組，透過 `app/context.ts` 的 `app` 取用 main.ts 的狀態與函式。main.ts 有行數上限（`web/src/main-size.test.ts`），超過時把功能拆出去，不要調高上限。
