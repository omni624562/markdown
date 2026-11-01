/**
 * 英文拼字檢查要看哪些字：從文字裡找出英文單字（位置以 JavaScript 字串為準）。
 * 像程式或路徑的寫法（含數字、底線、@、#、斜線、冒號、檔名的點）、全大寫的縮寫、
 * 中間有大寫的名稱（TypeScript、iPhone）都不檢查，免得滿篇底線。
 */

export interface WordHit {
  from: number;
  to: number;
  word: string;
}

/** 檢查的最短長度（太短的字多半是縮寫或代號）。 */
const MIN_LENGTH = 3;

/** 一段「不是空白也不是中文」的連續字元（英文、數字與常見的符號）。 */
const CHUNK = /[A-Za-z0-9_.@#/\\:'’\-+&=%~]+/g;
/** 這種寫法像程式、路徑、網址、信箱、標籤、版本號：整段都不檢查。 */
const CODE_LIKE = /[0-9_@#/\\:+&=%~]|[A-Za-z]\.[A-Za-z]/;

/** 常用但字典沒有的技術詞（小寫比對）。 */
export const TECH_WORDS: ReadonlySet<string> = new Set([
  "api", "apis", "app", "apps", "async", "backend", "backlog", "changelog", "checkbox", "codebase", "config", "configs",
  "css", "dev", "devops", "dropdown", "emoji", "emojis", "env", "frontend", "git", "github", "gitlab", "html", "http",
  "https", "json", "kanban", "localhost", "login", "logout", "markdown", "mermaid", "metadata", "middleware", "namespace",
  "namespaces", "npm", "plugin", "plugins", "prod", "refactor", "refactoring", "repo", "repos", "runtime", "scrum",
  "signup", "sprint", "sprints", "subfolder", "subfolders", "timestamp", "timestamps", "todo", "todos", "toml", "tooltip",
  "tooltips", "url", "urls", "username", "usernames", "webhook", "webhooks", "wiki", "wikis", "workflow", "workflows",
  "yaml", "azure", "javascript", "typescript", "rust", "tauri", "omarker",
]);

/** 這個字要不要檢查（已經是一個純英文字母、可能含撇號的字）。 */
export function worthChecking(word: string): boolean {
  if (word.length < MIN_LENGTH) return false;
  // 全大寫（縮寫：API、UAT）、中間有大寫（TypeScript、iPhone）。
  if (word === word.toUpperCase()) return false;
  if (/[a-z][A-Z]/.test(word)) return false;
  return !TECH_WORDS.has(word.toLowerCase());
}

/**
 * 找出要檢查的英文字。`skip` 是不檢查的範圍（程式碼、網址、HTML、公式，位置相對於 `text`）；
 * 跨到這些範圍的字也略過。連字號分開檢查（e-mail 的 mail）；撇號留在字裡（don't）。
 */
export function englishWords(text: string, skip: readonly (readonly [number, number])[] = []): WordHit[] {
  const out: WordHit[] = [];
  const skipped = (from: number, to: number) => skip.some(([a, b]) => from < b && to > a);
  for (const m of text.matchAll(CHUNK)) {
    const chunk = m[0];
    if (CODE_LIKE.test(chunk)) continue;
    for (const w of chunk.matchAll(/[A-Za-z](?:[A-Za-z'’]*[A-Za-z])?/g)) {
      const word = w[0].replace(/’/g, "'");
      const from = m.index + w.index;
      const to = from + word.length;
      if (!worthChecking(word) || skipped(from, to)) continue;
      out.push({ from, to, word });
    }
  }
  return out;
}
