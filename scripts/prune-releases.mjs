#!/usr/bin/env node
/**
 * 清理舊版本：版本號的 Release 與標籤（`v<主>.<次>.<修>`）只保留最近幾個，其他的連同標籤一起刪掉。
 *
 * 一定保留：
 * - 「最新版」（`latest`）與「穩定版」（`stable`）：程式的自動更新看這兩個（標籤不是版本號，本來就不在清理範圍）。
 * - 穩定版指向的那一版：穩定版的 version.json 網址指向 `v<版本號>` 的 omarker.exe，刪掉就下載不到。
 *
 * 只有標籤、沒有 Release 的舊版本號（例如發佈到一半的）也一起刪掉。
 *
 *   node scripts/prune-releases.mjs [--keep 3] [--dry-run]
 *
 * 需要 `gh`，並設定 `GH_TOKEN` 與 `GITHUB_REPOSITORY`（GitHub Actions 裡都有）。
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** `v1.2.3` → [1, 2, 3]；不是版本號的標籤（`latest`、`stable`、`v1.2` 等）回傳 null。 */
export function parseVersion(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 版本號由新到舊排序用。 */
function newerFirst(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return 0;
}

/**
 * 決定刪哪些：`tags` 是所有標籤（含有 Release 的），`keep` 是保留幾個最新的版本號，
 * `protect` 是另外一定要留的標籤（例如穩定版指向的那一版）。回傳由新到舊的 `{ keep, remove }`。
 */
export function plan(tags, keep, protect = []) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`保留的數量要是 1 以上的整數：${keep}`);
  const versions = [...new Set(tags.filter((t) => parseVersion(t)))].sort(newerFirst);
  const kept = new Set([...versions.slice(0, keep), ...protect]);
  return { keep: versions.filter((t) => kept.has(t)), remove: versions.filter((t) => !kept.has(t)) };
}

function gh(args, { input } = {}) {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** 穩定版指向的版本號標籤（`v1.2.3`）；還沒設定穩定版時是 null。 */
function stableTag(repo) {
  try {
    const manifest = JSON.parse(gh(["release", "download", "stable", "--repo", repo, "-p", "version.json", "-O", "-"]));
    return manifest.version ? `v${manifest.version}` : null;
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--keep");
  const keep = at >= 0 ? Number(args[at + 1]) : 3;
  const dryRun = args.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("請設定 GITHUB_REPOSITORY（例如 owner/repo）");

  const releases = new Set(gh(["release", "list", "--repo", repo, "--limit", "1000", "--json", "tagName", "-q", ".[].tagName"]).split("\n").filter(Boolean));
  const tags = gh(["api", `repos/${repo}/tags`, "--paginate", "-q", ".[].name"]).split("\n").filter(Boolean);
  const stable = stableTag(repo);
  const { keep: kept, remove } = plan([...releases, ...tags], keep, stable ? [stable] : []);

  console.log(`保留 ${kept.length} 個版本：${kept.join("、") || "（無）"}${stable ? `（穩定版是 ${stable}）` : ""}`);
  console.log(`${dryRun ? "試跑，不會刪：" : "刪除"} ${remove.length} 個版本${remove.length ? `：${remove.join("、")}` : ""}`);
  if (dryRun) return;

  let failed = 0;
  for (const tag of remove) {
    try {
      if (releases.has(tag)) gh(["release", "delete", tag, "--repo", repo, "--cleanup-tag", "--yes"]);
      else gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/tags/${tag}`]);
    } catch (e) {
      failed++;
      console.error(`刪除 ${tag} 失敗：${e.stderr?.toString().trim() || e.message}`);
    }
  }
  console.log(failed ? `完成，但有 ${failed} 個刪除失敗。` : "完成。");
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
