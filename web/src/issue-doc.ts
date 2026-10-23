/**
 * 把 Azure DevOps 工作項目、GitHub issue 整理成一份 Markdown：開在主要區域的唯讀檢視，
 * 以及「複製成 Markdown 文件」都用這一份。工作項目的 HTML 轉成 Markdown 後，
 * 由預覽同一套流程顯示（Rust 端會移除原始 HTML 與危險的連結）。
 */
import type { AdoWorkItemDetail, GitHubIssueDetail } from "./desktop.ts";
import { htmlToMarkdown } from "./html-paste.ts";
import { t } from "./i18n.ts";

/** 標題、表格裡的文字：跳脫 Markdown 符號，換行改成空白。 */
export function inlineText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]<>#|~])/g, "\\$1");
}

function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 欄位表：值是空的就不列出。 */
function fieldTable(rows: [string, string][]): string {
  const filled = rows.filter(([, v]) => v.trim());
  if (!filled.length) return "";
  const head = "| " + [t("欄位"), t("內容")].join(" | ") + " |";
  return [head, "| --- | --- |", ...filled.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
}

function section(title: string, body: string): string {
  return body.trim() ? `## ${title}\n\n${body.trim()}` : "";
}

const html = (s: string | null) => (s ? htmlToMarkdown(s, { keepImages: true }) : "");

/** 「在瀏覽器開啟」的連結（網址放在角括號裡，有空白或括號也不會斷掉）。 */
function webLink(url: string): string {
  const label = t("在瀏覽器開啟");
  return `[${label}](<${url}>)`;
}

/** 留言的小標題：「王小明・2026-10-20 14:00」。 */
function commentHeading(author: string, created: string | null): string {
  const name = inlineText(author || t("（不明）"));
  return `### ${[name, dateTime(created)].filter(Boolean).join("・")}`;
}

/** 工作項目的 Markdown。 */
export function workItemMarkdown(d: AdoWorkItemDetail): string {
  const fields = fieldTable([
    [t("類型"), inlineText(d.kind)],
    [t("狀態"), inlineText(d.state)],
    [t("指派給"), inlineText(d.assignedTo ?? "")],
    [t("建立者"), inlineText(d.createdBy ?? "")],
    [t("專案"), inlineText(d.project)],
    [t("區域"), inlineText(d.area ?? "")],
    [t("反覆項目"), inlineText(d.iteration ?? "")],
    [t("優先順序"), d.priority ? String(d.priority) : ""],
    [t("標籤"), d.tags.map(inlineText).join(t("、"))],
    [t("最後更新"), dateTime(d.changed)],
  ]);
  const comments = d.comments.map((c) => `${commentHeading(c.author, c.created)}\n\n${html(c.text)}`);
  const title = t("{label}：{title}", { label: inlineText(`${d.kind} ${d.id}`), title: inlineText(d.title) });
  return [
    `# ${title}`,
    fields,
    webLink(d.webUrl),
    // 「說明」在共用的翻譯是選單的「Help」；這裡是工作項目的 Description 欄位。
    section(t("工作項目說明"), html(d.description)),
    section(d.kind === "Bug" ? t("重現步驟") : t("驗收條件"), html(d.details)),
    section(t("留言（{n}）", { n: d.comments.length }), comments.join("\n\n")),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** GitHub issue 的 Markdown（內容本來就是 Markdown）。 */
export function githubIssueMarkdown(d: GitHubIssueDetail): string {
  const fields = fieldTable([
    [t("狀態"), d.state === "closed" ? t("已關閉") : t("開啟中")],
    [t("建立者"), inlineText(d.author)],
    [t("指派給"), d.assignees.map(inlineText).join(t("、"))],
    [t("標籤"), d.labels.map(inlineText).join(t("、"))],
    [t("最後更新"), dateTime(d.updated)],
  ]);
  const comments = d.commentList.map((c) => `${commentHeading(c.author, c.created)}\n\n${c.body.trim()}`);
  return [
    `# #${d.number} ${inlineText(d.title)}`,
    fields,
    webLink(d.webUrl),
    section(t("內容"), d.body),
    section(t("留言（{n}）", { n: d.commentList.length }), comments.join("\n\n")),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 「複製成 Markdown 文件」的檔名：「Bug 123 修正登入.md」，去掉檔名不能用的字元。 */
export function issueFileName(prefix: string, title: string): string {
  const name = `${prefix} ${title}`.replace(/[\\/:*?"<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return `${name.slice(0, 80).trim()}.md`;
}
