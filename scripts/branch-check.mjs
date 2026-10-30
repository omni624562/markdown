#!/usr/bin/env node
/**
 * 分支規則（CLAUDE.md）：每一項調整都從最新的 main 拉一條新分支，一個 PR 只放一件事，
 * 不要把不相關的調整疊在同一條分支上。CI 檢查兩件事：
 *
 * 1. PR 要合併到 main（不是合併到另一條功能分支）。
 * 2. PR 裡的合併提交只能是「把 main 合併進來」：合併進來的另一邊必須已經在 main 上。
 *    （以前常見的 `Merge claude/甲 into claude/乙` 會被擋下來。）
 *
 *   node scripts/branch-check.mjs <base 分支> <PR 的 head 提交>
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * 找出違反規則的地方。`merges` 是 PR 裡的合併提交（`parents[0]` 是原本的分支，其餘是合併進來的），
 * `inMain(sha)` 判斷提交是否已經在 main 上。回傳給人看的錯誤訊息。
 */
export function violations(base, merges, inMain) {
  const out = [];
  if (base !== "main") out.push(`PR 要合併到 main，這個 PR 的目標是 ${base}。請改成從 main 拉分支、合併回 main。`);
  for (const m of merges) {
    const others = m.parents.slice(1).filter((p) => !inMain(p));
    if (others.length) {
      out.push(`提交 ${m.sha.slice(0, 7)}（${m.subject}）把另一條還沒合併到 main 的分支合併進來；請不要把不同的調整疊在同一條分支上。`);
    }
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("用法：node scripts/branch-check.mjs <base 分支> <PR 的 head 提交>");
    process.exit(1);
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const main = "origin/main";
  const merges = git("rev-list", "--merges", "--format=%H %P%n%s", `${main}..${head}`)
    .split("\n")
    .filter((l) => l && !l.startsWith("commit "))
    .reduce((list, line, i, all) => {
      // 每個提交兩行：「sha 父提交…」與標題。
      if (i % 2 === 0) {
        const [sha, ...parents] = line.split(" ");
        list.push({ sha, parents, subject: all[i + 1] ?? "" });
      }
      return list;
    }, []);
  const inMain = (sha) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, main]);
      return true;
    } catch {
      return false;
    }
  };
  const errors = violations(base, merges, inMain);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  console.log(`✓ 分支符合規則（${merges.length} 個合併提交都是把 main 合併進來）`);
}
