#!/usr/bin/env node
/**
 * 版本號工具（規則見 VERSIONING.md）。所有地方的版本號一律相同：
 *   desktop/Cargo.toml（桌面版，程式裡顯示的版本）、Cargo.toml（核心與命令列工具）、
 *   web/package.json，以及對應的 Cargo.lock、package-lock.json。
 *
 *   node scripts/version.mjs                    顯示目前的版本
 *   node scripts/version.mjs check [基準分支]    檢查版本號一致；有改到程式時，PR 要新增一個
 *                                               changes/*.md 片段，而且不能自己改版本號（CI 用）
 *   node scripts/version.mjs release            依 changes/ 的片段升版、寫進 CHANGELOG.md、刪掉片段
 *                                               （合併到 main 後由 CI 執行）；沒有片段時不做事
 *   node scripts/version.mjs bump <major|minor|patch|x.y.z>
 *                                               直接改版本號（一般不需要，release 會改）
 *   node scripts/version.mjs notes [版本]        印出 CHANGELOG.md 中這一版的說明（發佈用）
 *   node scripts/version.mjs summary [版本]      這一版說明的一行摘要（更新提示用）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const write = (p, s) => writeFileSync(join(ROOT, p), s);

/** 每個檔案中版本號的位置：[檔案, 找版本號的正規表示式（第 1 組是版本號）]。 */
const SOURCES = [
  ["desktop/Cargo.toml", /^version = "([^"]+)"/m],
  ["desktop/Cargo.lock", /^name = "md-desktop"\nversion = "([^"]+)"/m],
  ["desktop/Cargo.lock", /^name = "md-text"\nversion = "([^"]+)"/m],
  ["desktop/Cargo.lock", /^name = "md-core"\nversion = "([^"]+)"/m],
  ["desktop/Cargo.lock", /^name = "md-docx"\nversion = "([^"]+)"/m],
  ["Cargo.toml", /^\[workspace\.package\][^[]*?^version = "([^"]+)"/ms],
  ["Cargo.lock", /^name = "md-core"\nversion = "([^"]+)"/m],
  ["Cargo.lock", /^name = "md-cli"\nversion = "([^"]+)"/m],
  ["Cargo.lock", /^name = "md-text"\nversion = "([^"]+)"/m],
  ["Cargo.lock", /^name = "md-docx"\nversion = "([^"]+)"/m],
  ["Cargo.lock", /^name = "md-wasm"\nversion = "([^"]+)"/m],
  ["web/package.json", /^ {2}"version": "([^"]+)"/m],
  ["web/package-lock.json", /^ {2}"version": "([^"]+)"/m],
  ["web/package-lock.json", /^ {4}"": \{\n {6}"name": "[^"]+",\n {6}"version": "([^"]+)"/m],
];

/** 改到這些路徑才算改了程式（文件、測試腳本、CI 設定不用改版本號）。 */
const APP_PATHS = /^(web\/(src|public|index\.html|package\.json)|desktop\/(src|icons|Cargo\.toml|tauri\.conf\.json|capabilities|build\.rs)|crates\/)/;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parse(v) {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`版本號格式不對：${v}（要像 1.2.3）`);
  return m.slice(1).map(Number);
}

export function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function next(v, part) {
  if (SEMVER.test(part)) return part;
  const [major, minor, patch] = parse(v);
  if (part === "major") return `${major + 1}.0.0`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  if (part === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`不認得「${part}」：請用 major、minor、patch 或完整的版本號`);
}

/** 所有地方的版本號。 */
function versions() {
  return SOURCES.map(([file, re]) => {
    const m = re.exec(read(file));
    if (!m) throw new Error(`在 ${file} 找不到版本號`);
    return { file, version: m[1] };
  });
}

function current() {
  const all = versions();
  const differ = all.filter((v) => v.version !== all[0].version);
  if (differ.length) {
    throw new Error(
      `版本號不一致：${all.map((v) => `${v.file} ${v.version}`).join("、")}。請用 node scripts/version.mjs bump 統一修改。`,
    );
  }
  return all[0].version;
}

