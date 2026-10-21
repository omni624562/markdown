/**
 * 文件範本：內建的週報、會議記錄、OKR 等，以及使用者自訂的範本（存在設定中）。
 * 範本裡的 {{日期}}、{{時間}}、{{年}}、{{月}}、{{日}}、{{星期}}、{{週次}} 會換成建立當下的值。
 */

export interface Template {
  name: string;
  body: string;
}

export const TEMPLATE_LIMITS = { count: 50, name: 40, body: 100_000 } as const;

export const BUILTIN_TEMPLATES: readonly Template[] = Object.freeze([
  {
    name: "週報",
    body: `# 週報（{{年}} 年第 {{週次}} 週）

> 填寫日期：{{日期}}（星期{{星期}}）

## 本週完成

- [x]

## 進行中

- [ ]

## 下週計畫

- [ ]

## 問題與需要協助

-
`,
  },
  {
    name: "會議記錄",
    body: `# 會議記錄：

| 項目 | 內容 |
| --- | --- |
| 日期 | {{日期}}（{{星期}}）{{時間}} |
| 地點 |  |
| 主持人 |  |
| 出席 |  |
| 記錄 |  |

## 議程

1.

## 討論

###

## 決議

-

## 待辦事項

| 事項 | 負責人 | 期限 |
| --- | --- | --- |
|  |  |  |
`,
  },
  {
    name: "OKR",
    body: `# {{年}} 年 OKR

## O1：

- **KR1**：
- **KR2**：
- **KR3**：

## O2：

- **KR1**：
- **KR2**：

## 進度追蹤

| KR | 目標 | 目前 | 狀態 |
| --- | --- | --- | --- |
| O1-KR1 |  |  | ☐ 未開始 |
`,
  },
  {
    name: "專案提案",
    body: `# 專案提案：

> 提案人：　　提案日期：{{日期}}

<!-- toc -->
<!-- /toc -->

## 一、背景與問題

## 二、目標

## 三、做法

## 四、時程

| 階段 | 內容 | 預計完成 |
| --- | --- | --- |
|  |  |  |

## 五、所需資源

## 六、風險與對策
`,
  },
  {
    name: "空白文件",
    body: "",
  },
]);

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 8601 週次（星期一開始，第一週包含當年第一個星期四）。 */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** 把範本中的變數換成建立當下的值。不認得的 {{…}} 原樣保留。 */
export function fillTemplate(body: string, now = new Date()): string {
  const values: Record<string, string> = {
    日期: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    時間: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    年: String(now.getFullYear()),
    月: String(now.getMonth() + 1),
    日: String(now.getDate()),
    星期: WEEKDAYS[now.getDay()],
    週次: String(isoWeek(now)),
  };
  return body.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, key: string) => values[key] ?? all);
}

/** 新文件的檔名：範本名稱加上日期（空白文件用「未命名」）。 */
export function templateFileName(name: string, now = new Date()): string {
  if (name === "空白文件") return "未命名.md";
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${name.replace(/[\\/:*?"<>|]/g, "")} ${date}.md`;
}
