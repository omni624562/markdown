/**
 * CHANGELOG.md 中一版的說明（Markdown）轉成更新視窗用的結構：開頭的說明文字，加上「新功能」「修正」等分類的項目。
 * 只認得這份檔案用到的寫法（### 分類、- 項目），其他內容當成一般文字；顯示時一律用 textContent。
 */
export interface ReleaseNotes {
  intro: string[];
  sections: { title: string; items: string[] }[];
}

export function parseReleaseNotes(markdown: string): ReleaseNotes {
  const notes: ReleaseNotes = { intro: [], sections: [] };
  const clean = (s: string) => s.replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").trim();
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{2,4}\s+(.+)$/.exec(line);
    if (heading) {
      notes.sections.push({ title: clean(heading[1]), items: [] });
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    const section = notes.sections.at(-1);
    if (item && section) section.items.push(clean(item[1]));
    else if (item) notes.sections.push({ title: "", items: [clean(item[1])] });
    else if (section?.items.length) section.items[section.items.length - 1] += clean(line);
    else notes.intro.push(clean(line));
  }
  notes.sections = notes.sections.filter((s) => s.items.length);
  return notes;
}

/** CHANGELOG.md 中某一版的說明（`## 1.2.0 — 日期` 到下一個 `## ` 之前）；找不到時回傳空字串。 */
export function notesForVersion(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^## \\[?v?${escaped}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}
