/**
 * 工作項目、Wiki 內容裡連到 Azure DevOps 儲存庫檔案或附件的連結：
 * 辨認出可以直接在 oMarker 閱讀的文字檔（Markdown、純文字、程式碼），不碰畫面，方便測試。
 */

import { underServer } from "./server-url.ts";

export type RepoFileLink =
  | {
      kind: "git";
      project: string;
      repo: string;
      /** 檔案在儲存庫裡的路徑（以 `/` 開頭）。 */
      path: string;
      /** 分支、標籤或提交（網址裡 `version=GBmain` 的 `main`）。 */
      version: string | null;
      versionType: "branch" | "tag" | "commit" | null;
      name: string;
    }
  | { kind: "attachment"; url: string; name: string };

/** 可以在 oMarker 閱讀的檔案（副檔名）。 */
const TEXT_FILE =
  /\.(md|markdown|mdx|txt|log|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|cs|c|h|cc|cpp|hpp|swift|php|sh|bash|ps1|psm1|bat|cmd|sql|gradle|properties|env|dockerfile|editorconfig|gitignore)$/i;

export function isReadableFileName(name: string): boolean {
  return TEXT_FILE.test(name) || /^(readme|license|changelog|dockerfile|makefile)$/i.test(name);
}

export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const VERSION_TYPES = { GB: "branch", GT: "tag", GC: "commit" } as const;

/** 可以在 oMarker 裡放大檢視的圖片（副檔名；SVG 可能帶指令碼，不算）。 */
export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

/**
 * `href` 是不是連線中那台伺服器（`base` 是集合的網址）上、可以閱讀的儲存庫檔案或附件。
 * 網址的寫法可以和連線設定不同（http／https、埠號、只寫電腦名稱）；附件的網址改用連線設定的伺服器。
 */
export function parseRepoFileLink(href: string, base: string): RepoFileLink | null {
  return serverFileLink(href, base, isReadableFileName);
}

/**
 * 連到伺服器上的圖片：工作項目的附件、儲存庫（含 Wiki 的儲存庫）裡的圖片，
 * 包括 Git 的網頁網址（`/_git/儲存庫?path=…`）與 API 的網址（`/_apis/git/repositories/…/items?path=…`）。
 */
/** 連到伺服器上儲存庫裡的 PDF、Office 文件、郵件（例如 Wiki 的附件）。 */
export function parseViewerLink(href: string, base: string): RepoFileLink | null {
  const link = serverFileLink(href, base, (name) => /\.(pdf|docx|xlsx|pptx|msg)$/i.test(name));
  return link?.kind === "git" ? link : null;
}

export function parseImageLink(href: string, base: string): RepoFileLink | null {
  return serverFileLink(href, base, isImageName);
}

function serverFileLink(href: string, base: string, accept: (name: string) => boolean): RepoFileLink | null {
  const at = underServer(href, base);
  if (!at) return null;
  const { rest, params: query } = at;
  const attachment = /^(?:\/[^/]+)?\/_apis\/wit\/attachments\/[^/]+$/i.exec(rest);
  if (attachment) {
    const name = query.get("fileName") ?? "";
    return name && accept(name) ? { kind: "attachment", url: `${at.root}${rest}${at.search}`, name } : null;
  }
  // `/專案/_git/儲存庫?path=/docs/a.md&version=GBmain`；舊版也可能省略專案（和儲存庫同名）。
  // `/專案/_apis/git/repositories/儲存庫/items?path=/.attachments/a.png`：Wiki 附件的網址常是這種。
  const git =
    /^(?:\/([^/]+))?\/_git\/([^/]+)\/?$/i.exec(rest) ?? /^(?:\/([^/]+))?\/_apis\/git\/repositories\/([^/]+)\/items\/?$/i.exec(rest);
  if (!git) return null;
  const rawPath = query.get("path");
  if (!rawPath) return null;
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!accept(name)) return null;
  const repo = decode(git[2]);
  const version = query.get("version") ?? query.get("versionDescriptor.version");
  const prefixed = version ? VERSION_TYPES[version.slice(0, 2).toUpperCase() as keyof typeof VERSION_TYPES] : undefined;
  // API 網址的版本不加 GB／GT／GC，當成分支。
  const api = !/_git/i.test(rest);
  const type = api ? (version ? "branch" : undefined) : prefixed;
  return {
    kind: "git",
    project: git[1] ? decode(git[1]) : repo,
    repo,
    path,
    version: version && type ? (api ? version : version.slice(2)) : null,
    versionType: type ?? null,
    name,
  };
}

/** 依 `.`、`..` 整理路徑（以 `/` 開頭）。 */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** 儲存庫檔案內容裡的相對路徑（連結、圖片）指到儲存庫裡的哪個檔案；網址、錨點回傳 null。 */
export function resolveRepoPath(fromFile: string, href: string): string | null {
  const raw = href.trim().split(/[?#]/)[0];
  if (!raw || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return null;
  const path = decode(raw);
  const dir = fromFile.slice(0, fromFile.lastIndexOf("/"));
  return normalize(path.startsWith("/") ? path : `${dir}/${path}`);
}

/** 儲存庫檔案在瀏覽器裡的網址（同一個分支）。 */
export function repoFileUrl(base: string, link: Extract<RepoFileLink, { kind: "git" }>, path = link.path): string {
  const root = base.trim().replace(/\/+$/, "");
  const prefix = { branch: "GB", tag: "GT", commit: "GC" } as const;
  const version = link.version && link.versionType ? `&version=${prefix[link.versionType]}${encodeURIComponent(link.version)}` : "";
  return `${root}/${encodeURIComponent(link.project)}/_git/${encodeURIComponent(link.repo)}?path=${encodeURIComponent(path)}${version}`;
}

/** 程式碼檔案用哪種語言上色（Markdown 程式碼區塊的語言名稱）。 */
export function fenceLanguage(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = { yml: "yaml", mjs: "js", cjs: "js", ps1: "powershell", psm1: "powershell", sh: "bash", h: "c", hpp: "cpp", cc: "cpp", htm: "html", txt: "", log: "" };
  return map[ext] ?? ext;
}
