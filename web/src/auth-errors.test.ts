import assert from "node:assert/strict";
import { test } from "node:test";
import { authProblem } from "./auth-errors.ts";

test("認得 GitHub 與 Azure DevOps 的登入問題（中英文）", () => {
  assert.equal(authProblem("GitHub 登入已過期，請重新登入"), "github");
  assert.equal(authProblem("Your GitHub sign-in has expired. Sign in again."), "github");
  assert.equal(authProblem("推送失敗：需要登入 GitHub。請到設定的 Git 頁按「用 GitHub 登入」。"), "github");
  assert.equal(authProblem("Push failed: GitHub denied access. You may not have permission for this repository, or your sign-in has expired. Sign in to GitHub again."), "github");
  assert.equal(
    authProblem("拉取失敗：Azure DevOps 拒絕存取。可能沒有這個儲存庫的權限，或個人存取權杖已過期，請到設定的 Azure DevOps／TFS 頁更新權杖。"),
    "ado",
  );
  assert.equal(authProblem("讀取工作項目失敗：個人存取權杖無效或已過期，請到設定的 Azure DevOps／TFS 頁更新權杖"), "ado");
  assert.equal(authProblem("已取消登入"), null);
  assert.equal(authProblem("拉取失敗：無法連線到 GitHub（timeout）"), null);
  assert.equal(authProblem("無法儲存檔案"), null);
});
