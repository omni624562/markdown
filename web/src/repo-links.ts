/**
 * 工作項目、Wiki 內容裡連到 Azure DevOps 儲存庫檔案或附件的連結：
 * 辨認出可以直接在 oMarker 閱讀的文字檔（Markdown、純文字、程式碼），不碰畫面，方便測試。
 */

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

/** `href` 是不是連線中那台伺服器（`base` 是集合的網址）上、可以閱讀的儲存庫檔案或附件。 */
export function parseRepoFileLink(href: string, base: string): RepoFileLink | null {
  const root = base.trim().replace(/\/+$/, "");
  const url = href.trim();
  if (!root || url.slice(0, root.length + 1).toLowerCase() !== `${root.toLowerCase()}/`) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const rest = url.slice(root.length).split(/[?#]/)[0];
  const attachment = /^(?:\/[^/]+)?\/_apis\/wit\/attachments\/[^/]+$/i.exec(rest);
  if (attachment) {
    const name = parsed.searchParams.get("fileName") ?? "";
    return name && isReadableFileName(name) ? { kind: "attachment", url, name } : null;
  }
  // `/專案/_git/儲存庫?path=/docs/a.md&version=GBmain`；舊版也可能省略專案（和儲存庫同名）。
  const git = /^(?:\/([^/]+))?\/_git\/([^/]+)\/?$/i.exec(rest);
  if (!git) return null;
  const rawPath = parsed.searchParams.get("path");
  if (!rawPath) return null;
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!isReadableFileName(name)) return null;
  const repo = decode(git[2]);
  const version = parsed.searchParams.get("version");
  const type = version ? VERSION_TYPES[version.slice(0, 2).toUpperCase() as keyof typeof VERSION_TYPES] : undefined;
  return {
    kind: "git",
    project: git[1] ? decode(git[1]) : repo,
    repo,
    path,
    version: version && type ? version.slice(2) : null,
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
