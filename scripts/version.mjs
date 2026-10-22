#!/usr/bin/env node
/**
 * 版本號工具（規則見 VERSIONING.md）。所有地方的版本號一律相同：
 *   desktop/Cargo.toml（桌面版，程式裡顯示的版本）、Cargo.toml（核心與命令列工具）、
 *   web/package.json，以及對應的 Cargo.lock、package-lock.json。
 *
 *   node scripts/version.mjs                    顯示目前的版本
 *   node scripts/version.mjs bump <major|minor|patch|x.y.z>
 *                                               改版本號，並在 CHANGELOG.md 加上新版的段落
 *   node scripts/version.mjs check [基準分支]    檢查版本號一致；有改到程式時，版本要比基準新，
 *                                               CHANGELOG.md 要有這一版的說明（CI 用）
 *   node scripts/version.mjs notes [版本]        印出 CHANGELOG.md 中這一版的說明（發佈用）
 *   node scripts/version.mjs summary [版本]      這一版說明的一行摘要（更新提示用）
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const write = (p, s) => writeFileSync(join(ROOT, p), s);

/** 每個檔案中版本號的位置：[檔案, 找版本號的正規表示式（第 1 組是版本號）]。 */
const SOURCES = [
  ["desktop/Cargo.toml", /^version = "([^"]+)"/m],
  ["desktop/Cargo.lock", /^name = "md-desktop"\nversion = "([^"]+)"/m],
  ["Cargo.toml", /^\[workspace\.package\][^[]*?^version = "([^"]+)"/ms],
  ["Cargo.lock", /^name = "md-core"\nversion = "([^"]+)"/m],
  ["Cargo.lock", /^name = "md-cli"\nversion = "([^"]+)"/m],
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
  const text = items.join("；");
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

function bump(part) {
  const from = current();
  const to = next(from, part);
  if (compare(to, from) <= 0) throw new Error(`新的版本號 ${to} 要比目前的 ${from} 大`);
  for (const [file, re] of SOURCES) {
    const text = read(file);
    const m = re.exec(text);
    const at = m.index + m[0].lastIndexOf(m[1]);
    write(file, text.slice(0, at) + to + text.slice(at + m[1].length));
  }
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
  const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const app = changed.filter((f) => APP_PATHS.test(f));
  if (!app.length) {
    console.log(`版本號 ${version}；這次沒有改到程式，不需要改版本號。`);
    return;
  }
  const baseToml = execFileSync("git", ["show", `${base}:desktop/Cargo.toml`], { cwd: ROOT, encoding: "utf8" });
  const baseVersion = SOURCES[0][1].exec(baseToml)[1];
  const problems = [];
  if (compare(version, baseVersion) <= 0) {
    problems.push(
      `改到了程式（${app.slice(0, 5).join("、")}${app.length > 5 ? "…" : ""}），版本號要比 ${base} 的 ${baseVersion} 新。` +
        "依 VERSIONING.md 執行 node scripts/version.mjs bump <major|minor|patch>。",
    );
  }
  const notes = notesOf(read("CHANGELOG.md"), version);
  if (!notes || /^-\s*$/m.test(notes)) problems.push(`CHANGELOG.md 要有「## ${version}」的說明，而且不能留空白的項目。`);
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log(`✓ 版本號 ${baseVersion} → ${version}，CHANGELOG.md 已寫好。`);
}

const [cmd, arg] = process.argv.slice(2);
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) try {
  if (!cmd) console.log(current());
  else if (cmd === "bump") bump(arg ?? "patch");
  else if (cmd === "check") check(arg ?? "origin/main");
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