/** 給更新提示用的一行摘要：把各項目接起來，太長就截斷。 */
export function summary(notes, max = 140) {
  const items = notes
    .split("\n")
    .filter((l) => /^\s*[-*] /.test(l))
    .map((l) => l.replace(/^\s*[-*] /, "").replace(/`/g, "").trim());
  // 以冒號結尾的項目後面接的是它的子項目，不再加「；」；句號結尾的換成「；」。
  const text = items.reduce((out, item, i) => {
    if (!i) return item;
    if (/[：:]$/.test(out)) return out + item;
    return out.replace(/。$/, "") + "；" + item;
  }, "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** CHANGELOG.md 中某一版的說明（不含標題）。 */
export function notesOf(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${version.replaceAll(".", "\\.")}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

// ---- 改動片段（changes/*.md） ---------------------------------------------------

/** 片段放的資料夾（README.md 是說明，不算片段）。 */
export const CHANGES_DIR = "changes";
const PARTS = ["patch", "minor", "major"];
/** 沒寫 `section:` 時，依升版的種類放在哪個分類。 */
const DEFAULT_SECTION = { major: "不相容的改變", minor: "新功能", patch: "修正" };
/** CHANGELOG 裡分類的順序。 */
const SECTIONS = ["不相容的改變", "新功能", "調整", "修正"];

/**
 * 讀一個片段：第一行 `bump: minor`（或 patch、major），可以再加一行 `section: 調整`，
 * 空一行之後是 CHANGELOG 的項目（`- ` 開頭）。格式不對時丟出錯誤（說明哪個檔案、哪裡不對）。
 */
export function parseFragment(text, name = "片段") {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const head = {};
  let i = 0;
  for (; i < lines.length && lines[i].trim(); i++) {
    const m = /^(bump|section)\s*:\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) throw new Error(`${name}：開頭要是「bump: minor」這樣的設定，看不懂「${lines[i]}」`);
    head[m[1]] = m[2];
  }
  if (!PARTS.includes(head.bump)) throw new Error(`${name}：bump 要是 patch、minor 或 major`);
  const section = head.section ?? DEFAULT_SECTION[head.bump];
  if (!SECTIONS.includes(section)) throw new Error(`${name}：section 要是 ${SECTIONS.join("、")} 其中之一`);
  const body = lines.slice(i).join("\n").trim();
  if (!/^[-*] \S/m.test(body) || /^[-*]\s*$/m.test(body)) throw new Error(`${name}：要有至少一個「- 」開頭的說明，而且不能留空白的項目`);
  return { bump: head.bump, section, body };
}

/** 把片段合成一版的說明：升版取最大的一種，項目依分類排好。 */
export function combine(fragments) {
  const bump = fragments.reduce((max, f) => (PARTS.indexOf(f.bump) > PARTS.indexOf(max) ? f.bump : max), "patch");
  const notes = SECTIONS.filter((s) => fragments.some((f) => f.section === s))
    .map((s) => `### ${s}\n\n${fragments.filter((f) => f.section === s).map((f) => f.body).join("\n")}`)
    .join("\n\n");
  return { bump, notes };
}

/** 待發佈的片段：[檔名, 內容]，依檔名排序。 */
function pendingFragments() {
  let names;
  try {
    names = readdirSync(join(ROOT, CHANGES_DIR));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
    .sort()
    .map((n) => [n, read(join(CHANGES_DIR, n))]);
}

/** 依片段升版、寫好 CHANGELOG.md、刪掉片段；沒有片段時什麼都不做。印出新的版本號。 */
function release() {
  const pending = pendingFragments();
  if (!pending.length) {
    console.log(`沒有待發佈的改動，版本號維持 ${current()}。`);
    return;
  }
  const { bump: part, notes } = combine(pending.map(([n, text]) => parseFragment(text, `${CHANGES_DIR}/${n}`)));
  const from = current();
  const to = next(from, part);
  setVersion(to);
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  let changelog = read("CHANGELOG.md");
  const at = changelog.search(/^## /m);
  const entry = `## ${to} — ${date}\n\n${notes}\n\n`;
  changelog = at < 0 ? `${changelog.trimEnd()}\n\n${entry}` : changelog.slice(0, at) + entry + changelog.slice(at);
  write("CHANGELOG.md", changelog);
  for (const [n] of pending) rmSync(join(ROOT, CHANGES_DIR, n));
  console.log(`${from} → ${to}（${pending.length} 個改動）`);
}

function setVersion(to) {
  for (const [file, re] of SOURCES) {
    const text = read(file);
    const m = re.exec(text);
    const at = m.index + m[0].lastIndexOf(m[1]);
    write(file, text.slice(0, at) + to + text.slice(at + m[1].length));
  }
}

function bump(part) {
  const from = current();
  const to = next(from, part);
  if (compare(to, from) <= 0) throw new Error(`新的版本號 ${to} 要比目前的 ${from} 大`);
  setVersion(to);
  let changelog = read("CHANGELOG.md");
  const hasNotes = notesOf(changelog, to) !== null;
  if (!hasNotes) {
    const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
    const entry = `## ${to} — ${date}\n\n### 新功能\n\n- \n\n### 修正\n\n- \n\n`;
    const i = changelog.search(/^## /m);
    changelog = i < 0 ? `${changelog.trimEnd()}\n\n${entry}` : changelog.slice(0, i) + entry + changelog.slice(i);
    write("CHANGELOG.md", changelog);
  }
  console.log(`${from} → ${to}。` + (hasNotes ? "" : "請在 CHANGELOG.md 填寫這一版的說明（沒有的分類整段刪掉）。"));
}

function check(base) {
  const version = current();
  const changed = execFileSync("git", ["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=AMR", `${base}...HEAD`], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const app = changed.filter((f) => APP_PATHS.test(f));
  const fragments = changed.filter((f) => f.startsWith(`${CHANGES_DIR}/`) && f.endsWith(".md") && !/readme\.md$/i.test(f));
  const problems = [];
  // 每個片段都要看得懂（合併後 release 才不會失敗）。
  for (const f of fragments) {
    try {
      parseFragment(read(f), f);
    } catch (e) {
      problems.push(e.message);
    }
  }
  const baseToml = execFileSync("git", ["show", `${base}:desktop/Cargo.toml`], { cwd: ROOT, encoding: "utf8" });
  const baseVersion = SOURCES[0][1].exec(baseToml)[1];
  if (version !== baseVersion) {
    problems.push(`不要自己改版本號（${baseVersion} → ${version}）：合併到 main 後 CI 會依 ${CHANGES_DIR}/ 的片段自動升版。`);
  }
  if (app.length && !fragments.length) {
    problems.push(
      `改到了程式（${app.slice(0, 5).join("、")}${app.length > 5 ? "…" : ""}），要新增一個 ${CHANGES_DIR}/*.md 片段` +
        `（第一行 bump: minor 或 patch，空一行後寫給使用者看的說明，見 ${CHANGES_DIR}/README.md）。`,
    );
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(app.length || fragments.length ? `✓ ${fragments.length} 個改動片段，合併後自動升版。` : `版本號 ${version}；這次沒有改到程式。`);
}

const [cmd, arg] = process.argv.slice(2);
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) try {
  if (!cmd) console.log(current());
  else if (cmd === "bump") bump(arg ?? "patch");
  else if (cmd === "check") check(arg ?? "origin/main");
  else if (cmd === "release") release();
  else if (cmd === "notes") {
    const v = arg ?? current();
    const notes = notesOf(read("CHANGELOG.md"), v);
    if (notes === null) throw new Error(`CHANGELOG.md 沒有 ${v} 的說明`);
    console.log(notes);
  } else if (cmd === "summary") {
    const v = arg ?? current();
    console.log(summary(notesOf(read("CHANGELOG.md"), v) ?? ""));
  } else throw new Error(`不認得的指令：${cmd}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
