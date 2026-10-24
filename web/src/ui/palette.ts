import { t } from "../i18n.ts";
import { type Command, type Commands, formatKeys, fuzzyScore } from "../commands.ts";
import * as storage from "../storage.ts";
import { Picker } from "./picker.ts";

/** 指令分類的顯示順序（指令面板、快速鍵一覽共用）；沒列到的分類排在最後。 */
export function commandGroups(): string[] {
  return [
    t("檔案"),
    t("分頁"),
    t("編輯"),
    t("格式"),
    t("插入"),
    t("檢視"),
    t("資料夾與專案"),
    t("匯入與匯出"),
    "Git",
    t("AI 與終端機"),
    t("說明"),
  ];
}

/** 依分類排序；同一分類保持註冊的順序。 */
export function sortByGroup(list: Command[]): Command[] {
  const order = commandGroups();
  const rank = (g: string) => {
    const i = order.indexOf(g);
    return i < 0 ? order.length : i;
  };
  return list.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c.group) - rank(b.c.group) || a.i - b.i).map((x) => x.c);
}

const RECENT_KEY = "palette-recent";
const RECENT_LIMIT = 5;

/** 沒有輸入時：最近用過的指令放最前面，其餘依分類分區；輸入時依符合程度排序。 */
export function paletteItems(all: Command[], query: string, recent: string[]): { c: Command; section?: string }[] {
  const list = all.filter((c) => c.id !== "palette");
  if (query.trim()) {
    return list
      .map((c) => ({ c, score: Math.max(fuzzyScore(query, c.title), fuzzyScore(query, `${c.group} ${c.title}`) - 1) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => ({ c: x.c }));
  }
  const byId = new Map(list.map((c) => [c.id, c]));
  const used = recent.flatMap((id) => byId.get(id) ?? []).slice(0, RECENT_LIMIT);
  return [
    ...used.map((c) => ({ c, section: t("最近使用") })),
    ...sortByGroup(list.filter((c) => !used.includes(c))).map((c) => ({ c, section: c.group })),
  ];
}

/**
 * 指令面板（Ctrl/⌘+Shift+P）：輸入關鍵字即可找到所有功能並看到對應的快速鍵。
 */
export class Palette {
  #picker: Picker<{ c: Command; section?: string }>;

  constructor(commands: Commands) {
    this.#picker = new Picker({
      label: t("指令面板"),
      placeholder: t("輸入指令名稱，例如「匯出」「表格」「深色」"),
      empty: t("找不到符合的指令"),
      columns: true,
      query: (q) => paletteItems(commands.available(), q, recentIds()),
      render: ({ c, section }) => {
        const keys = c.keys ?? c.shownKeys;
        return {
          title: c.title,
          // 分區顯示時標題已經說明分類；搜尋結果才在右邊註明。
          detail: section ? undefined : c.group,
          section,
          icon: c.icon ?? "command",
          keys: keys && formatKeys(keys),
        };
      },
      pick: ({ c }) => {
        storage.save(RECENT_KEY, JSON.stringify([c.id, ...recentIds().filter((id) => id !== c.id)].slice(0, RECENT_LIMIT)));
        void commands.run(c.id);
      },
    });
  }

  open(): void {
    this.#picker.open();
  }
}

function recentIds(): string[] {
  try {
    const v: unknown = JSON.parse(storage.load(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
